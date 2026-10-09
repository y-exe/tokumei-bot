import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DiscordAPIError, HTTPError } from 'discord.js';
import { deliveryError } from '../src/services/delivery-error.js';

test('Discordの明確な拒否は送信結果不明と区別し、Webhookや投稿内容を出力しない', () => {
  const output = mock.method(console, 'error', () => {});
  try {
    for (const [code, status, expected] of [[10015,404,/Webhook/],[50013,403,/権限/],[40005,413,/送信上限/],[50035,400,/投稿内容/]] as const) {
      const failure = new DiscordAPIError({ message: 'private text', code }, code, status, 'POST', 'https://discord.com/api/webhooks/123/secret-token', { body: { content: 'private text' }, files: [] });
      const result = deliveryError(failure, true);
      assert.match(result.message, expected);
      assert.match(result.message, new RegExp(`Discordコード: ${code}`));
      assert.doesNotMatch(result.message, /送信結果を確認できません|private text|secret-token/);
    }
    assert.doesNotMatch(JSON.stringify(output.mock.calls.map(call => call.arguments)), /private text|secret-token/);
  } finally { output.mock.restore(); }
});

test('通信障害とHTTP 5xxでは結果不明を維持し、自動再送を案内しない', () => {
  const output = mock.method(console, 'error', () => {});
  try {
    assert.match(deliveryError(new Error('private network details'), true).message, /送信結果を確認できませんでした/);
    assert.match(deliveryError(new Error('timeout'), true).message, /自動照合・再送は行いません/);
    const result = deliveryError(new HTTPError(500, 'secret response', 'POST', 'https://discord.com/api/webhooks/123/secret-token', {}), false);
    assert.match(result.message, /送信結果を確認できませんでした/);
    assert.match(result.message, /HTTP: 500/);
    assert.match(result.message, /`\/mine`/);
    assert.doesNotMatch(result.message, /secret response|secret-token|private network/);
  } finally { output.mock.restore(); }
});
