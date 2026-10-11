import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { detectAnimeExposure, initializeAnimeNudity } from '../src/media/anime-nudity.js';
import { parseDetections } from '../src/media/nudity.js';
import { checkMediaSafety, certifyImage } from '../src/media/safety-policy.js';
import { MediaService } from '../src/media/service.js';
import { defaults } from '../src/domain/config.js';

test('二次元モデルのラベルと配布閾値を実ファイルから検証する', async () => {
  assert.equal(initializeAnimeNudity(), initializeAnimeNudity());
  const { labels, threshold } = await initializeAnimeNudity();
  assert.deepEqual(new Set(labels), new Set(['nipple_f', 'penis', 'pussy']));
  assert.equal(threshold, 0.238);
  const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: 'white' } }).png().toBuffer();
  assert.deepEqual(await detectAnimeExposure(image), []);
  await assert.rejects(detectAnimeExposure(Buffer.from('broken')));
});

test('二次元モデルの推奨閾値が0.25未満でも正しく適用する', () => {
  const values = new Float32Array([20, 20, 10, 10, 0.24, 0.001, 0.001]);
  assert.equal(parseDetections(values, 1, ['nipple_f', 'penis', 'pussy'], 0.238, 0.7).length, 1);
  values[4] = 0.23;
  assert.equal(parseDetections(values, 1, ['nipple_f', 'penis', 'pussy'], 0.238, 0.7).length, 0);
});

test('元画像の判定は現在の設定で再評価し、内容・バージョンが違うキャッシュは使わない', async () => {
  const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: 'white' } }).png().toBuffer();
  const certificate = certifyImage(image, { nsfw: true, nsfl: false });
  await assert.rejects(checkMediaSafety(image, defaults, 'test.png', '', certificate), /NSFW/);
  await checkMediaSafety(image, { ...defaults, content: { ...defaults.content, allowNsfw: true } }, 'test.png', '', certificate);
  await checkMediaSafety(image, defaults, 'test.png', '', { ...certificate, sha256: 'different' });
  await checkMediaSafety(image, defaults, 'test.png', '', { ...certificate, version: 'old' });
});

for (let index = 1; index <= 4; index++) {
  test(`報告された見逃し画像${index}は元画像・最適化後とも拒否する`, async t => {
    if (!process.env.SAFETY_REPORTED_IMAGE_DIR) { t.skip('SAFETY_REPORTED_IMAGE_DIR未設定'); return; }
    const data = await readFile(join(process.env.SAFETY_REPORTED_IMAGE_DIR, `nsfw-${index}.jpg`));
    const detections = await detectAnimeExposure(data);
    assert.ok(detections.length > 0);
    console.info(`サンプル${index}`, detections.map(detection => ({ label: detection.label, score: detection.score })));
    await assert.rejects(new MediaService().optimize(data, defaults), /NSFW/);
    const allowed = { ...defaults, content: { ...defaults.content, allowNsfw: true } };
    const optimized = await new MediaService().optimize(data, allowed);
    assert.equal(optimized.safety?.nsfw, true);
    await assert.rejects(checkMediaSafety(optimized.data, defaults, optimized.name, '', optimized.safety), /NSFW/);
    await checkMediaSafety(optimized.data, allowed, optimized.name, '', optimized.safety);
  });
}
