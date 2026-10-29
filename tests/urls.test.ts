import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripXSharingParameters } from '../src/domain/urls.js';

test('Xの共有URLは本文・Markdown・複数リンクでもクエリを除去する', () => {
  const base = 'https://x.com/dixy_720/status/2115713637780508732';
  assert.equal(stripXSharingParameters(`${base}?a=private&s=20`), base);
  assert.equal(stripXSharingParameters(`画像 [リンク](${base}?a=private&s=20) と <${base}?s=20&a=private>`), `画像 [リンク](${base}) と <${base}>`);
  assert.equal(stripXSharingParameters(`こちら${base}?a=private。続き`), `こちら${base}。続き`);
  assert.equal(stripXSharingParameters(`${base}?a=one&a=two&s=20&utm_source=share#detail`), `${base}#detail`);
});

test('旧Twitter・モバイル・投稿者省略・画像や動画の個別URLでも除去する', () => {
  for (const host of ['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']) {
    for (const path of ['/example/status/123', '/i/status/123', '/i/web/status/123', '/example/status/123/photo/1', '/example/status/123/video/1']) {
      const base = `https://${host}${path}`;
      assert.equal(stripXSharingParameters(`${base}?a=private&s=20&t=tracking`), base);
    }
  }
});

test('画像配信URL・他サイト・検索やプロフィールの機能用クエリを維持する', () => {
  for (const value of [
    'https://pbs.twimg.com/media/example?format=jpg&name=large',
    'https://video.twimg.com/example.mp4?tag=12',
    'https://example.com/image?a=value&s=20',
    'https://x.com.evil.example/example/status/123?a=value',
    'https://x.com/search?q=example&s=20',
    'https://x.com/example?a=value',
    'https://x.com/example/status/123',
  ]) assert.equal(stripXSharingParameters(value), value);
});
