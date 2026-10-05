import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { MessageFlags, WebhookClient } from 'discord.js';
import { Store } from '../src/infra/store.js';
import { SecretBox } from '../src/infra/secrets.js';
import { Posting } from '../src/services/posting.js';
import { defaults } from '../src/domain/config.js';
import type { PostInput } from '../src/domain/validation.js';

let db: PGlite; let server: PGLiteSocketServer; let store: Store; let posting: Posting;
const guild = '100000000000000010'; const channel = '200000000000000010'; const user = '300000000000000010';
const sent: unknown[] = []; const edited: unknown[] = []; let deletes = 0;
before(async () => {
  db = await PGlite.create(); server = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1', maxConnections: 5 }); await server.start();
  store = new Store(`postgresql://postgres:postgres@${server.getServerConn()}/postgres`); await store.initialize();
  const box = new SecretBox(randomBytes(32).toString('base64')); posting = new Posting(store, box);
  const settings = await store.settings(guild, channel);
  await store.saveSettings(settings, 'channel', { policy: { cooldown: 0 } }, user);
  await store.setPanel(guild, channel, 'panel', box.seal(`https://discord.com/api/webhooks/500000000000000010/${'a'.repeat(68)}`));
  mock.method(WebhookClient.prototype, 'send', async (options: unknown) => {
    sent.push(options); return { id: `6000000000000000${sent.length.toString().padStart(2, '0')}`, attachments: [] };
  });
  mock.method(WebhookClient.prototype, 'fetchMessage', async () => ({ attachments: [] }));
  mock.method(WebhookClient.prototype, 'editMessage', async (_id: string, options: unknown) => { edited.push(options); return {}; });
  mock.method(WebhookClient.prototype, 'deleteMessage', async () => { deletes++; });
});
after(async () => { mock.restoreAll(); await store.close(); await server.stop(); await db.close(); });
const post = (operationId: string): PostInput => ({ operationId, guildId: guild, channelId: channel, userId: user, roles: [], text: '匿名テスト', media: [] });

test('匿名投稿は通常本文と添付で送信し、メンションを無効化して保存する', async () => {
  const link = await posting.publish(post('publish1'));
  assert.ok(link.endsWith('/600000000000000001'));
  const options = sent[0] as Record<string, unknown>;
  assert.ok(!('flags' in options)); assert.ok(!('components' in options)); assert.ok(!('embeds' in options));
  assert.equal(options.content, '匿名テスト');
  assert.equal(options.username, '匿名 001'); assert.deepEqual(options.allowedMentions, { parse: [] });
  assert.equal((await store.post(guild, channel, '600000000000000001'))?.user_id, user);
  await assert.rejects(posting.publish(post('publish1')), /送信済み/); assert.equal(sent.length, 1);
});
test('他人の編集・削除をWebhook操作前に拒否し、本人は通常本文を操作できる', async () => {
  await assert.rejects(posting.edit(guild, channel, '600000000000000001', 'someone-else', '改変'), /自分の投稿/);
  await assert.rejects(posting.remove(guild, channel, '600000000000000001', 'someone-else'), /自分の投稿/);
  assert.equal(edited.length, 0); assert.equal(deletes, 0);
  await posting.edit(guild, channel, '600000000000000001', user, '変更しました');
  assert.equal((edited[0] as Record<string, unknown>).content, '変更しました');
  assert.ok(!('components' in (edited[0] as Record<string, unknown>)));
  assert.equal((await store.post(guild, channel, '600000000000000001'))?.content, '変更しました');
  await posting.remove(guild, channel, '600000000000000001', user); assert.equal(deletes, 1);
  assert.equal(await store.post(guild, channel, '600000000000000001'), null);
});
test('投稿後のDB失敗では送信結果を不明として保持し、同じ操作を自動再送しない', async () => {
  const failure = mock.method(store, 'markSent', async () => { throw new Error('database failure'); });
  await assert.rejects(posting.publish(post('uncertain')), /送信結果を確認できません/);
  failure.mock.restore();
  const row = (await store.pool.query("SELECT status FROM v2_posts WHERE operation_id='uncertain'")).rows[0];
  assert.equal(row.status, 'uncertain');
  const count = sent.length; await assert.rejects(posting.publish(post('uncertain')), /確認中/); assert.equal(sent.length, count);
});

test('Discordの投稿番号を保存できた通信障害は本人だけが照合し、再送なしで編集可能に戻せる', async () => {
  const count = sent.length;
  const saved = (await store.uncertainPosts(guild, channel, user))[0]!;
  assert.equal(saved.operation_id, 'uncertain'); assert.ok(saved.message_id); assert.ok(saved.delivery_webhook);
  assert.equal((await store.uncertainPosts(guild, channel, 'other-user')).length, 0);
  const fetch = mock.method(WebhookClient.prototype, 'fetchMessage', async () => ({ channel_id: channel, webhook_id: '500000000000000010', attachments: [] }));
  await assert.rejects(posting.reconcile(guild, channel, 'other-user', saved.operation_id), /自分の/);
  await assert.rejects(posting.reconcile('other-guild', channel, user, saved.operation_id), /自分の/);
  assert.equal(fetch.mock.calls.length, 0);
  const link = await posting.reconcile(guild, channel, user, saved.operation_id);
  assert.ok(link.endsWith('/' + saved.message_id));
  assert.equal((await store.post(guild, channel, saved.message_id!))?.user_id, user);
  assert.equal((await store.uncertainPosts(guild, channel, user)).length, 0);
  assert.equal(await posting.reconcile(guild, channel, user, saved.operation_id), link);
  assert.equal(fetch.mock.calls.length, 1); assert.equal(sent.length, count);
  fetch.mock.restore();
  await store.deletePost(guild, channel, saved.message_id!);
  await assert.rejects(store.markSent(saved.operation_id, saved.message_id!, []), /削除済み/);
  await assert.rejects(posting.reconcile(guild, channel, user, saved.operation_id), /自分の/);
});

test('Discordの受付結果が不明な投稿は推測でひも付けず、再送も本人以外の照合もしない', async () => {
  const send = mock.method(WebhookClient.prototype, 'send', async () => { throw new Error('timeout'); });
  await assert.rejects(posting.publish(post('transport-unknown')), /送信結果を確認できません/);
  send.mock.restore();
  const saved = (await store.ownOperation(guild, channel, user, 'transport-unknown'))!;
  assert.equal(saved.message_id, null); assert.equal(saved.status, 'uncertain');
  const fetch = mock.method(WebhookClient.prototype, 'fetchMessage', async () => { throw new Error('must not fetch'); });
  await assert.rejects(posting.reconcile(guild, channel, user, saved.operation_id), /投稿番号/);
  assert.equal(fetch.mock.calls.length, 0);
  await store.pool.query("UPDATE v2_authors SET expires_at=now()-interval '1 minute' WHERE operation_id=$1", [saved.operation_id]);
  assert.equal(await store.ownOperation(guild, channel, user, saved.operation_id), null);
  fetch.mock.restore();
});

test('照合時に別チャンネル・別Webhookの応答が返っても送信済みにしない', async () => {
  await store.reserve(post('wrong-response'), { ...structuredClone(defaults), policy: { ...defaults.policy, cooldown: 0 } }, (await store.settings(guild,channel)).webhook!);
  await store.markUncertain('wrong-response', { messageId: '600000000000000099', media: [] });
  const fetch = mock.method(WebhookClient.prototype, 'fetchMessage', async () => ({ channel_id: 'different', webhook_id: '500000000000000010', attachments: [] }));
  await assert.rejects(posting.reconcile(guild, channel, user, 'wrong-response'), /送信先/);
  assert.equal((await store.ownOperation(guild,channel,user,'wrong-response'))?.status, 'uncertain');
  fetch.mock.restore();
});
test('返信と手入力の番号は直近の同じチャンネルの投稿へリンクし、編集で未来へずれない',async()=>{
  const c='reference-channel';const settings=await store.settings(guild,c);
  await store.saveSettings(settings,'channel',{policy:{cooldown:0}},user);
  await store.setPanel(guild,c,'reference-panel',(await store.settings(guild,channel)).webhook!);
  const input=(operationId:string,text:string)=>({...post(operationId),channelId:c,text});
  const first=await posting.publish(input('reference-first','最初'));
  const firstId=first.split('/').at(-1)!;
  await store.pool.query("UPDATE v2_posts SET anonymous_id=321,created_at=now()-interval '3 hours' WHERE operation_id='reference-first'");
  const second=await posting.publish(input('reference-second','直近'));
  const secondId=second.split('/').at(-1)!;
  await store.pool.query("UPDATE v2_posts SET anonymous_id=321,created_at=now()-interval '2 hours' WHERE operation_id='reference-second'");
  const reply=await posting.publish({...input('reference-reply','>>321 >>999 >>1234 [>>321](https://example.com)'),replyTo:secondId});
  const rendered=(sent.at(-1) as {content:string}).content;
  assert.ok(rendered.startsWith(`[>>321](${second})\n`));assert.ok(rendered.includes(`[>>321](${second}) >>999 >>1234 [>>321](https://example.com)`));
  await store.pool.query("UPDATE v2_posts SET created_at=now()-interval '1 hour' WHERE operation_id='reference-reply'");
  const future=await posting.publish(input('reference-future','後の同番号'));
  await store.pool.query("UPDATE v2_posts SET anonymous_id=321 WHERE operation_id='reference-future'");
  await posting.edit(guild,c,reply.split('/').at(-1)!,user,'>>321 編集');
  assert.ok((edited.at(-1) as {content:string}).content.includes(`[>>321](${second}) 編集`));
  assert.ok(!(edited.at(-1) as {content:string}).content.includes(future));
  await store.deletePost(guild,c,future.split('/').at(-1)!);await store.deletePost(guild,c,secondId);
  assert.equal(await posting.linkReferences('>>321',guild,c,new Date()),`[>>321](${first})`);
  assert.equal(await posting.linkReferences('>>321',guild,'different',new Date()),'>>321');
  await store.pool.query("UPDATE v2_posts SET expires_at=now()-interval '1 second' WHERE message_id=$1",[firstId]);
  assert.equal(await posting.linkReferences('>>321',guild,c,new Date()),'>>321');
});

test('停止中は受付を拒否し、設定変更後の画像必須・編集制限も検査する', async () => {
  const settings = await store.settings(guild, channel, true);
  await store.saveSettings(settings, 'channel', { content: { text: false, caption: false } }, user);
  await assert.rejects(posting.publish(post('text-in-image-mode')), /画像の添付/);
  const saved = { content: '旧テキスト', source: null, media: [] } as Parameters<Posting['validateEdit']>[0];
  assert.throws(() => posting.validateEdit(saved, '変更', { ...defaults, content: { ...defaults.content, text: false } }), /画像必須/);
  await store.disable(guild, channel); await assert.rejects(posting.publish(post('stopped')), /設置されていません/);
});

test('保存0でも送信でき、投稿・投稿者・セッション・カウンターをDBに作成しない',async()=>{
  const target='200000000000000011';const settings=await store.settings(guild,target,true);
  await store.saveSettings(settings,'channel',{policy:{retentionDays:0,reportRetentionDays:0,cooldown:0}},user);
  const credential=(await store.settings(guild,channel,true)).webhook!;await store.setPanel(guild,target,'panel',credential);
  const input={...post('no-log'),channelId:target};const before=sent.length;
  assert.ok((await posting.publish(input)).includes(target));assert.equal(sent.length,before+1);
  for(const table of ['v2_posts','v2_sessions','v2_counters','v2_reports'])assert.equal((await store.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE channel_id=$1`,[target])).rows[0].n,0);
  assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM v2_authors WHERE operation_id=$1',[input.operationId])).rows[0].n,0);
  await assert.rejects(posting.publish(input),/処理済み/);assert.equal(sent.length,before+1);
  await posting.publish({...input,operationId:'no-log-continuous'});
  await posting.publish({...input,operationId:'no-log-other',userId:'other'});
  await posting.publish({...input,operationId:'no-log-return'});
  const options = sent.slice(before) as {avatarURL:string;username:string}[];
  assert.equal(options[1]!.avatarURL,options[0]!.avatarURL);
  assert.notEqual(options[2]!.avatarURL,options[1]!.avatarURL);
  assert.notEqual(options[3]!.avatarURL,options[2]!.avatarURL);
  assert.equal(options[2]!.username,'匿名 002');
  for(const table of ['v2_posts','v2_sessions','v2_counters','v2_reports'])assert.equal((await store.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE channel_id=$1`,[target])).rows[0].n,0);
  await assert.rejects(posting.own(guild,target,'600000000000000011',user),/保存期限/);
});
