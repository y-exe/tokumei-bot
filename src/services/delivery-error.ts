import { randomUUID } from 'node:crypto';
import { DiscordAPIError, HTTPError } from 'discord.js';
import { UserError } from '../domain/errors.js';

export function deliveryError(error: unknown, withoutLog: boolean): UserError {
  const reference = randomUUID();
  const code = error instanceof DiscordAPIError && typeof error.code === 'number' ? error.code : undefined;
  const status = error instanceof DiscordAPIError || error instanceof HTTPError ? error.status : undefined;
  console.error('匿名投稿の送信処理に失敗しました', { reference, code, status });
  let reason: string | undefined;
  if (code === 10015 || code === 50027 || status === 401) reason = '投稿用Webhookが削除されたか、認証情報が無効になっています。管理者に `/setup` で投稿用Webhookを確認してもらってください。';
  else if (code === 50001 || code === 50013 || status === 403) reason = '投稿先にアクセスできないか、送信に必要な権限がありません。管理者にチャンネルとWebhookの権限を確認してもらってください。';
  else if (code === 40005 || status === 413) reason = '添付ファイルがDiscordの送信上限を超えています。画像や動画のサイズ・枚数を減らしてください。';
  else if (code === 50035) reason = 'Discordが投稿内容を受け付けませんでした。本文や添付ファイルを確認してください。';
  const details = [code !== undefined ? `Discordコード: ${code}` : '', status !== undefined ? `HTTP: ${status}` : '', `確認番号: ${reference}`].filter(Boolean).join(' / ');
  if (reason) return new UserError(`**投稿を送信できませんでした。**\n${reason}\n-# ${details}`);
  return new UserError(`**送信結果を確認できませんでした。**\n${withoutLog ? 'このチャンネルは投稿履歴を保存しない設定です。二重投稿を防ぐため自動照合・再送は行いません。投稿が届いているかチャンネルを確認してください。' : '二重投稿を防ぐため再送せず、`/mine` の「送信結果を確認」から確認してください。'}\n-# ${details}`);
}
