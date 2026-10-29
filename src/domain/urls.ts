const xHosts = new Set(['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);

export function stripXSharingParameters(text: string): string {
  return text.replace(/https?:\/\/[^\s<>\[\]()「」『』。、！？]+/gi, value => {
    let url: URL;
    try { url = new URL(value); } catch { return value; }
    if (!xHosts.has(url.hostname.toLowerCase()) || url.username || url.password || url.port ||
        !/^\/(?:\w+\/status|i\/(?:web\/)?status)\/\d+(?:\/(?:photo|video)\/\d+)?\/?$/.test(url.pathname) || !url.search) return value;
    const query = value.indexOf('?');
    const fragment = value.indexOf('#', query);
    return value.slice(0, query) + (fragment < 0 ? '' : value.slice(fragment));
  });
}
