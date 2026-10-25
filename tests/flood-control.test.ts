import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { floodDecision, type FloodState, type FloodEvent } from '../src/domain/flood-control.js';
import { configSchema, defaults, resolveConfig, overridesSchema } from '../src/domain/config.js';
import { SecretBox } from '../src/infra/secrets.js';
import { Store } from '../src/infra/store.js';
import { Posting } from '../src/services/posting.js';
import { FloodControlError } from '../src/domain/errors.js';
import { editorModal, limitsView } from '../src/ui/editor.js';

const policy = { ...defaults.policy, cooldown: 0 };
const empty = (): FloodState => ({ events: [], blockedUntil: 0 });
const event = (id: string, chars = 1, channelId = 'channel'): Omit<FloodEvent, 'at'> => ({ operationId: id, hash: id, chars, channelId });

test('60秒で5件を許可し、別チャンネルの6件目も拒否し、60秒境界で回復する', () => {
  let state = empty();
  for (let i = 0; i < 5; i++) {
    const result = floodDecision(state, event(String(i), 1, `channel${i}`), policy, i * 1000, true);
    assert.equal(result.denied, false); state = result.state;
  }
  assert.equal(floodDecision(state, event('six'), policy, 5000, true).denied, true);
  assert.equal(floodDecision(state, event('six'), policy, 60000, true).denied, false);
  assert.equal(state.blockedUntil, 0);
});

test('60秒で3000文字ちょうどは許可し、超過後10分は短文も拒否し期限を延長しない', () => {
  let state = floodDecision(empty(), event('first', 1500), policy, 0, true).state;
  state = floodDecision(state, event('second', 1500), policy, 1000, true).state;
  const blocked = floodDecision(state, event('third', 1), policy, 2000, false);
  assert.equal(blocked.denied, true); assert.equal(blocked.state.blockedUntil, 602000);
  assert.equal(blocked.state.events.length, 0);
  const again = floodDecision(blocked.state, event('retry'), policy, 601999, true);
  assert.equal(again.denied, true); assert.equal(again.state.blockedUntil, 602000);
  assert.equal(floodDecision(again.state, event('retry'), policy, 602000, true).denied, false);
});

test('60秒上限に届かなくても300秒で9000文字を超えた時点で10分制限する', () => {
  let state = empty();
  const rules = { ...policy, postsPerMinute: 0 };
  for (let i = 0; i < 9; i++) {
    const result = floodDecision(state, event(String(i), 1000), rules, i * 31000, true);
    assert.equal(result.denied, false); state = result.state;
  }
  const result = floodDecision(state, event('tenth', 1000), rules, 279000, true);
  assert.equal(result.denied, true); assert.equal(result.state.blockedUntil, 879000);
});

test('同一本文は別チャンネルでも5分拒否し、空の説明文では画像連投の重複扱いをしない', () => {
  const state = floodDecision(empty(), event('original'), policy, 0, true).state;
  assert.equal(floodDecision(state, { ...event('repeat', 1, 'other'), hash: 'original' }, policy, 299999, true).denied, true);
  assert.equal(floodDecision(state, { ...event('repeat'), hash: 'original' }, policy, 300000, true).denied, false);
  const blank = floodDecision(empty(), { ...event('image1', 0), hash: '' }, policy, 0, true).state;
  assert.equal(floodDecision(blank, { ...event('image2', 0), hash: '' }, policy, 1, true).denied, false);
});

test('事前確認は件数を消費せず、同一操作は二重集計せず、最短間隔だけ残り秒を返す', () => {
  const rules = { ...policy, cooldown: 5 };
  assert.equal(floodDecision(empty(), event('a'), rules, 0, false).state.events.length, 0);
  const state = floodDecision(empty(), event('a'), rules, 0, true).state;
  const retry = floodDecision(state, event('a'), rules, 1000, true);
  assert.equal(retry.denied, false); assert.equal(retry.state.events.length, 1);
  assert.equal(floodDecision(state, event('b'), rules, 1000, true).cooldown, 4);
  assert.equal(floodDecision(state, event('b'), rules, 5000, true).denied, false);
});

test('設定の旧形式に初期値を補い、部分上書き・無効化・入力範囲を維持する', () => {
  const old = structuredClone(defaults) as any;
  for (const name of ['postsPerMinute', 'charsPerMinute', 'charsPerFiveMinutes', 'spamTimeoutMinutes', 'duplicateSeconds']) delete old.policy[name];
  assert.equal(configSchema.parse(old).policy.postsPerMinute, 5);
  assert.deepEqual(overridesSchema.parse({ policy: { cooldown: 8 } }), { policy: { cooldown: 8 } });
  assert.equal(resolveConfig(defaults, { policy: { charsPerMinute: 0 } }).policy.charsPerFiveMinutes, 9000);
  assert.throws(() => resolveConfig(defaults, { policy: { spamTimeoutMinutes: 0 } }));
  assert.throws(() => resolveConfig(defaults, { policy: { postsPerMinute: -1 } }));
  const disabled = { ...policy, postsPerMinute: 0, charsPerMinute: 0, charsPerFiveMinutes: 0, duplicateSeconds: 0 };
  let state = empty();
  for (let i = 0; i < 10; i++) { const result = floodDecision(state, { ...event(String(i), 10000), hash: 'same' }, disabled, i, true); assert.equal(result.denied, false); state = result.state; }
  const modal = editorModal('test', 'spam', defaults).toJSON();
  assert.equal(modal.components?.length, 5); assert.ok(JSON.stringify(limitsView('test')).includes('連投対策'));
});

let db: PGlite; let server: PGLiteSocketServer; let store: Store;
before(async () => {
  db = await PGlite.create(); server = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1', maxConnections: 5 });
  await server.start(); store = new Store(`postgresql://postgres:postgres@${server.getServerConn()}/postgres`); await store.initialize();
});
after(async () => { await store.close(); await server.stop(); await db.close(); });

test('同時投稿を排他制御して上限を守り、文字数制限の拒否もDBに確定する', async () => {
  const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => store.checkFlood('concurrent', event(String(i)), policy, true)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 5);
  const rejection = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.ok(rejection.reason instanceof FloodControlError); assert.equal(rejection.reason.message, '現在、利用が制限されています。');
  await store.checkFlood('timeout', event('first', 3000), policy, true);
  await assert.rejects(store.checkFlood('timeout', event('second'), policy, true), FloodControlError);
  await assert.rejects(store.checkFlood('timeout', event('third'), policy), FloodControlError);
  const state = (await store.pool.query("SELECT state FROM v2_flood_control WHERE subject='timeout'")).rows[0].state;
  assert.ok(state.blockedUntil > Date.now()); assert.equal(state.events.length, 0);
});

test('保存なしでもHMACだけで再起動後の照合ができ、別利用者・別サーバーと分離する', async () => {
  const box = new SecretBox(randomBytes(32).toString('base64'));
  const input = { guildId: 'private-guild', channelId: 'private-channel', userId: 'private-user', operationId: 'operation-one', text: '保存しない本文' };
  const config = structuredClone(defaults); config.policy.cooldown = 0; config.policy.retentionDays = 0;
  await new Posting(store, box).preflight(input, config, true);
  await assert.rejects(new Posting(store, box).preflight({ ...input, operationId: 'operation-two' }, config), FloodControlError);
  await new Posting(store, box).preflight({ ...input, userId: 'another-user' }, config);
  await new Posting(store, box).preflight({ ...input, guildId: 'another-guild' }, config);
  const row = (await store.pool.query('SELECT * FROM v2_flood_control WHERE subject=$1', [box.fingerprint('user', input.guildId, input.userId)])).rows[0];
  for (const secret of Object.values(input)) assert.ok(!JSON.stringify(row).includes(secret));
  assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM v2_authors')).rows[0].n, 0);
  assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM v2_posts')).rows[0].n, 0);
  assert.notEqual(box.fingerprint('user', input.guildId, input.userId), new SecretBox(randomBytes(32).toString('base64')).fingerprint('user', input.guildId, input.userId));
  await store.pool.query('UPDATE v2_flood_control SET expires_at=now()-interval \'1 second\' WHERE subject=$1', [row.subject]);
  await store.cleanup(); assert.equal((await store.pool.query('SELECT 1 FROM v2_flood_control WHERE subject=$1', [row.subject])).rowCount, 0);
});
