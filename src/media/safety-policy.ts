import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp, { type Metadata } from 'sharp';
import type { Config } from '../domain/config.js';
import { UserError } from '../domain/errors.js';
import { classifyImage, type SafetyResult } from './safety.js';
import { WorkQueue } from './http.js';

const queue = new WorkQueue(1, 10);
export function enforceSafety(result: SafetyResult, config: Config): void {
  if ((result.label === 'NSFW' && !config.content.allowNsfw) || (result.label === 'NSFL' && !config.content.allowNsfl))
    throw new UserError(`このチャンネルでは${result.label === 'NSFW' ? '性的な画像・動画（NSFW）' : 'グロ・流血画像・動画（NSFL）'}を投稿できません。`);
}

export async function checkMediaSafety(data: Buffer, config: Config, name = '', contentType = ''): Promise<void> {
  return queue.run(async () => {
    let metadata: Metadata | undefined;
    try { metadata = await sharp(data, { limitInputPixels: 40_000_000 }).metadata(); } catch {}
    const video = contentType.startsWith('video/') || /\.(mp4|webm|mov|mkv|avi|m4v)$/i.test(name) || data.subarray(4, 8).toString() === 'ftyp' || data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    if (!metadata && !video) {
      if (contentType.startsWith('image/') || /\.(gif|webp|jpe?g|png|avif)$/i.test(name)) throw new UserError('画像が壊れているため安全判定できません。');
      return;
    }
    try {
      if (metadata && (metadata.pages ?? 1) === 1) { enforceSafety(await classifyImage(data), config); return; }
      if (metadata) {
        let elapsed = 0; let next = 0;
        for (let page = 0; page < metadata.pages!; page++) {
          if (elapsed >= next) {
            const frame = await sharp(data, { page, pages: 1, limitInputPixels: 40_000_000 }).resize(224, 224, { fit: 'fill', kernel: 'linear' }).png().toBuffer();
            enforceSafety(await classifyImage(frame), config);
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
        const child = spawn(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-threads', '1', '-filter_threads', '1', '-i', path, '-an', '-vf', 'select=isnan(prev_selected_t)+gte(t-prev_selected_t\\,5),scale=224:224', '-fps_mode', 'vfr', '-threads', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        let frames = 0;
        let pending = Buffer.alloc(0);
        const completion = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('動画デコード失敗'))); });
        void completion.catch(() => undefined);
        const timer = setTimeout(() => child.kill(), 120_000);
        try {
          for await (const chunk of child.stdout) {
            pending = Buffer.concat([pending, chunk as Buffer]);
            const size = 224 * 224 * 3;
            while (pending.length >= size) {
              const frame = pending.subarray(0, size); pending = pending.subarray(size);
              const png = await sharp(frame, { raw: { width: 224, height: 224, channels: 3 } }).png().toBuffer();
              enforceSafety(await classifyImage(png), config);
              if (++frames > 121) throw new Error('動画が長すぎます');
            }
          }
          await completion;
          if (!frames || pending.length) throw new Error('動画フレームを取得できません');
        } finally { clearTimeout(timer); child.kill(); await completion.catch(() => undefined); }
      } finally { await rm(directory, { recursive: true, force: true }); }
    } catch (error) {
      if (error instanceof UserError) throw error;
      console.error('[safety] メディア判定失敗', error instanceof Error ? error.message : 'unknown');
      throw new UserError('画像・動画の安全判定に失敗したため投稿できません。壊れたファイル、10分を超える動画、または管理者の設定を確認してください。');
    }
  });
}
