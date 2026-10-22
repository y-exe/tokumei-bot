export class UserError extends Error {}
export class MediaSafetyError extends UserError {}

export function errorMessage(error: unknown): string {
  if (error instanceof UserError) return error.message;
  return '処理を完了できませんでした。時間をおいて再試行してください。';
}
