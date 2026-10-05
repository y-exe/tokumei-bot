import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder,
  MessageFlags, SectionBuilder, SeparatorBuilder, TextDisplayBuilder, ThumbnailBuilder,
  type APIComponentInMessageActionRow, type APIMessageTopLevelComponent,
} from 'discord.js';
import { automaticUrlLabel, urlMethodLabel, retentionLabel, type Config } from '../domain/config.js';

export function button(id: string, label: string, style = ButtonStyle.Secondary): ButtonBuilder {
  return new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
}
export function row(...buttons: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder> { return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons); }
export function text(value: string): TextDisplayBuilder { return new TextDisplayBuilder().setContent(value); }
export const colors = { info: 0x3498db, settings: 0x3498db, success: 0x2ecc71, warning: 0xf39c12, danger: 0xe53935, report: 0xe74c3c, preview: 0x3498db } as const;
export const uiEmoji = {
  check: '<:9_:1407591872234520576>', flag: '<:3_:1407591152491827211>',
  warning: '<:11:1407591910767464459>', info: '<:10:1407591891318472794>',
  error: '<:12:1407591937728577599>',
  time:'<:6_:1407591216459153460>',content:'<:5_:1407591193751195698>',count:'<:8_:1407591279243825162>',reporter:'<:7_:1407591242656911391>',
};
export const legalLinks = '[利用規約](https://github.com/y-exe/tokumei-bot/blob/main/TERMS_OF_SERVICE.md)・[プライバシーポリシー](https://github.com/y-exe/tokumei-bot/blob/main/PRIVACY_POLICY.md)';
export function card(title: string, description: string, color: number = colors.info): ContainerBuilder {
  const emoji = color === colors.success ? uiEmoji.check : color === colors.warning ? uiEmoji.warning : color === colors.danger ? uiEmoji.error : uiEmoji.info;
  return new ContainerBuilder().setAccentColor(color).addTextDisplayComponents(text(`## ${emoji} ${title}\n${description}`));
}
export function payload(components: (ContainerBuilder | ActionRowBuilder<ButtonBuilder>)[], ephemeral = true) {
  return { components, flags: ephemeral ? MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral : MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] as ('users' | 'roles' | 'everyone')[] } };
}
export function panel(config: Config, preview = false): ContainerBuilder {
  const result = new ContainerBuilder().setAccentColor(config.panel.color);
  const heading = text(`## ${config.panel.title}\n${config.panel.description}`);
  if (config.panel.thumbnail) result.addSectionComponents(new SectionBuilder().addTextDisplayComponents(heading).setThumbnailAccessory(new ThumbnailBuilder().setURL(config.panel.thumbnail)));
  else result.addTextDisplayComponents(heading);
  if (config.panel.image) result.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(config.panel.image)));
  result.addSeparatorComponents(new SeparatorBuilder());
  result.addActionRowComponents(panelButtons(config, preview));
  result.addTextDisplayComponents(text(`-# ${legalLinks}`));
  if (config.panel.style === 'embed' || config.panel.metadata === false) {
    if (config.panel.footer) result.addTextDisplayComponents(text(`-# ${config.panel.footer}`));
    return result;
  }
  const format = !config.content.text ? config.content.urls ? '画像必須・URL変換可' : '画像の直接添付のみ' : config.content.images ? 'テキスト・画像' : 'テキスト';
  result.addTextDisplayComponents(text(`-# ${format} · 投稿ログ: ${retentionLabel(config.policy.retentionDays)}${config.panel.footer ? `\n-# ${config.panel.footer}` : ''}`));
  return result;
}
export function panelButtons(config: Config, preview = false): ActionRowBuilder<ButtonBuilder> {
  const actions: ButtonBuilder[] = [];
  const styles={primary:ButtonStyle.Primary,secondary:ButtonStyle.Secondary,success:ButtonStyle.Success,danger:ButtonStyle.Danger};
  const make=(kind:'text'|'image'|'url'|'help',fallback:ButtonStyle)=>{
    const configured=config.panel[`${kind}Style`];
    const label=kind==='url'&&automaticUrlLabel(config)?urlMethodLabel(config):config.panel[`${kind}Label`];
    const result=button(`post:${kind}`,label,configured?styles[configured]:fallback);
    const emoji=config.panel[`${kind}Emoji`];if(emoji)result.setEmoji(emoji);
    return result;
  };
  if (config.content.text) actions.push(make('text',ButtonStyle.Primary));
  if (config.content.images) actions.push(make('image',config.content.text?ButtonStyle.Secondary:ButtonStyle.Primary));
  if (config.content.urls && config.content.providers.length && config.panel.urlButton !== false) actions.push(make('url',ButtonStyle.Secondary));
  actions.push(make('help',ButtonStyle.Secondary));
  if (preview) actions.forEach(action => action.setDisabled(true));
  return row(...actions);
}
export function panelPayload(config: Config) {
  return payload([panel(config)], false);
}
export function help(config: Config): ContainerBuilder {
  const result = card('サーバー固有ルール・使い方', config.policy.rules || 'サーバーのルールに従ってご利用ください。', colors.info);
  result.addSeparatorComponents(new SeparatorBuilder());
  result.addTextDisplayComponents(text(`### ${uiEmoji.check} 投稿方法\n案内のボタン、または \`/post\`・\`/image\`・\`/url\` から投稿できます。\n**編集・削除**は \`/mine\`、または投稿を右クリック・長押しして「アプリ」から行えます。\n${uiEmoji.flag} **通報・返信**も「アプリ」メニューから選べます。`));
  const privacy=config.policy.retentionDays===0?'**投稿者対応・本文・添付情報はBotのDBに保存しません。**\n投稿履歴を保存しないため、Botによる本人編集・削除・通報は利用できません。':`投稿ログ: **${retentionLabel(config.policy.retentionDays)}**。通報内容: **${retentionLabel(config.policy.reportRetentionDays)}**。\n${uiEmoji.info} Botのデータ管理者は保存情報へアクセスできます。`;
  result.addTextDisplayComponents(text(`### ${uiEmoji.info} 匿名性と保存\n**他のメンバーに投稿者名は表示されません。**\n${privacy}\nDiscord上の投稿はこの設定では削除されません。匿名の表示IDは実ユーザーIDではありません。`));
  if (config.policy.rulesUrl) result.addActionRowComponents(row(new ButtonBuilder().setLabel('サーバールールを開く').setStyle(ButtonStyle.Link).setURL(config.policy.rulesUrl)));
  return result;
}

export function serializeComponents(components: { toJSON(): unknown }[]): APIMessageTopLevelComponent[] {
  return components.map(component => component.toJSON()) as APIMessageTopLevelComponent[];
}
export type ActionComponent = APIComponentInMessageActionRow;
