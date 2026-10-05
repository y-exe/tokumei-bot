import { ContainerBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder, ButtonStyle, ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import type { MediaFile } from '../domain/validation.js';
import { card, colors, button, row, text } from './components.js';
import type { OwnedSession } from './sessions.js';

export interface PreviewSession extends OwnedSession {
  files: MediaFile[]; text: string; source: string; warnings: string[]; selected: number[]; sending: boolean;
}
export function postCard(content: string, media: { name: string }[], color: number): ContainerBuilder {
  const result = new ContainerBuilder().setAccentColor(color);
  if (content) result.addTextDisplayComponents(text(content));
  if (media.length) result.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(...media.map(file => new MediaGalleryItemBuilder().setURL(`attachment://${file.name}`))));
  return result;
}
export function previewView(id: string, session: PreviewSession, caption = true): ContainerBuilder[] {
  const result = card('画像を確認', `投稿先: <#${session.channelId}>${caption?`\n${session.text || '説明文なし'}`:''}\n出典: <${session.source}>`, session.warnings.length ? colors.warning : colors.preview);
  result.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(...session.files.map(file => new MediaGalleryItemBuilder().setURL(`attachment://${file.name}`))));
  if (session.warnings.length) result.addTextDisplayComponents(text(`**取得時の注意**\n${session.warnings.join('\n')}`));
  result.addTextDisplayComponents(text('-# この画面はあなただけに表示されています。出典URLから元の作者やアカウントが分かる場合があります。'));
  result.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
    .setCustomId(`preview:${id}:select`).setPlaceholder('投稿する画像を選ぶ').setMinValues(1).setMaxValues(session.files.length)
    .addOptions(session.files.map((file, index) => ({ label: `画像 ${index + 1}`, value: `${index}`, default: session.selected.includes(index) })))));
  result.addActionRowComponents(row(button(`preview:${id}:send`, `${session.selected.length}枚を投稿する`, ButtonStyle.Success), ...(caption?[button(`preview:${id}:edit`, '説明文を直す')]:[]), button(`preview:${id}:cancel`, 'キャンセル')));
  return [result];
}
