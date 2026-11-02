import { Parser } from 'htmlparser2';

export interface PageMedia { url: string; kind: 'image' | 'video'; }
export const isHtml = (data: Buffer, contentType: string): boolean =>
  /(?:text\/html|application\/xhtml\+xml)/i.test(contentType) || /^\s*(?:\uFEFF)?\s*(?:<!doctype\s+html|<html\b|<head\b|<body\b|<meta\b)/i.test(data.subarray(0, 1024).toString('utf8'));

export function pageMedia(data: Buffer, base: string): PageMedia[] {
  const images: PageMedia[] = []; const videos: PageMedia[] = []; const seen = new Set<string>();
  const body: { url: string; large: boolean; main: boolean; group: number }[] = [];
  const stack: { name: string; excluded: boolean; main: boolean; group: number; picture?: string }[] = [];
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const excludedNames = /^(?:(?:site|page|post|widget)[_-])?(?:related|recommend\w*|sidebar|avatar|logo|icon|advert\w*|ads?|banner|sponsor\w*|navigation|footer|header)(?:$|[-_])/i;
  let node = 0;
  let inVideo = false;
  const absolute = (value: string | undefined): string | undefined => {
    if (!value || value.length > 4000) return;
    try {
      const url = new URL(value, base);
      if (url.protocol === 'https:' && !url.username && !url.password && !url.port) return url.href;
    } catch {}
  };
  const add = (value: string | undefined, kind: PageMedia['kind']): void => {
    const url = absolute(value);
    if (!url || seen.size >= 30 || seen.has(url)) return;
    seen.add(url); (kind === 'video' ? videos : images).push({ url, kind });
  };
  const srcset = (value = ''): { url: string; width: number } | undefined => {
    let best: { url: string; width: number } | undefined;
    for (const item of value.matchAll(/(?:^|,)\s*(\S+?)\s+(\d+(?:\.\d+)?)(w|x)(?=\s*(?:,|$))/g)) {
      const width = Number(item[2]) * (item[3] === 'x' ? 500 : 1);
      if (!best || width > best.width) best = { url: item[1]!, width };
    }
    return best;
  };
  const parser = new Parser({
    onopentag(name, attrs) {
      const parent = stack.at(-1);
      const identity = `${attrs.id ?? ''} ${attrs.class ?? ''}`;
      const excludedIdentity = !['html','body','main','article'].includes(name) && identity.split(/\s+/).some(token=>excludedNames.test(token));
      const excluded = !!parent?.excluded || ['header', 'footer', 'nav', 'aside'].includes(name) || excludedIdentity;
      const main = !excluded && (['main', 'article'].includes(name) || attrs.role === 'main' || /(?:^|[\s_-])(?:content|article|reader|comic|manga|gallery|pages)(?:$|[\s_-])/i.test(identity) || !!parent?.main);
      const ownGroup = main && !parent?.main;
      const group = ownGroup ? ++node : parent?.group ?? 0;
      if (!voidTags.has(name) && stack.length < 128) stack.push({ name, excluded, main, group });
      if (name === 'meta') {
        const key = (attrs.property ?? attrs.name ?? '').toLowerCase();
        if (/^(?:og:image(?::(?:url|secure_url))?|twitter:image(?::src)?)$/.test(key)) add(attrs.content, 'image');
        if (/^(?:og:video(?::(?:url|secure_url))?|twitter:player:stream)$/.test(key)) add(attrs.content, 'video');
      }
      if (name === 'video') { inVideo = true; add(attrs.src, 'video'); }
      if (name === 'source' && inVideo) add(attrs.src, 'video');
      if (name === 'source' && parent?.name === 'picture') {
        const candidate = srcset(attrs['data-srcset'] || attrs.srcset);
        if (candidate && !parent.picture) parent.picture = candidate.url;
      }
      if (name === 'img' && !excluded && body.length < 200) {
        const candidate = srcset(attrs['data-srcset'] || attrs.srcset);
        const url = absolute(attrs['data-original'] || attrs['data-lazy-src'] || attrs['data-src'] || candidate?.url || parent?.picture || attrs.src);
        if (!url || /\.(?:svg|ico)(?:[?#]|$)/i.test(url)) return;
        const size = (value = '') => /^\d+(?:px)?$/.test(value) ? Number.parseInt(value, 10) : NaN;
        const width = size(attrs.width || attrs['data-width']);
        const height = size(attrs.height || attrs['data-height']);
        const dimensions = Number.isFinite(width) && Number.isFinite(height);
        const large = dimensions && Math.min(width, height) >= 300 && width * height >= 240_000 || (candidate?.width ?? 0) >= 800;
        const small = dimensions && (Math.min(width, height) < 200 || width * height < 120_000);
        const decoration = /(?:^|[\/_-])(?:logo|avatar|icon|banner|placeholder|loading|thumb(?:nail)?)(?:[\/_.-]|$)/i.test(new URL(url).pathname);
        if (!small && (large || main && !decoration)) body.push({ url, large, main, group });
      }
    },
    onclosetag(name) {
      if (name === 'video') inVideo = false;
      const index = stack.findLastIndex(item => item.name === name);
      if (index >= 0) stack.length = index;
    },
  }, { decodeEntities: true });
  parser.end(data.subarray(0, 2 * 1024 * 1024).toString('utf8'));
  const candidates = body;
  const groups = new Map<number, number>();
  for (const item of candidates) groups.set(item.group, (groups.get(item.group) ?? 0) + (item.main ? 2 : 0) + (item.large ? 1 : 0));
  const bestGroup = [...groups].sort((a, b) => b[1] - a[1])[0]?.[0];
  const selected = candidates.filter(item => item.group === bestGroup);
  const result = [...videos, ...(selected.length ? selected.map(item => ({ url: item.url, kind: 'image' as const })) : images)];
  return result.filter((item, index) => result.findIndex(other => other.url === item.url) === index).slice(0, 11);
}

export function videoContentType(data: Buffer): string | undefined {
  if (data.length < 12) return;
  if (data.toString('ascii', 4, 8) === 'ftyp' && !/^(?:avif|avis|mif1|msf1|hei[cfmsx]|hevx)$/.test(data.toString('ascii', 8, 12))) return 'video/mp4';
  if (data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm';
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'AVI ') return 'video/x-msvideo';
  if (data.toString('ascii', 0, 3) === 'FLV') return 'video/x-flv';
  if (data.toString('ascii', 0, 4) === 'OggS') return 'video/ogg';
}
