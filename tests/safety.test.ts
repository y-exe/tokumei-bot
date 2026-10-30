import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { classifyImage, initializeSafety, type SafetyLabel } from '../src/media/safety.js';
import { analyzeImageSafety, certifyImage, checkMediaSafety, enforceSafety } from '../src/media/safety-policy.js';
import { defaults, resolveConfig } from '../src/domain/config.js';

test('安全設定は既存設定でも拒否が初期値でカテゴリごとに許可できる', () => {
  const nsfw = { sfw: 0, nsfw: 1, nsfl: 0, label: 'NSFW' as const };
  const nsfl = { sfw: 0, nsfw: 0, nsfl: 1, label: 'NSFL' as const };
  assert.throws(() => enforceSafety(nsfw, defaults), /NSFW/);
  assert.throws(() => enforceSafety(nsfw, defaults), /性的な画像でない場合は管理者にお問い合わせください\nNSFW検知モデルの改善等致します/);
  assert.throws(() => enforceSafety(nsfl, defaults), /NSFL/);
  const config = resolveConfig(defaults, { content: { allowNsfw: true } });
  enforceSafety(nsfw, config);
  assert.throws(() => enforceSafety(nsfl, config), /NSFL/);
});

test('壊れた画像と動画、内部URLは判定を通過しない', async () => {
  await assert.rejects(checkMediaSafety(Buffer.from('broken'), defaults, 'broken.png'), /壊れ/);
  await assert.rejects(checkMediaSafety(Buffer.from('broken'), defaults, 'broken.mp4'), /安全判定/);
  await assert.rejects(classifyImage('https://127.0.0.1/image.png'), /許可/);
});

test('NSFW許可時はNSFLだけを判定し、未検査カテゴリの証明を拒否設定で使い回さない', async () => {
  const config = resolveConfig(defaults, { content: { allowNsfw: true } });
  const image = await sharp({ create: { width: 64, height: 48, channels: 3, background: 'white' } }).png().toBuffer();
  const facts = await analyzeImageSafety(image, config);
  assert.deepEqual(facts, { nsfw: false, nsfl: false, checkedNsfw: false, checkedNsfl: true });
  const broken = Buffer.from('broken');
  const certificate = certifyImage(broken, facts);
  await checkMediaSafety(broken, config, 'broken.png', '', certificate);
  await assert.rejects(checkMediaSafety(broken, defaults, 'broken.png', '', certificate), /壊れ/);
  const nsfwOnly = resolveConfig(defaults, { content: { allowNsfl: true } });
  const uncheckedNsfl = certifyImage(broken, { nsfw: false, nsfl: false, checkedNsfw: true, checkedNsfl: false });
  await checkMediaSafety(broken, nsfwOnly, 'broken.png', '', uncheckedNsfl);
  await assert.rejects(checkMediaSafety(broken, defaults, 'broken.png', '', uncheckedNsfl), /壊れ/);
});

test('NSFWとNSFLを両方許可した場合は画像・動画の安全判定を実行しない', async () => {
  const config = resolveConfig(defaults, { content: { allowNsfw: true, allowNsfl: true } });
  const broken = Buffer.from('broken');
  assert.deepEqual(await analyzeImageSafety(broken, config), { nsfw: false, nsfl: false, checkedNsfw: false, checkedNsfl: false });
  await checkMediaSafety(broken, config, 'broken.png');
  await checkMediaSafety(broken, config, 'broken.mp4');
});

test('実ONNXのSingleton・RGB画像形式・確率を検証する', async () => {
  assert.equal(initializeSafety(), initializeSafety());
  for (const format of ['png', 'jpeg', 'webp', 'gif'] as const) {
    const data = await sharp({ create: { width: 64, height: 48, channels: 3, background: 'white' } }).toFormat(format).toBuffer();
    const result = await classifyImage(data);
    assert.ok(Math.abs(result.sfw + result.nsfw + result.nsfl - 1) < 0.001);
    assert.ok(['SFW', 'NSFW', 'NSFL'].includes(result.label));
    assert.equal(result.label, 'SFW');
  }
});

test('動画をFFmpegで抽出し5秒ごとのフレームを実ONNXで検査する', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'safety-video-test-'));
  try {
    const path = join(directory, 'safe.mp4');
    await promisify(execFile)(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=64x64:r=1', '-t', '6', '-threads', '1', '-pix_fmt', 'yuv420p', path], { timeout: 15_000 });
    await checkMediaSafety(await readFile(path), resolveConfig(defaults, { content: { allowNsfw: true } }), 'safe.mp4');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const [file, expected] of [['sfw.jpg', 'SFW'], ['nsfw-real.jpg', 'NSFW'], ['nsfw-anime.png', 'NSFW'], ['nsfl.jpg', 'NSFL']] as [string, SafetyLabel][]) {
  test(`実画像サンプル ${file} → ${expected}`, async t => {
    if (!process.env.SAFETY_FIXTURES_DIR) { t.skip('SAFETY_FIXTURES_DIRが未設定'); return; }
    const path = join(process.env.SAFETY_FIXTURES_DIR, file);
    await access(path);
    const result = await classifyImage(await readFile(path));
    console.info(file, result);
    assert.equal(result.label, expected);
  });
}
