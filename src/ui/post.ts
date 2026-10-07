import { ContainerBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder, ButtonStyle, ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import type { MediaFile } from '../domain/validation.js';
import { card, colors, button, row, text } from './components.js';
import type { OwnedSession } from './sessions.js';

export interface PreviewSession extends OwnedSession {
  files: MediaFile[]; text: string; source: string; warnings: string[]; selected: number[]; sending: boolean; videoLinks: string[];
}
export function postCard(content: string, media: { name: string }[], color: number): ContainerBuilder {
  const result = new ContainerBuilder().setAccentColor(color);
  if (content) result.addTextDisplayComponents(text(content));
  if (media.length) result.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(...media.map(file => new MediaGalleryItemBuilder().setURL(`attachment://${file.name}`))));
  return result;
}
export function previewView(id: string, session: PreviewSession, caption = true): ContainerBuilder[] {
  const gallery = session.files.filter(file => file.kind === 'image' || file.kind === 'animation');
  const others = session.files.filter(file => file.kind === 'video' || file.kind === 'file');
  const result = card('投稿を確認', `投稿先: <#${session.channelId}>${caption?`\n${session.text || '説明文なし'}`:''}\n出典: <${session.source}>`, session.warnings.length ? colors.warning : colors.preview);
  if (gallery.length) result.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(...gallery.map(file => new MediaGalleryItemBuilder().setURL(`attachment://${file.name}`))));
  if (others.length) result.addTextDisplayComponents(text(others.map(file => `-# 📎 ${file.name}`).join('\n')));
  if (session.videoLinks.length) result.addTextDisplayComponents(text(`**動画の埋め込み**\n${session.videoLinks.map(link => `[動画](${link})`).join('\n')}`));
  if (session.warnings.length) result.addTextDisplayComponents(text(`**取得時の注意**\n${session.warnings.join('\n')}`));
  result.addTextDisplayComponents(text('-# この画面はあなただけに表示されています。出典URLから元の作者やアカウントが分かる場合があります。'));
  if (session.files.length > 1) result.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
    .setCustomId(`preview:${id}:select`).setPlaceholder('投稿するファイルを選ぶ').setMinValues(1).setMaxValues(session.files.length)
    .addOptions(session.files.map((file, index) => ({ label: file.name.slice(0, 90) || `ファイル ${index + 1}`, value: `${index}`, default: session.selected.includes(index) })))));
  result.addActionRowComponents(row(button(`preview:${id}:send`, `${session.selected.length + session.videoLinks.length}件を投稿する`, ButtonStyle.Success), ...(caption?[button(`preview:${id}:edit`, '説明文を直す')]:[]), button(`preview:${id}:cancel`, 'キャンセル')));
  return [result];
}
