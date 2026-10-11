import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { detectBodyParts, exposesRestrictedParts, initializeNudity, parseDetections } from '../src/media/nudity.js';
import { checkMediaSafety } from '../src/media/safety-policy.js';
import { defaults } from '../src/domain/config.js';
import { MediaService } from '../src/media/service.js';
import { join } from 'node:path';

test('拒否対象は露出した女性の胸と男女の性器だけで信頼度50%以上', () => {
  const detection = (label: string, score: number) => ({ label, score, box: [0, 0, 10, 10] as [number, number, number, number] });
  for (const label of ['FEMALE_BREAST_EXPOSED', 'FEMALE_GENITALIA_EXPOSED', 'MALE_GENITALIA_EXPOSED']) {
    assert.equal(exposesRestrictedParts([detection(label, 0.5)]), true);
    assert.equal(exposesRestrictedParts([detection(label, 0.49)]), false);
  }
  for (const label of ['BELLY_EXPOSED', 'ARMPITS_EXPOSED', 'MALE_BREAST_EXPOSED', 'FEMALE_BREAST_COVERED', 'FEMALE_GENITALIA_COVERED', 'BUTTOCKS_EXPOSED']) {
    assert.equal(exposesRestrictedParts([detection(label, 0.99)]), false);
  }
  assert.equal(exposesRestrictedParts([detection('BELLY_EXPOSED', 0.6658), detection('FEMALE_GENITALIA_EXPOSED', 0.4476)]), false);
});

test('YOLOのCHW出力とモデル由来のラベルを解釈し重複した箱を抑制する', () => {
  const labels = ['BELLY_EXPOSED', 'FEMALE_GENITALIA_EXPOSED'];
  const output = new Float32Array([20, 20, 20, 20, 10, 10, 10, 10, 0.1, 0.1, 0.9, 0.8]);
  const detections = parseDetections(output, 2, labels);
  assert.equal(detections.length, 1); assert.equal(detections[0]!.label, labels[1]);
  assert.equal(exposesRestrictedParts(detections), true);
  assert.throws(() => parseDetections(new Float32Array(1), 1, labels), /形状/);
  output[10] = NaN;
  assert.throws(() => parseDetections(output, 2, labels), /確率/);
});

test('実ONNXは起動時に一度だけ読み込みRGB・透過・縦長画像を処理する', async () => {
  assert.equal(initializeNudity(), initializeNudity());
  const { session, labels } = await initializeNudity();
  assert.deepEqual(session.inputNames, ['images']); assert.deepEqual(session.outputNames, ['output0']); assert.equal(labels.length, 18);
  for (const [width, height, channels] of [[64, 64, 3], [32, 96, 4]] as const) {
    const image = await sharp({ create: { width, height, channels, background: { r: 255, g: 255, b: 255, alpha: 0.5 } } }).png().toBuffer();
    assert.equal(exposesRestrictedParts(await detectBodyParts(image)), false);
    await checkMediaSafety(image, defaults, 'safe.png');
  }
  await assert.rejects(detectBodyParts(Buffer.from('broken')));
});

test('提供された肌露出画像は投稿拒否しない', async t => {
  if (!process.env.SAFETY_ALLOWED_IMAGE) { t.skip('SAFETY_ALLOWED_IMAGE未設定'); return; }
  const source = await readFile(process.env.SAFETY_ALLOWED_IMAGE);
  await checkMediaSafety(source, defaults, 'sample.png');
  const optimized = await new MediaService().optimize(source, defaults, 0, 'sample.png', 'image/png');
  await checkMediaSafety(optimized.data, defaults, optimized.name);
});

for (const name of ['exposed-real.jpg', 'exposed-anime.png']) {
  test(`実画像の露出検出 ${name}`, async t => {
    if (!process.env.SAFETY_FIXTURES_DIR) { t.skip('SAFETY_FIXTURES_DIR未設定'); return; }
    const data = await readFile(join(process.env.SAFETY_FIXTURES_DIR, name));
    assert.equal(exposesRestrictedParts(await detectBodyParts(data)), true);
    await assert.rejects(checkMediaSafety(data, defaults, name), /NSFW/);
  });
}
