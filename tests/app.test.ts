import { test, mock, before } from 'node:test';
import { initializeBotAdmins } from '../src/domain/permissions.js';
before(() => initializeBotAdmins('https://admin.example/id',async()=> '483307286513582090'));
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PermissionFlagsBits, PermissionsBitField, ComponentType, ChannelType } from 'discord.js';
import { App } from '../src/app.js';
import { defaults } from '../src/domain/config.js';
import { SecretBox } from '../src/infra/secrets.js';
import { MediaService } from '../src/media/service.js';
import { UserError, MediaSafetyError } from '../src/domain/errors.js';
import { z } from 'zod';
import type { Store } from '../src/infra/store.js';
import type { Client, RepliableInteraction, ButtonInteraction, ModalSubmitInteraction } from 'discord.js';

const snapshot = { guildId: 'g', channelId: 'c', base: structuredClone(defaults), config: structuredClone(defaults), overrides: {}, guildVersion: 0, channelVersion: 0, enabled: true, panelId: null, webhook: null };
function app() {
  return new App({} as Client, { settings: async () => structuredClone(snapshot), reportDetail: async () => null, checkFlood: async () => {}, savedSetups: async () => [] } as unknown as Store,
    new SecretBox(randomBytes(32).toString('base64')), new MediaService());
}
function interaction(overrides: Record<string, unknown> = {}) {
  return { guildId: 'g', channelId: 'c', user: { id: 'alice' }, member: { roles: [] }, memberPermissions: new PermissionsBitField(0n), isCommand:()=>false, ...overrides } as unknown as RepliableInteraction;
}

test('プレビューは全体のメモリ上限を超えるデータを保持しない', () => {
  const bot = app();
  assert.throws(() => bot.previews.create({ owner: 'alice', guildId: 'g', channelId: 'c', files: [], text: '', source: '', warnings: [], selected: [], sending: false, videoLinks: [] }, 64 * 1024 * 1024 + 1), /混み合って/);
});

test('/setupと案内の埋め込み編集は選択数上限が選択肢数以内の画面を返す', async () => {
  const bot = app(); const views: unknown[] = [];
  bot.respond = async (_interaction, components) => { views.push(components.map(component => component.toJSON())); };
  const manager = { memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild) };
  await bot.command(interaction({ ...manager, commandName: 'setup', options: { getString: () => 'image' } }) as never);
  bot.store.settings = async () => ({ ...structuredClone(snapshot), panelId: 'panel' });
  await bot.context(interaction({ ...manager, commandName: '埋め込みを編集（Admin）', targetId: 'panel' }) as never);
  const inspect = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(inspect); return; }
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    if (item.type === ComponentType.StringSelect) assert.ok(Number(item.max_values ?? 1) <= (item.options as unknown[]).length);
    Object.values(item).forEach(inspect);
  };
  assert.equal(views.length, 2); views.forEach(inspect);
});

test('/setupはモード引数なしで機能・ルール・確認を進め、設置までは公開しない', async () => {
  const bot = app(); let shown = ''; let saved = 0;
  bot.respond = async (_interaction, components) => { shown = JSON.stringify(components.map(component => component.toJSON())); };
  bot.store.saveSettings = async () => { throw new Error('確認前に保存してはいけない'); };
  const manager = { memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild) };
  await bot.command(interaction({ ...manager, commandName: 'setup', options: { getString: () => { throw new Error('引数は不要'); } } }) as never);
  const id = shown.match(/cfg:([a-f0-9]+):features/)![1]!;
  const session = bot.editors.get(id, 'alice', 'g');
  const choose = async (action: string, values: string[] = []) => {
    await bot.configure(interaction({ ...manager, values, isStringSelectMenu: () => true, update: async (value: unknown) => { shown = JSON.stringify(value); } }) as never, id, action);
  };
  assert.ok(shown.includes('1/3')); assert.equal(session.setupPage, 0);
  assert.equal(session.value.content?.urls, false); assert.ok(!shown.includes(`cfg:${id}:providers`));
  await choose('features', ['urls']);
  assert.equal((session.value.content as { text: boolean }).text, false);
  assert.equal(session.value.content?.images, false); assert.equal(session.value.content?.urls, true);
  await assert.rejects(choose('save'), /確認ページ/);
  await choose('setupnext'); assert.ok(shown.includes('2/3'));
  await choose('directposts'); assert.equal(session.value.moderation?.allowDirectPosts, true);
  await choose('safety', ['nsfw']); assert.equal(session.value.content?.allowNsfw, true); assert.equal(session.value.content?.allowNsfl, false);
  await choose('setupprev'); assert.equal(session.setupPage, 0); assert.equal(session.value.content?.allowNsfw, true);
  assert.ok(shown.includes('送信できるSNSを設定'));
  await choose('providers', ['x']); assert.deepEqual(session.value.content?.providers, ['x']);
  await choose('back'); assert.ok(shown.includes('1/3'));
  await choose('setupnext'); await choose('setupnext'); assert.ok(shown.includes('3/3')); assert.ok(shown.includes('この内容で設置'));
  bot.saveEditor = async () => { saved++; };
  await bot.configure(interaction({ ...manager, deferUpdate: async () => {} }) as never, id, 'save'); assert.equal(saved, 1);
});

test('/setupで保存済み設定を確認して再設置し、新しく設定することも選べる', async () => {
  const bot=app();let shown='';let applied=0;
  const config=structuredClone(defaults);config.panel.title='停止前の案内';config.content.allowNsfw=true;
  bot.store.settings=async()=>({...structuredClone(snapshot),config});
  bot.store.savedSetups=async()=>[{channelId:'c',name:'前のチャンネル',title:config.panel.title,enabled:false,savedAt:null}];
  bot.respond=async(_i,components)=>{shown=JSON.stringify(components.map(component=>component.toJSON()));};
  const manager={memberPermissions:new PermissionsBitField(PermissionFlagsBits.ManageGuild)};
  const open=async()=>{await bot.command(interaction({...manager,commandName:'setup',options:{getString:()=>null}}) as never);return shown.match(/cfg:([a-f0-9]+):reusesource/)![1]!;};
  bot.saveEditor=async(_i,_id,session)=>{applied++;assert.equal(session.channelId,'c');assert.equal(session.value.panel?.title,'停止前の案内');assert.equal(session.value.content?.allowNsfw,true);};
  const id=await open();assert.ok(shown.includes('停止前の案内'));assert.equal(applied,0);
  await bot.configure(interaction({...manager,deferUpdate:async()=>{}}) as never,id,'reuseapply');assert.equal(applied,1);
  const fresh=await open();
  await bot.configure(interaction({...manager,update:async(value:unknown)=>{shown=JSON.stringify(value);}}) as never,fresh,'newsetup');
  assert.ok(shown.includes('1/3'));assert.equal(bot.editors.get(fresh,'alice','g').value.content?.allowNsfw,false);
});

test('別・削除済みチャンネルの設定はプレビューしてから今のチャンネルへコピーし、候補外は拒否する', async () => {
  const bot=app();let shown='';let applied=0;
  bot.store.savedSetups=async()=>[{channelId:'deleted',name:'削除したチャンネル',title:'元の案内',enabled:true,savedAt:null}];
  bot.store.savedSetup=async(g,c)=>{assert.equal(g,'g');assert.equal(c,'deleted');return {...structuredClone(defaults),panel:{...defaults.panel,title:'元の案内'}};};
  bot.respond=async(_i,components)=>{shown=JSON.stringify(components.map(component=>component.toJSON()));};
  const manager={memberPermissions:new PermissionsBitField(PermissionFlagsBits.ManageGuild)};
  await bot.command(interaction({...manager,commandName:'setup'}) as never);
  const id=shown.match(/cfg:([a-f0-9]+):reusesource/)![1]!;
  const request=(source:string)=>interaction({...manager,values:[source],isStringSelectMenu:()=>true,update:async(value:unknown)=>{shown=JSON.stringify(value);}});
  await assert.rejects(bot.configure(request('outside') as never,id,'reusesource'),/候補/);
  await bot.configure(request('deleted') as never,id,'reusesource');assert.ok(shown.includes('元の案内'));
  bot.saveEditor=async(_i,_id,session)=>{applied++;assert.equal(session.original.channelId,'c');assert.equal(session.value.panel?.title,'元の案内');};
  assert.equal(applied,0);await bot.configure(interaction({...manager,deferUpdate:async()=>{}}) as never,id,'reuseapply');assert.equal(applied,1);
});

test('バックアップは選択とプレビューまで下書きを変えず、削除には確認が必要', async () => {
  const bot=app();let shown='';
  const id=bot.editors.create({owner:'alice',guildId:'g',channelId:'c',scope:'channel',original:snapshot,value:{panel:{title:'編集中'}},installing:false});
  let deleted=false;
  bot.store.settingsBackups=async()=>deleted?[]:[{id:'1',createdAt:new Date(),channelId:'c',channelName:'保存元'}];
  bot.store.settingsBackup=async()=>deleted?null:{panel:{title:'変更前'}};
  bot.store.deleteSettingsBackup=async()=>{deleted=true;return true;};
  const request=(selected='1')=>interaction({values:[selected],isStringSelectMenu:()=>true,memberPermissions:new PermissionsBitField(PermissionFlagsBits.ManageGuild),update:async(value:unknown)=>{shown=JSON.stringify(value);}});
  await bot.configure(request() as never,id,'restore');assert.ok(shown.includes('設定バックアップ'));assert.equal(bot.editors.get(id,'alice','g').value.panel?.title,'編集中');
  await assert.rejects(bot.configure(request('2') as never,id,'restoreselect'),/一覧/);
  await bot.configure(request() as never,id,'restoreselect');assert.ok(shown.includes('変更前'));
  await bot.configure(request() as never,id,'restorecancel');assert.equal(bot.editors.get(id,'alice','g').value.panel?.title,'編集中');
  await assert.rejects(bot.configure(request() as never,id,'restoreapply'),/確認画面/);
  await bot.configure(request() as never,id,'restore');await bot.configure(request() as never,id,'restoreselect');await bot.configure(request() as never,id,'restoreapply');assert.equal(bot.editors.get(id,'alice','g').value.panel?.title,'変更前');
  await bot.configure(request() as never,id,'restore');await bot.configure(request() as never,id,'restoreselect');
  await assert.rejects(bot.configure(request() as never,id,'restoredeleteconfirm'),/削除確認/);
  await bot.configure(request() as never,id,'restoredelete');assert.ok(shown.includes('削除しますか'));assert.equal(deleted,false);
  await bot.configure(request() as never,id,'restoredeletecancel');assert.equal(deleted,false);
  await bot.configure(request() as never,id,'restoredelete');await bot.configure(request() as never,id,'restoredeleteconfirm');assert.equal(deleted,true);
  assert.ok(shown.includes('バックアップはありません'));assert.equal(bot.editors.get(id,'alice','g').value.panel?.title,'変更前');
});

test('停止中の案内は再開確認後に編集し、保存するまでは受付を再開しない',async()=>{
  const bot=app();let shown='',saved=0;
  const stopped={...structuredClone(snapshot),enabled:false,panelId:'stopped-panel'};
  bot.store.settings=async()=>stopped;
  bot.respond=async(_interaction,components)=>{shown=JSON.stringify(components.map(component=>component.toJSON()));};
  const manager={memberPermissions:new PermissionsBitField(PermissionFlagsBits.ManageGuild)};
  const open=async()=>{
    await bot.context(interaction({...manager,commandName:'埋め込みを編集（Admin）',targetId:'stopped-panel'}) as never);
    assert.ok(shown.includes('匿名投稿の受付を再開しますか'));
    return shown.match(/cfg:([a-f0-9]+):resumeconfirm/)![1]!;
  };
  const request=()=>interaction({...manager,update:async(value:unknown)=>{shown=JSON.stringify(value);},deferUpdate:async()=>{}});
  const cancelled=await open();await bot.configure(request() as never,cancelled,'cancel');assert.equal(stopped.enabled,false);
  const id=await open();
  await assert.rejects(bot.configure(request() as never,id,'save'),/再開を確認/);
  await bot.configure(request() as never,id,'resumeconfirm');assert.ok(shown.includes('保存して再開'));assert.equal(stopped.enabled,false);
  bot.saveEditor=async(_interaction,_id,session)=>{assert.equal(session.installing,true);assert.equal(session.resuming,true);saved++;};
  await bot.configure(request() as never,id,'save');assert.equal(saved,1);
});

test('他チャンネルのバックアップは適用直前にも保存元の管理権限を確認する',async()=>{
  const bot=app();const role='400000000000000088';let revoked=false;
  bot.store.settings=async(_g,c)=>({...structuredClone(snapshot),config:{...structuredClone(defaults),moderation:{...defaults.moderation,managerRoles:c==='source'&&revoked?[]:[role]}}});
  bot.store.settingsBackups=async(_g,roles)=>{assert.deepEqual(roles,[role]);return [{id:'1',createdAt:new Date(),channelId:'source',channelName:'保存元'}];};
  bot.store.settingsBackup=async()=>({...structuredClone(defaults),panel:{...defaults.panel,title:'保存元の内容'}});
  const id=bot.editors.create({owner:'alice',guildId:'g',channelId:'c',scope:'channel',original:snapshot,value:{},installing:false});
  const request=()=>interaction({member:{roles:[role]},values:['1'],isStringSelectMenu:()=>true,update:async()=>{}});
  await bot.configure(request() as never,id,'restore');await bot.configure(request() as never,id,'restoreselect');
  revoked=true;
  await assert.rejects(bot.configure(request() as never,id,'restoreapply'),/管理権限/);
  assert.deepEqual(bot.editors.get(id,'alice','g').value,{});
});

test('バックアップ一覧は25件ずつ移動し、非表示の候補や期限切れの設定を適用できない',async()=>{
  const bot=app();let shown='';let expired=false;
  const backups=Array.from({length:27},(_,index)=>({id:String(100-index),createdAt:new Date(),channelId:'c',channelName:'保存先'}));
  bot.store.settingsBackups=async(_guild,_roles,before)=>backups.filter(item=>!before||BigInt(item.id)<BigInt(before)).slice(0,26);
  bot.store.settingsBackup=async()=>expired?null:structuredClone(defaults);
  const id=bot.editors.create({owner:'alice',guildId:'g',channelId:'c',scope:'channel',original:snapshot,value:{},installing:false});
  const request=(selected='75')=>interaction({memberPermissions:new PermissionsBitField(PermissionFlagsBits.ManageGuild),values:[selected],isStringSelectMenu:()=>true,update:async(value:unknown)=>{shown=JSON.stringify(value);}});
  await bot.configure(request() as never,id,'restore');
  await assert.rejects(bot.configure(request() as never,id,'restoreselect'),/一覧/);
  await bot.configure(request() as never,id,'restorenext');assert.ok(shown.includes('2ページ目'));
  await bot.configure(request() as never,id,'restoreselect');
  expired=true;await assert.rejects(bot.configure(request() as never,id,'restoreapply'),/保存期限切れ/);
  assert.deepEqual(bot.editors.get(id,'alice','g').value,{});
  await bot.configure(request() as never,id,'restoreprev');assert.ok(shown.includes('1ページ目'));
});

test('別チャンネルの設定選択時も管理権限を再確認する',async()=>{
  const bot=app();let shown='';const role='400000000000000091';
  bot.store.settings=async(_g,c)=>({...structuredClone(snapshot),config:{...structuredClone(defaults),moderation:{...defaults.moderation,managerRoles:c==='c'?[role]:[]}}});
  bot.store.savedSetups=async(_g,_c,_offset,roles)=>{assert.deepEqual(roles,[role]);return [{channelId:'restricted',name:null,title:'非公開',enabled:false,savedAt:null}];};
  bot.store.savedSetup=async()=>{throw new Error('権限なしでは読み取らない');};
  bot.respond=async(_i,components)=>{shown=JSON.stringify(components.map(component=>component.toJSON()));};
  const request={member:{roles:[role]},memberPermissions:new PermissionsBitField(0n)};
  await bot.command(interaction({...request,commandName:'setup'}) as never);const id=shown.match(/cfg:([a-f0-9]+):reusesource/)![1]!;
  await assert.rejects(bot.configure(interaction({...request,values:['restricted'],isStringSelectMenu:()=>true}) as never,id,'reusesource'),/管理ロール/);
});

test('埋め込み編集のSNS一覧はURL取得を選んだ先に表示する', async () => {
  const bot = app(); let shown = '';
  const id = bot.editors.create({ owner: 'alice', guildId: 'g', channelId: 'c', scope: 'channel', original: snapshot, value: {}, installing: false });
  const request = { memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild), values: ['text', 'images', 'urls', 'caption'], isStringSelectMenu: () => true, update: async (value: unknown) => { shown = JSON.stringify(value); } };
  await bot.configure(interaction(request) as never, id, 'back'); assert.ok(shown.includes(`cfg:${id}:providers`)); assert.ok(shown.includes(`cfg:${id}:appearance`));
  await bot.configure(interaction(request) as never, id, 'content'); assert.ok(shown.includes('送信できるSNSを設定')); assert.ok(shown.includes(`cfg:${id}:providers`));
  assert.ok(shown.includes(`cfg:${id}:content`)); assert.ok(!shown.includes(`cfg:${id}:providersview`));
  assert.ok(shown.includes(`cfg:${id}:appearance`));
  await bot.configure(interaction({ ...request, values: ['text', 'images'] }) as never, id, 'content'); assert.ok(!shown.includes(`cfg:${id}:providers`));
  for (const action of ['management','filter','other','export','import']) assert.ok(shown.includes(`cfg:${id}:${action}`));
  await bot.configure(interaction(request) as never,id,'other');assert.ok(shown.includes('その他の設定'));
  let modal='';
  for(const action of ['limitsbasic','spam']) {
    await bot.configure(interaction({...request,showModal:async(value:unknown)=>{modal=JSON.stringify(value);}}) as never,id,action);
    assert.ok(modal.includes(`edit:${id}:${action}`));
  }
  for (const action of ['identity','urlcleanup','references'])assert.ok(shown.includes(`cfg:${id}:${action}`));
  await bot.configure(interaction(request) as never, id, 'back'); assert.ok(shown.includes('追加したい機能'));
});

test('標準・初期値へのリセットは確認必須で、キャンセル時は下書きを保持する', async () => {
  for (const scope of ['channel', 'guild'] as const) {
    const bot = app(); let shown = '';
    const original = { ...structuredClone(defaults), panel: { ...defaults.panel, title: '編集中の設定' } };
    const id = bot.editors.create({ owner: 'alice', guildId: 'g', channelId: 'c', scope, original: snapshot, value: original, installing: true });
    const session = bot.editors.get(id, 'alice', 'g');
    const request = () => interaction({ memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild), update: async (value: unknown) => { shown = JSON.stringify(value); } });
    await assert.rejects(bot.configure(request() as never, id, 'resetconfirm'), /確認画面/);
    await bot.configure(request() as never, id, 'reset'); assert.ok(shown.includes('resetconfirm')); assert.deepEqual(session.value, original);
    await bot.configure(request() as never, id, 'resetcancel'); assert.deepEqual(session.value, original);
    await assert.rejects(bot.configure(request() as never, id, 'resetconfirm'), /確認画面/);
    await bot.configure(request() as never, id, 'reset');
    await assert.rejects(bot.configure(interaction({ ...request(), user: { id: 'bob' } }) as never, id, 'resetconfirm'), /本人/);
    assert.deepEqual(session.value, original);
    await bot.configure(request() as never, id, 'resetconfirm'); assert.deepEqual(session.value, scope === 'guild' ? defaults : {});
  }
});

test('機能変更で説明文を切り替え、手動で書いた説明文は維持する', async () => {
  const bot = app();
  const id = bot.editors.create({ owner: 'alice', guildId: 'g', channelId: 'c', scope: 'channel', original: snapshot, value: {}, installing: true, setupPage: 0 });
  const session = bot.editors.get(id, 'alice', 'g');
  const request = (values: string[]) => interaction({ values, memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild), isStringSelectMenu: () => true, update: async () => {} });
  for (const [values, phrase] of [[['text'], 'メッセージを送信'], [['images'], '画像を送信'], [['text', 'images'], 'メッセージや画像を送信'], [['urls'],'画像を送信']] as const) {
    await bot.configure(request([...values]) as never, id, 'features'); assert.ok(session.value.panel?.description?.includes(phrase));
    assert.equal(session.value.content?.images,values.some(value=>value==='images'));
    assert.equal(session.value.content?.urls,values.some(value=>value==='urls'));
  }
  session.setupPage = undefined;
  await bot.configure(request(['urls']) as never,id,'content');assert.equal(session.value.content?.images,false);assert.equal(session.value.content?.urls,true);
  assert.equal(session.value.content?.caption,true);
  await bot.configure(request(['urls','noCaption']) as never,id,'content');assert.equal(session.value.content?.caption,false);
  await bot.configure(request(['urls']) as never,id,'content');assert.equal(session.value.content?.caption,true);
  session.setupPage = undefined; session.value.panel = { ...session.value.panel, description: '手動の説明文' };
  await bot.configure(request(['text']) as never, id, 'content'); assert.equal(session.value.panel.description, '手動の説明文');
});

test('処理失敗時は画面と保存詳細に同じエラーコードを付ける', async () => {
  const bot = app(); let savedCode = ''; let shown = '';
  bot.command = async () => { throw new Error('設定画面の検証に失敗'); };
  bot.store.saveDiagnostic = async (code, _guild, _channel, _interaction, action, details) => {
    savedCode = code; assert.equal(action, 'setup'); assert.ok(details.includes('設定画面の検証に失敗'));
  };
  bot.respond = async (_interaction, components) => { shown = JSON.stringify(components.map(component => component.toJSON())); };
  const command = interaction({ id: 'interaction', commandName: 'setup', isRepliable: () => true, isChatInputCommand: () => true, isCommand: () => true });
  await bot.handle(command as never);
  assert.match(savedCode, /^[a-f0-9]{8}$/); assert.ok(shown.includes('`' + savedCode + '`'));
  assert.ok(!shown.includes('/error'));
  assert.ok(shown.includes('バグを報告'));
  const reportUrl = JSON.parse(shown)[0].components.flatMap((component:{components?:unknown[]})=>component.components??[]).find((component:{url?:string})=>component.url)?.url;
  assert.equal(new URL(reportUrl).searchParams.get('diagnostics')!.split('\n').at(-1), `エラーID: ${savedCode}`);
  assert.ok(!reportUrl.includes('設定画面の検証に失敗'));
  bot.store.saveDiagnostic = async () => { throw new Error('DB停止'); };
  await bot.handle(command as never);
  assert.ok(shown.includes('エラーID')); assert.ok(shown.includes('処理エラー')); assert.ok(shown.includes('時間をおいて再試行してください。'));
});

test('短いエラーIDの保存が衝突した場合は再生成したIDを表示する', async () => {
  const bot = app(); const attempted: string[] = []; let shown = '';
  bot.command = async () => { throw new Error('処理失敗'); };
  bot.store.saveDiagnostic = async code => {
    attempted.push(code);
    if (attempted.length === 1) throw Object.assign(new Error('重複ID'), { code: '23505' });
  };
  bot.respond = async (_interaction, components) => { shown = JSON.stringify(components.map(component => component.toJSON())); };
  await bot.handle(interaction({ id: 'interaction', commandName: 'setup', isRepliable: () => true, isChatInputCommand: () => true, isCommand: () => true }) as never);
  assert.equal(attempted.length, 2);
  assert.ok(shown.includes('`' + attempted[1] + '`'));
  const reportUrl = JSON.parse(shown)[0].components.flatMap((component:{components?:unknown[]})=>component.components??[]).find((component:{url?:string})=>component.url)?.url;
  assert.equal(new URL(reportUrl).searchParams.get('diagnostics')!.split('\n').at(-1), `エラーID: ${attempted[1]}`);
});

test('保存0と設定取得不能時のエラーは本文を記録せず、識別子もHMAC化して照会できる', async () => {
  const bot = app(); const output: unknown[] = []; const saved: unknown[][] = [];
  const logger = mock.method(console, 'error', (...args: unknown[]) => { output.push(args); });
  const snapshot0 = structuredClone(snapshot); snapshot0.config.policy.retentionDays = 0;
  bot.store.settings = async () => snapshot0;
  bot.store.saveDiagnostic = async (...args) => { saved.push(args); };
  bot.command = async () => { throw Object.assign(new Error('非公開の本文 300000000000000123'), { code: '23505' }); };
  bot.respond = async () => {};
  const request = interaction({ id: 'private-operation', guildId: 'private-guild', channelId: 'private-channel', commandName: 'post', isRepliable: () => true, isChatInputCommand: () => true, isCommand: () => true });
  try {
    await bot.handle(request as never);
    bot.store.settings = async () => { throw new Error('設定取得不能'); };
    await bot.handle(request as never);
    assert.equal(saved.length, 2);
    for (const args of saved) {
      assert.equal(args[6], true);
      for (const value of args.slice(1, 4)) assert.match(value as string, /^[a-f0-9]{64}$/);
      assert.ok(String(args[5]).includes('code=23505'));
    }
    for (const secret of ['非公開の本文', '300000000000000123', 'private-operation', 'private-guild', 'private-channel']) {
      assert.ok(!JSON.stringify(saved).includes(secret)); assert.ok(!JSON.stringify(output).includes(secret));
    }
    bot.store.settings = async () => snapshot0;
    bot.store.diagnostic = async (code, scope) => scope === saved[0]![1] ? { code, action: 'post', details: String(saved[0]![5]), created_at: new Date() } : null;
    let shown = '';
    bot.respond = async (_interaction, components) => { shown = JSON.stringify(components); };
    await App.prototype.command.call(bot, interaction({ guildId: 'private-guild', commandName: 'error', memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild), deferReply: async () => {}, options: { getString: () => saved[0]![0] } }) as never);
    assert.ok(shown.includes('23505'));
  } finally { logger.mock.restore(); }
});

test('権限や取得失敗の案内からも報告でき、投稿内容や内部エラーはURLへ含めない', async () => {
  const bot=app();let shown:unknown;
  bot.command=async()=>{throw new UserError('非公開のチャンネル <#1407703723907616809> で取得に失敗しました。');};
  bot.respond=async(_interaction,components)=>{shown=components[0]!.toJSON();};
  await bot.handle(interaction({isRepliable:()=>true,isChatInputCommand:()=>true,isCommand:()=>true,commandName:'setup'}) as never);
  const report=JSON.stringify(shown).match(/https:\/\/github[^\"]+/)![0];
  assert.ok(report.includes('template=bug-report.yml'));assert.ok(!decodeURIComponent(report).includes('1407703723907616809'));
  assert.ok(!decodeURIComponent(report).includes('エラーID'));
});

test('返信済みのエラーにも報告ボタンを付け、NSFW拒否と入力形式エラーには付けない', async () => {
  const bot=app();let response='';
  bot.store.saveDiagnostic=async()=>{};
  const request=interaction({isRepliable:()=>true,isChatInputCommand:()=>true,isCommand:()=>true,commandName:'setup',replied:true,deferred:false,
    followUp:async(value:unknown)=>{response=JSON.stringify(value);}});
  bot.command=async()=>{throw new Error('詳細');};await bot.handle(request as never);assert.ok(response.includes('バグを報告'));
  for(const error of [new MediaSafetyError('性的な画像でない場合は管理者にお問い合わせください'),z.string().safeParse(1).error!]){
    bot.command=async()=>{throw error;};await bot.handle(request as never);assert.ok(!response.includes('バグを報告'));assert.ok(!response.includes('エラーID'));
  }
});

test('/errorは新しいIDと保存済みの旧コードを同じサーバー内で照会する', async () => {
  const bot = app(); let shown = '';
  bot.respond = async (_interaction, components) => { shown = JSON.stringify(components.map(component => component.toJSON())); };
  for (const [input, expected] of [['0A4DCAF0', '0a4dcaf0'], ['err-0123456789abcdef', 'ERR-0123456789ABCDEF']]) {
    bot.store.diagnostic = async (code, guild) => {
      assert.equal(code, expected); assert.equal(guild, 'g');
      return { code, action: 'setup', details: '詳細テスト', created_at: new Date() };
    };
    await bot.command(interaction({ commandName: 'error', memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild), deferReply: async () => {}, options: { getString: () => input } }) as never);
    assert.ok(shown.includes('詳細テスト'));
  }
});

test('想定内の拒否と入力エラーにはエラーコードや照会案内を表示・保存しない', async () => {
  const bot = app(); let shown = ''; let saved = false;
  bot.store.saveDiagnostic = async () => { saved = true; };
  bot.respond = async (_interaction, components) => { shown = JSON.stringify(components.map(component => component.toJSON())); };
  for (const error of [new UserError('性的な画像でない場合は管理者にお問い合わせください'), z.string().safeParse(123).error!]) {
    bot.command = async () => { throw error; };
    await bot.handle(interaction({ id: 'i', commandName: 'setup', isRepliable: () => true, isChatInputCommand: () => true }) as never);
    assert.ok(!shown.includes('エラーコード')); assert.ok(!shown.includes('エラーID')); assert.ok(!shown.includes('処理エラー')); assert.ok(!shown.includes('/error')); assert.equal(saved, false);
  }
});
test('管理操作はサーバー管理権限か指定されたBot管理者を許可する', async () => {
  const bot = app();
  await assert.rejects(bot.requireManager(interaction()), /管理権限/);
  await assert.doesNotReject(bot.requireManager(interaction({ memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild) })));
  await assert.doesNotReject(bot.requireManager(interaction({ user: { id: '483307286513582090' } })));
  await assert.rejects(bot.requireManager(interaction({ user: { id: '483307286513582091' } })), /管理権限/);
});

test('通常チャンネルの保存ではアナウンスの処置ログ先も受け付け、問題のある設定先を区別する', async () => {
  const bot=app();let saved=0;let logType=ChannelType.GuildAnnouncement;
  const logPermissions=new PermissionsBitField([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]);
  const logId='200000000000000099';
  const config=structuredClone(defaults);config.moderation.logChannel=logId;
  const channel={id:'c',type:ChannelType.GuildText,guild:{id:'g',members:{fetchMe:async()=>({})}},isThread:()=>false,
    permissionsFor:()=>new PermissionsBitField(PermissionsBitField.All),send:async()=>({id:'new'})};
  bot.client.channels={fetch:async(id:string)=>id===logId?{...channel,id,type:logType,permissionsFor:()=>logPermissions}:channel} as never;
  bot.store.saveSettings=async()=>{saved++;};bot.store.setPanel=async()=>{};
  bot.posting.createWebhook=async()=> 'credential';bot.respond=async()=>{};
  const session={owner:'alice',guildId:'g',channelId:'c',scope:'channel' as const,original:snapshot,value:config,installing:false};
  await bot.saveEditor(interaction(),'unused',session);assert.equal(saved,1);
  logPermissions.remove(PermissionFlagsBits.SendMessages);
  await assert.rejects(bot.saveEditor(interaction(),'unused',session),/処置ログ先.*メッセージを送信/);
  assert.equal(saved,1);
  logPermissions.add(PermissionFlagsBits.SendMessages);
  logType=ChannelType.GuildForum;
  await assert.rejects(bot.saveEditor(interaction(),'unused',session),/処置ログ先（<#200000000000000099>）/);
  assert.equal(saved,1);
});

test('スレッドとフォーラム内の投稿で保存し、親フォーラムや別サーバーは対象外にする', async () => {
  for (const type of [ChannelType.PublicThread,ChannelType.PrivateThread,ChannelType.AnnouncementThread]) {
    const bot=app();let saved=0;
    const permissions=new PermissionsBitField(PermissionsBitField.All).remove([PermissionFlagsBits.SendMessages,PermissionFlagsBits.Administrator]);
    const channel={id:'c',type,guild:{id:'g',members:{fetchMe:async()=>({})}},isThread:()=>true,
      permissionsFor:()=>permissions,send:async()=>({id:'new'})};
    bot.client.channels={fetch:async()=>channel} as never;
    bot.store.saveSettings=async()=>{saved++;};bot.store.setPanel=async()=>{};
    bot.posting.createWebhook=async()=> 'credential';bot.respond=async()=>{};
    const session={owner:'alice',guildId:'g',channelId:'c',scope:'channel' as const,original:snapshot,value:{},installing:false};
    await bot.saveEditor(interaction(),'unused',session);assert.equal(saved,1);
    assert.equal(await bot.posting.threadIdFor('g','c'),'c');
    await assert.rejects(bot.channel('other','c'),/このサーバー/);
    permissions.remove(PermissionFlagsBits.SendMessagesInThreads);
    await assert.rejects(bot.saveEditor(interaction(),'unused',session),/スレッドで送信/);
  }
});

test('Bot管理者はDiscord管理権限なしでサーバー標準の編集とエラー詳細を利用できる', async () => {
  const bot = app(); const owner = { id:'483307286513582090' };
  const id = bot.editors.create({owner:owner.id,guildId:'g',channelId:'c',scope:'guild',original:snapshot,value:structuredClone(defaults),installing:false});
  bot.respond = async () => {};
  await bot.configure(interaction({user:owner,customId:`cfg:${id}:back`,update:async()=>{}}) as ButtonInteraction,id,'back');
  await bot.modal(interaction({user:owner,customId:`edit:${id}:appearance`,fields:{getTextInputValue:(name:string)=>({title:'管理者による変更',description:'',color:'なし',footer:''})[name]},isFromMessage:()=>true,update:async()=>{}}) as ModalSubmitInteraction);
  assert.equal(bot.editors.get(id,owner.id,'g').value.panel?.color,null);
  let checked = false;
  bot.store.diagnostic = async () => {checked=true;return null;};
  await assert.rejects(bot.command(interaction({user:owner,commandName:'error',deferReply:async()=>{},options:{getString:()=> '1234abcd'}}) as never),/見つかりません/);
  assert.equal(checked,true);
});

test('管理ロールだけではサーバー標準の編集画面を開けない',async()=>{
  const bot=app();const role='400000000000000090';
  bot.store.settings=async()=>({...structuredClone(snapshot),config:{...structuredClone(defaults),moderation:{...defaults.moderation,managerRoles:[role]}}});
  await assert.rejects(bot.command(interaction({commandName:'settings',member:{roles:[role]},options:{getString:()=> 'guild'}}) as never),/サーバー標準の変更/);
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

test('処罰なしは通報通知だけを更新し、処罰を選んだ場合だけ処罰ログに送る', async () => {
  for (const action of ['none', 'ban', 'timeout', 'restrict'] as const) {
    const bot = app(); const edited: unknown[] = []; const sent: unknown[] = []; const destinations: string[] = [];
    const config = structuredClone(defaults);
    config.moderation.reportChannel = 'reports'; config.moderation.logChannel = 'logs';
    bot.store.settings = async () => ({ ...structuredClone(snapshot), config });
    bot.client.guilds = { fetch: async () => ({}) } as never;
    bot.moderation.execute = async (_guild, _channel, _message, _actor, selected) => {
      assert.equal(selected, action);
      return { report: { notificationId: 'notice', anonymousId: 5 } as never, warning: '' };
    };
    bot.channel = async (_guild, channel) => {
      destinations.push(channel);
      return { messages: { edit: async (id: string, value: unknown) => { assert.equal(id, 'notice'); edited.push(value); } }, send: async (value: unknown) => { sent.push(value); } } as never;
    };
    bot.respond = async () => {};
    await bot.modal(interaction({ memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild), customId: `punishconfirm:m:${action}:c`, deferReply: async () => {}, fields: { getTextInputValue: () => '' } }) as ModalSubmitInteraction);
    assert.equal(edited.length, 1);
    assert.ok(JSON.stringify(edited).includes('終了済み'));
    assert.deepEqual(destinations, action === 'none' ? ['reports'] : ['reports', 'logs']);
    assert.equal(sent.length, action === 'none' ? 0 : 1);
    if (sent.length) {
      const punishment = action === 'ban' ? 'サーバーBANを実施しました。' : action === 'timeout' ? '一か月タイムアウトを実施しました。' : '匿名投稿の利用をこのチャンネルで無期限停止しました。';
      const content = `**❌匿名つぶやき処罰通知❌**\n\n**対象番号：**匿名005\n**処罰理由：**未記入\n${punishment}\n**元メッセージ：**[匿名つぶやき](https://discord.com/channels/g/c/m)${action === 'restrict' ? '' : '\n(対象メッセージは自動削除されています)'}`;
      assert.deepEqual(sent[0], { content, allowedMentions: { parse: [] } });
    }
  }
});

test('投稿の削除に失敗した処罰ログは削除済みと表示せず、理由のメンションも通知しない', async () => {
  const bot = app(); let sent: unknown;
  const config = structuredClone(defaults); config.moderation.logChannel = 'logs';
  bot.store.settings = async () => ({ ...structuredClone(snapshot), config });
  bot.client.guilds = { fetch: async () => ({}) } as never;
  bot.moderation.execute = async () => ({ report: { notificationId: null, anonymousId: 12 } as never, warning: '処罰は実行済みですが、元メッセージを削除できませんでした。' });
  bot.channel = async () => ({ send: async (value: unknown) => { sent = value; } }) as never;
  bot.respond = async () => {};
  await bot.modal(interaction({ memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild), customId: 'punishconfirm:m:ban:c', deferReply: async () => {}, fields: { getTextInputValue: () => '@everyone 確認済み' } }) as ModalSubmitInteraction);
  assert.deepEqual(sent, { content: '**❌匿名つぶやき処罰通知❌**\n\n**対象番号：**匿名012\n**処罰理由：**@everyone 確認済み\nサーバーBANを実施しました。\n**元メッセージ：**[匿名つぶやき](https://discord.com/channels/g/c/m)\n(対象メッセージを自動削除できませんでした)', allowedMentions: { parse: [] } });
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
  assert.equal((await bot.store.settings('g','c')).config.panel.imageStyle,defaults.panel.imageStyle);
  const before=structuredClone(session.value);values.helpStyle='pink';
  await assert.rejects(bot.modal(submit()));assert.deepEqual(session.value,before);assert.equal(updates,1);
});

test('その他の自動処理設定は下書きに保存し、変更後も説明付きの一覧に戻る',async()=>{
  const bot=app();const id=bot.editors.create({owner:'alice',guildId:'g',channelId:'c',scope:'channel',original:snapshot,value:{},installing:false,returnToOther:true});
  let shown='';let value='off';
  for(const [action,name] of [['urlcleanup','cleanUrls'],['references','linkReferences']] as const) {
    const submit=()=>interaction({customId:`edit:${id}:${action}`,memberPermissions:new PermissionsBitField(PermissionFlagsBits.ManageGuild),
      fields:{fields:new Map([[name,{type:ComponentType.StringSelect}]]),getStringSelectValues:()=>[value]},isFromMessage:()=>true,update:async(body:unknown)=>{shown=JSON.stringify(body);}}) as ModalSubmitInteraction;
    await bot.modal(submit());assert.equal(bot.editors.get(id,'alice','g').value.policy?.[name],false);
    assert.ok(shown.includes('その他の設定'));assert.ok(shown.includes('無効'));
    assert.equal((await bot.store.settings('g','c')).config.policy[name],true);
    const before=structuredClone(bot.editors.get(id,'alice','g').value);value='invalid';
    await assert.rejects(bot.modal(submit()),/有効・無効/);assert.deepEqual(bot.editors.get(id,'alice','g').value,before);
    value='off';
  }
});

test('利用停止の設定は下書きに保持し、解除は管理権限を確認して対象チャンネルだけに行う',async()=>{
  const bot=app();let shown='',released:unknown[]=[];
  const id=bot.editors.create({owner:'alice',guildId:'g',channelId:'c',scope:'channel',original:snapshot,value:{},installing:false,returnToOther:true});
  const manager={memberPermissions:new PermissionsBitField(PermissionFlagsBits.ManageGuild)};
  await bot.configure(interaction({...manager,update:async(value:unknown)=>{shown=JSON.stringify(value);}}) as never,id,'channelrestriction');
  assert.equal(bot.editors.get(id,'alice','g').value.moderation?.allowChannelRestriction,true);
  assert.equal((await bot.store.settings('g','c')).config.moderation.allowChannelRestriction,false);
  assert.ok(shown.includes('解除する'));assert.ok(shown.includes('下書き'));
  bot.store.releaseChannelRestriction=async(...args)=>{released=args;};
  await bot.modal(interaction({...manager,customId:`edit:${id}:restrictionrelease`,fields:{getTextInputValue:()=> '300000000000000099'},isFromMessage:()=>true,update:async(value:unknown)=>{shown=JSON.stringify(value);}}) as ModalSubmitInteraction);
  assert.deepEqual(released,['g','c','300000000000000099','alice']);assert.ok(shown.includes('利用停止を解除しました'));
});

test('案内の色は空欄と「なし」で解除でき、不正入力では下書きを変更しない', async () => {
  const bot = app();
  const id = bot.editors.create({owner:'alice',guildId:'g',channelId:'c',scope:'channel',original:snapshot,value:{},installing:false});
  const values: Record<string, string> = {title:defaults.panel.title,description:defaults.panel.description,color:'',footer:''};
  const submit = () => interaction({customId:`edit:${id}:appearance`,memberPermissions:new PermissionsBitField(PermissionFlagsBits.ManageGuild),
    fields:{getTextInputValue:(name:string)=>values[name]},isFromMessage:()=>true,update:async()=>{}}) as ModalSubmitInteraction;
  for (const color of ['', '#000000', 'なし', ' #5865f2 ']) {
    values.color = color;
    await bot.modal(submit());
    assert.equal(bot.editors.get(id,'alice','g').value.panel?.color, color.trim().startsWith('#') ? parseInt(color.trim().slice(1),16) : null);
  }
  assert.equal((await bot.store.settings('g','c')).config.panel.color, defaults.panel.color);
  const before = structuredClone(bot.editors.get(id,'alice','g').value);
  values.color = '#xyzxyz';
  await assert.rejects(bot.modal(submit()), /色は/);
  assert.deepEqual(bot.editors.get(id,'alice','g').value, before);
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
