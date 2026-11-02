const xHosts = new Set(['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);

const trackingKeys = new Set(['fbclid', 'gclid', 'dclid', 'msclkid', 'gbraid', 'wbraid', 'mc_cid', 'mc_eid', 'igshid', 'igsh']);
const signedKeys = new Set(['signature', 'sig', 'token', 'access_token', 'expires', 'policy', 'key-pair-id', 'hmac', 'auth', 'auth_key']);

export function cleanSharedUrls(text: string, enabled = true): string {
  if (!enabled) return text;
  return text.replace(/https?:\/\/[^\s<>\[\]()「」『』。、！？]+/gi, value => {
    let url: URL;
    try { url = new URL(value); } catch { return value; }
    if (url.username || url.password || url.port || !url.search) return value;
    const keys = [...url.searchParams.keys()].map(key => key.toLowerCase());
    if (keys.some(key => signedKeys.has(key) || key.startsWith('x-amz-') || key.startsWith('x-goog-'))) return value;
    const query = value.indexOf('?');
    const fragment = value.indexOf('#', query);
    const isXPost = xHosts.has(url.hostname.toLowerCase()) && /^\/(?:\w+\/status|i\/(?:web\/)?status)\/\d+(?:\/(?:photo|video)\/\d+)?\/?$/.test(url.pathname);
    const original = value.slice(query + 1, fragment < 0 ? undefined : fragment).split('&');
    let retained: string[];
    try {
      retained = isXPost ? [] : original.filter(part => {
        const key = decodeURIComponent(part.split('=',1)[0]!.replace(/\+/g,' ')).toLowerCase();
        return !trackingKeys.has(key) && !/^utm_[a-z0-9_]+$/.test(key);
      });
    } catch { return value; }
    if (retained.length === original.length) return value;
    return value.slice(0, query) + (retained.length ? `?${retained.join('&')}` : '') + (fragment < 0 ? '' : value.slice(fragment));
  });
}
