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

test('設定バックアップは件数制限なしで全設定を保持し、保存から60日で参照と保存を終了する', async () => {
  const g='100000000000000081', c='200000000000000081';
  await store.saveSettings(await store.settings(g,c),'channel',{panel:{title:'最初の保存'}},actor,'保存先');
  const first=(await store.settingsBackups(g))[0]!;
  assert.equal(first.channelName,'保存先');assert.equal(first.channelId,c);
  assert.equal((await store.settingsBackup(g,c,first.id))?.panel?.title,'最初の保存');
  const base=await store.settings(g,c,true);
  const changed=structuredClone(base.base);changed.panel.description='標準を変更';
  await store.saveSettings(base,'guild',changed,actor);
  assert.notEqual((await store.settingsBackup(g,c,first.id))?.panel?.description,'標準を変更');
  const standard=(await store.settingsBackups(g))[0]!;
  assert.equal((await store.settingsBackup(g,null,standard.id))?.panel?.description,'標準を変更');
  assert.equal(await store.settingsBackup('other',c,first.id),null);
  assert.equal(await store.settingsBackup(g,null,first.id),null);
  assert.equal(await store.settingsBackup(g,'other',first.id),null);
  assert.equal(await store.deleteSettingsBackup('other',c,first.id),false);
  assert.equal(await store.deleteSettingsBackup(g,null,first.id),false);
  await store.pool.query("UPDATE v2_revisions SET created_at=now()-interval '59 days 23 hours' WHERE id=$1",[first.id]);
  assert.ok(await store.settingsBackup(g,c,first.id));
  await store.pool.query("UPDATE v2_revisions SET created_at=now()-interval '60 days' WHERE id=$1",[first.id]);
  assert.equal(await store.settingsBackup(g,c,first.id),null);
  assert.ok(!(await store.settingsBackups(g)).some(item=>item.id===first.id));
  await store.cleanup();assert.equal((await store.pool.query('SELECT 1 FROM v2_revisions WHERE id=$1',[first.id])).rowCount,0);
  await store.pool.query('INSERT INTO v2_revisions(guild_id,channel_id,config,actor_id) VALUES($1,$2,$3,$4)',[g,c,{panel:{title:'移行前の履歴'}},actor]);
  const legacy=(await store.settingsBackups(g))[0]!;
  assert.equal((await store.settingsBackup(g,c,legacy.id))?.panel?.title,'移行前の履歴');
  for(let n=0;n<25;n++)await store.saveSettings(await store.settings(g,c,true),'channel',{panel:{title:`保存${n}`}},actor,'保存先');
  const page=await store.settingsBackups(g);
  assert.equal(page.length,26);
  const next=await store.settingsBackups(g,undefined,page[24]!.id);
  assert.equal(next.length,2);
  assert.equal(new Set([...page.slice(0,25),...next].map(item=>item.id)).size,27);
  assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM v2_revisions WHERE guild_id=$1',[g])).rows[0].n,27);
  assert.equal(await store.settingsBackup(g,c,first.id),null);
  const latest=(await store.settingsBackups(g))[0]!;
  await store.disable(g,c);assert.ok(await store.settingsBackup(g,c,latest.id));
  assert.equal(await store.deleteSettingsBackup(g,c,latest.id),true);
  assert.equal(await store.settingsBackup(g,c,latest.id),null);
  assert.equal((await store.settings(g,c,true)).config.panel.title,'保存24');
});

test('停止しても最新設定と名前を保持し、同じサーバーの権限がある候補だけを再利用できる', async () => {
  const g='100000000000000071', c='200000000000000071', role='400000000000000071';
  await store.saveSettings(await store.settings(g,c),'channel',{panel:{title:'再利用する設定'},content:{allowNsfw:true},moderation:{managerRoles:[role]}},actor,'元のチャンネル');
  await store.setPanel(g,c,'old-panel','private-webhook'); await store.disable(g,c);
  const saved=(await store.savedSetups(g,c))[0]!;
  assert.equal(saved.name,'元のチャンネル');assert.equal(saved.enabled,false);assert.equal(saved.title,'再利用する設定');
  assert.ok(!JSON.stringify(saved).includes('private-webhook'));
  const config=await store.savedSetup(g,c);assert.equal(config?.content.allowNsfw,true);
  assert.ok(!JSON.stringify(config).includes('private-webhook'));
  assert.deepEqual(await store.savedSetups(g,c,0,[]),[]);
  assert.equal((await store.savedSetups(g,c,0,[role])).length,1);
  assert.equal(await store.savedSetup('other-guild',c),null);
  await store.cleanup();assert.ok(await store.savedSetup(g,c));
  await store.pool.query('INSERT INTO v2_channels(guild_id,channel_id) VALUES($1,$2)',[g,'200000000000000072']);
  assert.equal((await store.savedSetups(g,c)).length,1);
  const target='200000000000000074';
  await store.saveSettings(await store.settings(g,target),'channel',config!,actor,'新しいチャンネル');
  const copied=await store.settings(g,target,true);
  assert.equal(copied.config.panel.title,'再利用する設定');assert.equal(copied.config.content.allowNsfw,true);assert.equal(copied.webhook,null);
  assert.equal((await store.settings(g,c,true)).enabled,false);
});

test('バックアップは並行保存でも欠落せず、権限やサーバーで分離し、起動時に60日経過分だけ削除する',async()=>{
  const g='backup-pool',role='400000000000000081';
  await store.settings(g,'init');
  await Promise.all(Array.from({length:12},async(_,index)=>{
    const channel=`backup-channel-${index}`;
    await store.saveSettings(await store.settings(g,channel,true),'channel',{moderation:{managerRoles:[role]}},actor,`保存先${index}`);
  }));
  const backups=await store.settingsBackups(g);
  assert.equal(backups.length,12);assert.equal(new Set(backups.map(item=>item.id)).size,12);
  assert.ok(backups.every(item=>item.channelName.startsWith('保存先')));
  assert.equal((await store.settingsBackups(g,[role])).length,12);
  assert.equal((await store.settingsBackups(g,[])).length,0);
  await store.saveSettings(await store.settings('other-backup-pool','c'),'channel',{},actor,'別サーバー');
  assert.equal((await store.settingsBackups('other-backup-pool')).length,1);
  const latest=backups[0]!;
  assert.equal(await store.settingsBackup('other-backup-pool',latest.channelId,latest.id),null);
  assert.equal(await store.deleteSettingsBackup('other-backup-pool',latest.channelId,latest.id),false);
  const settings=await store.settings(g,latest.channelId!,true);
  await store.setPanel(g,settings.channelId,'old-panel','webhook');
  const beforeStop=await store.settings(g,settings.channelId,true);
  await store.disable(g,settings.channelId);
  assert.equal(await store.setPanel(g,settings.channelId,'stale-panel','webhook',beforeStop),false);
  assert.equal((await store.settings(g,settings.channelId,true)).enabled,false);
  await assert.rejects(store.saveSettings(beforeStop,'channel',{},actor),/更新されました/);
  assert.equal((await store.settingsBackups(g)).length,12);
  for(let index=0;index<10;index++)await store.pool.query('INSERT INTO v2_revisions(guild_id,config,actor_id) VALUES($1,$2,$3)',['old-backup-pool',defaults,actor]);
  await store.pool.query("INSERT INTO v2_revisions(guild_id,config,actor_id,created_at) VALUES($1,$2,$3,now()-interval '61 days')",['old-backup-pool',defaults,actor]);
  await store.initialize();
  assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM v2_revisions WHERE guild_id=$1',['old-backup-pool'])).rows[0].n,10);
  assert.equal((await store.settingsBackups('other-backup-pool')).length,1);
});

test('再利用候補はこのチャンネルを先頭にし、25件を超える設定もページで取得できる', async () => {
  const g='100000000000000073', c='200000000000000073';
  await store.saveSettings(await store.settings(g,c),'channel',{},actor);
  for(let index=0;index<27;index++)await store.pool.query('INSERT INTO v2_channels(guild_id,channel_id,version) VALUES($1,$2,1)',[g,`2000000000000001${String(index).padStart(2,'0')}`]);
  const first=await store.savedSetups(g,c), second=await store.savedSetups(g,c,25);
  assert.equal(first.length,26);assert.equal(first[0]!.channelId,c);assert.equal(second.length,3);
  assert.equal(new Set([...first.slice(0,25),...second].map(item=>item.channelId)).size,28);
});

test('エラー詳細は再読み込みでき別サーバーには開示せず30日で削除する', async () => {
  await store.saveDiagnostic('ERR-0123456789ABCDEF', guild, channel, 'interaction', 'setup', '原因の詳細');
  assert.equal((await store.diagnostic('ERR-0123456789ABCDEF', guild))?.details, '原因の詳細');
  assert.equal(await store.diagnostic('ERR-0123456789ABCDEF', 'other'), null);
  await store.pool.query("UPDATE v2_diagnostics SET created_at=now()-interval '31 days' WHERE code=$1", ['ERR-0123456789ABCDEF']);
  assert.equal(await store.diagnostic('ERR-0123456789ABCDEF', guild), null);
  await store.cleanup();
  assert.equal((await store.pool.query('SELECT count(*)::int AS count FROM v2_diagnostics')).rows[0].count, 0);
});

test('保存0の最小診断は24時間で失効し、保存0チャンネルの旧診断も削除する', async () => {
  await store.saveDiagnostic('11223344', 'hashed-guild', 'hashed-channel', 'hashed-operation', '匿名投稿', 'Error code=23505', true);
  const row = (await store.pool.query("SELECT expires_at,created_at FROM v2_diagnostics WHERE code='11223344'")).rows[0];
  assert.equal(new Date(row.expires_at).getTime() - new Date(row.created_at).getTime(), 86400000);
  assert.ok(await store.diagnostic('11223344', 'hashed-guild'));
  const target = '200000000000000098';
  await store.saveSettings(await store.settings(guild, target, true), 'channel', { policy: { retentionDays: 0 } }, actor);
  await store.saveDiagnostic('55667788', guild, target, 'legacy-operation', '投稿', '旧エラー内容');
  await store.cleanup();
  assert.equal((await store.pool.query("SELECT 1 FROM v2_diagnostics WHERE code='55667788'")).rowCount, 0);
  assert.ok(await store.diagnostic('11223344', 'hashed-guild'));
  await store.pool.query("UPDATE v2_diagnostics SET expires_at=now()-interval '1 second' WHERE code='11223344'");
  assert.equal(await store.diagnostic('11223344', 'hashed-guild'), null);
  await store.cleanup();
  assert.equal((await store.pool.query("SELECT 1 FROM v2_diagnostics WHERE code='11223344'")).rowCount, 0);
});

test('処罰中の追加通報と二重実行を拒否し、利用停止は対象チャンネルだけに適用する',async()=>{
  const g='moderation-g',c='moderation-c',m='moderation-m';
  await store.settings(g,c,true);const config=structuredClone(defaults);config.policy.cooldown=0;
  await store.reserve({operationId:'moderation-post',guildId:g,channelId:c,userId:'target',text:'本文'},config);await store.markSent('moderation-post',m,[]);
  const post=(await store.post(g,c,m))!;await store.addReport(post,'reporter','理由',null);
  const token=await store.claimReportAction(g,c,m);
  await assert.rejects(store.claimReportAction(g,c,m),/処理中/);
  await assert.rejects(store.addReport(post,'reporter2','追加',null),/処理中/);
  await store.releaseReportAction(g,m,token);
  assert.equal(await store.addReport(post,'reporter2','追加',null),2);
  const second=await store.claimReportAction(g,c,m);await store.finishReportAction(g,m,second,'manager','restrict','理由','target');
  assert.equal(await store.reportDetail(g,c,m),null);
  await assert.rejects(store.addReport(post,'reporter3','追加',null),/対応済み/);
  await assert.rejects(store.reserve({operationId:'blocked-channel',guildId:g,channelId:c,userId:'target',text:'本文'},config),/利用が停止/);
  await assert.doesNotReject(store.reserve({operationId:'allowed-channel',guildId:g,channelId:'other-channel',userId:'target',text:'通常投稿'},config));
  await store.releaseChannelRestriction(g,c,'target','manager');
  await assert.doesNotReject(store.checkRestrictions(g,'target',c));
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
