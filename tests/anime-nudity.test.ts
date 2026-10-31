import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { confirmAnimeExposure, detectAnimeExposure, hasAnimeExposure, initializeAnimeNudity } from '../src/media/anime-nudity.js';
import { parseDetections } from '../src/media/nudity.js';
import type { BodyDetection } from '../src/media/nudity.js';
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

test('高信頼の検出と検出なしでは切り出し推論を行わない', async () => {
  const detect = async () => { throw new Error('不要な再推論'); };
  assert.equal(await confirmAnimeExposure(Buffer.alloc(0), [], detect), false);
  assert.equal(await confirmAnimeExposure(Buffer.alloc(0), [{ label: 'penis', score: 0.6, box: [0, 0, 10, 10] }], detect), true);
});

test('低信頼の検出は周辺を含む領域で同じ部位を再確認する', async () => {
  const image = await sharp({ create: { width: 300, height: 500, channels: 3, background: 'white' } }).png().toBuffer();
  const detections: BodyDetection[] = [{ label: 'nipple_f', score: 0.3677, box: [1180, 10, 27, 30] }];
  const detect = async (crop: Buffer): Promise<BodyDetection[]> => {
    const metadata = await sharp(crop).metadata();
    assert.equal(metadata.width, 240);
    assert.equal(metadata.height, 240);
    const scale = 1216 / 240;
    return [{ label: 'nipple_f', score: 0.3, box: [204 * scale, 10 * scale, 27 * scale, 30 * scale] }];
  };
  assert.equal(await confirmAnimeExposure(image, detections, detect), true);
  assert.equal(await confirmAnimeExposure(image, detections, async () => []), false);
  assert.equal(await confirmAnimeExposure(image, detections, async () => [{ label: 'nipple_f', score: 0.3, box: [10, 10, 30, 30] }]), false);
  assert.equal(await confirmAnimeExposure(image, detections, async () => [{ label: 'penis', score: 0.8, box: [0, 0, 10, 10] }]), false);
});

test('複数の低信頼候補は逐次確認し、再検出された場合に拒否する', async () => {
  const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: 'white' } }).png().toBuffer();
  const detections: BodyDetection[] = [
    { label: 'nipple_f', score: 0.5, box: [0, 0, 25, 25] },
    { label: 'pussy', score: 0.3, box: [600, 600, 25, 20] },
  ];
  let calls = 0;
  assert.equal(await confirmAnimeExposure(image, detections, async crop => {
    calls++;
    const metadata = await sharp(crop).metadata();
    assert.equal(metadata.width, 200);
    return calls === 1 ? [] : [{ label: 'pussy', score: 0.3, box: [88 * 6.08, 90 * 6.08, 25 * 6.08, 20 * 6.08] }];
  }), true);
  assert.equal(calls, 2);
  await assert.rejects(confirmAnimeExposure(image, detections, async () => { throw new Error('推論失敗'); }), /推論失敗/);
});

test('大きな候補でも全画像と同じ領域を再推論せず、別の位置の検出を確認として扱わない', async () => {
  const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: 'white' } }).png().toBuffer();
  const detections: BodyDetection[] = [{ label: 'penis', score: 0.27, box: [422, 740, 193, 91] }];
  assert.equal(await confirmAnimeExposure(image, detections, async crop => {
    assert.equal((await sharp(crop).metadata()).width, 972);
    return [{ label: 'penis', score: 0.55, box: [1100, 1100, 20, 20] }];
  }), false);
});

test('報告された装飾の誤検出画像は再確認で許可する', async t => {
  if (!process.env.SAFETY_FALSE_POSITIVE_IMAGE) { t.skip('SAFETY_FALSE_POSITIVE_IMAGE未設定'); return; }
  const data = await readFile(process.env.SAFETY_FALSE_POSITIVE_IMAGE);
  assert.equal(await hasAnimeExposure(data), false);
  await new MediaService().optimize(data, defaults);
});

test('報告された水着画像は切り出し再確認で許可する', async t => {
  if (!process.env.SAFETY_SWIMSUIT_IMAGE) { t.skip('SAFETY_SWIMSUIT_IMAGE未設定'); return; }
  const data = await readFile(process.env.SAFETY_SWIMSUIT_IMAGE);
  assert.equal(await hasAnimeExposure(data), false);
  await new MediaService().optimize(data, defaults);
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
    assert.equal(optimized.safety?.checkedNsfw, false);
    assert.equal(optimized.safetyInput, data);
    await assert.rejects(checkMediaSafety(optimized.data, defaults, optimized.name, '', optimized.safety, optimized.safetyInput), /NSFW/);
    await checkMediaSafety(optimized.data, allowed, optimized.name, '', optimized.safety, optimized.safetyInput);
  });
}
