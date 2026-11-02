import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { defaults } from '../src/domain/config.js';
import { GalleryDl, galleryEnvironment, galleryMedia } from '../src/media/gallery.js';
import { MediaService } from '../src/media/service.js';
import { SafeHttp, WorkQueue } from '../src/media/http.js';

test('gallery-dlの子プロセスにBotのトークン・DB・Cookie・実行オプションを渡さない',()=>{
  assert.deepEqual(galleryEnvironment({PATH:'path',SystemRoot:'windows',DISCORD_BOT_TOKEN:'secret',DATABASE_URL:'secret',PIXIV_PHPSESSID:'secret',PYTHONPATH:'untrusted',PYTHONSTARTUP:'untrusted',HTTP_PROXY:'untrusted',HOME:'private'}),{PATH:'path',SystemRoot:'windows'});
});

test('抽出結果はHTTPSの実ファイルだけを採用し、Cookieや認証ヘッダーを引き継がない',()=>{
  const media=galleryMedia({status:'ok',media:[{url:'https://cdn.example/a.webp',headers:{Referer:'https://example.com/',Cookie:'secret',Authorization:'secret','User-Agent':'gallery-dl'}},{url:'file:///private'},{url:'https://user:password@cdn.example/a.png'}]},defaults);
  assert.equal(media.length,1);assert.deepEqual(media[0]!.headers,{Referer:'https://example.com/','User-Agent':'gallery-dl'});
  const config=structuredClone(defaults);config.policy.blockedDomains=['cdn.example'];
  assert.throws(()=>galleryMedia({status:'ok',media:[{url:'https://cdn.example/a.webp'}]},config),/禁止/);
  assert.deepEqual(galleryMedia({status:'unsupported',media:[]},defaults),[]);
});

test('gallery-dl対応ページのURLを既存の最適化処理へ渡し、無効なサイトでは起動しない',async()=>{
  let calls=0;
  class StubGallery extends GalleryDl {override async resolve(){calls++;return [{url:'https://cdn.example/page.png',kind:'image' as const}];}}
  const image=await sharp({create:{width:8,height:8,channels:3,background:'white'}}).png().toBuffer();
  class ImageHttp extends SafeHttp {override async get(url:string){assert.equal(url,'https://cdn.example/page.png');return {data:image,contentType:'image/png',url};}}
  const config=structuredClone(defaults);config.content.allowNsfw=true;config.content.allowNsfl=true;
  const service=new MediaService(new ImageHttp(),new WorkQueue(),new StubGallery());
  const result=await service.fromUrl('https://example.com/gallery/123',config);
  assert.equal(calls,1);assert.equal(result.files.length,1);assert.equal(result.files[0]!.kind,'image');
  config.content.providers=['x'];await assert.rejects(service.fromUrl('https://example.com/gallery/123',config),/無効/);assert.equal(calls,1);
});

test('gallery-dl未対応ページは既存の本文画像抽出へ戻す',async()=>{
  class Unsupported extends GalleryDl {override async resolve(){return [];}}
  const image=await sharp({create:{width:8,height:8,channels:3,background:'white'}}).png().toBuffer();
  class PageHttp extends SafeHttp {override async get(url:string){return url.endsWith('.png')?{data:image,contentType:'image/png',url}:{data:Buffer.from('<main><img src="/page.png" width="720" height="1040"></main>'),contentType:'text/html',url};}}
  const config=structuredClone(defaults);config.content.allowNsfw=true;config.content.allowNsfl=true;
  const result=await new MediaService(new PageHttp(),new WorkQueue(),new Unsupported()).fromUrl('https://example.com/gallery',config);
  assert.equal(result.files.length,1);
});

test('拡張子が画像でも中身がHTMLならgallery-dlで実画像を解決する',async()=>{
  let calls=0;
  class Extract extends GalleryDl {override async resolve(){calls++;return [{url:'https://cdn.example/actual.png',kind:'image' as const}];}}
  const image=await sharp({create:{width:8,height:8,channels:3,background:'white'}}).png().toBuffer();
  class PageHttp extends SafeHttp {override async get(url:string){return url.includes('cdn.example')?{data:image,contentType:'image/png',url}:{data:Buffer.from('<html></html>'),contentType:'text/html',url};}}
  const config=structuredClone(defaults);config.content.allowNsfw=true;config.content.allowNsfl=true;
  const result=await new MediaService(new PageHttp(),new WorkQueue(),new Extract()).fromUrl('https://example.com/wiki/File:Example.jpg',config);
  assert.equal(calls,1);assert.equal(result.files[0]!.kind,'image');
});

const installed=process.env.GALLERY_DL_PYTHON??resolve('.local/gallery-dl',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const python=existsSync(installed)?installed:undefined;
const bridge=resolve('src/media/gallery_bridge.py');
const prefix=`import importlib.util, sys\nspec=importlib.util.spec_from_file_location('bridge',sys.argv[1]);b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)\n`;

test('Python側は内部・混在DNS・非HTTPSを拒否する',{skip:!python},async()=>{
  const script=prefix+`import socket
for value in ['127.0.0.1','10.1.2.3','100.64.0.1','169.254.169.254','::1','::ffff:127.0.0.1','2001:db8::1']:
 assert not b.public_address(value)
for value in ['http://example.com/','file:///private','https://user:pass@example.com/','https://example.com:444/']:
 try: b.public_url(value,[]); raise AssertionError('allowed')
 except ValueError: pass
socket.getaddrinfo=lambda *a,**k:[(2,1,6,'',('1.1.1.1',443)),(2,1,6,'',('127.0.0.1',443))]
b.protect_network([])
try: socket.getaddrinfo('mixed.example',443); raise AssertionError('allowed')
except OSError: pass
s=socket.socket()
try:
 try: s.connect(('127.0.0.1',443)); raise AssertionError('allowed')
 except OSError: pass
finally: s.close()
print('ok')`;
  const result=await promisify(execFile)(python!,['-I','-B','-c',script,bridge],{env:galleryEnvironment(process.env),timeout:10000});assert.equal(result.stdout.trim(),'ok');
});

test('本家の抽出APIからURLだけを最大11件取り出し、秘密のヘッダーは除く',{skip:!python},async()=>{
  const script=prefix+`from gallery_dl import extractor
from gallery_dl.extractor.message import Message
class Session:
 headers={'Referer':'https://example.com/','Cookie':'secret','Authorization':'secret'}
 def close(self): pass
class Fake:
 url='https://example.com/gallery'
 session=Session()
 def __iter__(self):
  for i in range(100): yield (Message.Url,f'https://cdn.example/{i}.png',{})
extractor.find=lambda url:Fake()
r=b.resolve({'url':'https://example.com/gallery','blockedDomains':[]})
assert r['status']=='ok' and len(r['media'])==11
assert r['media'][0]['headers']=={'Referer':'https://example.com/'}
print('ok')`;
  const result=await promisify(execFile)(python!,['-I','-B','-c',script,bridge],{env:galleryEnvironment(process.env),timeout:10000});assert.equal(result.stdout.trim(),'ok');
});
