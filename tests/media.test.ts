import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { defaults } from '../src/domain/config.js';
import { isPublicAddress, SafeHttp, WorkQueue } from '../src/media/http.js';
import { MediaService } from '../src/media/service.js';
import { UserError } from '../src/domain/errors.js';
import { randomBytes } from 'node:crypto';

test('画像取得は内部IP・特殊アドレス・認証URL・非HTTPSを拒否する', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1']) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('1.1.1.1'), true); assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  const http = new SafeHttp();
  for (const url of ['http://example.com/a', 'https://user:pass@example.com/a', 'https://127.0.0.1/a', 'https://localhost/a', 'https://example.com:8443/a']) await assert.rejects(http.get(url, 100), /HTTPS|許可されていません/);
});
test('画像処理は透明度を保ち、サイズを抑え、位置情報と元の名前を除去する', async () => {
  const source = await sharp({ create: { width: 2000, height: 1800, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } } }).png().withMetadata().toBuffer();
  const service = new MediaService(); const result = await service.optimize(source, defaults);
  const metadata = await sharp(result.data).metadata();
  assert.ok(metadata.hasAlpha); assert.ok(metadata.width! <= 1600); assert.ok(metadata.height! <= 1600);
  assert.equal(metadata.exif, undefined); assert.equal(result.name, 'image_1.png');
  const notImage = await service.optimize(Buffer.from('not an image'), defaults, 0, 'memo.txt', 'text/plain');
  assert.equal(notImage.kind, 'file'); assert.equal(notImage.name, 'memo.txt'); assert.deepEqual(notImage.data, Buffer.from('not an image'));
});

test('画像取得と最適化は旧ファイルサイズ設定で投稿を拒否しない',async()=>{
  const source=await sharp({create:{width:100,height:100,channels:3,background:'red'}}).png().toBuffer();
  const config=structuredClone(defaults);config.content.maxFileMB=0;
  let byteLimit:number|undefined;
  class ImageHttp extends SafeHttp {
    override async get(url:string,maxBytes:number){byteLimit=maxBytes;return {data:source,contentType:'image/png',url};}
  }
  const files=await new MediaService(new ImageHttp()).attachments(['https://example.com/image.png'],config);
  assert.equal(byteLimit,Number.POSITIVE_INFINITY);assert.equal(files.length,1);assert.ok(files[0]!.data.length>0);
});

test('旧10MB上限を超える実画像を取得して最適化できる',async()=>{
  const source=await sharp(randomBytes(2048*2048*3),{raw:{width:2048,height:2048,channels:3}}).png({compressionLevel:0}).toBuffer();
  assert.ok(source.length>10*1024*1024);
  class LargeHttp extends SafeHttp {
    override async get(url:string,maxBytes:number){assert.equal(maxBytes,Number.POSITIVE_INFINITY);return {data:source,contentType:'image/png',url};}
  }
  const files=await new MediaService(new LargeHttp()).attachments(['https://example.com/large.png'],defaults);
  assert.equal(files.length,1);assert.ok(files[0]!.data.length>0);
  assert.ok((await sharp(files[0]!.data).metadata()).width!<=1600);
});
test('画像キューは同時実行を制限し、満杯時は分かるエラーを出す', async () => {
  const queue = new WorkQueue(1, 1); let release!: () => void; let active = 0; let maximum = 0;
  const first = queue.run(async () => { active++; maximum = Math.max(maximum, active); await new Promise<void>(resolve => release = resolve); active--; });
  const second = queue.run(async () => { active++; maximum = Math.max(maximum, active); active--; });
  await assert.rejects(queue.run(async () => undefined), /混み合って/);
  release(); await Promise.all([first, second]); assert.equal(maximum, 1);
});
test('URL判定は正規のドメインだけをXとして扱い、無効なサービスを取得前に拒否する', async () => {
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#3366cc' } }).png().toBuffer();
  class StubHttp extends SafeHttp {
    calls: string[] = [];
    override async json<T>(url: string): Promise<T> { this.calls.push(url); return { tweet: { media: { all: [{ type: 'photo', url: 'https://pbs.twimg.com/a.jpg' }, { type: 'video', url: 'https://video.twimg.com/a.mp4' }] } } } as T; }
    override async get(url: string) { return { data: image, contentType: 'image/png', url }; }
  }
  const http = new StubHttp(); const service = new MediaService(http);
  const result = await service.resolve('https://x.com/example/status/123?s=20', defaults);
  assert.equal(result.provider, 'x'); assert.equal(result.media.length, 2); assert.equal(result.source, 'https://x.com/example/status/123'); assert.equal(result.warnings.length, 0);
  const fromUrl = await service.fromUrl('https://x.com/example/status/123?s=20', defaults);
  assert.equal(fromUrl.files.length, 1); assert.equal(fromUrl.videoLinks.length, 1);
  assert.equal(fromUrl.videoLinks[0], 'https://x-p.yexe.xyz/a.mp4');
  const disabled = structuredClone(defaults); disabled.content.providers = ['pixiv'];
  await assert.rejects(service.resolve('https://x.com/example/status/123', disabled), /無効/);
  const fake = await service.resolve('https://x.com.evil.example/example/status/123', defaults);
  assert.equal(fake.provider, 'direct');
});

test('取得先の応答形式変更・JSON不正は入力項目の英語エラーではなく次の操作を案内する',async()=>{
  class ChangedHttp extends SafeHttp { override async json<T>():Promise<T>{return {body:{unexpected:true}} as T;} }
  await assert.rejects(new MediaService(new ChangedHttp()).resolve('https://www.pixiv.net/artworks/123',defaults),error=>error instanceof UserError&&error.message.includes('画像を直接添付'));
  class InvalidHttp extends SafeHttp { override async json<T>():Promise<T>{throw new SyntaxError('unexpected response data');} }
  await assert.rejects(new MediaService(new InvalidHttp()).resolve('https://bsky.app/profile/bsky.app/post/abc',defaults),error=>error instanceof UserError&&!error.message.includes('unexpected response data'));
});

test('一部画像の取得失敗は元の番号で案内し、取得できた画像を安全な名前でプレビューに残す',async()=>{
  const image=await sharp({create:{width:16,height:16,channels:3,background:'#00aa66'}}).png().toBuffer();
  class PartialHttp extends SafeHttp {
    override async json<T>():Promise<T>{return {error:false,body:[1,2,3].map(i=>({urls:{original:`https://i.pximg.net/${i}.png`}}))} as T;}
    override async get(url:string){if(!url.endsWith('/2.png'))throw new UserError('failed');return {data:image,contentType:'image/png',url};}
  }
  const result=await new MediaService(new PartialHttp()).fromUrl('https://www.pixiv.net/artworks/123',defaults);
  assert.equal(result.files.length,1);assert.ok(result.files[0]!.name.startsWith('image_1.'));
  assert.ok(result.warnings[0]!.includes('元のファイル1'));assert.ok(result.warnings[1]!.includes('元のファイル3'));
});

test('Pixiv・Bluesky・Mastodonの公開画像をそれぞれの応答から抽出する',async()=>{
  const image=await sharp({create:{width:8,height:8,channels:3,background:'#2266cc'}}).png().toBuffer();
  class ProviderHttp extends SafeHttp {
    nested=false;
    override async json<T>(url:string):Promise<T>{
      if(url.includes('/ajax/illust/'))return {error:false,body:[{urls:{original:'https://i.pximg.net/original.png'}}]} as T;
      if(url.includes('resolveHandle'))return {did:'did:plc:example'} as T;
      if(url.includes('getPosts')){const images={images:[{fullsize:'https://cdn.bsky.app/image.png'}]};return {posts:[{embed:this.nested?{media:images}:images}]} as T;}
      return {visibility:'public',media_attachments:[{type:'image',url:null,remote_url:'https://cdn.example.com/photo.png'},{type:'video',url:'https://cdn.example.com/video.mp4'}]} as T;
    }
    override async get(url:string){return url.endsWith('.mp4') ? {data:Buffer.from('fakevideo'),contentType:'video/mp4',url} : {data:image,contentType:'image/png',url};}
  }
  const http=new ProviderHttp();const service=new MediaService(http);
  const pixiv=await service.resolve('https://www.pixiv.net/en/artworks/123',defaults);
  assert.equal(pixiv.provider,'pixiv');assert.equal(pixiv.media[0]!.headers?.Referer,'https://www.pixiv.net/artworks/123');
  const bluesky=await service.resolve('https://bsky.app/profile/bsky.app/post/abc',defaults);
  assert.equal(bluesky.provider,'bluesky');assert.equal(bluesky.media[0]!.url,'https://cdn.bsky.app/image.png');
  http.nested=true;assert.equal((await service.resolve('https://bsky.app/profile/did:plc:example/post/abc',defaults)).media.length,1);
  const mastodon=await service.resolve('https://mastodon.example/@someone/123',defaults);
  assert.equal(mastodon.provider,'mastodon');assert.equal(mastodon.media.length,2);assert.equal(mastodon.warnings.length,0);
  const mastodonPost=await new MediaService(http).fromUrl('https://mastodon.example/@someone/123',defaults);
  assert.equal(mastodonPost.files.length,2);assert.equal(mastodonPost.files[1]!.kind,'video');
});

test('Xのi/statusやトラッキング付きURLを投稿者の正規URLに変換する',async()=>{
  class XHttp extends SafeHttp {
    override async json<T>(url:string):Promise<T>{
      return {tweet:{author:{screen_name:'1201_exe'},media:{all:[{type:'photo',url:'https://pbs.twimg.com/a.jpg'}]}}} as T;
    }
  }
  const service=new MediaService(new XHttp());
  const short=await service.resolve('https://x.com/i/status/2107439604907536632',defaults);
  assert.equal(short.source,'https://x.com/1201_exe/status/2107439604907536632');
  const tracked=await service.resolve('https://x.com/1201_exe/status/2107439604907536632?s=61',defaults);
  assert.equal(tracked.source,'https://x.com/1201_exe/status/2107439604907536632');
  const mobile=await service.resolve('https://mobile.twitter.com/i/web/status/2107439604907536632',defaults);
  assert.equal(mobile.source,'https://x.com/1201_exe/status/2107439604907536632');
  const legacy=await service.resolve('https://twitter.com/i/status/2107439604907536632',defaults);
  assert.equal(legacy.provider,'x');
});

test('Pixivの旧形式URLも作品ページの正規URLに変換する',async()=>{
  class PixivHttp extends SafeHttp {
    override async json<T>(url:string):Promise<T>{assert.ok(url.includes('/ajax/illust/999/pages'));return {error:false,body:[{urls:{original:'https://i.pximg.net/999.png'}}]} as T;}
  }
  const result=await new MediaService(new PixivHttp()).resolve('https://www.pixiv.net/member_illust.php?mode=medium&illust_id=999',defaults);
  assert.equal(result.source,'https://www.pixiv.net/artworks/999');assert.equal(result.media[0]!.kind,'image');
});

test('直接添付は画像以外のファイルも元の名前のまま受け付ける',async()=>{
  class Http extends SafeHttp { override async get(url:string){return {data:Buffer.from('%PDF-1.4 test'),contentType:'application/pdf',url};} }
  const files=await new MediaService(new Http()).attachments(['https://cdn.discordapp.com/ephemeral-attachments/1/2/document_(1).PDF'],defaults);
  assert.equal(files.length,1);assert.equal(files[0]!.kind,'file');assert.ok(files[0]!.name.endsWith('.PDF'));
  assert.deepEqual(files[0]!.data,Buffer.from('%PDF-1.4 test'));
});

test('Misskeyの公開投稿の画像を取得し、非公開は拒否する',async()=>{
  class MisskeyHttp extends SafeHttp {
    constructor(private visibility='public'){super();}
    override async postJson<T>(url:string,body:unknown):Promise<T>{
      assert.equal(url,'https://misskey.io/api/notes/show');assert.deepEqual(body,{noteId:'note123'});
      return {visibility:this.visibility,files:[{type:'image/png',url:'https://misskey.io/files/a.png'},{type:'video/webm',url:'https://misskey.io/files/b.webm'}]} as T;
    }
  }
  const service=new MediaService(new MisskeyHttp());
  const result=await service.resolve('https://misskey.io/notes/note123',defaults);
  assert.equal(result.provider,'misskey');assert.equal(result.source,'https://misskey.io/notes/note123');
  assert.equal(result.media.length,2);assert.equal(result.warnings.length,0);
  const image=await sharp({create:{width:8,height:8,channels:3,background:'#2266cc'}}).png().toBuffer();
  class DownloadHttp extends MisskeyHttp { override async get(url:string){return url.endsWith('.webm') ? {data:Buffer.from('fakewebm'),contentType:'video/webm',url} : {data:image,contentType:'image/png',url};} }
  const posted=await new MediaService(new DownloadHttp()).fromUrl('https://misskey.io/notes/note123',defaults);
  assert.equal(posted.files.length,2);assert.equal(posted.files[1]!.kind,'video');assert.equal(posted.files[1]!.name,'b.webm');
  await assert.rejects(new MediaService(new MisskeyHttp('followers')).resolve('https://misskey.io/notes/note123',defaults),/公開された投稿/);
});
