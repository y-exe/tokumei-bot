import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PermissionFlagsBits, PermissionsBitField, ComponentType } from 'discord.js';
import { App } from '../src/app.js';
import { defaults } from '../src/domain/config.js';
import { SecretBox } from '../src/infra/secrets.js';
import { MediaService } from '../src/media/service.js';
import type { Store } from '../src/infra/store.js';
import type { Client, RepliableInteraction, ButtonInteraction, ModalSubmitInteraction } from 'discord.js';

const snapshot = { guildId: 'g', channelId: 'c', base: structuredClone(defaults), config: structuredClone(defaults), overrides: {}, guildVersion: 0, channelVersion: 0, enabled: true, panelId: null, webhook: null };
function app() {
  return new App({} as Client, { settings: async () => structuredClone(snapshot), reportDetail: async () => null } as unknown as Store,
    new SecretBox(randomBytes(32).toString('base64')), new MediaService());
}
function interaction(overrides: Record<string, unknown> = {}) {
  return { guildId: 'g', channelId: 'c', user: { id: 'alice' }, member: { roles: [] }, memberPermissions: new PermissionsBitField(0n), ...overrides } as unknown as RepliableInteraction;
}
test('管理操作は実行時に権限を確認し、サーバー管理権限だけを無条件で許可する', async () => {
  const bot = app();
  await assert.rejects(bot.requireManager(interaction()), /管理権限/);
  await assert.doesNotReject(bot.requireManager(interaction({ memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild) })));
});
test('他人の下書き・別サーバーの下書きを操作できず、管理権限が失われた操作も拒否する', async () => {
  const bot = app();
  const id = bot.editors.create({ owner: 'alice', guildId: 'g', channelId: 'c', scope: 'channel', original: snapshot, value: {}, installing: false });
  await assert.rejects(bot.configure(interaction({ user: { id: 'bob' } }) as ButtonInteraction, id, 'cancel'), /本人/);
  await assert.rejects(bot.configure(interaction({ guildId: 'other' }) as ButtonInteraction, id, 'cancel'), /本人/);
  await assert.rejects(bot.configure(interaction() as ButtonInteraction, id, 'cancel'), /管理権限/);
  assert.ok(bot.editors.get(id, 'alice', 'g'));
});
test('公開案内の画像ボタンはコマンド案内ではなくFileUploadモーダルを開く', async () => {
  const bot = app(); let modal: { toJSON(): unknown } | undefined;
  await bot.component(interaction({ customId: 'post:image', showModal: async (value: typeof modal) => { modal = value; } }) as ButtonInteraction);
  assert.ok(modal); assert.ok(JSON.stringify(modal.toJSON()).includes('"type":19'));
});

test('通報・処罰理由は任意のフォームを開き、空欄で確定しても処理する',async()=>{
  const bot=app();const modals:string[]=[];const config=structuredClone(defaults);config.moderation.reportChannel='destination';
  bot.store.settings=async()=>({...structuredClone(snapshot),config});bot.store.post=async()=>({}) as never;
  const manager={memberPermissions:new PermissionsBitField(PermissionFlagsBits.ManageGuild),showModal:async(value:{toJSON():unknown})=>{modals.push(JSON.stringify(value.toJSON()));}};
  await bot.context(interaction({...manager,targetId:'m',commandName:'匿名つぶやき通報'}) as never);
  await bot.component(interaction({...manager,customId:'punish:m:ban:c'}) as ButtonInteraction);
  for(const modal of modals){assert.ok(modal.includes('任意'));assert.ok(modal.includes('"required":false'));}
  const reasons:string[]=[];
  bot.report=async(_interaction,_id,reason)=>{reasons.push(reason);};
  bot.client.guilds={fetch:async()=>({})} as never;
  bot.moderation.execute=async(_guild,_channel,_message,_actor,_action,reason)=>{reasons.push(reason);return {report:{notificationId:null} as never,warning:''};};
  bot.respond=async()=>{};
  const submit={...manager,deferReply:async()=>{},fields:{getTextInputValue:()=>''}};
  await bot.modal(interaction({...submit,customId:'report:m'}) as ModalSubmitInteraction);
  await bot.modal(interaction({...submit,customId:'punishconfirm:m:ban:c'}) as ModalSubmitInteraction);
  assert.deepEqual(reasons,['','']);
});

test('通報通知は匿名の証拠と操作ボタンを送り、保存済みnonceで再送の重複を抑える', async () => {
  const bot = app(); const completions: unknown[][] = []; let sent: unknown;
  bot.store.settings = async () => ({ ...structuredClone(snapshot), config: { ...structuredClone(defaults), moderation: { ...defaults.moderation, reportThreshold: 1, reportChannel: 'destination' } } });
  bot.store.claimReportNotification = async () => 'pending:lease';
  bot.store.reportNotification = async (...args) => { completions.push(args); };
  bot.channel = async () => ({ send: async (value: unknown) => { sent = value; return { id: 'notice-id' }; } }) as never;
  await bot.sendReportNotice({ guild_id: 'g', channel_id: 'c', message_id: 'm', count: 1, content: '証拠', reason: '理由', nonce: 'r42' });
  const json = JSON.stringify(sent);
  assert.ok(json.includes('証拠')); assert.ok(json.includes('punish:m:ban:c'));
  assert.ok(json.includes('"nonce":"r42"')); assert.ok(json.includes('"enforceNonce":true'));
  assert.ok(json.includes('"parse":[]'));
  assert.deepEqual(completions, [['g', 'm', 'pending:lease', 'notice-id']]);
});

test('通知失敗は保存したリースで再試行待ちに戻し、送信権を得られなければ送信しない', async () => {
  const bot = app(); const completions: unknown[][] = []; let attempts = 0;
  bot.store.settings = async () => ({ ...structuredClone(snapshot), config: { ...structuredClone(defaults), moderation: { ...defaults.moderation, reportThreshold: 1, reportChannel: 'destination' } } });
  bot.store.claimReportNotification = async () => 'pending:lease';
  bot.store.reportNotification = async (...args) => { completions.push(args); };
  bot.channel = async () => ({ send: async () => { attempts++; throw new Error('network'); } }) as never;
  const notice = { guild_id: 'g', channel_id: 'c', message_id: 'm', count: 1, content: '証拠', reason: '理由', nonce: 'r42' };
  await assert.rejects(bot.sendReportNotice(notice), /network/);
  assert.deepEqual(completions, [['g', 'm', 'pending:lease', null]]);
  bot.store.claimReportNotification = async () => null;
  await bot.sendReportNotice(notice); assert.equal(attempts, 1);
});

test('案内の再送失敗でも成功した投稿を再送せず、投稿リンクと案内の警告を返す',async()=>{
  const bot=app();let sends=0;let view:unknown;
  bot.posting.publish=async()=>{sends++;return 'https://discord.com/channels/g/c/m';};
  bot.panels.bump=async()=>{throw new Error('permissions');};
  bot.respond=async(_interaction,components)=>{view=components.map(component=>component.toJSON());};
  await bot.send(interaction({id:'op'}),'本文',[]);
  assert.equal(sends,1);const json=JSON.stringify(view);
  assert.ok(json.includes('投稿は送信済み'));assert.ok(json.includes('https://discord.com/channels/g/c/m'));
});

test('投稿成功後は確認カードを送らず非公開の操作画面を消す',async()=>{
  const bot=app();let deleted=0;let published=0;
  bot.posting.publish=async()=>{published++;return 'https://discord.com/channels/g/c/m';};
  bot.panels.bump=async()=>{};
  bot.respond=async()=>{throw new Error('success must remain silent');};
  await bot.send(interaction({id:'op',deleteReply:async()=>{deleted++;}}),'本文',[]);
  assert.equal(published,1);assert.equal(deleted,1);
});

test('部分切り替えでは既存グローバルimageのattachment/content引数でも投稿する',async()=>{
  const bot=app();let received:unknown;
  const file={name:'image.jpg',data:Buffer.from('image'),kind:'image' as const};
  bot.media.attachments=async urls=>{assert.deepEqual(urls,['https://example.com/old.png']);return [file];};
  bot.send=async(_interaction,content,files)=>{received={content,files};};
  await bot.command(interaction({commandName:'image',deferReply:async()=>{},options:{
    getAttachment:(name:string)=>name==='attachment'?{url:'https://example.com/old.png'}:null,
    getString:(name:string)=>name==='content'?'旧形式の説明文':null,
  }}) as never);
  assert.deepEqual(received,{content:'旧形式の説明文',files:[file]});
});

test('URL確認画面から投稿しても削除済みの画面を再編集しない',async()=>{
  const bot=app();let deleted=0;
  const id=bot.previews.create({owner:'alice',guildId:'g',channelId:'c',files:[{name:'image.jpg',data:Buffer.from('image'),kind:'image'}],text:'',source:'https://example.com/image.jpg',warnings:[],selected:[0],sending:false});
  bot.posting.publish=async()=> 'https://discord.com/channels/g/c/m';
  bot.panels.bump=async()=>{};
  await bot.component(interaction({id:'op',customId:`preview:${id}:send`,deferUpdate:async()=>{},deleteReply:async()=>{deleted++;},editReply:async()=>{throw new Error('reply was deleted');}}) as ButtonInteraction);
  assert.equal(deleted,1);assert.throws(()=>bot.previews.get(id,'alice','g'));
});

test('ボタン色のモーダル選択は下書きだけを更新し、不正な選択は部分反映しない',async()=>{
  const bot=app();const id=bot.editors.create({owner:'alice',guildId:'g',channelId:'c',scope:'channel',original:snapshot,value:{},installing:false});
  const values:Record<string,string>={textStyle:'primary',imageStyle:'success',urlStyle:'secondary',helpStyle:'secondary'};
  let updates=0;
  const submit=()=>interaction({customId:`edit:${id}:styles`,memberPermissions:new PermissionsBitField(PermissionFlagsBits.ManageGuild),
    fields:{fields:new Map(Object.keys(values).map(name=>[name,{type:ComponentType.StringSelect}])),getStringSelectValues:(name:string)=>[values[name]],getTextInputValue:()=>{throw new Error('text input must not be used');}},
    isFromMessage:()=>true,update:async()=>{updates++;}}) as ModalSubmitInteraction;
  await bot.modal(submit());const session=bot.editors.get(id,'alice','g');
  assert.equal(session.value.panel?.imageStyle,'success');assert.equal(updates,1);
  assert.equal((await bot.store.settings('g','c')).config.panel.imageStyle,undefined);
  const before=structuredClone(session.value);values.helpStyle='pink';
  await assert.rejects(bot.modal(submit()));assert.deepEqual(session.value,before);assert.equal(updates,1);
});

test('説明文禁止への切り替え後は古い説明文モーダルもURLコマンドも受け付けない',async()=>{
  const bot=app();const config=structuredClone(snapshot.config);config.content.caption=false;
  bot.store.settings=async()=>({...snapshot,config});
  bot.media.fromUrl=async()=>{throw new Error('説明文検査前に取得しない');};
  await assert.rejects(bot.prepareUrl(interaction() as never,'https://example.com/image.jpg','説明文'),/説明文/);
  const id=bot.previews.create({owner:'alice',guildId:'g',channelId:'c',files:[],text:'',source:'https://example.com/image.jpg',warnings:[],selected:[],sending:false});
  await assert.rejects(bot.modal(interaction({customId:`caption:${id}`,fields:{getTextInputValue:()=> '説明文'}}) as ModalSubmitInteraction),/説明文/);
  assert.equal(bot.previews.get(id,'alice','g').text,'');
});

test('説明文禁止の画像投稿は自分の投稿の編集フォームも開かず、削除操作を残す',async()=>{
  const bot=app();const config=structuredClone(snapshot.config);config.content.caption=false;
  bot.store.settings=async()=>({...snapshot,config});
  const post={content:'',media:[{name:'image.jpg',url:'https://example.com/a',kind:'image'}],layout:'plain'};
  bot.posting.own=async()=>post as never;
  const edit=interaction({customId:'own:message:edit',showModal:async()=>{throw new Error('フォームを開かない');}});
  await assert.rejects(bot.component(edit as ButtonInteraction),/説明文/);
  let view='';await bot.component(interaction({customId:'mine:select',values:['message'],isStringSelectMenu:()=>true,update:async(payload:{components:{toJSON():unknown}[]})=>{view=JSON.stringify(payload.components.map(item=>item.toJSON()));}}) as never);
  assert.ok(!view.includes('own:message:edit'));assert.ok(view.includes('own:message:delete'));
});

test('保存0の投稿履歴画面はログを照会せず、利用できない操作を説明する',async()=>{
  const bot=app();const config=structuredClone(snapshot.config);config.policy.retentionDays=0;
  bot.store.settings=async()=>({...snapshot,config});
  bot.store.ownPosts=async()=>{throw new Error('履歴を照会しない');};
  let message='';bot.respond=async(_interaction,components)=>{message=JSON.stringify(components.map(component=>component.toJSON()));};
  await bot.mine(interaction() as never);assert.ok(message.includes('投稿履歴を保存していません'));assert.ok(message.includes('本人編集・削除・送信結果照合'));
});
