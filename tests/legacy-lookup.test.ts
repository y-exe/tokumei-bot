import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { Store } from '../src/infra/store.js';
import { SecretBox } from '../src/infra/secrets.js';

let db: PGlite; let server: PGLiteSocketServer; let store: Store;
const guild = '100000000000000321', channel = '200000000000000321', user = '300000000000000321';
const id = (n: number) => String(600000000000000000n + BigInt(n));
before(async () => {
  db = await PGlite.create(); server = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1', maxConnections: 5 }); await server.start();
  store = new Store(`postgresql://postgres:postgres@${server.getServerConn()}/postgres`, new SecretBox(randomBytes(32).toString('base64'))); await store.initialize();
  await store.pool.query('CREATE TABLE anonymous_messages(message_id text PRIMARY KEY,user_id text,channel_id text,timestamp timestamptz)');
  await store.pool.query('CREATE TABLE messages(message_id bigint PRIMARY KEY,channel_id bigint,created_at timestamptz)');
  await store.saveSettings(await store.settings(guild, channel, true), 'channel', { policy: { retentionDays: null, cooldown: 0 } }, user);
});
after(async () => { await store.close(); await server.stop(); await db.close(); });
async function legacy(n: number, sourceChannel: string | null, metadataChannel: string | null, ageDays = 300) {
  await store.pool.query("INSERT INTO anonymous_messages VALUES($1,$2,$3,now()-$4*interval '1 day')", [id(n), user, sourceChannel, ageDays]);
  if (metadataChannel) await store.pool.query("INSERT INTO messages VALUES($1,$2,now()-$3*interval '1 day')", [id(n), metadataChannel, ageDays]);
}

test('旧ログの投稿先を照合して古い投稿を検索でき、原本を一切書き換えない', async () => {
  await legacy(1, null, channel); await legacy(2, channel, null);
  const before = (await store.pool.query('SELECT * FROM anonymous_messages ORDER BY message_id')).rows;
  for (const n of [1, 2]) assert.deepEqual(await store.lookupAuthor(id(n)), { user_id: user, guild_id: guild, channel_id: channel });
  assert.deepEqual((await store.pool.query('SELECT * FROM anonymous_messages ORDER BY message_id')).rows, before);
  assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM v2_posts')).rows[0].n, 0);
  await legacy(3, null, null); await legacy(4, null, '200000000000000999');
  assert.equal(await store.lookupAuthor(id(3)), null); assert.equal(await store.lookupAuthor(id(4)), null);
  assert.equal(await store.lookupAuthor('99999999999999999999'), null);
});

test('保存0へ切り替えた旧ログは、無期限へ戻しても再開示せず新規投稿だけ照会できる', async () => {
  const target = '200000000000000322';
  await store.saveSettings(await store.settings(guild, target, true), 'channel', { policy: { retentionDays: null, cooldown: 0 } }, user);
  await legacy(5, null, target); assert.ok(await store.lookupAuthor(id(5)));
  await store.saveSettings(await store.settings(guild, target, true), 'channel', { policy: { retentionDays: 0, cooldown: 0 } }, user);
  assert.equal(await store.lookupAuthor(id(5)), null);
  await store.saveSettings(await store.settings(guild, target, true), 'channel', { policy: { retentionDays: null, cooldown: 0 } }, user);
  assert.equal(await store.lookupAuthor(id(5)), null);
  await store.reserve({ operationId: 'after-zero', guildId: guild, channelId: target, userId: user, text: '新規投稿' }, (await store.settings(guild, target, true)).config);
  await store.markSent('after-zero', id(6), []); assert.equal((await store.lookupAuthor(id(6)))!.user_id, user);
});

test('旧ログにも現在の保存期限を適用し、日時が欠けていても収集日時から確認する', async () => {
  const target = '200000000000000323';
  await store.saveSettings(await store.settings(guild, target, true), 'channel', { policy: { retentionDays: 1 } }, user);
  await legacy(7, target, null, 2); await legacy(8, null, target, 0);
  await store.pool.query('UPDATE anonymous_messages SET timestamp=NULL WHERE message_id=$1', [id(8)]);
  assert.equal(await store.lookupAuthor(id(7)), null); assert.ok(await store.lookupAuthor(id(8)));
  await legacy(9, target, null); await store.pool.query('UPDATE anonymous_messages SET timestamp=NULL WHERE message_id=$1', [id(9)]);
  assert.equal(await store.lookupAuthor(id(9)), null);
});

test('v2で削除・期限切れになった投稿は、清掃後や保存期限の変更後も旧ログへ迂回しない', async () => {
  const config = (await store.settings(guild, channel, true)).config;
  for (const n of [10, 11, 12]) {
    await legacy(n, null, channel, 0);
    await store.reserve({ operationId: `blocked-${n}`, guildId: guild, channelId: channel, userId: user, text: '本文' }, config);
    await store.markSent(`blocked-${n}`, id(n), []);
  }
  await store.deletePost(guild, channel, id(10));
  await store.pool.query("UPDATE v2_posts SET expires_at=now()-interval '1 second' WHERE message_id=$1", [id(11)]);
  await store.pool.query("UPDATE v2_authors SET expires_at=now()-interval '1 second' WHERE operation_id='blocked-12'");
  for (const n of [10, 11, 12]) assert.equal(await store.lookupAuthor(id(n)), null);
  await store.cleanup();
  await store.pool.query("DELETE FROM v2_posts WHERE operation_id IN ('blocked-10','blocked-12')");
  for (const n of [10, 11, 12]) assert.equal(await store.lookupAuthor(id(n)), null);
  const markers = (await store.pool.query('SELECT message_key FROM v2_legacy_lookup_denials')).rows;
  assert.equal(markers.length, 3); assert.ok(markers.every(row => /^h1:[a-f0-9]{64}$/.test(row.message_key)));
});
