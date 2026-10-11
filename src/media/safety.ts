import sharp from 'sharp';
import * as ort from 'onnxruntime-node';
import { mkdir, access, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SafeHttp, WorkQueue, MAX_DOWNLOAD_BYTES } from './http.js';

export type SafetyLabel = 'SFW' | 'NSFW' | 'NSFL';
export type SafetyResult = { sfw: number; nsfw: number; nsfl: number; label: SafetyLabel };
export const MODEL_REVISION = '54f4560bd9c5ee92d45dc30418a8f8680e80de6d';
const directory = resolve(process.env.SAFETY_MODEL_DIR ?? 'models/image-safety-xs');
const queue = new WorkQueue(1, 10);
let singleton: Promise<{ session: ort.InferenceSession; labels: SafetyLabel[] }> | undefined;
sharp.cache(false);
sharp.concurrency(1);

async function download(name: string, remote: string): Promise<void> {
  const path = resolve(directory, name);
  try { await access(path); return; } catch {}
  const response = await fetch(`https://huggingface.co/OwenElliott/image-safety-classifier-xs/resolve/${MODEL_REVISION}/${remote}`, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`モデル取得失敗: ${response.status}`);
  await writeFile(`${path}.tmp`, Buffer.from(await response.arrayBuffer()));
  await rename(`${path}.tmp`, path);
}

export function initializeSafety(): Promise<{ session: ort.InferenceSession; labels: SafetyLabel[] }> {
  return singleton ??= (async () => {
    await mkdir(directory, { recursive: true });
    await download('config.json', 'config.json');
    await download('model.onnx', 'onnx/image-safety-classifier-xs.onnx');
    const config = JSON.parse(await readFile(resolve(directory, 'config.json'), 'utf8'));
    const labels: SafetyLabel[] = config.pretrained_cfg?.label_names;
    if (!Array.isArray(labels) || labels.length !== 3 || new Set(labels).size !== 3 || !labels.every(label => ['SFW', 'NSFW', 'NSFL'].includes(label))) throw new Error('モデルラベルが不正です');
    const session = await ort.InferenceSession.create(resolve(directory, 'model.onnx'), {
      executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1,
      executionMode: 'sequential', enableCpuMemArena: false, enableMemPattern: false,
    });
    if (session.inputNames.join() !== 'image' || session.outputNames.join() !== 'probabilities') throw new Error('未対応のONNX入出力です');
    console.info(`[safety] loaded rssMB=${(process.memoryUsage().rss / 1048576).toFixed(1)}`);
    return { session, labels };
  })();
}

export async function classifyImage(input: Buffer | string): Promise<SafetyResult> {
  return queue.run(async () => {
    const start = performance.now();
    const { session, labels } = await initializeSafety();
    const data = typeof input === 'string' ? (await new SafeHttp().get(input, MAX_DOWNLOAD_BYTES)).data : input;
    const pixels = await sharp(data, { pages: 1, limitInputPixels: 40_000_000, failOn: 'warning' })
      .toColourspace('srgb').removeAlpha().resize(224, 224, { fit: 'fill', kernel: 'linear' }).raw().toBuffer();
    if (pixels.length !== 224 * 224 * 3) throw new Error('RGB画像に変換できませんでした');
    const tensor = new Float32Array(pixels.length);
    for (let i = 0; i < 224 * 224; i++) for (let c = 0; c < 3; c++) tensor[c * 224 * 224 + i] = pixels[i * 3 + c]!;
    const output = await session.run({ image: new ort.Tensor('float32', tensor, [1, 3, 224, 224]) });
    const probabilities = Array.from(output.probabilities!.data as Float32Array);
    if (probabilities.length !== 3 || probabilities.some(p => !Number.isFinite(p) || p < 0 || p > 1) || Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) > 0.001) throw new Error('モデルの確率出力が不正です');
    const values = Object.fromEntries(labels.map((label, i) => [label.toLowerCase(), probabilities[i]!])) as Omit<SafetyResult, 'label'>;
    const label = labels[probabilities.indexOf(Math.max(...probabilities))]!;
    console.info(`[safety] label=${label} ms=${(performance.now() - start).toFixed(0)} rssMB=${(process.memoryUsage().rss / 1048576).toFixed(1)}`);
    return { ...values, label };
  });
}
