import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export class VideoDecodeError extends Error {
  constructor(readonly stage: 'probe' | 'frame', readonly reason: string, readonly exitCode?: number, readonly signal?: string) {
    super(`動画解析失敗: ${stage}/${reason}`);
  }
}

async function run(tool: string, args: string[], stage: 'probe' | 'frame', maxBuffer: number): Promise<Buffer> {
  try {
    return (await execute(tool, args, { encoding: 'buffer', maxBuffer, windowsHide: true })).stdout;
  } catch (error) {
    const failure = error as { code?: unknown; signal?: unknown; stderr?: Buffer };
    const stderr = failure.stderr?.toString() ?? '';
    const reason = failure.code === 'ENOENT' ? 'tool_missing' :
      /Cannot allocate memory|Resource temporarily unavailable/i.test(stderr) ? 'resources' :
      /Invalid data|moov atom not found/i.test(stderr) ? 'invalid_video' : 'decode_failed';
    throw new VideoDecodeError(stage, reason, typeof failure.code === 'number' ? failure.code : undefined,
      typeof failure.signal === 'string' && /^SIG[A-Z]+$/.test(failure.signal) ? failure.signal : undefined);
  }
}

export function videoSampleTimes(duration: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0) throw new VideoDecodeError('probe', 'invalid_duration');
  const count = duration <= 5 ? 1 : duration <= 120 ? 2 : 3;
  const last = Math.max(0, duration - Math.min(1, duration / 2));
  return Array.from({ length: count }, (_, index) => count === 1 ? 0 : Number((last * index / (count - 1)).toFixed(3)));
}

export async function videoDuration(path: string): Promise<number> {
  const output = await run(process.env.FFPROBE_PATH ?? 'ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'format=duration:stream=duration:stream_tags=DURATION', '-of', 'json', path,
  ], 'probe', 16 * 1024);
  let data: { streams?: { duration?: string; tags?: { DURATION?: string } }[]; format?: { duration?: string } };
  try { data = JSON.parse(output.toString()); } catch { throw new VideoDecodeError('probe', 'invalid_response'); }
  if (!data.streams?.length) throw new VideoDecodeError('probe', 'no_video_stream');
  const tagged = data.streams[0]?.tags?.DURATION?.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  const tagDuration = tagged ? Number(tagged[1]) * 3600 + Number(tagged[2]) * 60 + Number(tagged[3]) : NaN;
  let duration = [Number(data.streams[0]?.duration), tagDuration, Number(data.format?.duration)].find(value => Number.isFinite(value) && value > 0);
  if (duration === undefined) {
    const packets = await run(process.env.FFPROBE_PATH ?? 'ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', path,
    ], 'probe', 4 * 1024 * 1024);
    let end = 0;
    for (const line of packets.toString().split(/\r?\n/)) {
      const [timestamp, length] = line.split(',').map(Number);
      if (Number.isFinite(timestamp)) end = Math.max(end, timestamp! + (Number.isFinite(length) ? length! : 0));
    }
    duration = end;
  }
  videoSampleTimes(duration);
  return duration;
}

export async function extractVideoFrame(path: string, seconds: number, size: number): Promise<Buffer> {
  const frame = await run(process.env.FFMPEG_PATH ?? 'ffmpeg', [
    '-v', 'error', '-threads', '1', '-filter_threads', '1', '-ss', seconds.toFixed(3), '-i', path,
    '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-dn',
    '-vf', `scale=${size}:${size}:force_original_aspect_ratio=decrease:flags=bicubic`,
    '-threads', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1',
  ], 'frame', 8 * 1024 * 1024);
  if (!frame.length) throw new VideoDecodeError('frame', 'empty_frame');
  return frame;
}
