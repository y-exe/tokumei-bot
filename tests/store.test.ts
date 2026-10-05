import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { Store } from '../src/infra/store.js';
import { defaults, presetOverrides } from '../src/domain/config.js';
import { applyLegacy, planLegacy } from '../src/migration/legacy.js';
import { SecretBox } from '../src/infra/secrets.js';
import { randomBytes } from 'node:crypto';

let db: PGlite; let server: PGLiteSocketServer; let store: Store;
const guild = '100000000000000001'; const channel = '200000000000000001'; const actor = '300000000000000001';
before(async () => {
  db = await PGlite.create(); server = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1', maxConnections: 5 });
  await server.start(); store = new Store(`postgresql://postgres:postgres@${server.getServerConn()}/postgres`); await store.initialize();
});
after(async () => { if (store) await store.close(); if (server) await server.stop(); if (db) await db.close(); });

test('処罰中の追加通報と二重実行を拒否し、要望の永久停止は通常投稿へ影響しない',async()=>{
  const g='moderation-g',c='moderation-c',m='moderation-m';
  await store.settings(g,c,true);const config=structuredClone(defaults);config.policy.cooldown=0;
  await store.reserve({operationId:'moderation-post',guildId:g,channelId:c,userId:'target',text:'本文'},config);await store.markSent('moderation-post',m,[]);
  const post=(await store.post(g,c,m))!;await store.addReport(post,'reporter','理由',null);
  const token=await store.claimReportAction(g,c,m);
  await assert.rejects(store.claimReportAction(g,c,m),/処理中/);
  await assert.rejects(store.addReport(post,'reporter2','追加',null),/処理中/);
  await store.releaseReportAction(g,m,token);
  assert.equal(await store.addReport(post,'reporter2','追加',null),2);
  const second=await store.claimReportAction(g,c,m);await store.finishReportAction(g,m,second,'manager','revoke','理由','target');
  assert.equal(await store.reportDetail(g,c,m),null);
  await assert.rejects(store.addReport(post,'reporter3','追加',null),/対応済み/);
  config.identity.kind='request';await assert.rejects(store.reserve({operationId:'blocked-request',guildId:g,channelId:c,userId:'target',text:'要望'},config),/使用権/);
  config.identity.kind='chat';await assert.doesNotReject(store.reserve({operationId:'allowed-chat',guildId:g,channelId:c,userId:'target',text:'通常投稿'},config));
});

test('Bot管理者のWeb開示でも保存0・期限切れ・削除済みの投稿者は取得できない',async()=>{
  const g='100000000000000077',c='200000000000000077',m='400000000000000077';
  await store.saveSettings(await store.settings(g,c,true),'channel',{policy:{retentionDays:null,cooldown:0}},actor);
  await store.reserve({operationId:'lookup-test',guildId:g,channelId:c,userId:actor,text:'本文'},(await store.settings(g,c,true)).config);await store.markSent('lookup-test',m,[]);
  await store.pool.query("UPDATE v2_guilds SET config=jsonb_set(config,'{policy,retentionDays}','0') WHERE guild_id=$1",[g]);
  assert.deepEqual(await store.lookupAuthor(m),{user_id:actor,guild_id:g,channel_id:c});
  await store.pool.query("UPDATE v2_channels SET overrides=jsonb_set(overrides,'{policy,retentionDays}','0') WHERE channel_id=$1",[c]);assert.equal(await store.lookupAuthor(m),null);
  await store.pool.query("UPDATE v2_channels SET overrides=jsonb_set(overrides,'{policy,retentionDays}','null') WHERE channel_id=$1",[c]);
  await store.pool.query("UPDATE v2_authors SET expires_at=now()-interval '1 second' WHERE operation_id='lookup-test'");assert.equal(await store.lookupAuthor(m),null);
  await store.pool.query("UPDATE v2_authors SET expires_at='infinity' WHERE operation_id='lookup-test'");
  await store.deletePost(g,c,m);assert.equal(await store.lookupAuthor(m),null);
});

test('無期限の投稿と通報は期限削除されず、保存0へ変えると既存の投稿者対応も消える',async()=>{
  const target='200000000000000099';const previous=await store.settings(guild,target,true);
  await store.saveSettings(previous,'channel',{policy:{cooldown:0}},actor);
  const config=(await store.settings(guild,target,true)).config;const input={operationId:'infinite',guildId:guild,channelId:target,userId:actor,text:'本文'};
  await store.reserve(input,config);await store.markSent(input.operationId,'600000000000000099',[]);
  const post=(await store.post(guild,target,'600000000000000099'))!;await store.addReport(post,actor,'通報',null);
  assert.equal((await store.pool.query("SELECT expires_at='infinity'::timestamptz AS infinite FROM v2_posts WHERE operation_id=$1",[input.operationId])).rows[0].infinite,true);
  await store.cleanup();assert.ok(await store.post(guild,target,'600000000000000099'));
  await store.saveSettings(await store.settings(guild,target,true),'channel',{policy:{retentionDays:0,reportRetentionDays:0}},actor);
  for(const table of ['v2_posts','v2_sessions','v2_reports'])assert.equal((await store.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE channel_id=$1`,[target])).rows[0].n,0);
  assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM v2_authors WHERE operation_id=$1',[input.operationId])).rows[0].n,0);
  assert.equal((await store.pool.query('SELECT last_user FROM v2_counters WHERE channel_id=$1',[target])).rows[0].last_user,null);
  await assert.rejects(store.reserve({...input,operationId:'disabled'},(await store.settings(guild,target,true)).config),/保存しない/);
  await assert.rejects(store.reserve({...input,operationId:'stale-settings'},defaults),/保存しない/);
});

test('DB設定はサーバーで分離し、同時編集を拒否し、設定キャッシュを更新する', async () => {
  const original = await store.settings(guild, channel);
  await store.saveSettings(original, 'channel', presetOverrides('image'), actor);
  const changed = await store.settings(guild, channel);
  assert.equal(changed.config.content.text, false); assert.equal(changed.channelVersion, 1);
  await assert.rejects(store.saveSettings(original, 'channel', {}, actor), /更新されました/);
  assert.equal((await store.settings('100000000000000002', '200000000000000002')).config.content.text, true);
  assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM v2_revisions WHERE channel_id=$1',[channel])).rows[0].n, 1);
});
test('匿名IDは連続投稿で維持し、別ユーザーの投稿で切り替え、二重送信とクールダウンを拒否する', async () => {
  const config = structuredClone(defaults); config.policy.cooldown = 0;
  const input = { operationId: 'op1', guildId: guild, channelId: channel, userId: actor, text: 'first' };
  const first = await store.reserve(input, config); assert.equal(first.anonymous_id, 1);
  const second = await store.reserve({ ...input, operationId: 'op2' }, config); assert.equal(second.anonymous_id, 1);
  const third = await store.reserve({ ...input, operationId: 'op3', userId: 'other' }, config); assert.equal(third.anonymous_id, 2);
  const fourth = await store.reserve({ ...input, operationId: 'op4' }, config); assert.equal(fourth.anonymous_id, 3);
  assert.equal(second.avatar, first.avatar);
  assert.notEqual(third.avatar, second.avatar);
  assert.notEqual(fourth.avatar, third.avatar);
  await assert.rejects(store.reserve(input, config), /処理中/);
  await assert.rejects(store.reserve({ ...input, operationId: 'op5' }, defaults), /連続投稿/);
  await store.markSent('op1', '400000000000000001', []);
  await assert.rejects(store.reserve(input, config), /送信済み/);
});
test('匿名セッションの期限後とID一周後も直前のアイコン色を除外する', async () => {
  const target = '200000000000000088';
  const config = structuredClone(defaults); config.policy.cooldown = 0;
  const input = { operationId: 'avatar-first', guildId: guild, channelId: target, userId: actor, text: '' };
  const first = await store.reserve(input, config);
  await store.pool.query('DELETE FROM v2_sessions WHERE channel_id=$1', [target]);
  await store.pool.query('UPDATE v2_counters SET counter=1000,last_avatar=NULL WHERE channel_id=$1', [target]);
  const second = await store.reserve({ ...input, operationId: 'avatar-reset' }, config);
  assert.equal(second.anonymous_id, 1); assert.notEqual(second.avatar, first.avatar);
});
test('本人対応と投稿の取得はサーバー・チャンネルを検査し、利用停止を他サーバーへ波及させない', async () => {
  const message = '400000000000000001';
  const post = await store.post(guild, channel, message); assert.equal(post?.user_id, actor);
  assert.equal(await store.post('other', channel, message), null); assert.equal(await store.post(guild, 'other', message), null);
  assert.equal((await store.ownPosts(guild, channel, actor)).length, 1);
  assert.equal(await store.addReport(post!, 'reporter', '問題のある内容', 30), 1);
  await assert.rejects(store.addReport(post!, 'reporter', '重複通報', 30), /すでに通報/);
  await store.restrict(guild, message, actor, 24);
  const input = { operationId: 'blocked', guildId: guild, channelId: channel, userId: actor, text: 'post' };
  await assert.rejects(store.reserve(input, defaults), /利用が制限/);
  assert.ok(await store.reserve({ ...input, operationId: 'allowed-other-guild', guildId: 'other', channelId: 'other-channel' }, defaults));
});
test('削除後も通報証拠は保持し、期限を過ぎた対応・本文・通報証拠を実際に消す', async () => {
  await store.deletePost(guild, channel, '400000000000000001');
  assert.equal(await store.post(guild, channel, '400000000000000001'), null);
  const evidence = (await store.pool.query('SELECT evidence FROM v2_reports WHERE guild_id=$1 AND message_id=$2',[guild,'400000000000000001'])).rows[0].evidence;
  assert.equal(evidence.content, 'first');
  await store.pool.query("UPDATE v2_posts SET expires_at=now()-interval '1 day'");
  await store.pool.query("UPDATE v2_reports SET expires_at=now()-interval '1 day'");
  await store.cleanup();
  assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM v2_posts')).rows[0].n, 0);
  assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM v2_authors')).rows[0].n, 0);
  assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM v2_reports')).rows[0].n, 0);
});
test('移行適用は受付を有効にせず、旧Webhookを暗号化し、再実行してもデータを重複させない', async () => {
  const guildId = '100000000000000030'; const channelId = '200000000000000030'; const userId = '300000000000000030'; const messageId = '400000000000000030';
  const webhook = 'https://discord.com/api/webhooks/500000000000000030/testtoken'; const now = new Date();
  const plan = planLegacy({ channels: { [channelId]: { webhook_url: webhook } }, messages: { [messageId]: { channel_id: channelId, user_id: userId, timestamp: now, content: '旧投稿', anonymous_id: 45 } }, anonymous: { [channelId]: { counter: 45, last_user_id: userId } } }, { channels: { [channelId]: guildId } }, now);
  const box = new SecretBox(randomBytes(32).toString('base64'));
  await applyLegacy(store, box, plan); await applyLegacy(store, box, plan);
  const settings = await store.settings(guildId, channelId); assert.equal(settings.enabled, false); assert.equal(settings.panelId, null);
  assert.equal(box.open(settings.webhook!), webhook);
  const post = await store.post(guildId, channelId, messageId); assert.equal(post?.user_id, userId); assert.equal(post?.layout, 'legacy');
  assert.equal(box.open(post!.legacy_webhook!), webhook);
  assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM v2_posts WHERE message_id=$1', [messageId])).rows[0].n, 1);
  assert.equal((await store.pool.query('SELECT counter FROM v2_counters WHERE channel_id=$1', [channelId])).rows[0].counter, 45);
});
test('移行でサーバー対応が衝突した場合はトランザクション全体を戻す', async () => {
  const existing = '200000000000000030'; const before = (await store.pool.query('SELECT count(*)::int AS n FROM v2_guilds')).rows[0].n;
  const plan = planLegacy({ channels: { [existing]: { webhook_url: 'https://discord.com/api/webhooks/500000000000000030/testtoken' } } }, { channels: { [existing]: '100000000000000099' } });
  await assert.rejects(applyLegacy(store, new SecretBox(randomBytes(32).toString('base64')), plan), /衝突/);
  assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM v2_guilds')).rows[0].n, before);
});

test('通報通知は失敗・再起動後に回復し、古い処理が新しい通知結果を上書きしない', async () => {
  const config = structuredClone(defaults); config.policy.cooldown = 0;
  const g = 'notice-guild'; const c = 'notice-channel'; const m = 'notice-message';
  await store.saveSettings(await store.settings(g, c), 'channel', { moderation: { reportChannel: '900000000000000001', reportThreshold: 1 } }, actor);
  await store.reserve({ operationId: 'notice-op', guildId: g, channelId: c, userId: actor, text: '通報の証拠' }, config);
  await store.markSent('notice-op', m, []);
  const post = (await store.post(g, c, m))!;
  await store.addReport(post, 'reporter-one', '理由', 30);
  const notice = (await store.pendingReportNotices(g, m))[0]!;
  assert.equal(notice.content, '通報の証拠'); assert.equal(notice.count, 1);
  assert.ok(!JSON.stringify(notice).includes('reporter-one'));
  assert.equal(await store.claimReportNotification('wrong-guild', m), null);
  const first = (await store.claimReportNotification(g, m))!; assert.ok(first);
  assert.equal(await store.claimReportNotification(g, m), null);
  assert.equal((await store.pendingReportNotices(g, m)).length, 0);
  await store.reportNotification(g, m, first, null);
  assert.equal((await store.pendingReportNotices(g, m)).length, 0);
  await store.pool.query("UPDATE v2_reports SET notification_retry_at=now()-interval '1 minute' WHERE guild_id=$1", [g]);
  const second = (await store.claimReportNotification(g, m))!;
  assert.ok(second); assert.notEqual(first, second);
  await store.pool.query("UPDATE v2_reports SET notification_retry_at=now()-interval '1 minute' WHERE guild_id=$1", [g]);
  assert.equal((await store.pendingReportNotices(g, m))[0]!.nonce, notice.nonce);
  const third = (await store.claimReportNotification(g, m))!;
  await store.reportNotification(g, m, third, 'discord-notice');
  await store.reportNotification(g, m, second, null);
  assert.equal((await store.pendingReportNotices(g, m)).length, 0);
  assert.equal(await store.claimReportNotification(g, m), null);
  assert.equal((await store.pool.query('SELECT notification_id FROM v2_reports WHERE guild_id=$1', [g])).rows[0].notification_id, 'discord-notice');
});

test('通知対象の20件制限はしきい値未満・通知先未設定の通報を除いて適用する', async () => {
  const g = 'queue-guild'; const c = 'queue-channel';
  await store.saveSettings(await store.settings(g, c), 'guild', { ...structuredClone(defaults), moderation: { ...defaults.moderation, reportChannel: '900000000000000002', reportThreshold: 2 } }, actor);
  await store.pool.query(`INSERT INTO v2_reports(guild_id,channel_id,message_id,reporter_id,reason,evidence,expires_at,created_at)
    SELECT $1,$2,'below-'||i,'reporter','理由','{"content":"未達"}',now()+interval '1 day',now()-interval '1 hour'
    FROM generate_series(1,25) AS i`, [g,c]);
  await store.pool.query(`INSERT INTO v2_reports(guild_id,channel_id,message_id,reporter_id,reason,evidence,expires_at)
    SELECT $1,$2,'ready','reporter-'||i,'理由','{"content":"対象"}',now()+interval '1 day'
    FROM generate_series(1,2) AS i`, [g,c]);
  assert.deepEqual((await store.pendingReportNotices(g)).map(n => n.message_id), ['ready']);
  await store.saveSettings(await store.settings(g, c), 'channel', { moderation: { reportChannel: null } }, actor);
  assert.equal((await store.pendingReportNotices(g)).length, 0);
  await store.saveSettings(await store.settings(g, c), 'channel', { moderation: { reportThreshold: 1 } }, actor);
  assert.equal((await store.pendingReportNotices(g)).length, 20);
});
