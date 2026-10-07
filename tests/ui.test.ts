import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags, ComponentType } from 'discord.js';
import { defaults, presetOverrides, resolveConfig, urlMethodLabel, parseRetention, retentionLabel, importTemplate, exportTemplate } from '../src/domain/config.js';
import { panel, panelPayload, payload, help, legalLinks } from '../src/ui/components.js';
import { postModal } from '../src/ui/modals.js';
import { editorView, editorModal, managementView, type EditorSession } from '../src/ui/editor.js';
import { postCard, previewView } from '../src/ui/post.js';
import { commands } from '../src/commands.js';

function flatten(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(flatten);
  if (!value || typeof value !== 'object') return [];
  const item = value as Record<string, unknown>;
  return [item, ...flatten(item.components), ...flatten(item.component), ...flatten(item.accessory)];
}
function customIds(value: unknown): string[] { return flatten(value).filter(item => typeof item.custom_id === 'string').map(item => item.custom_id as string); }
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
  assert.deepEqual(customIds(panel(resolveConfig(defaults, presetOverrides('upload'))).toJSON()), ['post:image', 'post:help']);
  assert.deepEqual(customIds(panel(resolveConfig(defaults, presetOverrides('image'))).toJSON()), ['post:image', 'post:url', 'post:help']);
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
  assert.ok(JSON.stringify(container).includes(config.panel.description));
  assert.ok(JSON.stringify(container).includes(legalLinks));
  assert.deepEqual(customIds(body.components.map(component=>component.toJSON())),customIds(panel(defaults).toJSON()));
});

test('すべての投稿モードで共通の規約リンクをボタン直下に置き、補足offでも消さない',()=>{
  for(const preset of ['chat','image','upload','request'] as const){
    const config=resolveConfig(defaults,{...presetOverrides(preset),panel:{metadata:false,footer:'任意の補足'}});
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
  assert.equal(display.length,4);
  assert.equal((display.find(item=>item.custom_id==='urlButton')!.options as {value:string;default?:boolean}[]).find(option=>option.default)?.value,'off');
});

test('旧ボタンの文字・色・絵文字と3つの並びを、V2構造を保って設定から再現する',()=>{
  const config=resolveConfig(defaults,{panel:{textLabel:'クリックして匿名で送信',textStyle:'primary',textEmoji:'✍️',imageLabel:'画像送信',imageStyle:'success',imageEmoji:'🖼️',helpLabel:'ヘルプ・詳細',helpStyle:'secondary',metadata:false,urlButton:false}});
  const buttons=flatten(panel(config).toJSON()).filter(item=>item.type===ComponentType.Button);
  assert.deepEqual(buttons.map(b=>({label:b.label,style:b.style,emoji:(b.emoji as {name?:string}|undefined)?.name})),[
    {label:'クリックして匿名で送信',style:1,emoji:'✍️'},{label:'画像送信',style:3,emoji:'🖼️'},{label:'ヘルプ・詳細',style:2,emoji:undefined}]);
  assert.equal(config.content.urls,true);
  assert.ok(!JSON.stringify(panel(config).toJSON()).includes('投稿者対応は'));
  for(const action of ['styles','emojis','display'])assert.doesNotThrow(()=>editorModal('session',action,config).toJSON());
});
test('画像ボタンからLabel内のFileUploadで直接複数ファイルを選択できる', () => {
  const modal = postModal('image', defaults).toJSON();
  const file = flatten(modal).find(item => item.type === ComponentType.FileUpload)!;
  assert.equal(file.max_values, 5); assert.equal(file.min_values, 1); assert.equal(file.required, true);
  const label = flatten(modal).find(item => (item.component as Record<string, unknown> | undefined)?.type === ComponentType.FileUpload)!;
  assert.equal(label.type, ComponentType.Label);
  assert.ok(!JSON.stringify(modal).includes('1枚10MB以内'));
  const upload = postModal('image', resolveConfig(defaults, presetOverrides('upload'))).toJSON();
  assert.ok(!customIds(upload).includes('text'));
});
test('画像とサムネイルを設定した編集画面も40コンポーネント以内で直列化できる', () => {
  const config = structuredClone(defaults); config.panel.image = 'https://example.com/image.jpg'; config.panel.thumbnail = 'https://example.com/icon.png';
  const session: EditorSession = { owner: 'u', guildId: 'g', channelId: 'c', scope: 'guild', value: config,
    original: { guildId: 'g', channelId: 'c', base: config, config, overrides: {}, guildVersion: 0, channelVersion: 0, enabled: true, panelId: null, webhook: null }, installing: false };
  const view = editorView('session', session).map(item => item.toJSON());
  assert.ok(flatten(view).filter(item => typeof item.type === 'number').length <= 40);
  assert.ok(customIds(view).every(id => id.length <= 100));
  assert.ok(flatten(view).filter(item => String(item.custom_id ?? '').startsWith('post:')).every(item => item.disabled));
  assert.ok(flatten(managementView('session', session).map(item => item.toJSON())).length <= 40);
});
test('匿名投稿とプレビューは添付をMediaGalleryで明示し、画像選択とキャンセルを持つ', () => {
  const file = { name: 'image_1.jpg', data: Buffer.from('image'), kind: 'image' as const };
  const post = postCard('こんにちは', [file], 0x5865f2).toJSON();
  const gallery = flatten(post).find(item => item.type === ComponentType.MediaGallery)!;
  assert.deepEqual((gallery.items as { media: { url: string } }[])[0]?.media.url, 'attachment://image_1.jpg');
  const preview = previewView('session', { owner: 'u', guildId: 'g', channelId: 'c', text: '', source: 'https://example.com/a', warnings: [], files: [file], selected: [0], sending: false });
  assert.ok(customIds(preview.map(item => item.toJSON())).includes('preview:session:cancel'));
  assert.ok(customIds(preview.map(item => item.toJSON())).includes('preview:session:select'));
});
test('スラッシュコマンド名は短く、ハイフンを使わず、imageを持つ', () => {
  const slash = commands.filter(command => !command.type || command.type === 1);
  assert.ok(slash.some(command => command.name === 'image'));
  assert.ok(slash.every(command => /^[a-z]+$/.test(command.name)));
  assert.deepEqual(commands.filter(command=>command.type===3).map(command=>command.name),['メッセージに返信','メッセージを編集','メッセージを削除','匿名つぶやき通報','埋め込みを編集（Admin）']);
});

test('説明文禁止時は添付とURLフォーム・確認画面の説明文操作を隠す', () => {
  const config=resolveConfig(defaults,{content:{text:false,caption:false}});
  for(const kind of ['image','url'] as const)assert.ok(!customIds(postModal(kind,config).toJSON()).includes('text'));
  const file={name:'image.jpg',data:Buffer.from('image'),kind:'image' as const};
  const session={owner:'u',guildId:'g',channelId:'c',text:'',source:'https://example.com/a',warnings:[],files:[file],selected:[0],sending:false};
  assert.ok(!customIds(previewView('p',session,false).map(item=>item.toJSON())).includes('preview:p:edit'));
  assert.ok(customIds(previewView('p',session,true).map(item=>item.toJSON())).includes('preview:p:edit'));
  assert.ok(JSON.stringify(editorModal('s','caption',config).toJSON()).includes('許可しない（画像のみ）'));
});

test('URL案内は許可されたサービスに追従し、手動のボタン名も維持する', () => {
  const config=resolveConfig(defaults,{content:{providers:['pixiv','bluesky']}});
  assert.equal(urlMethodLabel(config),'Pixiv・BlueskyのURL');
  const button=flatten(panel(config).toJSON()).find(item=>item.custom_id==='post:url');
  assert.equal(button?.label,'Pixiv・BlueskyのURL');
  assert.equal(postModal('url',config).toJSON().title,'Pixiv・BlueskyのURL');
  const manual=resolveConfig(config,{panel:{urlLabel:'作品のURL',urlAutoLabel:false}});
  assert.equal(flatten(panel(manual).toJSON()).find(item=>item.custom_id==='post:url')?.label,'作品のURL');
  assert.ok(urlMethodLabel(defaults).length<=45);
  const empty=resolveConfig(config,{content:{providers:[]}});
  assert.ok(!customIds(panel(empty).toJSON()).includes('post:url'));
});
