import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLegacy, migrationSummary } from '../src/migration/legacy.js';

const guild = '100000000000000020'; const channel = '200000000000000020'; const user = '300000000000000020';
const webhook = 'https://discord.com/api/webhooks/500000000000000020/testtoken';
const now = new Date('2026-10-05T00:00:00Z');
test('移行dry-runは明示されたサーバー対応だけを使い、共通制限を全サーバーへ配らない', () => {
  const plan = planLegacy({ channels: { [channel]: { webhook_url: webhook, source: 'image', button_message_id: 'old-panel' }, '200000000000000021': { webhook_url: webhook } },
    keywords: ['legacyword'], bans: { [user]: {} } }, { channels: { [channel]: guild } }, now);
  assert.equal(plan.channels.length, 1); assert.equal(plan.channels[0]?.overrides.content?.text, false);
  assert.equal(plan.restrictions.length, 0); assert.deepEqual(plan.guilds.get(guild)?.policy.blockedWords, []);
  assert.ok(plan.warnings.some(value => value.includes('globalsGuild')));
  const explicit = planLegacy({ channels: { [channel]: { webhook_url: webhook } }, keywords: ['legacyword'], bans: { [user]: {} } }, { channels: { [channel]: guild }, globalsGuild: guild }, now);
  assert.equal(explicit.restrictions[0]?.guildId, guild); assert.deepEqual(explicit.guilds.get(guild)?.policy.blockedWords, ['legacyword']);
});
test('無期限への移行は古い投稿を復旧し、作成日時がない投稿は保留する', () => {
  const plan = planLegacy({ channels: { [channel]: { webhook_url: webhook } }, messages: {
    '600000000000000020': { channel_id: channel, user_id: user, timestamp: '2026-10-04T23:00:00Z', content: '本文', anonymous_id: 12 },
    '600000000000000021': { channel_id: channel, user_id: user, timestamp: '2026-09-01T00:00:00Z', content: '期限切れ' },
    '600000000000000022': { channel_id: channel, user_id: user },
  } }, { channels: { [channel]: guild } }, now);
  assert.equal(plan.posts.length, 2); assert.equal(plan.skippedExpired, 0); assert.ok(plan.warnings.some(value => value.includes('作成日時')));
  assert.ok(plan.posts.every(post=>post.expires==='infinity'));
  const summary = JSON.stringify(migrationSummary(plan));
  assert.ok(!summary.includes('testtoken')); assert.ok(!summary.includes('本文')); assert.ok(!summary.includes(user));
});
test('移行は匿名カウンターと直近セッションを引き継ぎ、不正なWebhookを保留する', () => {
  const plan = planLegacy({ channels: { [channel]: { webhook_url: webhook }, '200000000000000021': { webhook_url: 'https://evil.example/api/webhooks/123/secret' } },
    anonymous: { [channel]: { counter: 12, last_user_id: user } }, users: { [user]: { [channel]: { timestamp: '2026-10-04T23:55:00Z', anonymous_id: 12, avatar_url: 'https://cdn.discordapp.com/embed/avatars/3.png' } } } },
  { channels: { [channel]: guild, '200000000000000021': guild } }, now);
  assert.equal(plan.channels.length, 1); assert.equal(plan.counters[0]?.counter, 12); assert.equal(plan.sessions[0]?.avatar, 3);
  assert.equal(plan.sessions[0]?.anonymousId, 12);
});
