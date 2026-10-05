export class UserError extends Error {}

export function errorMessage(error: unknown): string {
  if (error instanceof UserError) return error.message;
  return '処理を完了できませんでした。少し待ってからもう一度お試しください。';
}
