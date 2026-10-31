import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { classifyImage, initializeSafety, type SafetyLabel } from '../src/media/safety.js';
import { analyzeImageSafety, certifyImage, checkMediaSafety, enforceSafety } from '../src/media/safety-policy.js';
import { defaults, resolveConfig } from '../src/domain/config.js';
import { extractVideoFrame, videoDuration, videoSampleTimes, VideoDecodeError } from '../src/media/video-frames.js';

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

test('設定変更で追加検査が必要な画像は加工後ではなく結び付けた元画像で確認する', async () => {
  const image = await sharp({ create: { width: 32, height: 32, channels: 3, background: 'white' } }).png().toBuffer();
  const original = Buffer.from('broken');
  const certificate = certifyImage(image, { nsfw: false, nsfl: false, checkedNsfw: false, checkedNsfl: true }, original);
  const allowed = resolveConfig(defaults, { content: { allowNsfw: true } });
  await checkMediaSafety(image, allowed, 'image.png', '', certificate, original);
  await assert.rejects(checkMediaSafety(image, defaults, 'image.png', '', certificate, original), /壊れ/);
  await assert.rejects(checkMediaSafety(image, defaults, 'image.png', '', certificate, Buffer.from('other')), /元画像/);
  await assert.rejects(checkMediaSafety(image, defaults, 'image.png', '', { ...certificate, sha256: 'different' }, original), /元画像/);
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

test('動画とGIFから分散抽出したフレームを実ONNXで検査する', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'safety-video-test-'));
  try {
    const path = join(directory, 'safe.mp4');
    await promisify(execFile)(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=64x64:r=1', '-t', '6', '-threads', '1', '-pix_fmt', 'yuv420p', path], { timeout: 15_000 });
    await checkMediaSafety(await readFile(path), resolveConfig(defaults, { content: { allowNsfw: true } }), 'safe.mp4');
    const gif = join(directory, 'safe.gif');
    await promisify(execFile)(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=32x32:r=1', '-t', '6', '-threads', '1', gif]);
    await checkMediaSafety(await readFile(gif), resolveConfig(defaults, { content: { allowNsfw: true } }), 'safe.gif');
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

test('動画長に応じて1〜3コマを先頭から終盤へ分散し、長い動画でも件数を増やさない', () => {
  for (const [seconds, count] of [[1, 1], [5, 1], [6, 2], [30, 2], [31, 2], [120, 2], [121, 3], [600, 3], [3600, 3]]) {
    const times = videoSampleTimes(seconds!);
    assert.equal(times.length, count);
    assert.equal(times[0], 0);
    assert.ok(times.every(time => time >= 0 && time < seconds!));
    assert.ok(times.every((time, index) => !index || time > times[index - 1]!));
    if (count! > 1) assert.ok(times.at(-1)! >= seconds! * 0.8);
  }
  for (const invalid of [0, -1, NaN, Infinity]) assert.throws(() => videoSampleTimes(invalid), VideoDecodeError);
});

test('10分を超える動画も全体をデコードせず指定位置を取り出し、縦横比を維持する', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'video-frames-test-'));
  try {
    const path = join(directory, 'long.mp4');
    await promisify(execFile)(process.env.FFMPEG_PATH ?? 'ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=64x32:r=1', '-t', '610',
      '-threads', '1', '-pix_fmt', 'yuv420p', path,
    ]);
    const duration = await videoDuration(path);
    assert.ok(duration >= 610);
    const times = videoSampleTimes(duration);
    assert.equal(times.length, 3);
    for (const seconds of [times[0]!, times.at(-1)!]) {
      const frame = await extractVideoFrame(path, seconds, 128);
      const metadata = await sharp(frame).metadata();
      assert.equal(metadata.width, 128);
      assert.equal(metadata.height, 64);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('長さ情報のないWebMでも映像パケットから長さを確認できる', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'video-webm-test-'));
  try {
    const video = await promisify(execFile)(process.env.FFMPEG_PATH ?? 'ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=64x64:r=5', '-t', '2',
      '-threads', '1', '-c:v', 'libvpx', '-f', 'webm', 'pipe:1',
    ], { encoding: 'buffer' });
    const path = join(directory, 'stream.webm');
    await writeFile(path, video.stdout);
    const duration = await videoDuration(path);
    assert.ok(duration >= 1.8 && duration <= 2.2);
    assert.ok((await extractVideoFrame(path, 1, 64)).length > 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('壊れた動画と映像のないファイルは診断可能なエラーとして拒否する', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'video-broken-test-'));
  try {
    const path = join(directory, 'broken.mp4');
    await writeFile(path, 'broken');
    await assert.rejects(videoDuration(path), error => error instanceof VideoDecodeError && error.stage === 'probe');
    await assert.rejects(extractVideoFrame(path, 0, 64), error => error instanceof VideoDecodeError && error.stage === 'frame');
    const audio = join(directory, 'audio.m4a');
    await promisify(execFile)(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc', '-t', '1', audio]);
    await assert.rejects(videoDuration(audio), error => error instanceof VideoDecodeError && error.reason === 'no_video_stream');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('動画を装ったプレイリストから外部URLや別のローカルファイルを読み込まない', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'video-playlist-test-'));
  try {
    const image = join(directory, 'private.png');
    await sharp({ create: { width: 16, height: 16, channels: 3, background: 'white' } }).png().toFile(image);
    for (const [name, body] of [
      ['remote.mp4', '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttps://127.0.0.1/private.ts\n#EXT-X-ENDLIST\n'],
      ['local.mp4', `ffconcat version 1.0\nfile '${image.replaceAll('\\', '/')}'\n`],
    ]) {
      const path = join(directory, name!);
      await writeFile(path, body!);
      await assert.rejects(videoDuration(path), VideoDecodeError);
      await assert.rejects(extractVideoFrame(path, 0, 64), VideoDecodeError);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
