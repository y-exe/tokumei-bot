import type { RepliableInteraction } from 'discord.js';
import { commands } from '../commands.js';
import { parseDiagnosticCode } from '../infra/diagnostics.js';

const commandNames = new Set(commands.map(command => command.name));
const operations: Record<string, string> = {
  cfg: '設定の変更', edit: '設定の入力', post: '投稿フォームを開く', submit: '匿名投稿',
  preview: '投稿の確認', caption: '説明文の変更', reply: '返信', replyimage: '画像で返信',
  own: '自分の投稿の操作', selfedit: '自分の投稿の編集', mine: '自分の投稿の一覧',
  recover: '送信結果の確認', report: '通報', reports: '通報の確認', mod: '通報の操作',
  moderate: '通報への対応', punish: '通報への対応', dismiss: '画面を閉じる',
  blocked: '禁止用語の修正',
};

export function reportOperation(interaction: RepliableInteraction): string {
  if (interaction.isCommand()) return commandNames.has(interaction.commandName) ? interaction.commandName : '不明';
  const prefix = 'customId' in interaction ? interaction.customId.split(':')[0] : undefined;
  return prefix && Object.hasOwn(operations, prefix) ? operations[prefix]! : '不明';
}

export function bugReportUrl(operation: string, code: string | undefined, occurredAt: Date): string {
  const safeOperation = commandNames.has(operation) || Object.values(operations).includes(operation) ? operation : '不明';
  const errorId = code ? parseDiagnosticCode(code) : undefined;
  const url = new URL('https://github.com/y-exe/tokumei-bot/issues/new');
  url.searchParams.set('template', 'bug-report.yml');
  url.searchParams.set('title', `[不具合] ${errorId ?? 'Botの操作'}`);
  url.searchParams.set('diagnostics', [
    `操作: ${safeOperation}`, `日時: ${occurredAt.toISOString()}`,
    ...(errorId ? [`エラーID: ${errorId}`] : []),
  ].join('\n'));
  return url.toString();
}
