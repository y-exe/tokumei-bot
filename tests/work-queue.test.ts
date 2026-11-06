import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkQueue } from '../src/media/http.js';

const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

test('混雑中のWorkQueueは複数guildの処理を交互にさばく', async () => {
  const queue = new WorkQueue(1, 8);
  const order: string[] = [];
  let release: () => void = () => undefined;
  const hold = new Promise<void>(resolve => release = resolve);
  const occupied = queue.run(() => hold, 'idle');
  await Promise.resolve();
  for (let index = 0; index < 3; index++) void queue.run(async () => { order.push(`a${index}`); }, 'a').catch(() => undefined);
  for (let index = 0; index < 3; index++) void queue.run(async () => { order.push(`b${index}`); }, 'b').catch(() => undefined);
  release();
  await occupied;
  await settle();
  assert.deepEqual(order, ['a0', 'b0', 'a1', 'b1', 'a2', 'b2']);
});

test('待ち列の上限はguild間で公平に分けられる', async () => {
  const queue = new WorkQueue(1, 8);
  let release: () => void = () => undefined;
  const hold = new Promise<void>(resolve => release = resolve);
  const occupied = queue.run(() => hold, 'busy');
  await Promise.resolve();
  for (let index = 0; index < 3; index++) void queue.run(async () => undefined, 'busy').catch(() => undefined);
  void queue.run(async () => undefined, 'other').catch(() => undefined);
  await assert.rejects(() => queue.run(async () => undefined, 'busy'), /混み合っています/);
  release();
  await occupied;
  await settle();
});

test('他のguildの待ちが無ければ1つのguildが全待ち列を使える', async () => {
  const queue = new WorkQueue(1, 3);
  let release: () => void = () => undefined;
  const hold = new Promise<void>(resolve => release = resolve);
  const occupied = queue.run(() => hold, 'busy');
  await Promise.resolve();
  const accepted: Promise<unknown>[] = [];
  for (let index = 0; index < 3; index++) accepted.push(queue.run(async () => undefined, 'busy'));
  await assert.rejects(() => queue.run(async () => undefined, 'busy'), /混み合っています/);
  release();
  await occupied;
  await Promise.all(accepted);
  await settle();
});
