import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp, { type Metadata } from 'sharp';
import type { Config } from '../domain/config.js';
import { UserError, MediaSafetyError } from '../domain/errors.js';
import { createHash } from 'node:crypto';
import { classifyImage, type SafetyResult } from './safety.js';
import { WorkQueue } from './http.js';
import { detectBodyParts, exposesRestrictedParts } from './nudity.js';
import { hasAnimeExposure, ANIME_INPUT_SIZE } from './anime-nudity.js';
import { extractVideoFrame, videoDuration, videoSampleTimes, VideoDecodeError } from './video-frames.js';

const queue = new WorkQueue(1, 10);
const frameQueue = new WorkQueue(1, 10);
const detectorVersion = 'nudenet320-anime-s1216-crop8-0.6-v3';
export type ImageSafetyFacts = { nsfw: boolean; nsfl: boolean; checkedNsfw?: boolean; checkedNsfl?: boolean };
export type ImageSafetyCertificate = ImageSafetyFacts & { sha256: string; version: string };
export function certifyImage(data: Buffer, facts: ImageSafetyFacts): ImageSafetyCertificate {
  return { ...facts, checkedNsfw: facts.checkedNsfw ?? true, checkedNsfl: facts.checkedNsfl ?? true,
    sha256: createHash('sha256').update(data).digest('hex'), version: detectorVersion };
}
export function enforceImageSafety(facts: ImageSafetyFacts, config: Config): void {
  if (facts.nsfl) enforceSafety({ label: 'NSFL', sfw: 0, nsfw: 0, nsfl: 1 }, config);
  if (facts.nsfw) enforceSafety({ label: 'NSFW', sfw: 0, nsfw: 1, nsfl: 0 }, config);
}
export function enforceSafety(result: SafetyResult, config: Config): void {
  if ((result.label === 'NSFW' && !config.content.allowNsfw) || (result.label === 'NSFL' && !config.content.allowNsfl))
    throw new MediaSafetyError(`このチャンネルでは${result.label === 'NSFW' ? '性的な画像・動画（NSFW）' : 'グロ・流血画像・動画（NSFL）'}を投稿できません。\n\n${result.label === 'NSFW' ? '性的な画像でない場合は管理者にお問い合わせください\nNSFW検知モデルの改善等致します' : 'グロ・流血画像でない場合は管理者にお問い合わせください\nNSFL検知モデルの改善等致します'}`);
}

export async function analyzeImageSafety(data: Buffer, config?: Config): Promise<ImageSafetyFacts> {
  const checkedNsfw = !config?.content.allowNsfw;
  const checkedNsfl = !config?.content.allowNsfl;
  if (!checkedNsfw && !checkedNsfl) return { nsfw: false, nsfl: false, checkedNsfw, checkedNsfl };
  return frameQueue.run(async () => {
    const nsfl = checkedNsfl && (await classifyImage(data)).label === 'NSFL';
    const nsfw = checkedNsfw && (exposesRestrictedParts(await detectBodyParts(data)) || await hasAnimeExposure(data));
    return { nsfw, nsfl, checkedNsfw, checkedNsfl };
  });
}
async function checkFrame(data: Buffer, config: Config): Promise<void> {
  enforceImageSafety(await analyzeImageSafety(data, config), config);
}

export async function checkMediaSafety(data: Buffer, config: Config, name = '', contentType = '', certificate?: ImageSafetyCertificate): Promise<void> {
  if (config.content.allowNsfw && config.content.allowNsfl) return;
  return queue.run(async () => {
    if (certificate?.version === detectorVersion &&
        (config.content.allowNsfw || certificate.checkedNsfw === true) &&
        (config.content.allowNsfl || certificate.checkedNsfl === true) &&
        certificate.sha256 === createHash('sha256').update(data).digest('hex')) {
      enforceImageSafety(certificate, config); return;
    }
    let metadata: Metadata | undefined;
    try { metadata = await sharp(data, { limitInputPixels: 40_000_000 }).metadata(); } catch {}
    const video = contentType.startsWith('video/') || /\.(mp4|webm|mov|mkv|avi|m4v)$/i.test(name) || data.subarray(4, 8).toString() === 'ftyp' || data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    if (!metadata && !video) {
      if (contentType.startsWith('image/') || /\.(gif|webp|jpe?g|png|avif)$/i.test(name)) throw new UserError('画像が壊れているため安全判定できません。');
      return;
    }
    try {
      if (metadata && (metadata.pages ?? 1) === 1) { await checkFrame(data, config); return; }
      const started = performance.now();
      if (metadata) {
        const delay = (page: number) => Math.max(metadata!.delay?.[page] ?? 100, 10);
        let duration = 0;
        for (let page = 0; page < metadata.pages!; page++) duration += delay(page);
        const times = videoSampleTimes(duration / 1000);
        let elapsed = 0; let target = 0; let frames = 0;
        for (let page = 0; page < metadata.pages! && target < times.length; page++) {
          const end = elapsed + delay(page);
          if (times[target]! * 1000 < end) {
            const frame = await sharp(data, { page, pages: 1, limitInputPixels: 40_000_000 }).resize(ANIME_INPUT_SIZE, ANIME_INPUT_SIZE, { fit: 'inside', withoutEnlargement: true, kernel: 'cubic' }).png().toBuffer();
            await checkFrame(frame, config);
            frames++;
            while (target < times.length && times[target]! * 1000 < end) target++;
          }
          elapsed = end;
        }
        console.info('[safety] アニメーション判定完了', { seconds: duration / 1000, frames, ms: Math.round(performance.now() - started) });
        return;
      }
      const directory = await mkdtemp(join(tmpdir(), 'tokumei-safety-'));
      try {
        const path = join(directory, 'input');
        await writeFile(path, data);
        const duration = await videoDuration(path);
        const times = videoSampleTimes(duration);
        for (const seconds of times) {
          const frame = await extractVideoFrame(path, seconds, ANIME_INPUT_SIZE);
          await checkFrame(frame, config);
        }
        console.info('[safety] 動画判定完了', { seconds: duration, frames: times.length, ms: Math.round(performance.now() - started) });
      } finally { await rm(directory, { recursive: true, force: true }); }
    } catch (error) {
      if (error instanceof UserError) throw error;
      console.error('[safety] メディア判定失敗', error instanceof VideoDecodeError ?
        { stage: error.stage, reason: error.reason, exitCode: error.exitCode, signal: error.signal } : { reason: 'inference_failed' });
      throw new UserError('画像・動画の安全判定に失敗したため投稿できません。ファイルを再取得してお試しください。繰り返す場合は管理者にお問い合わせください。');
    }
  });
}
