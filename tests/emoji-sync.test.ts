import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { loadEmojiAssets, syncApplicationEmojis, type ApplicationEmoji } from '../src/ui/emoji-sync.js';
import { emojiDefinitions, fallbackEmoji } from '../src/ui/emojis.js';

function fixture(initial: ApplicationEmoji[] = []) {
  const items = [...initial]; let created = 0; let fail = '';
  const api = {
    list: async () => [...items],
    create: async (name: string, _image: Buffer) => {
      if (name === fail) throw new Error('追加失敗');
      const emoji = { id: `${100000000000000000n + BigInt(++created)}`, name };
      items.push(emoji); return emoji;
    },
  };
  return { api, items, fail: (name: string) => { fail = name; } };
}

test('全9種類の素材を128px・256KiB以下のPNGとして同梱する', async () => {
  const assets = await loadEmojiAssets();
  assert.equal(assets.length, 9);
  for (const asset of assets) {
    const metadata = await sharp(asset.image).metadata();
    assert.equal(metadata.format, 'png'); assert.equal(metadata.width, 128); assert.equal(metadata.height, 128);
    assert.ok(asset.image.length <= 256 * 1024);
  }
});

test('初回だけ登録し、再起動・絵文字削除後には不足分だけ補充する', async () => {
  const f = fixture();
  const first = await syncApplicationEmojis(f.api);
  assert.equal(first.created, 9); assert.deepEqual(first.failed, []);
  const restart = await syncApplicationEmojis(f.api);
  assert.equal(restart.created, 0); assert.equal(restart.reused, 9); assert.deepEqual(restart.mappings, first.mappings);
  f.items.splice(f.items.findIndex(emoji => emoji.name === 'tm_info'), 1);
  assert.equal((await syncApplicationEmojis(f.api)).created, 1); assert.equal(f.items.length, 9);
});

test('旧名の登録をID・名前を変更せず再利用し、無関係な絵文字を維持する', async () => {
  const initial = Object.values(emojiDefinitions).map((definition, index) => ({ id: String(index + 1), name: definition.legacyName }));
  initial.push({ id:'unrelated', name:'other' });
  const f = fixture(initial); const result = await syncApplicationEmojis(f.api);
  assert.equal(result.created, 0); assert.equal(result.reused, 9); assert.deepEqual(f.items, initial);
  assert.equal(result.mappings.check, '<:legacy_9:1>');
});

test('追加が途中で失敗しても成功分を使い、次回は失敗分だけ再試行する', async () => {
  const f = fixture(); f.fail('tm_warning');
  const first = await syncApplicationEmojis(f.api);
  assert.equal(first.created, 8); assert.deepEqual(first.failed, ['warning']);
  assert.equal(first.mappings.warning, fallbackEmoji.warning);
  assert.match(first.mappings.info, /^<:tm_info:/);
  f.fail(''); const second = await syncApplicationEmojis(f.api);
  assert.equal(second.created, 1); assert.equal(second.reused, 8); assert.deepEqual(second.failed, []);
});

test('空き枠不足では標準表示にし、素材不備なら登録を開始しない', async () => {
  const f = fixture(Array.from({length:2000}, (_, index)=>({id:String(index),name:`other_${index}`})));
  const full = await syncApplicationEmojis(f.api);
  assert.equal(full.created, 0); assert.equal(full.failed.length, 9); assert.deepEqual(full.mappings, fallbackEmoji);
  const empty = fixture();
  await assert.rejects(syncApplicationEmojis(empty.api, [{key:'check',image:Buffer.from('broken')}]));
  assert.equal(empty.items.length, 0);
});
