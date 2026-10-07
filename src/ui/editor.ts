import { ActionRowBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, ContainerBuilder, RoleSelectMenuBuilder,
  SeparatorBuilder, StringSelectMenuBuilder, FileUploadBuilder, LabelBuilder, ModalBuilder } from 'discord.js';
import { automaticUrlLabel, allowsDirectPosts, resolveConfig, type Config, type Overrides } from '../domain/config.js';
import type { ChannelSettings } from '../infra/store.js';
import { button, card, colors, panel, row, text } from './components.js';
import { input, choice } from './modals.js';
import type { OwnedSession } from './sessions.js';

export interface EditorSession extends OwnedSession {
  scope: 'guild' | 'channel'; original: ChannelSettings; value: Config | Overrides; installing: boolean;
}
export function editorConfig(session: EditorSession): Config {
  return session.scope === 'guild' ? session.value as Config : resolveConfig(session.original.base, session.value as Overrides);
}
export function editSection<K extends keyof Config>(session: EditorSession, section: K, changes: Partial<Config[K]>): void {
  const value = { ...session.value, [section]: { ...session.value[section], ...changes } };
  editorConfig({ ...session, value });
  session.value = value;
}
export function editorView(id: string, session: EditorSession): ContainerBuilder[] {
  const config = editorConfig(session);
  const inherited = session.scope === 'channel' ? Object.keys(session.value).length ? 'このチャンネルの上書きを編集中' : 'サーバー標準を継承中' : 'サーバー内の継承チャンネルに反映されます';
  const menu = card('匿名Botの設定', `${session.scope === 'guild' ? 'サーバー標準' : `<#${session.channelId}>`} · ${inherited}\n変更は下書きです。「保存して反映」を押すまで公開されません。`, colors.settings);
  menu.addActionRowComponents(row(button(`cfg:${id}:appearance`, 'タイトル・説明'), button(`cfg:${id}:images`, '画像・サムネイル'), button(`cfg:${id}:buttons`, 'ボタン設定'), button(`cfg:${id}:display`, '表示・再送')));
  menu.addActionRowComponents(row(button(`cfg:${id}:rules`, 'ルール'), button(`cfg:${id}:limits`, '枚数・制限'), button(`cfg:${id}:identity`, '匿名ID・保存期間'), button(`cfg:${id}:caption`, '画像の説明文')));
  const options = [
    { label: 'テキストだけの投稿', value: 'text', description: '画像なしでも投稿できる' },
    { label: 'ファイルの直接添付', value: 'images', description: 'フォームから画像や動画などを選択できる' },
    { label: 'URLから画像を取得', value: 'urls', description: '対応サイトの画像や動画を自動変換する' },
    { label: '画像に説明文を添える', value: 'caption', description: '無効にすると説明文欄・編集ボタンを表示しない' },
    ].map(option => ({ ...option, default: config.content[option.value as 'text' | 'images' | 'urls' | 'caption'] }));
  menu.addTextDisplayComponents(text('**投稿できる内容** · 選択した項目を有効にします'));
  menu.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
    .setCustomId(`cfg:${id}:content`).setPlaceholder('投稿形式を選ぶ').setMinValues(1).setMaxValues(5).addOptions(options)));
  menu.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
    .setCustomId(`cfg:${id}:providers`).setPlaceholder('URL変換するサイト').setMinValues(0).setMaxValues(9)
    .addOptions([{ label: 'X / Twitter', value: 'x' }, { label: 'Pixiv', value: 'pixiv' }, { label: '画像への直接URL', value: 'direct' },
      { label: 'Bluesky', value: 'bluesky' }, { label: 'Mastodon', value: 'mastodon' }, { label: 'Misskey', value: 'misskey' },
      { label: 'TikTok', value: 'tiktok' }, { label: 'Instagram', value: 'instagram' }, { label: 'Threads', value: 'threads' }].map(item => ({ ...item, default: config.content.providers.includes(item.value as Config['content']['providers'][number]) })))));
  menu.addActionRowComponents(row(button(`cfg:${id}:management`, '管理・投稿ロール'), button(`cfg:${id}:filter`, '禁止語・ドメイン'), button(`cfg:${id}:export`, '書き出し'), button(`cfg:${id}:import`, '読み込み')));
  menu.addActionRowComponents(row(button(`cfg:${id}:save`, session.installing ? '保存して設置' : '保存して反映', ButtonStyle.Success),
    button(`cfg:${id}:restore`, '前の設定を読み込む'), button(`cfg:${id}:reset`, session.scope === 'channel' ? '標準に戻す' : '初期値に戻す'), button(`cfg:${id}:cancel`, 'キャンセル')));
  return [panel(config, true), menu];
}

export function managementView(id: string, session: EditorSession): ContainerBuilder[] {
  const config = editorConfig(session);
  const menu = card('管理と投稿権限', 'サーバー管理権限を持つ人は常に設定できます。選択は下書きに保存されます。', colors.settings);
  const roles = new RoleSelectMenuBuilder().setCustomId(`cfg:${id}:roles`).setMinValues(0).setMaxValues(20).setPlaceholder('管理を任せるロール（任意）');
  if (config.moderation.managerRoles.length) roles.setDefaultRoles(config.moderation.managerRoles);
  menu.addTextDisplayComponents(text('**管理ロール**'));
  menu.addActionRowComponents(new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roles));
  const allowed = new RoleSelectMenuBuilder().setCustomId(`cfg:${id}:allowedroles`).setMinValues(0).setMaxValues(20).setPlaceholder('投稿できるロール（空欄なら全員）');
  if (config.policy.allowedRoles.length) allowed.setDefaultRoles(config.policy.allowedRoles);
  menu.addTextDisplayComponents(text('**投稿できるロール**'));
  menu.addActionRowComponents(new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(allowed));
  const channel = new ChannelSelectMenuBuilder().setCustomId(`cfg:${id}:reportchannel`).setChannelTypes(ChannelType.GuildText).setMinValues(0).setMaxValues(1).setPlaceholder('通報を受け取るチャンネル');
  if (config.moderation.reportChannel) channel.setDefaultChannels(config.moderation.reportChannel);
  menu.addTextDisplayComponents(text('**通報先**'));
  menu.addActionRowComponents(new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(channel));
  const log = new ChannelSelectMenuBuilder().setCustomId(`cfg:${id}:logchannel`).setChannelTypes(ChannelType.GuildText).setMinValues(0).setMaxValues(1).setPlaceholder('処置ログのチャンネル（任意）');
  if (config.moderation.logChannel) log.setDefaultChannels(config.moderation.logChannel);
  menu.addTextDisplayComponents(text('**処置ログ先**'));
  menu.addActionRowComponents(new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(log));
  menu.addActionRowComponents(row(button(`cfg:${id}:directposts`, `通常投稿: ${allowsDirectPosts(config) ? '許可' : '削除・DM警告'}`), button(`cfg:${id}:back`, 'プレビューに戻る', ButtonStyle.Primary)));
  return [menu];
}
export function buttonSettingsView(id:string,session:EditorSession):ContainerBuilder[] {
  const menu=card('ボタンの設定','文字・色・絵文字を変更できます。変更は保存するまで公開されません。',colors.settings);
  menu.addActionRowComponents(row(button(`cfg:${id}:labels`,'ボタン名'),button(`cfg:${id}:styles`,'ボタン色'),button(`cfg:${id}:emojis`,'絵文字')));
  menu.addActionRowComponents(row(button(`cfg:${id}:back`,'プレビューに戻る',ButtonStyle.Primary)));
  return [panel(editorConfig(session),true),menu];
}

export function editorModal(id: string, action: string, config: Config): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(`edit:${id}:${action}`).setTitle('設定を編集');
  const toggle=(name:string,label:string,on:boolean)=>choice(name,label,on?'on':'off',[{label:'有効',value:'on'},{label:'無効',value:'off'}]);
  switch (action) {
    case 'display': modal.addLabelComponents(toggle('repost','匿名・通常投稿ごとに案内を再送',config.panel.repost!==false),toggle('urlButton','URLボタンを表示',config.panel.urlButton!==false),toggle('metadata','投稿形式・保存期間を表示',config.panel.metadata!==false),toggle('urlAutoLabel','URLボタン名を許可サイトから自動表示',automaticUrlLabel(config)));break;
    case 'caption': modal.addLabelComponents(choice('caption','画像に説明文を付ける',config.content.caption?'on':'off',[{label:'許可する',value:'on'},{label:'許可しない（画像のみ）',value:'off',description:'画像添付・URL変換の説明文欄を非表示にします'}]));break;
    case 'styles': modal.addLabelComponents(...(['text','image','url','help'] as const).map(kind=>choice(`${kind}Style`,`${{text:'投稿',image:'画像',url:'URL',help:'ヘルプ'}[kind]}ボタンの色`,config.panel[`${kind}Style`]??(kind==='text'||kind==='image'&&!config.content.text?'primary':'secondary'),[{label:'青',value:'primary'},{label:'灰',value:'secondary'},{label:'緑',value:'success'},{label:'赤',value:'danger'}])));break;
    case 'emojis': modal.addLabelComponents(...(['text','image','url','help'] as const).map(kind=>input(`${kind}Emoji`,`${{text:'投稿',image:'画像',url:'URL',help:'ヘルプ'}[kind]}ボタンの絵文字（空欄で解除）`,config.panel[`${kind}Emoji`]??'',100,false,false)));break;
    case 'appearance': modal.addLabelComponents(input('title', 'タイトル', config.panel.title, 100), input('description', '説明文', config.panel.description, 1500, true, false), input('color', '色（例: #5865f2）', `#${config.panel.color.toString(16).padStart(6, '0')}`, 7), input('footer', 'フッター（任意）', config.panel.footer, 200, false, false)); break;
    case 'images': modal.addLabelComponents(input('image', '画像URL（空欄で削除）', config.panel.image, 1000, false, false), input('thumbnail', 'サムネイルURL（空欄で削除）', config.panel.thumbnail, 1000, false, false)); break;
    case 'labels': modal.addLabelComponents(input('textLabel', 'テキスト投稿ボタン', config.panel.textLabel, 40), input('imageLabel', '画像投稿ボタン', config.panel.imageLabel, 40), input('urlLabel', 'URL変換ボタン', config.panel.urlLabel, 40), input('helpLabel', 'ヘルプボタン', config.panel.helpLabel, 40)); break;
    case 'rules': modal.addLabelComponents(input('rules', 'サーバールール', config.policy.rules, 2500, true, false), input('rulesUrl', '詳細ルールのURL（任意）', config.policy.rulesUrl, 1000, false, false)); break;
    case 'limits': modal.addLabelComponents(input('cooldown', '投稿間隔の秒数（0〜3600）', `${config.policy.cooldown}`, 4), input('threshold', '通報通知の人数（1〜50）', `${config.moderation.reportThreshold}`, 2)); break;
    case 'identity': modal.addLabelComponents(toggle('showId','匿名IDを表示',config.identity.showId), input('minutes', '連続投稿のID保持時間（分、0〜1440）', `${config.identity.minutes}`, 4), input('retention', '投稿ログ（0・1〜90日・無期限）', config.policy.retentionDays===null?'無期限':`${config.policy.retentionDays}`, 8), input('reportRetention', '通報内容（0・1〜180日・無期限）', config.policy.reportRetentionDays===null?'無期限':`${config.policy.reportRetentionDays}`, 8)); break;
    case 'filter': modal.addLabelComponents(input('words', '禁止語（1行に1つ、空欄で解除）', config.policy.blockedWords.join('\n'), 3000, true, false), input('domains', '禁止ドメイン（1行に1つ）', config.policy.blockedDomains.join('\n'), 3000, true, false)); break;
    case 'import': modal.addLabelComponents(new LabelBuilder().setLabel('書き出した設定JSON').setFileUploadComponent(new FileUploadBuilder().setCustomId('template').setMinValues(1).setMaxValues(1).setRequired(true))); break;
    default: throw new Error('Unknown editor action');
  }
  return modal;
}
