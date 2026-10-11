import sharp from 'sharp';
import * as ort from 'onnxruntime-node';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WorkQueue } from './http.js';
import { onnxMetadata, parseDetections, type BodyDetection } from './nudity.js';

export const ANIME_REVISION = '0cf62fd6b28213b40ae0c0055f92e7ae6a96bdc2';
export const ANIME_INPUT_SIZE = 1216;
const directory = resolve(process.env.ANIME_NUDITY_MODEL_DIR ?? 'models/anime-censor');
const checksum = '2c2524824d7d320c5619a0a73702a2e2186f619067c823d211e94f7cfe489cba';
const modelFile = 'model-s.onnx';
const queue = new WorkQueue(1, 10);
let singleton: Promise<{ session: ort.InferenceSession; labels: string[]; threshold: number }> | undefined;

export async function prepareAnimeNudityModel(): Promise<void> {
  const files = [[modelFile, 'model.onnx'], ['labels.json', 'labels.json'], ['threshold-s.json', 'threshold.json']] as const;
  for (const [local, remote] of files) {
    const path = resolve(directory, local);
    try { await access(path); continue; } catch {}
    await mkdir(directory, { recursive: true });
    const response = await fetch(`https://huggingface.co/deepghs/anime_censor_detection/resolve/${ANIME_REVISION}/censor_detect_v1.0_s/${remote}`, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`二次元部位検出モデル取得失敗: ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (local === modelFile && createHash('sha256').update(data).digest('hex') !== checksum) throw new Error('二次元モデルのチェックサム不一致');
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, data); await rename(temporary, path);
  }
}

export function initializeAnimeNudity(): Promise<{ session: ort.InferenceSession; labels: string[]; threshold: number }> {
  return singleton ??= (async () => {
    await prepareAnimeNudityModel();
    const data = await readFile(resolve(directory, modelFile));
    if (createHash('sha256').update(data).digest('hex') !== checksum) throw new Error('二次元モデルのチェックサム不一致');
    const metadata = onnxMetadata(data);
    const labels: string[] = JSON.parse(await readFile(resolve(directory, 'labels.json'), 'utf8'));
    const modelNames = [...(metadata.names ?? '').matchAll(/(\d+):\s*'([a-z_]+)'/g)];
    if (!Array.isArray(labels) || labels.length !== 3 || modelNames.length !== labels.length || !labels.every((label, index) => modelNames[index]?.[1] === String(index) && modelNames[index]?.[2] === label && ['nipple_f', 'penis', 'pussy'].includes(label)) || new Set(labels).size !== 3 || metadata.stride !== '32') throw new Error('二次元モデルのラベル・メタデータが不正です');
    const threshold: number = JSON.parse(await readFile(resolve(directory, 'threshold-s.json'), 'utf8')).threshold;
    if (threshold !== 0.238) throw new Error('二次元モデルの判定閾値が不正です');
    const session = await ort.InferenceSession.create(resolve(directory, modelFile), { executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential', enableCpuMemArena: false, enableMemPattern: false });
    if (session.inputNames.join() !== 'images' || session.outputNames.join() !== 'output0') throw new Error('二次元モデルの入出力が不正です');
    console.info(`[anime-nudity] loaded rssMB=${(process.memoryUsage().rss / 1048576).toFixed(1)}`);
    return { session, labels, threshold };
  })();
}

export async function detectAnimeExposure(data: Buffer): Promise<BodyDetection[]> {
  return queue.run(async () => {
    const start = performance.now(); const { session, labels, threshold } = await initializeAnimeNudity();
    const size = ANIME_INPUT_SIZE; const area = size * size;
    const pixels = await sharp(data, { pages: 1, limitInputPixels: 40_000_000, failOn: 'warning' }).flatten({ background: 'white' }).toColourspace('srgb').removeAlpha()
      .resize(size, size, { fit: 'fill', kernel: 'cubic' }).raw().toBuffer();
    if (pixels.length !== area * 3) throw new Error('二次元モデルのRGB変換に失敗しました');
    const tensor = new Float32Array(area * 3);
    for (let i = 0; i < area; i++) for (let c = 0; c < 3; c++) tensor[c * area + i] = pixels[i * 3 + c]! / 255;
    const output = (await session.run({ images: new ort.Tensor('float32', tensor, [1, 3, size, size]) })).output0!;
    if (output.type !== 'float32' || output.dims.length !== 3 || output.dims[0] !== 1 || output.dims[1] !== labels.length + 4 || output.dims[2] !== 30324) throw new Error('二次元モデルの出力が不正です');
    const detections = parseDetections(output.data as Float32Array, output.dims[2], labels, threshold, 0.7);
    console.info(`[anime-nudity] blocked=${detections.length > 0} ms=${(performance.now() - start).toFixed(0)} rssMB=${(process.memoryUsage().rss / 1048576).toFixed(1)}`);
    return detections;
  });
}
