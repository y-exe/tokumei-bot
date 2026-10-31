import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { DiscordAPIError, MessageFlags, WebhookClient, ChannelType, Collection, type TextChannel } from 'discord.js';
import type { PostingChannel } from '../src/domain/channels.js';
import { Store } from '../src/infra/store.js';
import { SecretBox } from '../src/infra/secrets.js';
import { Posting } from '../src/services/posting.js';
import { defaults } from '../src/domain/config.js';
import type { PostInput } from '../src/domain/validation.js';
import { BlockedWordError } from '../src/domain/errors.js';
import { MediaService } from '../src/media/service.js';
import { SafeHttp } from '../src/media/http.js';
import { certifyImage } from '../src/media/safety-policy.js';

let db: PGlite; let server: PGLiteSocketServer; let store: Store; let posting: Posting; let secrets: SecretBox;
const guild = '100000000000000010'; const channel = '200000000000000010'; const user = '300000000000000010';
const sent: unknown[] = []; const edited: unknown[] = []; let deletes = 0;
before(async () => {
  db = await PGlite.create(); server = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1', maxConnections: 5 }); await server.start();
  const box = new SecretBox(randomBytes(32).toString('base64')); secrets = box;
  store = new Store(`postgresql://postgres:postgres@${server.getServerConn()}/postgres`, box); await store.initialize();
  posting = new Posting(store, box);
  const settings = await store.settings(guild, channel);
  await store.saveSettings(settings, 'guild', { ...structuredClone(defaults), policy: { ...defaults.policy, postsPerMinute: 0, charsPerMinute: 0, charsPerFiveMinutes: 0, duplicateSeconds: 0 } }, user);
  await store.saveSettings(await store.settings(guild, channel, true), 'channel', { policy: { cooldown: 0 } }, user);
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

test('保存0でも送信でき、投稿・投稿者・セッションをDBに作成しない',async()=>{
  const target='200000000000000011';const settings=await store.settings(guild,target,true);
  await store.saveSettings(settings,'channel',{policy:{retentionDays:0,reportRetentionDays:0,cooldown:0}},user);
  const credential=(await store.settings(guild,channel,true)).webhook!;await store.setPanel(guild,target,'panel',credential);
  const input={...post('no-log'),channelId:target};const before=sent.length;
  assert.ok((await posting.publish(input)).includes(target));assert.equal(sent.length,before+1);
  for(const table of ['v2_posts','v2_sessions','v2_reports'])assert.equal((await store.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE channel_id=$1`,[target])).rows[0].n,0);
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
  const counter=(await store.pool.query('SELECT counter,last_avatar,last_user FROM v2_counters WHERE channel_id=$1',[target])).rows[0];
  assert.equal(counter.counter,3);assert.ok(counter.last_avatar!==null);assert.equal(counter.last_user,null);
  await assert.rejects(posting.own(guild,target,'600000000000000011',user),/保存期限/);
});

test('保存0の番号と見た目は再起動しても続き、色は直前のものを除外する',async()=>{
  const target='200000000000000011';const input={...post('no-log-restart'),channelId:target};const before=sent.length;
  const restarted=new Posting(store,secrets);
  await restarted.publish(input);
  const options=sent.slice(before) as {avatarURL:string;username:string}[];
  assert.equal(options[0]!.username,'匿名 004');
  assert.notEqual(options[0]!.avatarURL,(sent.slice(0,before).at(-1) as {avatarURL:string}).avatarURL);
});

test('保存0の送信拒否では具体的な理由を表示し、同じ操作を再送しない',async()=>{
  const output=mock.method(console,'error',()=>{});
  const send=mock.method(WebhookClient.prototype,'send',async()=>{throw new DiscordAPIError({code:10015,message:'Unknown Webhook'},10015,404,'POST','https://discord.com/api/webhooks/secret',{});});
  const input={...post('no-log-rejected'),channelId:'200000000000000011'};
  try{
    await assert.rejects(posting.publish(input),/投稿用Webhookが削除された/);
    await assert.rejects(posting.publish(input),/処理済み/);
    assert.equal(send.mock.calls.length,1);
    assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM v2_posts WHERE operation_id=$1',[input.operationId])).rows[0].n,0);
  }finally{send.mock.restore();output.mock.restore();}
});

test('再設置では有効なWebhookを維持し、削除済みだけを作り直す',async()=>{
  const credential=(await store.settings(guild,channel,true)).webhook!;
  let creates=0;let failure:Error|undefined;
  const destination={id:channel,type:ChannelType.GuildText,isThread:()=>false,guild:{id:guild},client:{fetchWebhook:async()=>{if(failure)throw failure;return {channelId:channel};}},createWebhook:async()=>{creates++;return {url:`https://discord.com/api/webhooks/500000000000000012/${'b'.repeat(68)}`};}} as unknown as TextChannel;
  assert.equal(await posting.createWebhook(destination),credential);assert.equal(creates,0);
  failure=new DiscordAPIError({code:10015,message:'Unknown Webhook'},10015,404,'GET','https://discord.com/api/webhooks/secret',{});
  const replacement=await posting.createWebhook(destination);
  assert.match(secrets.open(replacement),/500000000000000012/);assert.equal(creates,1);
  failure=new Error('timeout');
  await assert.rejects(posting.createWebhook(destination),/timeout/);assert.equal(creates,1);
  failure=new DiscordAPIError({code:50013,message:'Missing Permissions'},50013,403,'GET','https://discord.com/api/webhooks/secret',{});
  await assert.rejects(posting.createWebhook(destination),/Missing Permissions/);assert.equal(creates,1);
});

test('スレッドへの送信・本人編集・削除・送信照合にスレッドIDを渡し、保存0でも親へ誤送信しない', async()=>{
  const credential=(await store.settings(guild,channel,true)).webhook!;
  const threaded=new Posting(store,secrets,async(_guild,id)=>id);
  const requests:unknown[]=[];
  const fetched=mock.method(WebhookClient.prototype,'fetchMessage',async(_id:string,options:unknown)=>{
    requests.push(options);return {channel_id:'200000000000000031',webhook_id:'500000000000000010',attachments:[]};
  });
  const deleted=mock.method(WebhookClient.prototype,'deleteMessage',async(_id:string,threadId?:string)=>{requests.push({threadId});});
  try{
    for(const [target,retention] of [['200000000000000031',null],['200000000000000032',0]] as const){
      await store.saveSettings(await store.settings(guild,target,true),'channel',{policy:{cooldown:0,retentionDays:retention}},user);
      await store.setPanel(guild,target,'panel',credential);
      const link=await threaded.publish({...post('thread-'+target),channelId:target});
      const messageId=link.split('/').at(-1)!;
      assert.equal((sent.at(-1) as {threadId:string}).threadId,target);
      if(retention===null){
        await threaded.edit(guild,target,messageId,user,'スレッド内の変更');
        assert.equal((edited.at(-1) as {threadId:string}).threadId,target);
        await store.pool.query("UPDATE v2_posts SET status='uncertain' WHERE message_id=$1",[messageId]);
        assert.equal(await threaded.reconcile(guild,target,user,'thread-'+target),link);
        await threaded.remove(guild,target,messageId,user);
        assert.equal(requests.length,3);
        assert.ok(requests.every(options=>(options as {threadId:string}).threadId===target));
      }
    }
  }finally{fetched.mock.restore();deleted.mock.restore();}
});

test('同じ親のスレッドとフォーラム投稿ではWebhookを共有し、再設置でも親を検証する',async()=>{
  let creates=0;
  const hooks=new Collection<string,{id:string;owner:{id:string};name:string;token:string;url:string}>();
  const parent={id:'200000000000000040',type:ChannelType.GuildForum,fetchWebhooks:async()=>hooks,createWebhook:async()=>{
    creates++;const webhook={id:'500000000000000040',owner:{id:'bot'},name:'匿名投稿',token:'c'.repeat(68),url:`https://discord.com/api/webhooks/500000000000000040/${'c'.repeat(68)}`};hooks.set(webhook.id,webhook);return webhook;
  }};
  const thread=(id:string)=>({id,type:ChannelType.PublicThread,isThread:()=>true,parent,guild:{id:guild},client:{user:{id:'bot'},fetchWebhook:async()=>({channelId:parent.id})}}) as unknown as PostingChannel;
  const first=thread('200000000000000041');const second=thread('200000000000000042');
  const credentials=await Promise.all([posting.createWebhook(first),posting.createWebhook(second)]);
  assert.equal(creates,1);assert.equal(secrets.open(credentials[0]!),secrets.open(credentials[1]!));
  await store.saveSettings(await store.settings(guild,first.id,true),'channel',{},user);
  await store.setPanel(guild,first.id,'panel',credentials[0]!);
  assert.equal(await posting.createWebhook(first),credentials[0]);assert.equal(creates,1);
  first.client.fetchWebhook=async()=>({channelId:'other'}) as never;
  await assert.rejects(posting.createWebhook(first),/送信先が一致しません/);
});

test('公開済みの投稿編集でも禁止語を確認し、拒否した編集はWebhookへ送らない',async()=>{
  const target='200000000000000050';
  await store.saveSettings(await store.settings(guild,target,true),'channel',{policy:{cooldown:0,blockedWords:['改造']}},user);
  await store.setPanel(guild,target,'panel',(await store.settings(guild,channel,true)).webhook!);
  const link=await posting.publish({...post('edit-blocked-word'),channelId:target});
  const messageId=link.split('/').at(-1)!;const before=edited.length;
  await assert.rejects(posting.edit(guild,target,messageId,user,'Switch2改造'),error=>error instanceof BlockedWordError&&error.words.includes('改造'));
  assert.equal(edited.length,before);
  assert.equal((await store.post(guild,target,messageId))!.content,'匿名テスト');
  await posting.edit(guild,target,messageId,user,'Switch2＊＊');
  assert.equal(edited.length,before+1);assert.equal((await store.post(guild,target,messageId))!.content,'Switch2＊＊');
});

test('保存あり・なしの投稿をサーバー単位で合算し、同一本文と6件目を送信前に止める', async () => {
  const targetGuild = '100000000000000099';
  const targets = ['200000000000000098', '200000000000000099'];
  const credential = (await store.settings(guild, channel, true)).webhook!;
  for (const [index, target] of targets.entries()) {
    await store.saveSettings(await store.settings(targetGuild, target, true), 'channel', { policy: { cooldown: 0, retentionDays: index ? 0 : null } }, user);
    await store.setPanel(targetGuild, target, 'panel', credential);
  }
  const input = { ...post('flood-first'), guildId: targetGuild, channelId: targets[1]!, text: '同一本文' };
  const before = sent.length;
  await posting.publish(input);
  await assert.rejects(posting.publish({ ...input, operationId: 'flood-duplicate', channelId: targets[0]! }), /現在、利用が制限されています。/);
  for (let i = 1; i < 5; i++) await posting.publish({ ...input, operationId: `flood-${i}`, channelId: targets[i % 2]!, text: `別の本文${i}` });
  await assert.rejects(new Posting(store, secrets).publish({ ...input, operationId: 'flood-sixth', text: '6件目' }), /現在、利用が制限されています。/);
  assert.equal(sent.length - before, 5);
  assert.equal((await store.pool.query('SELECT 1 FROM v2_posts WHERE channel_id=$1', [targets[1]])).rowCount, 0);
  assert.equal((await store.pool.query('SELECT 1 FROM v2_sessions WHERE channel_id=$1', [targets[1]])).rowCount, 0);
  assert.equal((await store.pool.query('SELECT 1 FROM v2_authors WHERE operation_id=$1', [input.operationId])).rowCount, 0);
});

test('本文・出典のX共有パラメータは送信と保存の前に除去し、編集時も残さない', async () => {
  const c = 'sharing-parameters-channel';
  await store.saveSettings(await store.settings(guild, c), 'channel', { policy: { cooldown: 0 } }, user);
  await store.setPanel(guild, c, 'sharing-panel', (await store.settings(guild, channel)).webhook!);
  const base = 'https://x.com/example/status/123';
  const link = await posting.publish({ ...post('sharing-parameters'), channelId: c, text: `本文 ${base}?a=private&s=20`, source: `${base}?s=20&a=private` });
  const id = link.split('/').at(-1)!;
  assert.equal((sent.at(-1) as { content: string }).content, `本文 ${base}\n出典: <${base}>`);
  const saved = await store.post(guild, c, id);
  assert.equal(saved?.content, `本文 ${base}`);
  assert.equal(saved?.source, base);
  await posting.edit(guild, c, id, user, `編集 [リンク](${base}?a=another&s=20)`);
  assert.equal((edited.at(-1) as { content: string }).content, `編集 [リンク](${base})\n出典: <${base}>`);
  assert.equal((await store.post(guild, c, id))?.content, `編集 [リンク](${base})`);
  await store.deletePost(guild, c, id);
});

test('X動画だけのURL投稿は画像必須でも送信・保存・説明文の空編集ができ、安全判定も設定に従う', async () => {
  const c = 'url-video-channel';
  await store.saveSettings(await store.settings(guild, c), 'channel', {
    policy: { cooldown: 0 }, content: { text: false, caption: false, allowNsfw: true, allowNsfl: false },
  }, user);
  await store.setPanel(guild, c, 'video-panel', (await store.settings(guild, channel)).webhook!);
  class XHttp extends SafeHttp {
    override async json<T>(): Promise<T> {
      return { tweet: { media: { all: [{ type: 'video', url: 'https://video.twimg.com/test.mp4' }] } } } as T;
    }
  }
  const result = await new MediaService(new XHttp()).fromUrl('https://x.com/example/status/123?a=private&s=20', defaults);
  assert.equal(result.files.length, 0);
  assert.deepEqual(result.videoLinks, ['https://x-p.yexe.xyz/test.mp4']);
  const video = await promisify(execFile)(process.env.FFMPEG_PATH ?? 'ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=64x64:r=1', '-t', '1', '-threads', '1',
    '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1',
  ], { encoding: 'buffer', timeout: 15_000 });
  const get = mock.method(SafeHttp.prototype, 'get', async (url: string) => {
    assert.equal(url, 'https://video.twimg.com/test.mp4');
    return { data: video.stdout, contentType: 'video/mp4', url };
  });
  try {
    const videoPost = { ...post('url-video-only'), channelId: c, text: '', media: result.files, source: result.source, videoLinks: result.videoLinks };
    const link = await posting.publish(videoPost);
    const id = link.split('/').at(-1)!;
    assert.equal(get.mock.calls.length, 1);
    assert.ok((sent.at(-1) as { content: string }).content.includes('[動画](https://x-p.yexe.xyz/test.mp4)'));
    assert.deepEqual((await store.post(guild, c, id))?.videoLinks, result.videoLinks);
    await posting.edit(guild, c, id, user, '');
    assert.ok((edited.at(-1) as { content: string }).content.includes('[動画]'));
    await store.saveSettings(await store.settings(guild, c, true), 'channel', {
      policy: { cooldown: 0 }, content: { text: false, caption: false, allowNsfw: true, allowNsfl: true },
    }, user);
    await posting.publish({ ...videoPost, operationId: 'url-video-unrestricted' });
    assert.equal(get.mock.calls.length, 1);
  } finally { get.mock.restore(); }
});

test('X以外の対応サイト・直接URL・動画添付も実MP4を分散検査して送信できる', async () => {
  const c = 'other-video-channel';
  await store.saveSettings(await store.settings(guild, c), 'channel', {
    policy: { cooldown: 0 }, content: { text: false, allowNsfw: true, allowNsfl: false },
  }, user);
  await store.setPanel(guild, c, 'other-video-panel', (await store.settings(guild, channel)).webhook!);
  const video = await promisify(execFile)(process.env.FFMPEG_PATH ?? 'ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=64x64:r=1', '-t', '6', '-threads', '1',
    '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1',
  ], { encoding: 'buffer' });
  let broken = false;
  const downloads: string[] = [];
  class VideoHttp extends SafeHttp {
    override async json<T>(url: string): Promise<T> {
      if (url.includes('/api/v1/statuses/')) return { visibility: 'public', media_attachments: [{ type: 'video', url: 'https://mastodon.example/clip.mp4' }] } as T;
      assert.ok(url.startsWith('https://api.atmosphere.tools/2/'));
      return { status: { media: { all: [{ type: 'video', url: 'https://api.atmosphere.tools/proxy?url=clip.mp4' }] } } } as T;
    }
    override async postJson<T>(): Promise<T> {
      return { visibility: 'public', files: [{ type: 'video/mp4', url: 'https://misskey.example/clip.mp4' }] } as T;
    }
    override async get(url: string) {
      downloads.push(url);
      return { data: broken ? Buffer.from('broken') : video.stdout, contentType: 'video/mp4', url };
    }
  }
  const service = new MediaService(new VideoHttp());
  const config = (await store.settings(guild, c, true)).config;
  const urls = [
    'https://www.tiktok.com/@example/video/123', 'https://www.instagram.com/reel/abc/',
    'https://www.threads.net/@example/post/abc', 'https://mastodon.example/@example/123',
    'https://misskey.example/notes/abc123', 'https://cdn.example/clip.mp4',
  ];
  for (const [index, url] of urls.entries()) {
    const result = await service.fromUrl(url, config);
    assert.equal(result.files.length, 1, url);
    assert.equal(result.files[0]!.kind, 'video', url);
    assert.equal(result.videoLinks.length, 0, url);
    await posting.publish({ ...post(`other-video-${index}`), channelId: c, text: '', media: result.files, source: result.source });
    assert.equal((sent.at(-1) as { files: unknown[] }).files.length, 1, url);
  }
  const files = await service.attachments(['https://cdn.discordapp.com/attachments/1/2/clip.mp4'], config);
  await posting.publish({ ...post('other-video-attachment'), channelId: c, text: '', media: files });
  assert.equal((sent.at(-1) as { files: unknown[] }).files.length, 1);
  assert.equal(downloads.length, 7);
  assert.ok(downloads.every(url => !url.includes('x-p.yexe.xyz')));
  broken = true;
  const invalid = await service.fromUrl(urls[0]!, config);
  const before = sent.length;
  await assert.rejects(posting.publish({ ...post('other-video-broken'), channelId: c, text: '', media: invalid.files }), /安全判定/);
  assert.equal(sent.length, before);
});


test('許可から拒否への設定変更後は送信処理でも保持した元画像を再検査する', async () => {
  const c = 'original-safety-channel';
  await store.saveSettings(await store.settings(guild, c), 'channel', {
    policy: { cooldown: 0 }, content: { allowNsfw: true, allowNsfl: false },
  }, user);
  await store.setPanel(guild, c, 'original-safety-panel', (await store.settings(guild, channel)).webhook!);
  const data = await sharp({ create: { width: 32, height: 32, channels: 3, background: 'white' } }).png().toBuffer();
  const original = Buffer.from('broken');
  const safety = certifyImage(data, { nsfw: false, nsfl: false, checkedNsfw: false, checkedNsfl: true }, original);
  const input: PostInput = { ...post('original-permissive'), channelId: c, text: '', media: [{ data, safetyInput: original, safety, name: 'image.png', kind: 'image' }] };
  await posting.publish(input);
  await store.saveSettings(await store.settings(guild, c, true), 'channel', { policy: { cooldown: 0 }, content: { allowNsfw: false, allowNsfl: false } }, user);
  const before = sent.length;
  await assert.rejects(posting.publish({ ...input, operationId: 'original-strict' }), /壊れ/);
  assert.equal(sent.length, before);
});
