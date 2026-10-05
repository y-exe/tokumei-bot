import sharp from 'sharp';
import { z } from 'zod';
import type { Config, Provider } from '../domain/config.js';
import { UserError } from '../domain/errors.js';
import type { MediaFile } from '../domain/validation.js';
import { SafeHttp, WorkQueue } from './http.js';

export interface MediaSource { url: string; kind: 'image' | 'animation' | 'video'; headers?: Record<string, string>; }
export interface ResolvedMedia { provider: Provider; source: string; media: MediaSource[]; warnings: string[]; }
const webUrl = z.string().url();
const xResponse = z.object({ tweet: z.object({ media: z.object({ all: z.array(z.object({ type: z.string(), url: webUrl })) }).optional() }).optional() });
const pixivResponse = z.object({ error: z.boolean(), body: z.array(z.object({ urls: z.object({ original: webUrl }) })).optional() });
const mastodonResponse = z.object({ visibility: z.string(), media_attachments: z.array(z.object({ type: z.string(), url: webUrl.nullable(), remote_url: webUrl.nullable().optional() })) });

export class MediaService {
  constructor(readonly http = new SafeHttp(), readonly queue = new WorkQueue()) {}
  async optimize(data: Buffer, config: Config, index = 0): Promise<MediaFile> {
    try {
      const image = sharp(data, { animated: true, limitInputPixels: 40_000_000 });
      const metadata = await image.metadata();
      if (!['jpeg', 'png', 'webp', 'gif', 'avif'].includes(metadata.format ?? '')) throw new UserError('JPEG・PNG・WebP・GIF・AVIF画像を添付してください。');
      const animated = (metadata.pages ?? 1) > 1;
      if (animated && !config.content.animation) throw new UserError('このチャンネルでは動く画像を投稿できません。');
      if ((metadata.width ?? 0) * (metadata.height ?? 0) > 40_000_000) throw new UserError('画像のピクセル数が大きすぎます。');
      const pipeline = image.rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true });
      const transparent = metadata.hasAlpha;
      let output = animated ? await pipeline.webp({ quality: 85, effort: 3 }).toBuffer() :
        transparent ? await pipeline.png({ compressionLevel: 6 }).toBuffer() : await pipeline.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
      let extension = animated ? 'webp' : transparent ? 'png' : 'jpg';
      if (!animated && !transparent && metadata.format === 'png' && output.length > data.length) {
        const png = await pipeline.png({ compressionLevel: 6 }).toBuffer();
        if (png.length < output.length) { output = png; extension = 'png'; }
      }
      return { data: output, name: `image_${index + 1}.${extension}`, kind: animated ? 'animation' : 'image' };
    } catch (error) {
      if (error instanceof UserError) throw error;
      throw new UserError('画像を読み取れませんでした。対応する画像ファイルを直接添付してください。');
    }
  }
  async attachments(urls: string[], config: Config): Promise<MediaFile[]> {
    if (urls.length > config.content.maxFiles) throw new UserError(`画像は${config.content.maxFiles}枚まで添付できます。`);
    return this.queue.run(async () => {
      const result: MediaFile[] = [];
      for (const url of urls) {
        const response = await this.http.get(url, Number.POSITIVE_INFINITY);
        result.push(await this.optimize(response.data, config, result.length));
      }
      return result;
    });
  }
  async resolve(value: string, config: Config): Promise<ResolvedMedia> {
    try { return await this.resolveSource(value,config); }
    catch(error) {
      if(error instanceof z.ZodError || error instanceof SyntaxError) throw new UserError('画像取得先から正しい応答を受け取れませんでした。少し待ってから試すか、画像を直接添付してください。');
      throw error;
    }
  }
  private async resolveSource(value:string,config:Config):Promise<ResolvedMedia> {
    if (!config.content.urls) throw new UserError('このチャンネルではURL変換を利用できません。');
    let url: URL;
    try { url = new URL(value.trim()); } catch { throw new UserError('URLを1件入力してください。'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new UserError('HTTPSの公開URLを入力してください。');
    const host = url.hostname.toLowerCase();
    let provider: Provider; let source = url.href; let media: MediaSource[] = [];
    const warnings: string[] = [];
    if (['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(host)) provider = 'x';
    else if (['pixiv.net', 'www.pixiv.net'].includes(host)) provider = 'pixiv';
    else if (host === 'bsky.app') provider = 'bluesky';
    else if (/^\/@[^/]+\/\d+\/?$|^\/users\/[^/]+\/statuses\/\d+\/?$/.test(url.pathname)) provider = 'mastodon';
    else provider = 'direct';
    if (!config.content.providers.includes(provider)) throw new UserError('このサイトのURL変換はサーバー設定で無効になっています。');
    if (provider === 'x') {
      const match = url.pathname.match(/^\/([\w]+)\/status\/(\d+)(?:\/.*)?$/);
      if (!match) throw new UserError('Xの投稿URLを入力してください。');
      source = `https://x.com/${match[1]}/status/${match[2]}`;
      for (const api of ['api.fxtwitter.com', 'api.fixupx.com']) {
        try {
          const data = xResponse.parse(await this.http.json(`https://${api}/status/${match[2]}`));
          media = (data.tweet?.media?.all ?? []).map(item => ({ url: item.url, kind: item.type === 'photo' ? 'image' : item.type === 'gif' ? 'animation' : 'video' }));
          if (media.length) break;
        } catch {}
      }
    } else if (provider === 'pixiv') {
      const id = url.pathname.match(/^\/(?:en\/)?artworks\/(\d+)\/?$/)?.[1];
      if (!id) throw new UserError('Pixivの作品URLを入力してください。');
      source = `https://www.pixiv.net/artworks/${id}`;
      const data = pixivResponse.parse(await this.http.json(`https://www.pixiv.net/ajax/illust/${id}/pages?lang=ja`));
      if (data.error) throw new UserError('公開作品の画像を取得できませんでした。画像を直接添付してください。');
      media = (data.body ?? []).map(item => ({ url: item.urls.original, kind: 'image', headers: { Referer: source } }));
    } else if (provider === 'bluesky') {
      const match = url.pathname.match(/^\/profile\/([^/]+)\/post\/([^/]+)\/?$/);
      if (!match) throw new UserError('Blueskyの投稿URLを入力してください。');
      let did = match[1]!;
      if (!did.startsWith('did:')) {
        const result = z.object({ did: z.string().startsWith('did:') }).parse(await this.http.json(`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(did)}`));
        did = result.did;
      }
      const uri = `at://${did}/app.bsky.feed.post/${match[2]}`;
      const result = z.object({ posts: z.array(z.object({ embed: z.unknown().optional() })) }).parse(await this.http.json(`https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(uri)}`));
      const embed = result.posts[0]?.embed;
      const images = z.object({ images: z.array(z.object({ fullsize: webUrl })) }).safeParse(embed);
      const nested = z.object({ media: z.object({ images: z.array(z.object({ fullsize: webUrl })) }) }).safeParse(embed);
      media = (images.success ? images.data.images : nested.success ? nested.data.media.images : []).map(item => ({ url: item.fullsize, kind: 'image' }));
    } else if (provider === 'mastodon') {
      const id = url.pathname.match(/\/(\d+)\/?$/)?.[1];
      const data = mastodonResponse.parse(await this.http.json(`https://${host}/api/v1/statuses/${id}`));
      if (!['public', 'unlisted'].includes(data.visibility)) throw new UserError('公開された投稿のURLを入力してください。');
      media = data.media_attachments.filter(item => item.url || item.remote_url).map(item => ({
        url: (item.url ?? item.remote_url)!, kind: item.type === 'image' ? 'image' : item.type === 'gifv' ? 'animation' : 'video',
      }));
    } else media = [{ url: source, kind: 'image' }];
    const images = media.filter(item => item.kind === 'image');
    if (images.length !== media.length) warnings.push('このURLに含まれる動画・アニメーションは今回の画像変換から除外しました。');
    if (!images.length) throw new UserError('画像を取得できませんでした。画像のある公開投稿か、画像ファイルのURLを指定してください。');
    if (images.length > config.content.maxFiles) warnings.push(`画像が多いため、最初の${config.content.maxFiles}枚を表示しています。`);
    return { provider, source, media: images.slice(0, config.content.maxFiles), warnings };
  }
  async fromUrl(value: string, config: Config): Promise<{ files: MediaFile[]; source: string; warnings: string[] }> {
    return this.queue.run(async () => {
      const resolved = await this.resolve(value, config);
      const files: MediaFile[] = [];
      const warnings = [...resolved.warnings];
      for (const [sourceIndex,item] of resolved.media.entries()) {
        try {
          const response = await this.http.get(item.url, Number.POSITIVE_INFINITY, item.headers);
          files.push(await this.optimize(response.data, config, files.length));
        } catch { warnings.push(`元の画像${sourceIndex + 1}を取得できませんでした。取得できた画像だけを表示しています。`); }
      }
      if (!files.length) throw new UserError('画像を取得できませんでした。画像を直接添付してお試しください。');
      return { files, source: resolved.source, warnings };
    });
  }
}
