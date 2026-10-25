import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PermissionsBitField, type Client, type RepliableInteraction, type ButtonInteraction, type ModalSubmitInteraction } from 'discord.js';
import { App } from '../src/app.js';
import { defaults } from '../src/domain/config.js';
import { validatePost, validateText, type PostInput } from '../src/domain/validation.js';
import { UserError, BlockedWordError, FloodControlError } from '../src/domain/errors.js';
import type { Store } from '../src/infra/store.js';
import { SecretBox } from '../src/infra/secrets.js';
import { MediaService } from '../src/media/service.js';

function request(overrides:Record<string,unknown>={}) {
  return {id:'operation',guildId:'guild',channelId:'channel',user:{id:'alice'},member:{roles:[]},memberPermissions:new PermissionsBitField(0n),
    isCommand:()=>false,isButton:()=>true,isModalSubmit:()=>false,deferred:true,replied:false,
    deferUpdate:async()=>{},deferReply:async()=>{},deleteReply:async()=>{},editReply:async()=>{},...overrides} as unknown as RepliableInteraction;
}
function nodes(value:any):any[] {
  if(Array.isArray(value))return value.flatMap(nodes);
  return value&&typeof value==='object'?[value,...nodes(value.components),...nodes(value.component)]:[];
}
function fixture() {
  const config=structuredClone(defaults);config.policy.blockedWords=['改造'];
  const snapshot={guildId:'guild',channelId:'channel',base:config,config,overrides:{},guildVersion:0,channelVersion:0,enabled:true,panelId:null,webhook:null};
  const bot=new App({} as Client,{settings:async()=>snapshot,checkFlood:async()=>{}} as unknown as Store,new SecretBox(randomBytes(32).toString('base64')),new MediaService());
  const views:any[]=[];const posts:PostInput[]=[];const edits:{id:string;text:string}[]=[];
  bot.respond=async(_interaction,components)=>{views.push(components.map(component=>component.toJSON()));};
  bot.panels.bump=async()=>{};
  bot.posting.publish=async input=>{validatePost(input,config);posts.push(input);return 'https://discord.com/channels/guild/channel/message';};
  bot.posting.edit=async(_guild,_channel,id,user,text)=>{assert.equal(user,'alice');validateText(text,config,2000);edits.push({id,text});};
  const recoveryId=()=>nodes(views.at(-1)).find(node=>node.custom_id?.startsWith('blocked:'))!.custom_id.split(':')[1] as string;
  const click=(id:string,action:string,overrides:Record<string,unknown>={})=>request({customId:`blocked:${id}:${action}`,...overrides}) as ButtonInteraction;
  return {bot,config,views,posts,edits,recoveryId,click};
}

test('連投制限中はURL・添付の取得前に止め、公開案内に理由・時間・エラーID・報告ボタンを出さない', async () => {
  const f = fixture(); let downloads = 0;
  f.bot.posting.preflight = async () => { throw new FloodControlError(); };
  f.bot.media.fromUrl = async () => { downloads++; throw new Error('取得されるべきではありません'); };
  f.bot.media.attachments = async () => { downloads++; throw new Error('取得されるべきではありません'); };
  await assert.rejects(f.bot.prepareUrl(request(), 'https://example.com/image.jpg', '画像'), FloodControlError);
  await assert.rejects(f.bot.modal(request({ customId: 'submit:image', fields: { fields: new Map([['text', {}]]), getTextInputValue: () => '画像' } }) as ModalSubmitInteraction), FloodControlError);
  f.bot.component = async () => { throw new FloodControlError(); };
  await f.bot.handle(request({ isRepliable: () => true, isChatInputCommand: () => false, isMessageContextMenuCommand: () => false }) as any);
  assert.equal(downloads, 0);
  const result = JSON.stringify(f.views.at(-1));
  assert.ok(result.includes('現在、利用が制限されています。'));
  for (const hidden of ['3000', '9000', '10分', 'エラーID', 'バグを報告']) assert.ok(!result.includes(hidden));
});

test('拒否した本文を編集モーダルへ戻し、添付・返信先・出典を保って伏字で再送できる',async()=>{
  const f=fixture();const text='Switch2改造\n改造の話';
  const files=[{data:Buffer.from('file'),name:'file.txt',kind:'file' as const}];
  await f.bot.send(request(),text,files,'https://example.com/source','reply',['https://example.com/video']);
  assert.equal(f.posts.length,0);assert.ok(JSON.stringify(f.views).includes('`改造`'));
  const id=f.recoveryId();let modal:any;
  await f.bot.component(f.click(id,'edit',{showModal:async(value:any)=>{modal=value.toJSON();}}));
  assert.equal(nodes(modal).find(node=>node.custom_id==='text').value,text);
  await f.bot.component(f.click(id,'mask'));
  assert.equal(f.posts.length,1);assert.equal(f.posts[0]!.text,'Switch2＊＊\n＊＊の話');
  assert.equal(f.posts[0]!.media,files);assert.equal(f.posts[0]!.replyTo,'reply');
  assert.equal(f.posts[0]!.source,'https://example.com/source');assert.deepEqual(f.posts[0]!.videoLinks,['https://example.com/video']);
  await assert.rejects(f.bot.component(f.click(id,'mask')),/有効期限/);assert.equal(f.posts.length,1);
});

test('再送時の最新設定を使い、手動修正で禁止語が残っていても再検査する',async()=>{
  const f=fixture();await f.bot.send(request(),'A改造B',[]);
  const original=f.recoveryId();f.config.policy.blockedWords.push('A');
  await f.bot.modal(request({isModalSubmit:()=>true,customId:`blocked:${original}:submit`,fields:{getTextInputValue:()=> 'A改造B'}}) as ModalSubmitInteraction);
  assert.equal(f.posts.length,0);const latest=f.recoveryId();assert.notEqual(latest,original);
  await f.bot.component(f.click(latest,'mask'));assert.equal(f.posts[0]!.text,'＊＊＊B');
});

test('手動で修正した本文を再送し、元の入力は書き換えず復元できる',async()=>{
  const f=fixture();await f.bot.send(request(),'改造についての本文',[]);const id=f.recoveryId();
  await f.bot.modal(request({customId:`blocked:${id}:submit`,fields:{getTextInputValue:()=> '開発についての本文'}}) as ModalSubmitInteraction);
  assert.equal(f.posts[0]!.text,'開発についての本文');assert.equal(f.posts.length,1);
  await assert.rejects(f.bot.component(f.click(id,'mask')),/有効期限/);
});

test('伏字にしても他の禁止語や投稿ロールの制限をすり抜けない',async()=>{
  const words=fixture();await words.bot.send(request(),'改造',[]);words.config.policy.blockedWords.push('**');
  await words.bot.component(words.click(words.recoveryId(),'mask'));
  assert.equal(words.posts.length,0);assert.ok(JSON.stringify(words.views.at(-1)).includes('`**`'));
  const roles=fixture();await roles.bot.send(request(),'改造',[]);roles.config.policy.allowedRoles=['500000000000000001'];
  await assert.rejects(roles.bot.component(roles.click(roles.recoveryId(),'mask')),/ロール/);assert.equal(roles.posts.length,0);
});

test('処理中に同じ再送ボタンを押しても投稿は1回だけになる',async()=>{
  const f=fixture();await f.bot.send(request(),'改造',[]);const id=f.recoveryId();
  let start!:()=>void,finish!:()=>void;
  const started=new Promise<void>(resolve=>{start=resolve;});const pending=new Promise<void>(resolve=>{finish=resolve;});
  const publish=f.bot.posting.publish;
  f.bot.posting.publish=async input=>{start();await pending;return publish(input);};
  const first=f.bot.component(f.click(id,'mask'));await started;
  await assert.rejects(f.bot.component(f.click(id,'mask')),/有効期限|処理中/);
  finish();await first;assert.equal(f.posts.length,1);
});

test('投稿後の編集では拒否された編集文を戻し、伏字は元のメッセージにだけ反映する',async()=>{
  const f=fixture();const attempted='変更した改造の説明';
  await f.bot.modal(request({customId:'selfedit:message',fields:{getTextInputValue:()=>attempted}}) as ModalSubmitInteraction);
  assert.equal(f.edits.length,0);const id=f.recoveryId();let modal:any;
  await f.bot.component(f.click(id,'edit',{showModal:async(value:any)=>{modal=value.toJSON();}}));
  const field=nodes(modal).find(node=>node.custom_id==='text');assert.equal(field.value,attempted);assert.equal(field.max_length,2000);
  await f.bot.component(f.click(id,'mask'));
  assert.deepEqual(f.edits,[{id:'message',text:'変更した＊＊の説明'}]);assert.equal(f.posts.length,0);
});

test('画像説明文の変更も確認し、拒否された入力を修正するまで下書きへ反映しない',async()=>{
  const f=fixture();const files=[{data:Buffer.from('image'),name:'image.png',kind:'image' as const}];
  const preview=f.bot.previews.create({owner:'alice',guildId:'guild',channelId:'channel',text:'元の説明',files,source:'url',warnings:[],selected:[0],sending:false,videoLinks:[]});
  await f.bot.modal(request({customId:`caption:${preview}`,fields:{getTextInputValue:()=> '改造の説明'}}) as ModalSubmitInteraction);
  assert.equal(f.bot.previews.get(preview,'alice','guild').text,'元の説明');
  let restored:any;
  await f.bot.component(f.click(f.recoveryId(),'mask',{editReply:async(value:any)=>{restored=value;}}));
  assert.equal(f.bot.previews.get(preview,'alice','guild').text,'＊＊の説明');assert.equal(f.posts.length,0);
  assert.equal(restored.files.length,1);assert.equal(restored.files[0].name,'image.png');assert.deepEqual(restored.attachments,[]);
});

test('URL投稿の説明文を修正しても取得元URLは変えず、禁止されたURLは本文として再送しない',async()=>{
  const f=fixture();const source='https://example.com/image.png';let fetched='';
  f.bot.media.fromUrl=async url=>{fetched=url;return {files:[],source:url,warnings:[],videoLinks:[]};};
  await f.bot.prepareUrl(request(),source,'改造の画像');assert.equal(fetched,'');
  await f.bot.component(f.click(f.recoveryId(),'mask'));assert.equal(fetched,source);
  await assert.rejects(f.bot.prepareUrl(request(),'https://example.com/改造','本文'),error=>error instanceof BlockedWordError&&error.scope==='source');
});

test('本人・元サーバー・元チャンネル・10分の有効期限を確認する',async()=>{
  const f=fixture();await f.bot.send(request(),'改造',[]);const id=f.recoveryId();
  await assert.rejects(f.bot.component(f.click(id,'mask',{user:{id:'bob'}})),/本人/);
  await assert.rejects(f.bot.component(f.click(id,'mask',{guildId:'other'})),/本人/);
  await assert.rejects(f.bot.component(f.click(id,'mask',{channelId:'other'})),/元のチャンネル/);
  const now=Date.now();const clock=mock.method(Date,'now',()=>now+600_001);
  try{await assert.rejects(f.bot.component(f.click(id,'mask')),/有効期限/);}finally{clock.mock.restore();}
  assert.equal(f.posts.length,0);
});

test('送信結果が不明なエラーでは同じ再送ボタンを再利用できない',async()=>{
  const f=fixture();await f.bot.send(request(),'改造',[]);const id=f.recoveryId();
  f.bot.posting.publish=async()=>{throw new UserError('送信結果を確認してください');};
  await assert.rejects(f.bot.component(f.click(id,'mask')),/送信結果/);
  await assert.rejects(f.bot.component(f.click(id,'mask')),/有効期限/);
});
