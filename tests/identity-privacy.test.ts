import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { Store } from '../src/infra/store.js';
import { SecretBox } from '../src/infra/secrets.js';
import { defaults } from '../src/domain/config.js';
import { applyLegacy, planLegacy } from '../src/migration/legacy.js';

let db: PGlite; let server: PGLiteSocketServer; let store: Store; let url: string;
const box = new SecretBox(randomBytes(32).toString('base64'));
const guild = '100000000000000123', channel = '200000000000000123', user = '300000000000000123', reporter = '400000000000000123', actor = '500000000000000123';
const config = { ...structuredClone(defaults), policy: { ...defaults.policy, cooldown: 0 } };
const input = (id: string) => ({ operationId: id, guildId: guild, channelId: channel, userId: user, text: '保存する本文' });
before(async () => {
  db = await PGlite.create(); server = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1', maxConnections: 5 }); await server.start();
  url = `postgresql://postgres:postgres@${server.getServerConn()}/postgres`;
  const old = new Store(url); await old.initialize();
  await old.saveSettings(await old.settings(guild, channel, true), 'guild', config, actor);
  await old.saveSettings(await old.settings(guild, channel, true), 'channel', {}, actor);
  await old.reserve(input('legacy'), config); await old.markSent('legacy', '600000000000000123', []);
  await old.addReport((await old.post(guild, channel, '600000000000000123'))!, reporter, '通報', null);
  await old.pool.query("INSERT INTO v2_restrictions VALUES($1,'restricted-user',now()+interval '1 day','制限')", [guild]);
  await old.pool.query("INSERT INTO v2_request_restrictions(guild_id,user_id,reason) VALUES($1,'revoked-user','制限')", [guild]);
  await old.pool.query("INSERT INTO v2_actions(guild_id,actor_id,action) VALUES($1,$2,'resolve')", [guild, actor]);
  await old.pool.query('CREATE TABLE unrelated_history(user_id text)'); await old.pool.query('INSERT INTO unrelated_history VALUES($1)', [user]);
  await old.pool.query("INSERT INTO v2_legacy_lookup_denials VALUES('600000000000009999')");
  await old.close(); store = new Store(url, box); await store.initialize();
});
after(async () => { await store.close(); await server.stop(); await db.close(); });

test('既存の投稿・通報・利用停止を失わずIDを保護し、他プロジェクトのテーブルは変更しない', async () => {
  const raw = (await store.pool.query(`SELECT a.user_id,a.user_ciphertext,s.user_id AS session_user,c.last_user,
    r.reporter_id,r.reporter_ciphertext,r.evidence FROM v2_authors a JOIN v2_posts p USING(operation_id)
    JOIN v2_sessions s ON s.channel_id=p.channel_id JOIN v2_counters c ON c.channel_id=p.channel_id
    JOIN v2_reports r ON r.message_id=p.message_id WHERE p.operation_id='legacy'`)).rows[0];
  assert.match(raw.user_id, /^h1:[a-f0-9]{64}$/); assert.equal(raw.session_user, raw.user_id); assert.equal(raw.last_user, raw.user_id);
  assert.ok(!Object.hasOwn(raw.evidence, 'userId')); assert.ok(raw.evidence.userCiphertext);
  for (const id of [user, reporter, actor]) assert.ok(!JSON.stringify(raw).includes(id));
  const detail = await store.reportDetail(guild, channel, '600000000000000123');
  assert.equal(detail!.userId, user); assert.deepEqual(detail!.reporters, [reporter]);
  assert.deepEqual(await store.lookupAuthor('600000000000000123'), { user_id: user, guild_id: guild, channel_id: channel });
  assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM v2_posts')).rows[0].n, 1);
  assert.equal((await store.pool.query('SELECT user_id FROM unrelated_history')).rows[0].user_id, user);
  assert.equal((await store.pool.query('SELECT message_key FROM v2_legacy_lookup_denials')).rows[0].message_key, store.identityKey('legacy-lookup-message', '600000000000009999'));
  await assert.rejects(store.checkRestrictions(guild, 'restricted-user', false), /利用が制限/);
  await assert.rejects(store.checkRestrictions(guild, 'revoked-user', true), /使用権/);
  for (const table of ['v2_actions', 'v2_revisions']) {
    const rows = (await store.pool.query(`SELECT actor_id FROM ${table}`)).rows;
    assert.ok(rows.every(row => /^h1:[a-f0-9]{64}$/.test(row.actor_id)));
  }
});

test('新規投稿の本人照合・通報者照合・利用停止も平文IDをDB保存せず動作する', async () => {
  await store.reserve(input('protected-new'), config); await store.markSent('protected-new', '600000000000000124', []);
  assert.equal((await store.post(guild, channel, '600000000000000124'))!.user_id, user);
  assert.equal((await store.ownPosts(guild, channel, user)).length, 2);
  assert.equal((await store.ownPosts(guild, channel, reporter)).length, 0);
  assert.ok(await store.ownOperation(guild, channel, user, 'protected-new'));
  await store.addReport((await store.post(guild, channel, '600000000000000124'))!, reporter, '通報', null);
  await assert.rejects(store.addReport((await store.post(guild, channel, '600000000000000124'))!, reporter, '重複', null), /すでに通報/);
  const row = (await store.pool.query("SELECT reporter_id,reporter_ciphertext,evidence FROM v2_reports WHERE message_id='600000000000000124'")).rows[0];
  assert.ok(!JSON.stringify(row).includes(user)); assert.ok(!JSON.stringify(row).includes(reporter));
  await store.restrict(guild, '600000000000000124', actor, 24);
  await assert.rejects(store.checkRestrictions(guild, user, false), /利用が制限/);
  await assert.rejects(store.reserve(input('restricted'), config), /利用が制限/);
});

test('同じ鍵で再起動しても照会でき、鍵の相違は情報を書き換える前に検出する', async () => {
  const before = (await store.pool.query("SELECT user_id,user_ciphertext FROM v2_authors WHERE operation_id='legacy'")).rows[0];
  await store.initialize();
  assert.deepEqual((await store.pool.query("SELECT user_id,user_ciphertext FROM v2_authors WHERE operation_id='legacy'")).rows[0], before);
  const wrong = new Store(url, new SecretBox(randomBytes(32).toString('base64')));
  try { await assert.rejects(wrong.initialize(), /暗号鍵が一致しません/); } finally { await wrong.close(); }
  assert.deepEqual(await store.lookupAuthor('600000000000000123'), { user_id: user, guild_id: guild, channel_id: channel });
});

test('旧形式からの追加移行も保護形式で保存し、保存0の照会禁止を維持する', async () => {
  const g = '100000000000000999', c = '200000000000000999', u = '300000000000000999', m = '600000000000000999';
  const plan = planLegacy({ channels: { [c]: { webhook_url: `https://discord.com/api/webhooks/700000000000000999/${'a'.repeat(68)}` } },
    messages: { [m]: { channel_id: c, user_id: u, timestamp: new Date().toISOString(), content: '旧本文', anonymous_id: 1 } } }, { channels: { [c]: g } });
  await applyLegacy(store, box, plan);
  const author = (await store.pool.query('SELECT user_id,user_ciphertext FROM v2_authors WHERE operation_id=$1', [`legacy:${m}`])).rows[0];
  assert.match(author.user_id, /^h1:/); assert.ok(!JSON.stringify(author).includes(u));
  assert.equal((await store.lookupAuthor(m))!.user_id, u);
  await store.saveSettings(await store.settings(g, c, true), 'channel', { policy: { retentionDays: 0 } }, actor);
  assert.equal(await store.lookupAuthor(m), null);
});
