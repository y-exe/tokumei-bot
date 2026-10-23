export class UserError extends Error {}
export class MediaSafetyError extends UserError {}
export class BlockedWordError extends UserError {
  constructor(readonly words: string[], readonly maxLength = 1800, readonly scope: 'body' | 'source' = 'body') {
    const labels = words.slice(0, 12).map(word => `\`${word.replaceAll('`', 'ˋ').replace(/[\r\n]/g, ' ')}\``).join('・');
    super(`このサーバーの禁止語が${scope === 'source' ? '取得元・出典URL' : '本文'}に含まれています。\n該当する禁止語: ${labels}${words.length > 12 ? ` ほか${words.length - 12}語` : ''}`);
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof UserError) return error.message;
  return '処理を完了できませんでした。時間をおいて再試行してください。';
}
