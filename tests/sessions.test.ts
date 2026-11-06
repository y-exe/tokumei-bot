import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sessions } from '../src/ui/sessions.js';

type Session = { owner: string; guildId: string; channelId: string };

test('セッション上限は1サーバーあたりに分けられ、他のサーバーを塞がない', () => {
  const sessions = new Sessions<Session>();
  const create = (guildId: string, id: string): string => sessions.create({ owner: 'owner', guildId, channelId: `channel-${id}` });
  for (let index = 0; index < 25; index++) create('busy-guild', String(index));
  assert.throws(() => create('busy-guild', '25'), /混み合っています/);
  const opened = create('other-guild', '0');
  assert.equal(sessions.get(opened, 'owner', 'other-guild').channelId, 'channel-0');
});

test('全体の上限も他サーバーへ公平に分かれる', () => {
  const sessions = new Sessions<Session>();
  const create = (guildId: string, id: string): string => sessions.create({ owner: 'owner', guildId, channelId: `channel-${id}` });
  for (let index = 0; index < 100; index++) create(`guild-${index}`, String(index));
  assert.throws(() => create('guild-A', 'x'), /混み合っています/);
});
