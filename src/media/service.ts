import sharp from 'sharp';
import { z } from 'zod';
import type { Config, Provider } from '../domain/config.js';
import { providerNames } from '../domain/config.js';
import { UserError } from '../domain/errors.js';
import type { MediaFile } from '../domain/validation.js';
import { SafeHttp, WorkQueue } from './http.js';

export interface MediaSource { url: string; kind: 'image' | 'animation' | 'video'; headers?: Record<string, string>; }
export interface ResolvedMedia { provider: Provider; source: string; media: MediaSource[]; warnings: string[]; }
export const DISCORD_FILE_LIMIT = 25 * 1024 * 1024;
const videoExtension: Record<string, string> = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'audio/mpeg': '.mp3', 'application/pdf': '.pdf', 'text/plain': '.txt' };
const safeFileName = (name: string | undefined, contentType: string | undefined, index: number): string => {
  const cleaned = (name ?? '').replace(/[^\w.\- ]/g, '_').replace(/ {2,}/g, ' ').trim().slice(-100) || `file_${index + 1}`;
  return /\.[a-z0-9]{1,8}$/i.test(cleaned) ? cleaned : `${cleaned}${videoExtension[contentType ?? ''] ?? ''}`;
};
const fileNameFromUrl = (url: string): string | undefined => {
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '') || undefined; }
  catch { return undefined; }
};
export const videoProxyUrl = (url: string): string => {
  try { const target = new URL(url); return `https://x-p.yexe.xyz${target.pathname}${target.search}`; }
  catch { return url; }
};
const isTwimgVideo = (url: string): boolean => /^https:\/\/video\.twimg\.com\//.test(url);
const webUrl = z.string().url();
const xResponse = z.object({ tweet: z.object({
    media: z.object({ all: z.array(z.object({ type: z.string(), url: webUrl })) }).optional(),
    author: z.object({ screen_name: z.string().optional(), username: z.string().optional() }).optional(),
  }).optional() });
const pixivResponse = z.object({ error: z.boolean(), body: z.array(z.object({ urls: z.object({ original: webUrl }) })).optional() });
const mastodonResponse = z.object({ visibility: z.string(), media_attachments: z.array(z.object({ type: z.string(), url: webUrl.nullable(), remote_url: webUrl.nullable().optional() })) });
const misskeyResponse = z.object({ visibility: z.string(), files: z.array(z.object({ type: z.string(), url: webUrl })).optional() });
const atmoResponse = z.object({ status: z.object({
    url: z.string().optional(),
    media: z.object({ all: z.array(z.object({ type: z.string(), url: z.string() })).optional() }).optional(),
  }).nullable().optional() }).passthrough();
const canonical = (url: URL): string => `${url.origin}${url.pathname}`;
const mediaKind = (url: string, type?: string): MediaSource['kind'] => {
  const value = (type ?? url).toLowerCase();
  if (value === 'image/gif' || value.endsWith('.gif')) return 'animation';
  if (value.startsWith('image/') || value === 'image') return 'image';
  if (value === 'gifv') return 'animation';
  return 'video';
};

export class MediaService {
  constructor(readonly http = new SafeHttp(), readonly queue = new WorkQueue()) {}
  async optimize(data: Buffer, config: Config, index = 0, fallbackName?: string, contentType?: string): Promise<MediaFile> {
    const passthrough = (): MediaFile => ({ data, name: safeFileName(fallbackName, contentType, index), kind: contentType?.startsWith('video/') ? 'video' : 'file' });
    try {
      const image = sharp(data, { animated: true, limitInputPixels: 40_000_000 });
      const metadata = await image.metadata();
      if (!['jpeg', 'png', 'webp', 'gif', 'avif'].includes(metadata.format ?? '')) return passthrough();
      const animated = (metadata.pages ?? 1) > 1;
      if ((metadata.width ?? 0) * (metadata.height ?? 0) > 40_000_000) return passthrough();
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
      return passthrough();
    }
  }
  async attachments(urls: string[], config: Config): Promise<MediaFile[]> {
    return this.queue.run(async () => {
      const result: MediaFile[] = [];
      for (const url of urls) {
        const response = await this.http.get(url, Number.POSITIVE_INFINITY);
        result.push(await this.optimize(response.data, config, result.length, fileNameFromUrl(url), response.contentType));
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
    if (['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'].includes(host)) provider = 'x';
    else if (['pixiv.net', 'www.pixiv.net'].includes(host)) provider = 'pixiv';
    else if (host === 'bsky.app') provider = 'bluesky';
    else if (/^\/@[^/]+\/\d+\/?$|^\/users\/[^/]+\/statuses\/\d+\/?$/.test(url.pathname)) provider = 'mastodon';
    else if (/(?:^|\.)tiktok\.com$/.test(host) || host === 'vm.tiktok.com' || host === 'vt.tiktok.com') provider = 'tiktok';
    else if (/(?:^|\.)instagram\.com$/.test(host) || host === 'instagr.am') provider = 'instagram';
    else if (/(?:^|\.)threads\.(com|net)$/.test(host)) provider = 'threads';
    else if (/^\/notes\/[a-z0-9]+\/?$/i.test(url.pathname)) provider = 'misskey';
    else provider = 'direct';
    if (!config.content.providers.includes(provider)) throw new UserError('このサイトのURL変換はサーバー設定で無効になっています。');
    if (provider === 'x') {
      const unknownUser = url.pathname.match(/^\/i\/(?:web\/)?status\/(\d+)\/?$/);
      const match = unknownUser ? ([url.pathname, 'i', unknownUser[1]!] as unknown as RegExpMatchArray)
        : url.pathname.match(/^\/([\w]+)\/status\/(\d+)(?:\/[^/?]*)?\/?$/);
      if (!match) throw new UserError('Xの投稿URLを入力してください。');
      source = `https://x.com/${match[1]}/status/${match[2]}`;
      for (const api of ['api.fxtwitter.com', 'api.fixupx.com']) {
        try {
          const data = xResponse.parse(await this.http.json(`https://${api}/status/${match[2]}`));
          media = (data.tweet?.media?.all ?? []).map(item => ({ url: item.url, kind: item.type === 'photo' ? 'image' : item.type === 'gif' ? 'animation' : 'video' }));
          const handle = [data.tweet?.author?.screen_name, data.tweet?.author?.username].find(value => /^@?[\w]{1,20}$/.test(value ?? ''));
          if (handle) source = `https://x.com/${handle.replace(/^@/, '')}/status/${match[2]}`;
          if (media.length) break;
        } catch {}
      }
    } else if (provider === 'pixiv') {
      const id = url.pathname.match(/^\/(?:en\/)?artworks\/(\d+)\/?$/)?.[1] ?? (url.pathname === '/member_illust.php' ? new URLSearchParams(url.search).get('illust_id') : null);
      if (!id || !/^\d+$/.test(id)) throw new UserError('Pixivの作品URLを入力してください。');
      source = `https://www.pixiv.net/artworks/${id}`;
      const data = pixivResponse.parse(await this.http.json(`https://www.pixiv.net/ajax/illust/${id}/pages?lang=ja`));
      if (data.error) throw new UserError('公開作品の画像を取得できませんでした。画像を直接添付してください。');
      media = (data.body ?? []).map(item => ({ url: item.urls.original, kind: 'image', headers: { Referer: source } }));
    } else if (provider === 'bluesky') {
      const match = url.pathname.match(/^\/profile\/([^/]+)\/post\/([^/]+)\/?$/);
      if (!match) throw new UserError('Blueskyの投稿URLを入力してください。');
      source = canonical(url);
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
      source = canonical(url);
      media = data.media_attachments.filter(item => item.url || item.remote_url).map(item => ({
        url: (item.url ?? item.remote_url)!, kind: mediaKind((item.url ?? item.remote_url)!, item.type === 'gifv' ? 'gifv' : item.type),
      }));
    } else if (provider === 'misskey') {
      const id = url.pathname.match(/^\/notes\/([a-z0-9]+)\/?$/i)![1]!;
      source = `https://${host}/notes/${id}`;
      const data = misskeyResponse.parse(await this.http.postJson(`https://${host}/api/notes/show`, { noteId: id }));
      if (!['public', 'home'].includes(data.visibility)) throw new UserError('公開された投稿のURLを入力してください。');
      media = (data.files ?? []).map(file => ({ url: file.url, kind: mediaKind(file.url, file.type) }));
    } else if (provider === 'tiktok' || provider === 'instagram' || provider === 'threads') {
      const data = atmoResponse.parse(await this.http.json(`https://api.atmosphere.tools/2/${provider}/status/${encodeURIComponent(value.trim())}`));
      const post = data.status;
      if (!post) throw new UserError(`${providerNames[provider]}の公開投稿を取得できませんでした。非公開か、URLを確認してください。`);
      source = post.url ?? canonical(url);
      media = (post.media?.all ?? []).map(item => ({ url: item.url, kind: mediaKind(item.url, item.type) }));
    } else media = [{ url: source, kind: 'image' }];
    if (!media.length) throw new UserError('画像を取得できませんでした。画像のある公開投稿か、画像ファイルのURLを指定してください。');
    if (media.length > 10) warnings.push('Discordの上限により、最初の10個のファイルを添付します。');
    return { provider, source, media: media.slice(0, 10), warnings };
  }
  async fromUrl(value: string, config: Config): Promise<{ files: MediaFile[]; source: string; warnings: string[]; videoLinks: string[] }> {
    return this.queue.run(async () => {
      const resolved = await this.resolve(value, config);
      const files: MediaFile[] = [];
      const videoLinks: string[] = [];
      const warnings = [...resolved.warnings];
      for (const [sourceIndex,item] of resolved.media.entries()) {
        if (resolved.provider === 'x' && isTwimgVideo(item.url)) { videoLinks.push(videoProxyUrl(item.url)); continue; }
        try {
          const response = await this.http.get(item.url, DISCORD_FILE_LIMIT, item.headers);
          const original = fileNameFromUrl(item.url);
          const name = original && original !== 'proxy' ? original : undefined;
          files.push(await this.optimize(response.data, config, files.length, name, response.contentType));
        } catch (error) {
          if (error instanceof UserError && error.message.includes('大きすぎ')) warnings.push(`元のファイル${sourceIndex + 1}は大きすぎて添付できませんでした。`);
          else warnings.push(`元のファイル${sourceIndex + 1}を取得できませんでした。取得できたファイルだけを表示しています。`);
        }
      }
      if (!files.length && !videoLinks.length) throw new UserError('ファイルを取得できませんでした。直接添付してお試しください。');
      return { files, source: resolved.source, warnings, videoLinks };
    });
  }
}
