import sharp from 'sharp';
import * as ort from 'onnxruntime-node';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WorkQueue } from './http.js';

export const NUDITY_REVISION = '44956a0587943016350c7815f9e0dec089d45cae';
const checksum = 'c15d8273adad2d0a92f014cc69ab2d6c311a06777a55545f2c4eb46f51911f0f';
const path = resolve(process.env.NUDITY_MODEL_DIR ?? 'models/nudenet', '320n.onnx');
const queue = new WorkQueue(1, 10);
const restricted = new Set(['FEMALE_BREAST_EXPOSED', 'FEMALE_GENITALIA_EXPOSED', 'MALE_GENITALIA_EXPOSED']);
export const NUDITY_THRESHOLD = 0.5;
export type BodyDetection = { label: string; score: number; box: [number, number, number, number] };
let singleton: Promise<{ session: ort.InferenceSession; labels: string[] }> | undefined;

function fields(buffer: Buffer): { id: number; value: Buffer }[] {
  let offset = 0;
  const result: { id: number; value: Buffer }[] = [];
  const integer = (): number => {
    let value = 0;
    for (let shift = 0; shift < 56; shift += 7) {
      if (offset >= buffer.length) throw new Error('ONNXメタデータが壊れています');
      const byte = buffer[offset++]!;
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
    }
    throw new Error('ONNX整数が不正です');
  };
  while (offset < buffer.length) {
    const tag = integer(); const wire = tag % 8;
    if (wire === 0) { integer(); continue; }
    if (wire === 1 || wire === 5) { offset += wire === 1 ? 8 : 4; }
    else if (wire === 2) {
      const length = integer(); const end = offset + length;
      if (!Number.isSafeInteger(end) || end > buffer.length) throw new Error('ONNXフィールド長が不正です');
      result.push({ id: Math.floor(tag / 8), value: buffer.subarray(offset, end) }); offset = end;
    } else throw new Error('未対応のONNXメタデータです');
    if (offset > buffer.length) throw new Error('ONNXメタデータが壊れています');
  }
  return result;
}

export function onnxMetadata(buffer: Buffer): Record<string, string> {
  return Object.fromEntries(fields(buffer).filter(field => field.id === 14).map(field => {
    const entry = fields(field.value);
    return [entry.find(item => item.id === 1)?.value.toString(), entry.find(item => item.id === 2)?.value.toString()];
  }));
}
export function modelLabels(buffer: Buffer): string[] {
  const metadata = onnxMetadata(buffer);
  if (metadata.imgsz !== '[320, 320]' || metadata.task !== 'detect') throw new Error('未対応の部位検出モデルです');
  const labels: string[] = [];
  for (const match of (metadata.names ?? '').matchAll(/(\d+):\s*'([A-Z_]+)'/g)) {
    if (Number(match[1]) !== labels.length) throw new Error('部位ラベル順序が不正です');
    labels.push(match[2]!);
  }
  if (labels.length !== 18 || [...restricted].some(label => !labels.includes(label))) throw new Error('部位ラベルが不正です');
  return labels;
}

export async function prepareNudityModel(): Promise<void> {
  try { await access(path); return; } catch {}
  await mkdir(resolve(path, '..'), { recursive: true });
  const response = await fetch(`https://huggingface.co/deepghs/nudenet_onnx/resolve/${NUDITY_REVISION}/320n.onnx`, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`部位検出モデル取得失敗: ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(data).digest('hex') !== checksum) throw new Error('部位検出モデルのチェックサム不一致');
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, data); await rename(temporary, path);
}

export function initializeNudity(): Promise<{ session: ort.InferenceSession; labels: string[] }> {
  return singleton ??= (async () => {
    await prepareNudityModel();
    const data = await readFile(path);
    if (createHash('sha256').update(data).digest('hex') !== checksum) throw new Error('部位検出モデルのチェックサム不一致');
    const labels = modelLabels(data);
    const session = await ort.InferenceSession.create(path, { executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential', enableCpuMemArena: false, enableMemPattern: false });
    if (session.inputNames.join() !== 'images' || session.outputNames.join() !== 'output0') throw new Error('部位検出モデルの入出力が不正です');
    console.info(`[nudity] loaded rssMB=${(process.memoryUsage().rss / 1048576).toFixed(1)}`);
    return { session, labels };
  })();
}

export function parseDetections(values: Float32Array, count: number, labels: string[], minimumScore = 0.25, iouThreshold = 0.45): BodyDetection[] {
  if (values.length !== (labels.length + 4) * count || count <= 0) throw new Error('部位検出の出力形状が不正です');
  const candidates: BodyDetection[] = [];
  for (let i = 0; i < count; i++) {
    let classId = 0; let score = 0;
    for (let c = 0; c < labels.length; c++) {
      const value = values[(c + 4) * count + i]!;
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('部位検出の確率が不正です');
      if (value > score) { score = value; classId = c; }
    }
    if (score < minimumScore) continue;
    const x = values[i]!; const y = values[count + i]!; const w = values[count * 2 + i]!; const h = values[count * 3 + i]!;
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) throw new Error('部位検出の座標が不正です');
    candidates.push({ label: labels[classId]!, score, box: [x - w / 2, y - h / 2, w, h] });
  }
  const kept: BodyDetection[] = [];
  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    if (kept.some(other => {
      const [x, y, w, h] = candidate.box; const [ox, oy, ow, oh] = other.box;
      const intersection = Math.max(0, Math.min(x + w, ox + ow) - Math.max(x, ox)) * Math.max(0, Math.min(y + h, oy + oh) - Math.max(y, oy));
      return intersection / (w * h + ow * oh - intersection) > iouThreshold;
    })) continue;
    kept.push(candidate);
  }
  return kept;
}

export function exposesRestrictedParts(detections: BodyDetection[]): boolean {
  return detections.some(detection => restricted.has(detection.label) && detection.score >= NUDITY_THRESHOLD);
}

export async function detectBodyParts(data: Buffer): Promise<BodyDetection[]> {
  return queue.run(async () => {
    const start = performance.now(); const { session, labels } = await initializeNudity();
    const image = sharp(data, { pages: 1, limitInputPixels: 40_000_000, failOn: 'warning' }).toColourspace('srgb').flatten({ background: 'white' }).removeAlpha();
    const metadata = await image.metadata(); const width = metadata.width!; const height = metadata.pageHeight ?? metadata.height!;
    const scale = 320 / Math.max(width, height);
    const scaledWidth = Math.max(1, Math.round(width * scale)); const scaledHeight = Math.max(1, Math.round(height * scale));
    const pixels = await image.resize(scaledWidth, scaledHeight, { fit: 'fill', kernel: 'linear' })
      .extend({ top: 0, left: 0, bottom: 320 - scaledHeight, right: 320 - scaledWidth, background: 'black' }).raw().toBuffer();
    const tensor = new Float32Array(320 * 320 * 3);
    if (pixels.length !== tensor.length) throw new Error('部位検出のRGB変換に失敗しました');
    for (let i = 0; i < 320 * 320; i++) for (let c = 0; c < 3; c++) tensor[c * 320 * 320 + i] = pixels[i * 3 + c]! / 255;
    const output = await session.run({ images: new ort.Tensor('float32', tensor, [1, 3, 320, 320]) });
    const result = output.output0!;
    if (result.dims.length !== 3 || result.dims[0] !== 1 || result.dims[1] !== labels.length + 4 || result.type !== 'float32') throw new Error('部位検出の出力が不正です');
    const detections = parseDetections(result.data as Float32Array, result.dims[2]!, labels);
    console.info(`[nudity] blocked=${exposesRestrictedParts(detections)} ms=${(performance.now() - start).toFixed(0)} rssMB=${(process.memoryUsage().rss / 1048576).toFixed(1)}`);
    return detections;
  });
}
