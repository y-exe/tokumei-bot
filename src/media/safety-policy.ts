import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

const queue = new WorkQueue(1, 10);
const frameQueue = new WorkQueue(1, 10);
const detectorVersion = 'nudenet320-anime-s1216-crop8-0.6-v2';
export type ImageSafetyFacts = { nsfw: boolean; nsfl: boolean };
export type ImageSafetyCertificate = ImageSafetyFacts & { sha256: string; version: string };
export function certifyImage(data: Buffer, facts: ImageSafetyFacts): ImageSafetyCertificate {
  return { ...facts, sha256: createHash('sha256').update(data).digest('hex'), version: detectorVersion };
}
export function enforceImageSafety(facts: ImageSafetyFacts, config: Config): void {
  if (facts.nsfl) enforceSafety({ label: 'NSFL', sfw: 0, nsfw: 0, nsfl: 1 }, config);
  if (facts.nsfw) enforceSafety({ label: 'NSFW', sfw: 0, nsfw: 1, nsfl: 0 }, config);
}
export function enforceSafety(result: SafetyResult, config: Config): void {
  if ((result.label === 'NSFW' && !config.content.allowNsfw) || (result.label === 'NSFL' && !config.content.allowNsfl))
    throw new MediaSafetyError(`このチャンネルでは${result.label === 'NSFW' ? '性的な画像・動画（NSFW）' : 'グロ・流血画像・動画（NSFL）'}を投稿できません。\n\n${result.label === 'NSFW' ? '性的な画像でない場合は管理者にお問い合わせください\nNSFW検知モデルの改善等致します' : 'グロ・流血画像でない場合は管理者にお問い合わせください\nNSFL検知モデルの改善等致します'}`);
}

export async function analyzeImageSafety(data: Buffer): Promise<ImageSafetyFacts> {
  return frameQueue.run(async () => {
    const result = await classifyImage(data);
    const nsfw = exposesRestrictedParts(await detectBodyParts(data)) || await hasAnimeExposure(data);
    return { nsfw, nsfl: result.label === 'NSFL' };
  });
}
async function checkFrame(data: Buffer, config: Config): Promise<void> {
  enforceImageSafety(await analyzeImageSafety(data), config);
}

export async function checkMediaSafety(data: Buffer, config: Config, name = '', contentType = '', certificate?: ImageSafetyCertificate): Promise<void> {
  return queue.run(async () => {
    if (certificate?.version === detectorVersion && certificate.sha256 === createHash('sha256').update(data).digest('hex')) {
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
      if (metadata) {
        let elapsed = 0; let next = 0;
        for (let page = 0; page < metadata.pages!; page++) {
          if (elapsed >= next) {
            const frame = await sharp(data, { page, pages: 1, limitInputPixels: 40_000_000 }).resize(ANIME_INPUT_SIZE, ANIME_INPUT_SIZE, { fit: 'inside', withoutEnlargement: true, kernel: 'cubic' }).png().toBuffer();
            await checkFrame(frame, config);
            next = elapsed + 5000;
          }
          elapsed += Math.max(metadata.delay?.[page] ?? 100, 10);
          if (elapsed > 600_000) throw new Error('アニメーションが長すぎます');
        }
        return;
      }
      const directory = await mkdtemp(join(tmpdir(), 'tokumei-safety-'));
      try {
        const path = join(directory, 'input');
        await writeFile(path, data);
        const probe = await promisify(execFile)(process.env.FFPROBE_PATH ?? 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path], { timeout: 15_000, maxBuffer: 4096 });
        const duration = Number(probe.stdout.trim());
        if (!Number.isFinite(duration) || duration <= 0 || duration > 600) throw new Error('動画は10分以内にしてください');
        const child = spawn(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-threads', '1', '-filter_threads', '1', '-i', path, '-an', '-vf', `select=isnan(prev_selected_t)+gte(t-prev_selected_t\\,5),scale=${ANIME_INPUT_SIZE}:${ANIME_INPUT_SIZE}:flags=bicubic`, '-fps_mode', 'vfr', '-threads', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        let frames = 0;
        const frameSize = ANIME_INPUT_SIZE * ANIME_INPUT_SIZE * 3;
        const frameBuffer = Buffer.allocUnsafe(frameSize);
        let filled = 0;
        const completion = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('動画デコード失敗'))); });
        void completion.catch(() => undefined);
        const timer = setTimeout(() => child.kill(), Math.min(600_000, 120_000 + Math.ceil(duration / 5) * 3000));
        try {
          for await (const chunk of child.stdout) {
            const bytes = chunk as Buffer;
            for (let offset = 0; offset < bytes.length;) {
              const copied = Math.min(frameSize - filled, bytes.length - offset);
              bytes.copy(frameBuffer, filled, offset, offset + copied);
              filled += copied; offset += copied;
              if (filled === frameSize) {
                const png = await sharp(frameBuffer, { raw: { width: ANIME_INPUT_SIZE, height: ANIME_INPUT_SIZE, channels: 3 } }).png().toBuffer();
                await checkFrame(png, config);
                filled = 0;
                if (++frames > 121) throw new Error('動画が長すぎます');
              }
            }
          }
          await completion;
          if (!frames || filled) throw new Error('動画フレームを取得できません');
        } finally { clearTimeout(timer); child.kill(); await completion.catch(() => undefined); }
      } finally { await rm(directory, { recursive: true, force: true }); }
    } catch (error) {
      if (error instanceof UserError) throw error;
      console.error('[safety] メディア判定失敗');
      throw new UserError('画像・動画の安全判定に失敗したため投稿できません。壊れたファイル、10分を超える動画、または管理者の設定を確認してください。');
    }
  });
}
