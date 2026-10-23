import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { emojiDefinitions, fallbackEmoji, type EmojiKey } from './emojis.js';

export interface ApplicationEmoji { id: string; name: string; animated?: boolean; }
export interface EmojiApi {
  list(): Promise<ApplicationEmoji[]>;
  create(name: string, image: Buffer): Promise<ApplicationEmoji>;
}
export interface EmojiAsset { key: EmojiKey; image: Buffer; }

export async function loadEmojiAssets(): Promise<EmojiAsset[]> {
  return Promise.all((Object.keys(emojiDefinitions) as EmojiKey[]).map(async key => ({
    key, image: await readFile(new URL(`../../assets/emojis/${key}.png`, import.meta.url)),
  })));
}

export async function syncApplicationEmojis(api: EmojiApi, assets?: EmojiAsset[]) {
  const source = assets ?? await loadEmojiAssets();
  for (const asset of source) {
    const metadata = await sharp(asset.image).metadata();
    if (metadata.format !== 'png' || metadata.width !== 128 || metadata.height !== 128 || asset.image.length > 256 * 1024)
      throw new Error(`絵文字素材 ${asset.key} は128×128px・256KiB以下のPNGで用意してください。`);
  }
  const existing = await api.list();
  const mappings: Record<EmojiKey, string> = { ...fallbackEmoji };
  let created = 0, reused = 0;
  const failed: EmojiKey[] = [];
  for (const { key, image } of source) {
    const definition = emojiDefinitions[key];
    let found = [definition.name, definition.legacyName].flatMap(name =>
      existing.filter(emoji => emoji.name === name).sort((a, b) => a.id.localeCompare(b.id)))[0];
    if (found) reused++;
    else {
      if (existing.length >= 2000) { failed.push(key); continue; }
      try {
        found = await api.create(definition.name, image);
        existing.push(found); created++;
      } catch { failed.push(key); continue; }
    }
    mappings[key] = `<${found.animated ? 'a' : ''}:${found.name}:${found.id}>`;
  }
  return { mappings, created, reused, failed };
}
