import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { defaults, exportTemplate, importTemplate, presetOverrides, resolveConfig } from '../src/domain/config.js';
import { validatePost, validateText, type PostInput } from '../src/domain/validation.js';
import { SecretBox } from '../src/infra/secrets.js';
import { Sessions } from '../src/ui/sessions.js';
import { editSection, type EditorSession } from '../src/ui/editor.js';
import { SerialQueue } from '../src/infra/serial.js';

const input: PostInput = { guildId: '100000000000000001', channelId: '200000000000000001', userId: '300000000000000001', operationId: '400000000000000001', roles: [], text: 'こんにちは', media: [] };
const image = { data: Buffer.from('fixture'), name: 'image.jpg', kind: 'image' as const };
test('プリセットごとにテキスト・画像・URLの制約を全入口用の検査で守る', () => {
  const chat = resolveConfig(defaults, presetOverrides('chat'));
  assert.doesNotThrow(() => validatePost(input, chat));
  const images = resolveConfig(defaults, presetOverrides('image'));
  assert.throws(() => validatePost(input, images), /画像の添付が必要/);
  assert.doesNotThrow(() => validatePost({ ...input, media: [image], source: 'https://x.com/example/status/123' }, images));
  const upload = resolveConfig(defaults, presetOverrides('upload'));
  assert.throws(() => validatePost({ ...input, media: [image] }, upload), /説明文/);
  assert.throws(() => validatePost({ ...input, text: '', media: [image], source: 'https://example.com/image.jpg' }, upload), /URL変換/);
  assert.doesNotThrow(() => validatePost({ ...input, text: '', media: [image] }, upload));
  assert.equal(resolveConfig(defaults, presetOverrides('request')).identity.showId, false);
});
test('禁止語の正規化、禁止ドメインのサブドメイン、メンション、投稿ロールを検査する', () => {
  const config = structuredClone(defaults);
  config.policy.blockedWords = ['abc']; config.policy.blockedDomains = ['example.com']; config.policy.allowedRoles = ['500000000000000001'];
  assert.throws(() => validateText('ＡＢＣ', config), /禁止語/);
  assert.throws(() => validateText('https://sub.example.com/a', config), /禁止されているURL/);
  assert.doesNotThrow(() => validateText('https://notexample.com/a', config));
  assert.throws(() => validateText('<@300000000000000001>', config), /メンション/);
  assert.throws(() => validatePost(input, config), /ロール/);
  assert.doesNotThrow(() => validatePost({ ...input, roles: ['500000000000000001'] }, config));
});
test('画像上限・アニメーション・本文上限を共通検査で拒否する', () => {
  assert.throws(() => validatePost({ ...input, media: Array(6).fill(image) }, defaults), /5枚/);
  assert.throws(() => validatePost({ ...input, media: [{ ...image, kind: 'animation' }] }, defaults), /動く画像/);
  assert.throws(() => validateText('a'.repeat(1801), defaults), /1800/);
});
test('設定は深い継承、厳密なインポート、秘密情報排除を行う', () => {
  const value = { panel: { title: '画像置き場' }, policy: { cooldown: 10 } };
  const config = resolveConfig(defaults, value);
  assert.equal(config.panel.description, defaults.panel.description);
  assert.equal(config.policy.cooldown, 10);
  assert.deepEqual(importTemplate(JSON.parse(exportTemplate(value)), defaults), value);
  assert.throws(() => importTemplate({ version: 1, settings: { webhook: 'secret' } }, defaults));
  assert.throws(() => importTemplate({ version: 1, settings: { panel: { image: 'http://example.com/a' } } }, defaults));
});
test('無効な設定変更は編集中の下書きを壊さない', () => {
  const session = { scope: 'channel', original: { base: defaults }, value: {} } as EditorSession;
  assert.throws(() => editSection(session, 'content', { text: false, images: false }));
  assert.deepEqual(session.value, {});
});
test('下書きは本人とサーバーで分離し、容量・期限を制限する', async () => {
  const sessions = new Sessions(10, 5);
  const id = sessions.create({ owner: 'alice', guildId: 'a', channelId: 'c' }, 5);
  assert.throws(() => sessions.get(id, 'bob', 'a'), /本人/);
  assert.throws(() => sessions.get(id, 'alice', 'b'), /本人/);
  assert.throws(() => sessions.create({ owner: 'alice', guildId: 'a', channelId: 'c' }, 1), /混み合って/);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.throws(() => sessions.get(id, 'alice', 'a'), /有効期限/);
});
test('Webhook資格情報は暗号化し、改ざんを検知する', () => {
  const box = new SecretBox(randomBytes(32).toString('base64'));
  const encrypted = box.seal('https://discord.com/api/webhooks/123/private');
  assert.ok(!encrypted.includes('private'));
  assert.equal(box.open(encrypted), 'https://discord.com/api/webhooks/123/private');
  const parts = encrypted.split('.'); const data = Buffer.from(parts[2]!, 'base64'); data[0] = data[0]! ^ 1; parts[2] = data.toString('base64');
  assert.throws(() => box.open(parts.join('.')));
});
test('同じチャンネルの投稿は送信順を保ち、別チャンネルは待たず、失敗後も次の投稿が動く', async () => {
  const queue = new SerialQueue(10, 3); const order: string[] = []; let release!: () => void;
  const first = queue.run('channel-a', 4, async () => { order.push('a1-start'); await new Promise<void>(resolve => release = resolve); order.push('a1-end'); throw new Error('simulated send failure'); });
  const firstResult = assert.rejects(first, /simulated/);
  await new Promise(resolve => setImmediate(resolve));
  const second = queue.run('channel-a', 4, async () => { order.push('a2'); });
  await queue.run('channel-b', 1, async () => { order.push('b'); });
  await assert.rejects(queue.run('channel-c', 3, async () => undefined), /混み合って/);
  assert.deepEqual(order, ['a1-start', 'b']); release(); await Promise.all([firstResult, second]);
  assert.deepEqual(order, ['a1-start', 'b', 'a1-end', 'a2']);
  await assert.doesNotReject(queue.run('channel-a', 10, async () => undefined));
});
