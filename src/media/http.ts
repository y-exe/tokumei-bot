import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { UserError } from '../domain/errors.js';

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0));
  }
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    return /^[23][0-9a-f]{3}:/.test(value) && !value.startsWith('2001:db8:') &&
      !value.startsWith('2001:0:') && !value.startsWith('2002:');
  }
  return false;
}

export interface HttpResult { data: Buffer; contentType: string; url: string; }
export class SafeHttp {
  async get(value: string, maxBytes: number, headers: Record<string, string> = {}, redirects = 0): Promise<HttpResult> {
    let url: URL;
    try { url = new URL(value); } catch { throw new UserError('URLの形式を確認してください。'); }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443'))
      throw new UserError('取得できるのは認証情報を含まないHTTPSのURLです。');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] :
      await Promise.race([lookup(host, { all: true }), new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new UserError('接続先の確認がタイムアウトしました。')), 5000); timer.unref();
      })]);
    if (!addresses.length || addresses.some(item => !isPublicAddress(item.address)))
      throw new UserError('このURLの接続先は許可されていません。');
    const pinned = addresses[0]!;
    const result = await new Promise<HttpResult | { redirect: string }>((resolve, reject) => {
      const req = request(url, {
        headers: { 'User-Agent': 'TokumeiBot/2.0', ...headers },
        lookup: (_hostname, options, callback) => {
          if (typeof options === 'object' && options.all) (callback as unknown as (error: null, values: typeof addresses) => void)(null, [pinned]);
          else callback(null, pinned.address, pinned.family);
        },
      }, response => {
        if (response.statusCode && [301, 302, 303, 307, 308].includes(response.statusCode)) {
          response.resume();
          if (!response.headers.location || redirects >= 3) { reject(new UserError('URLの転送が多すぎるため取得できません。')); return; }
          resolve({ redirect: new URL(response.headers.location, url).href }); return;
        }
        if (response.statusCode !== 200) {
          response.resume(); reject(new UserError('画像を取得できませんでした。公開状態を確認するか、画像を直接添付してください。')); return;
        }
        const size = Number(response.headers['content-length'] ?? 0);
        if (size > maxBytes) { response.destroy(); reject(new UserError('取得するファイルのサイズが大きすぎます。')); return; }
        const parts: Buffer[] = []; let received = 0;
        response.on('data', (part: Buffer) => {
          received += part.length;
          if (received > maxBytes) { response.destroy(); reject(new UserError('取得するファイルのサイズが大きすぎます。')); }
          else parts.push(part);
        });
        response.on('end', () => resolve({ data: Buffer.concat(parts), contentType: String(response.headers['content-type'] ?? ''), url: url.href }));
        response.on('error', reject);
      });
      const timer = setTimeout(() => req.destroy(new UserError('画像の取得がタイムアウトしました。直接添付でも投稿できます。')), 15_000);
      req.on('close', () => clearTimeout(timer));
      req.on('error', reject); req.end();
    });
    if ('redirect' in result) {
      const forwarded = new URL(result.redirect).hostname === url.hostname ? headers : {};
      return this.get(result.redirect, maxBytes, forwarded, redirects + 1);
    }
    return result;
  }
  async json<T = unknown>(url: string): Promise<T> {
    const result = await this.get(url, 2 * 1024 * 1024);
    try { return JSON.parse(result.data.toString('utf8')); }
    catch { throw new UserError('取得先から画像情報を読み取れませんでした。画像を直接添付してください。'); }
  }
}

export class WorkQueue {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private concurrency = 2, private maxWaiting = 10) {}
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      if (this.waiting.length >= this.maxWaiting) throw new UserError('画像処理が混み合っています。少し待ってからお試しください。');
      await new Promise<void>(resolve => this.waiting.push(resolve));
    } else this.active++;
    try { return await task(); }
    finally { const next = this.waiting.shift(); if (next) next(); else this.active--; }
  }
}
