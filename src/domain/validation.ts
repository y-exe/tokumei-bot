import type { Config } from './config.js';
import { UserError } from './errors.js';

export interface MediaFile { data: Buffer; name: string; kind: 'image' | 'animation' | 'video' | 'file'; }
export interface PostInput {
  guildId: string; channelId: string; userId: string; roles: string[]; operationId: string;
  text: string; media: MediaFile[]; source?: string; replyTo?: string; videoLinks?: string[];
}

export function validateText(text: string, config: Config, maxLength = 1800): void {
  if (text.length > maxLength) throw new UserError(`本文は${maxLength}文字以内で入力してください。`);
  if (/<@!?&?\d+>|@everyone|@here/i.test(text)) throw new UserError('匿名投稿ではメンションを使えません。');
  const normalized = text.normalize('NFKC').toLocaleLowerCase();
  if (config.policy.blockedWords.some(word => normalized.includes(word.normalize('NFKC').toLocaleLowerCase())))
    throw new UserError('このサーバーの禁止語が含まれています。内容を確認してください。');
  const urls = text.match(/https?:\/\/[^\s<>]+/gi) ?? [];
  for (const value of urls) {
    let host: string;
    try { host = new URL(value).hostname.toLowerCase(); } catch { continue; }
    if (config.policy.blockedDomains.some(domain => host === domain || host.endsWith(`.${domain}`)))
      throw new UserError('このサーバーで禁止されているURLが含まれています。');
  }
}

export function validatePost(input: PostInput, config: Config): void {
  validateText(input.text, config);
  if (input.source) validateText(input.source, config);
  if (config.policy.allowedRoles.length && !input.roles.some(role => config.policy.allowedRoles.includes(role)))
    throw new UserError('このチャンネルに匿名投稿できるロールを持っていません。');
  if (!input.text.trim() && !input.media.length) throw new UserError('本文か画像を入力してください。');
  if (!config.content.text && !input.media.length) throw new UserError('このチャンネルでは画像の添付が必要です。');
  if (input.media.length && !config.content.images) throw new UserError('このチャンネルはテキスト専用です。');
  if (input.media.length && input.text.trim() && !config.content.caption) throw new UserError('このチャンネルでは画像に説明文を付けられません。');
  if (input.source && !config.content.urls) throw new UserError('このチャンネルではURL変換を利用できません。画像を直接添付してください。');
  if (input.media.length > 10) throw new UserError('Discordの上限により、1回に添付できるファイルは10個までです。');
}

export function postContent(text: string, source?: string, replyTo?: string, guildId?: string, channelId?: string, replyNumber?: number, videoLinks?: string[]): string {
  return [replyTo && replyNumber !== undefined ? `[>>${replyNumber}](https://discord.com/channels/${guildId}/${channelId}/${replyTo})` : '', text.trim(), source ? `出典: <${source}>` : '',
    ...(videoLinks ?? []).map(link => `[動画](${link})`)].filter(Boolean).join('\n');
}
