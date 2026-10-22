import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RepliableInteraction } from 'discord.js';
import { commands } from '../src/commands.js';
import { bugReportUrl, reportOperation } from '../src/ui/bug-report.js';

const date = new Date('2026-10-23T00:00:00.000Z');

test('報告URLはテンプレートの動作情報に操作・日時・エラーIDを入力する', () => {
  const url = new URL(bugReportUrl('setup', '0a4dcaf0', date));
  assert.equal(url.origin, 'https://github.com');
  assert.equal(url.pathname, '/y-exe/tokumei-bot/issues/new');
  assert.equal(url.searchParams.get('template'), 'bug-report.yml');
  assert.equal(url.searchParams.get('title'), '[不具合] 0a4dcaf0');
  assert.equal(url.searchParams.get('diagnostics'), '操作: setup\n日時: 2026-10-23T00:00:00.000Z\nエラーID: 0a4dcaf0');
  assert.equal(url.searchParams.get('problem'), null);
});

test('報告URLはIDなしでも使え、未知の操作や任意文字列を外へ渡さない', () => {
  const url = new URL(bugReportUrl('https://private.example/secret?cookie=value', 'private-token', date));
  assert.match(url.searchParams.get('diagnostics')!, /操作: 不明/);
  assert.ok(!url.toString().includes('private'));
  assert.ok(!url.searchParams.get('diagnostics')!.includes('エラーID'));
});

test('全コマンドとボタン操作でDiscordリンクボタンの512文字以内に収める', () => {
  for (const operation of [...commands.map(command => command.name), '設定の変更', '自分の投稿の編集', '送信結果の確認']) {
    for (const code of ['0a4dcaf0', undefined]) assert.ok(bugReportUrl(operation, code, date).length <= 512, operation);
  }
});

test('操作名は固定文面に変換し、セッションや投稿・チャンネルのIDを含めない', () => {
  for (const customId of ['cfg:private-session:save', 'punish:1401157007691743312:ban:1407703723907616809']) {
    const operation = reportOperation({isCommand:()=>false,customId} as unknown as RepliableInteraction);
    assert.ok(['設定の変更','通報への対応'].includes(operation));
    const url = decodeURIComponent(bugReportUrl(operation, '0a4dcaf0', date));
    assert.ok(!url.includes('private-session')); assert.ok(!/140\d{15}/.test(url));
  }
});
