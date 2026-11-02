import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags, ComponentType } from 'discord.js';
import { defaults, defaultPanelDescription, resolveConfig, urlMethodLabel, parseRetention, retentionLabel, importTemplate, exportTemplate } from '../src/domain/config.js';
import { panel, panelPayload, payload, help, legalLinks } from '../src/ui/components.js';
import { postModal } from '../src/ui/modals.js';
import { editorView, editorModal, managementView, otherView, setupView, reuseSetupView, backupsView, buttonSettingsView, resetConfirmationView, type EditorSession } from '../src/ui/editor.js';
import { postCard, previewView } from '../src/ui/post.js';
import { commands } from '../src/commands.js';

function flatten(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(flatten);
  if (!value || typeof value !== 'object') return [];
  const item = value as Record<string, unknown>;
  return [item, ...flatten(item.components), ...flatten(item.component), ...flatten(item.accessory)];
}
function customIds(value: unknown): string[] { return flatten(value).filter(item => typeof item.custom_id === 'string').map(item => item.custom_id as string); }

test('初期の案内ボタンは指定の文言・色・絵文字で、SNS名によらず共通のURLラベルになる', () => {
  assert.equal(defaults.panel.color,null);
  assert.equal(panel(defaults).toJSON().accent_color,undefined);
  const buttons = flatten(panel(defaults).toJSON()).filter(item => item.type === ComponentType.Button);
  assert.deepEqual(buttons.map(item => ({ label: item.label, style: item.style, emoji: (item.emoji as {name?: string} | undefined)?.name })), [
    { label: '匿名メッセージ送信', style: 1, emoji: '✍️' }, { label: '画像送信', style: 3, emoji: '🖼️' },
    { label: 'URLから画像送信', style: 4, emoji: '📎' }, { label: 'ヘルプ・詳細', style: 2, emoji: undefined },
  ]);
  const single = resolveConfig(defaults, { content: { providers: ['pixiv'] } });
  assert.equal(flatten(panel(single).toJSON()).find(item => item.custom_id === 'post:url')?.label, 'URLから画像送信');
  const urlOnly=resolveConfig(defaults,{content:{text:false,images:false,urls:true},panel:{urlButton:false}});
  assert.deepEqual(customIds(panel(urlOnly).toJSON()),['post:url','post:help']);
  assert.deepEqual(customIds(panel(resolveConfig(urlOnly,{content:{text:true,urls:false}})).toJSON()),['post:text','post:help']);
  for (const [content, subject] of [[{text:true,images:true,urls:true}, 'メッセージや画像'], [{text:false,images:true,urls:false}, '画像'], [{text:false,images:false,urls:true}, '画像']] as const) {
    assert.equal(defaultPanelDescription(content), `名前を公開せず匿名で${subject}を送信できます。\nルールや詳しい使い方は「ヘルプ・詳細」から確認してください。`);
  }
});

test('ヘルプはNSFW・NSFLの現在の許可設定をそれぞれ表示する', () => {
  for (const allowNsfw of [false, true]) for (const allowNsfl of [false, true]) {
    const config = resolveConfig(defaults, { content: { allowNsfw, allowNsfl } });
    const content = flatten(help(config).toJSON()).map(item => item.content ?? '').join('\n');
    assert.ok(content.includes(`**NSFW（性的な露出）**：${allowNsfw ? '許可' : '拒否'}`));
    assert.ok(content.includes(`**NSFL（グロ・流血）**：${allowNsfl ? '許可' : '拒否'}`));
  }
});

test('設定内の選択項目はすべて説明付きで、公開案内の投稿形式・保存期間は表示しない', () => {
  const config = structuredClone(defaults);
  const session: EditorSession = { owner: 'u', guildId: 'g', channelId: 'c', scope: 'guild', value: config,
    original: { guildId: 'g', channelId: 'c', base: config, config, overrides: {}, guildVersion: 0, channelVersion: 0, enabled: true, panelId: null, webhook: null }, installing: false };
  const views: unknown[] = [editorView('s', session).map(item => item.toJSON())];
  for (const setupPage of [0, 1, 2] as const) {
    const setup = setupView('s', { ...session, setupPage }).map(item => item.toJSON());
    assert.ok(!customIds(setup).includes('cfg:s:restore'));
    views.push(setup);
  }
  for (const action of ['display', 'caption', 'styles', 'identity']) views.push(editorModal('s', action, config).toJSON());
  for (const select of flatten(views).filter(item => item.type === ComponentType.StringSelect)) {
    for (const option of select.options as {description?: string}[]) assert.ok(option.description && option.description.length <= 100);
  }
  const editor=editorView('s',session).map(item=>item.toJSON());
  const contentSelect=flatten(editor).find(item=>item.custom_id==='cfg:s:content')!;
  const noCaption=(contentSelect.options as {value:string;label:string;default:boolean}[]).find(item=>item.value==='noCaption')!;
  assert.equal(noCaption.label,'画像に説明文を加えない');assert.equal(noCaption.default,false);
  for(const action of ['appearance','rules'])assert.equal(flatten(editor).find(item=>item.custom_id===`cfg:s:${action}`)?.style,1);
  assert.equal(flatten(editor).find(item=>item.custom_id==='cfg:s:cancel')?.style,4);
  for(const setupPage of [0,1,2] as const)assert.equal(flatten(setupView('s',{...session,setupPage}).map(item=>item.toJSON())).find(item=>item.custom_id==='cfg:s:cancel')?.style,4);
  for(const control of flatten(editor).filter(item=>item.type===ComponentType.Button&&String(item.custom_id).startsWith('cfg:')))assert.equal(control.emoji,undefined);
  assert.ok(!customIds(editor).includes('cfg:s:restore'));
  assert.ok(!customIds(editor).includes('cfg:s:toolsview'));
  assert.ok(!customIds(editor).includes('cfg:s:limits'));
  for(const action of ['management','filter','export','import','other'])assert.ok(customIds(editor).includes(`cfg:s:${action}`));
  const children=editor[1]!.components;
  assert.equal(children[1]!.type,ComponentType.Separator);
  assert.deepEqual(customIds(children[2]),['cfg:s:appearance','cfg:s:images','cfg:s:buttons','cfg:s:management']);
  assert.deepEqual(customIds(children[3]),['cfg:s:rules','cfg:s:safetyview','cfg:s:filter','cfg:s:other']);
  assert.equal(children[4]!.type,ComponentType.Separator);
  assert.ok(String((children[5] as {content?:string}).content).includes('必要なものを選ぶと、上のプレビューに反映されます。'));
  assert.equal(children[7]!.type,ComponentType.Separator);
  assert.equal(children[10]!.type,ComponentType.Separator);
  assert.deepEqual(customIds(children[11]),['cfg:s:save','cfg:s:reset','cfg:s:export','cfg:s:import','cfg:s:cancel']);
  const other=otherView('s',session).map(item=>item.toJSON());
  const sections=flatten(other).filter(item=>item.type===ComponentType.Section);
  assert.equal(sections.length,8);
  for(const section of sections)assert.equal((section.accessory as {type:number}).type,ComponentType.Button);
  assert.equal(flatten(other).filter(item=>item.type===ComponentType.Separator).length,9);
  assert.ok(!customIds(other).includes('cfg:s:buttons'));
  assert.ok(flatten(other).filter(item=>typeof item.type==='number').length<=40);
  for(const action of ['limitsbasic','spam','identity','urlcleanup','references','restore'])assert.ok(customIds(other).includes(`cfg:s:${action}`));
  const providers=flatten(editor).find(item=>item.custom_id==='cfg:s:providers')!;
  assert.equal((providers.options as {value:string}[]).at(-1)!.value,'direct');
  const feature=flatten(setupView('s',{...session,setupPage:0}).map(item=>item.toJSON())).find(item=>item.custom_id==='cfg:s:features')!;
  assert.ok((feature.options as {description:string}[]).every(item=>item.description.length<35));
  const heading=flatten(buttonSettingsView('s',session).map(item=>item.toJSON())).find(item=>String(item.content).includes('ボタンの設定'))!;
  assert.ok(!String(heading.content).includes('📝'));
  for (const metadata of [true, false, undefined]) {
    const content = JSON.stringify(panel(resolveConfig(config, { panel: { metadata, footer: '任意のフッター' } })).toJSON());
    assert.ok(!content.includes('投稿ログ:')); assert.ok(!content.includes('テキスト・画像')); assert.ok(content.includes('任意のフッター'));
  }
});

test('保存設定の選択は25件ずつ表示し、設定プレビューにもコンポーネント上限を適用する',()=>{
  const config=structuredClone(defaults);
  const session:EditorSession={owner:'u',guildId:'g',channelId:'c',scope:'guild',value:config,original:{base:config} as never,installing:true,choosingSetup:true,reuseSource:'c',
    setupSources:Array.from({length:26},(_,index)=>({channelId:index===0?'c':String(index),name:`チャンネル${index}`,title:'保存済み',enabled:false,savedAt:null}))};
  const view=reuseSetupView('s',session).map(item=>item.toJSON());
  assert.ok(!customIds(view).includes('cfg:s:restore'));
  const select=flatten(view).find(item=>item.type===ComponentType.StringSelect)!;
  assert.equal((select.options as unknown[]).length,25);assert.ok(customIds(view).includes('cfg:s:reusenext'));
  assert.ok(flatten(view).filter(item=>typeof item.type==='number').length<=40);
  config.panel.image='https://example.com/image.jpg';config.panel.thumbnail='https://example.com/icon.png';config.panel.footer='フッター';
  session.backups=Array.from({length:26},(_,index)=>({id:String(index+1),channelId:'c',channelName:'設定したチャンネル',createdAt:new Date()}));
  session.selectedBackup='1';session.pendingRevision=config;
  for(const deletingBackup of [false,true]) {
    const backups=backupsView('s',{...session,deletingBackup}).map(item=>item.toJSON());
    const options=flatten(backups).find(item=>item.type===ComponentType.StringSelect)!.options as {label:string;description:string}[];
    assert.equal(options.length,25);assert.equal(options[0]!.label,'設定したチャンネル');
    assert.ok(!options[0]!.description.includes('#'));assert.ok(customIds(backups).includes('cfg:s:restorenext'));
    assert.ok(flatten(backups).filter(item=>typeof item.type==='number').length<=40);
    assert.equal(customIds(backups).includes('cfg:s:restoredeleteconfirm'),deletingBackup);
  }
});
test('保存期間の無期限・0はフォームとテンプレートで維持し、ヘルプに制約を表示する',()=>{
  assert.equal(parseRetention('無限'),null);assert.equal(parseRetention('無期限'),null);assert.equal(parseRetention('0'),0);assert.equal(parseRetention('30'),30);assert.throws(()=>parseRetention('30x'));
  assert.equal(retentionLabel(null),'無期限');assert.equal(retentionLabel(0),'保存しない');
  const config=resolveConfig(defaults,{policy:{retentionDays:0,reportRetentionDays:0}});
  assert.ok(JSON.stringify(help(config).toJSON()).includes('DBに保存しません'));
  assert.ok(JSON.stringify(editorModal('s','identity',defaults).toJSON()).includes('無期限'));
  const value={policy:{retentionDays:null,reportRetentionDays:0}};
  assert.deepEqual(importTemplate(JSON.parse(exportTemplate(value)),defaults),value);
});
test('Components v2の案内は許可された投稿ボタンだけ表示する', () => {
  assert.deepEqual(customIds(panel(resolveConfig(defaults, { content: { text: false, images: true, urls: false, caption: false } })).toJSON()), ['post:image', 'post:help']);
  assert.deepEqual(customIds(panel(resolveConfig(defaults, { content: { text: false, images: true, urls: true } })).toJSON()), ['post:image', 'post:url', 'post:help']);
  const result = payload([panel(defaults)], false);
  assert.equal(result.flags, MessageFlags.IsComponentsV2);
  assert.ok(!('content' in result)); assert.ok(!('embeds' in result));
  assert.ok(payload([help(defaults)]).flags & MessageFlags.Ephemeral);
});

test('旧表示設定を読み込んでも文面・色を保ったV2案内と共通リンクになる', () => {
  const config = structuredClone(defaults); config.panel.style='embed';config.panel.color=0x313338;
  const body = panelPayload(config);
  assert.equal(body.flags,MessageFlags.IsComponentsV2);assert.ok(!('embeds' in body));
  const container=body.components[0]!.toJSON();
  assert.equal(container.accent_color,0x313338);
  assert.ok(flatten(container).some(item => String(item.content ?? '').includes(config.panel.description)));
  assert.ok(JSON.stringify(container).includes(legalLinks));
  assert.deepEqual(customIds(body.components.map(component=>component.toJSON())),customIds(panel(defaults).toJSON()));
});

test('案内の色なしは継承で上書きされず、プレビューと設定JSONにも保持される', () => {
  const overrides = { panel: { color: null } };
  const config = resolveConfig(defaults, overrides);
  assert.equal(config.panel.color, null);
  assert.equal(panel(config).toJSON().accent_color, undefined);
  assert.equal(panel(config, true).toJSON().accent_color, undefined);
  assert.equal(postCard('本文', [], null).toJSON().accent_color, undefined);
  assert.deepEqual(importTemplate(JSON.parse(exportTemplate(overrides)), defaults), overrides);
  const modal = editorModal('session', 'appearance', config).toJSON();
  const color = flatten(modal).find(item => item.custom_id === 'color')!;
  assert.equal(color.required, false);
  assert.equal(color.value, undefined);
  assert.doesNotThrow(() => editorModal('session', 'appearance', defaults).toJSON());
  assert.equal(panel(resolveConfig(config, { panel: { color: 0 } })).toJSON().accent_color, 0);
});

test('投稿方法の組み合わせによらず規約リンクをボタン直下に置き、補足offでも消さない',()=>{
  for(const content of [{text:true,images:true,urls:true},{text:false,images:true,urls:false},{text:false,images:false,urls:true}]){
    const config=resolveConfig(defaults,{content,panel:{metadata:false,footer:'任意の補足'}});
    const children=panel(config).toJSON().components;
    const buttons=children.findIndex(component=>component.type===ComponentType.ActionRow);
    const below=children[buttons+1];
    assert.equal(below?.type,ComponentType.TextDisplay);
    assert.ok(below&&'content' in below&&below.content===`-# ${legalLinks}`);
  }
});

test('ボタン色・表示切り替えは選択式で、現在の値を初期選択にする',()=>{
  const config=resolveConfig(defaults,{panel:{imageStyle:'success',urlButton:false,repost:true,metadata:false}});
  const styles=flatten(editorModal('session','styles',config).toJSON()).filter(item=>item.type===ComponentType.StringSelect);
  assert.equal(styles.length,4);
  const image=styles.find(item=>item.custom_id==='imageStyle')!;
  assert.deepEqual((image.options as {label:string}[]).map(option=>option.label),['青','灰','緑','赤']);
  assert.equal((image.options as {value:string;default?:boolean}[]).find(option=>option.default)?.value,'success');
  const display=flatten(editorModal('session','display',config).toJSON()).filter(item=>item.type===ComponentType.StringSelect);
  assert.equal(display.length,2);
  assert.ok(!display.some(item=>item.custom_id==='urlButton'));
  assert.ok(JSON.stringify(editorModal('session','display',config)).includes('URLボタンの名前の決め方'));
});

test('旧ボタンの文字・色・絵文字と3つの並びを、V2構造を保って設定から再現する',()=>{
  const config=resolveConfig(defaults,{content:{urls:false},panel:{textLabel:'クリックして匿名で送信',textStyle:'primary',textEmoji:'✍️',imageLabel:'画像送信',imageStyle:'success',imageEmoji:'🖼️',helpLabel:'ヘルプ・詳細',helpStyle:'secondary',metadata:false,urlButton:false}});
  const buttons=flatten(panel(config).toJSON()).filter(item=>item.type===ComponentType.Button);
  assert.deepEqual(buttons.map(b=>({label:b.label,style:b.style,emoji:(b.emoji as {name?:string}|undefined)?.name})),[
    {label:'クリックして匿名で送信',style:1,emoji:'✍️'},{label:'画像送信',style:3,emoji:'🖼️'},{label:'ヘルプ・詳細',style:2,emoji:undefined}]);
  assert.equal(config.content.urls,false);
  assert.ok(!JSON.stringify(panel(config).toJSON()).includes('投稿者対応は'));
  for(const action of ['styles','emojis','display'])assert.doesNotThrow(()=>editorModal('session',action,config).toJSON());
});
test('画像ボタンからLabel内のFileUploadで直接複数ファイルを選択できる', () => {
  const modal = postModal('image', defaults).toJSON();
  const file = flatten(modal).find(item => item.type === ComponentType.FileUpload)!;
  assert.equal(file.max_values, 10); assert.equal(file.min_values, 1); assert.equal(file.required, true);
  const label = flatten(modal).find(item => (item.component as Record<string, unknown> | undefined)?.type === ComponentType.FileUpload)!;
  assert.equal(label.type, ComponentType.Label);
  assert.ok(!JSON.stringify(modal).includes('1枚10MB以内'));
  const upload = postModal('image', resolveConfig(defaults, { content: { text: false, images: true, urls: false, caption: false } })).toJSON();
  assert.ok(!customIds(upload).includes('text'));
});
test('画像とサムネイルを設定した編集画面も40コンポーネント以内で直列化できる', () => {
  const config = structuredClone(defaults); config.panel.image = 'https://example.com/image.jpg'; config.panel.thumbnail = 'https://example.com/icon.png'; config.panel.footer = '任意のフッター';
  const session: EditorSession = { owner: 'u', guildId: 'g', channelId: 'c', scope: 'guild', value: config,
    original: { guildId: 'g', channelId: 'c', base: config, config, overrides: {}, guildVersion: 0, channelVersion: 0, enabled: true, panelId: null, webhook: null }, installing: false };
  const view = editorView('session', session).map(item => item.toJSON());
  assert.ok(flatten(view).filter(item => typeof item.type === 'number').length <= 40);
  assert.ok(customIds(view).every(id => id.length <= 100));
  assert.ok(flatten(view).filter(item => String(item.custom_id ?? '').startsWith('post:')).every(item => item.disabled));
  assert.ok(!customIds(view).includes('cfg:session:panelpreview'));
  const preview=view;
  assert.deepEqual(preview[0],panel(config,true).toJSON());
  assert.ok(flatten(preview).some(item=>item.type===ComponentType.Thumbnail));
  assert.ok(flatten(preview).filter(item=>String(item.custom_id??'').startsWith('post:')).every(item=>item.disabled));
  assert.ok(flatten(preview).filter(item=>typeof item.type==='number').length<=40);
  const thumbnailOnly=structuredClone(config);thumbnailOnly.panel.image='';
  assert.ok(flatten(editorView('session',{...session,value:thumbnailOnly}).map(item=>item.toJSON())).filter(item=>typeof item.type==='number').length<=40);
  for (const select of flatten(view).filter(item => item.type === ComponentType.StringSelect)) {
    const options = select.options as unknown[];
    assert.ok(Number(select.max_values ?? 1) <= options.length);
    assert.ok(Number(select.min_values ?? 1) <= Number(select.max_values ?? 1));
  }
  assert.ok(flatten(managementView('session', session).map(item => item.toJSON())).length <= 40);
  assert.ok(customIds(view).includes('cfg:session:providers'));
  assert.ok(customIds(view).includes('cfg:session:appearance'));
  const expanded = editorView('session', session).map(item => item.toJSON());
  assert.ok(customIds(expanded).includes('cfg:session:providers'));
  assert.ok(!customIds(expanded).includes('cfg:session:providersview'));
  assert.ok(flatten(expanded).filter(item => typeof item.type === 'number').length <= 40);
  assert.ok(JSON.stringify(resetConfirmationView('session', session)).includes('resetconfirm'));
  for (const setupPage of [0, 1, 2] as const) {
    const setup = setupView('session', { ...session, setupPage, installing: true, setupAvatar: 'https://example.com/bot.png' }).map(item => item.toJSON());
    assert.ok(flatten(setup).filter(item => typeof item.type === 'number').length <= 40);
    assert.ok(JSON.stringify(setup).includes(`${setupPage + 1}/3`));
    assert.ok(customIds(setup[0]).some(id => id.startsWith('post:')));
    const header = flatten(setup).find(item => item.type === ComponentType.TextDisplay && String(item.content).includes('匿名投稿のセットアップ'))?.content as string;
    assert.equal((header.match(/ℹ️/g) ?? []).length, 1); assert.ok(!header.includes('✅'));
    assert.ok(flatten(setup).filter(item => item.type === ComponentType.Separator).length >= 3);
    assert.ok(flatten(setup).some(item => item.type === ComponentType.Thumbnail));
  }
});
test('匿名投稿とプレビューは添付をMediaGalleryで明示し、ファイル選択とキャンセルを持つ', () => {
  const file = { name: 'image_1.jpg', data: Buffer.from('image'), kind: 'image' as const };
  const video = { name: 'clip.mp4', data: Buffer.from('video'), kind: 'video' as const };
  const post = postCard('こんにちは', [file], 0x5865f2).toJSON();
  const gallery = flatten(post).find(item => item.type === ComponentType.MediaGallery)!;
  assert.deepEqual((gallery.items as { media: { url: string } }[])[0]?.media.url, 'attachment://image_1.jpg');
  const preview = previewView('session', { owner: 'u', guildId: 'g', channelId: 'c', text: '', source: 'https://example.com/a', warnings: [], files: [file, video], selected: [0], sending: false, videoLinks: ['https://x-p.yexe.xyz/amplify_video/1/vid/a.mp4'] });
  const view = preview.map(item => item.toJSON());
  assert.ok(customIds(view).includes('preview:session:cancel'));
  assert.ok(customIds(view).includes('preview:session:select'));
  assert.ok(JSON.stringify(view).includes('[動画](https://x-p.yexe.xyz/amplify_video/1/vid/a.mp4)'));
  assert.ok(!JSON.stringify(view).includes('attachment://clip.mp4'));
});
test('スラッシュコマンド名は短く、ハイフンを使わず、imageを持つ', () => {
  const slash = commands.filter(command => !command.type || command.type === 1);
  assert.ok(slash.some(command => command.name === 'image'));
  assert.ok(slash.every(command => /^[a-z]+$/.test(command.name)));
  assert.ok(slash.every(command => command.default_member_permissions == null));
  assert.deepEqual(commands.filter(command=>command.type===3).map(command=>command.name),['メッセージに返信','メッセージを編集','メッセージを削除','匿名つぶやき通報','埋め込みを編集（Admin）']);
});

test('説明文禁止時は添付とURLフォーム・確認画面の説明文操作を隠す', () => {
  const config=resolveConfig(defaults,{content:{text:false,caption:false}});
  for(const kind of ['image','url'] as const)assert.ok(!customIds(postModal(kind,config).toJSON()).includes('text'));
  const file={name:'image.jpg',data:Buffer.from('image'),kind:'image' as const};
  const session={owner:'u',guildId:'g',channelId:'c',text:'',source:'https://example.com/a',warnings:[],files:[file],selected:[0],sending:false,videoLinks:[]};
  assert.ok(!customIds(previewView('p',session,false).map(item=>item.toJSON())).includes('preview:p:edit'));
  assert.ok(customIds(previewView('p',session,true).map(item=>item.toJSON())).includes('preview:p:edit'));
  assert.ok(JSON.stringify(editorModal('s','caption',config).toJSON()).includes('許可しない（画像のみ）'));
});

test('URL案内は許可されたサービスに追従し、手動のボタン名も維持する', () => {
  const config=resolveConfig(defaults,{content:{providers:['pixiv','bluesky']},panel:{urlAutoLabel:true}});
  assert.equal(urlMethodLabel(config),'Pixiv・BlueskyのURL');
  const button=flatten(panel(config).toJSON()).find(item=>item.custom_id==='post:url');
  assert.equal(button?.label,'Pixiv・BlueskyのURL');
  const urlModal=postModal('url',config).toJSON();
  assert.equal(urlModal.title,'URLから画像を送る');
  assert.ok(JSON.stringify(urlModal).includes('Pixiv・BlueskyのURL'));
  const manual=resolveConfig(config,{panel:{urlLabel:'作品のURL',urlAutoLabel:false}});
  assert.equal(flatten(panel(manual).toJSON()).find(item=>item.custom_id==='post:url')?.label,'作品のURL');
  assert.ok(urlMethodLabel(defaults).length<=80);
  const empty=resolveConfig(config,{content:{providers:[]}});
  assert.ok(!customIds(panel(empty).toJSON()).includes('post:url'));
});
