import { ButtonBuilder, ButtonStyle } from 'discord.js';
import type { PostInput } from '../domain/validation.js';
import type { BlockedWordError } from '../domain/errors.js';
import type { OwnedSession } from './sessions.js';
import { button, card, colors, row } from './components.js';

export type TextAction =
  | { kind: 'post'; media: PostInput['media']; source?: string; replyTo?: string; videoLinks?: string[] }
  | { kind: 'url'; url: string }
  | { kind: 'edit'; messageId: string }
  | { kind: 'caption'; previewId: string };
export interface TextRecoverySession extends OwnedSession {
  text: string; action: TextAction; maxLength: number; busy: boolean;
}
export function blockedTextView(id: string, error: BlockedWordError, action: TextAction, reportUrl: string) {
  const notice = action.kind === 'edit' || action.kind === 'caption' ? '入力した変更はまだ反映されていません。' : 'この投稿はまだ送信されていません。';
  return card('禁止用語を確認してください', `${error.message}\n\n${notice}\n本文を修正するか、禁止語を伏字にしてやり直せます。操作できるのは10分間です。`, colors.warning)
    .addActionRowComponents(row(button(`blocked:${id}:edit`, '文字を編集', ButtonStyle.Success), button(`blocked:${id}:mask`, '禁止用語を伏字して再送信', ButtonStyle.Primary),
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('バグを報告').setURL(reportUrl)));
}
