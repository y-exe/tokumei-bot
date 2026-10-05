import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { Store } from './infra/store.js';
import { SecretBox } from './infra/secrets.js';
import { applyLegacy, migrationSummary, planLegacy, type LegacyBundle } from './migration/legacy.js';

const args = process.argv.slice(2);
function option(name: string): string | undefined { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; }
const directory = option('--source'); const mappingFile = option('--mapping');
if (!mappingFile || (!directory && !process.env.MIGRATION_SOURCE_DATABASE_URL))
  throw new Error('--mapping と、--source または MIGRATION_SOURCE_DATABASE_URL を指定してください。');
const filenames = { channels: 'channels.json', guildSettings: 'guild_settings.json', keywords: 'keywords.json', domains: 'domains.json', thresholds: 'thresholds.json', bans: 'banned_users.json', anonymous: 'anonymous_data.json', users: 'user_data.json', messages: 'message_logs.json' } as const;
const bundle: LegacyBundle = { channels: {} };
for (const [key, filename] of Object.entries(filenames)) {
  if (!directory) continue;
  try { (bundle as unknown as Record<string, unknown>)[key] = JSON.parse(await readFile(path.join(path.resolve(directory), filename), 'utf8')); }
  catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw new Error(`移行元の ${filename} を読み取れませんでした。`); }
}
if (process.env.MIGRATION_SOURCE_DATABASE_URL) {
  const source = new Pool({ connectionString: process.env.MIGRATION_SOURCE_DATABASE_URL, max: 1 });
  try {
    for (const [key, filename] of Object.entries(filenames)) {
      const result = await source.query('SELECT data FROM app_json_documents WHERE name=$1 OR name=$2 ORDER BY CASE WHEN name=$1 THEN 0 ELSE 1 END LIMIT 1', [`detas/${filename}`, filename]);
      if (result.rows[0]) (bundle as unknown as Record<string, unknown>)[key] = result.rows[0].data;
    }
    const result = await source.query("SELECT message_id,user_id,anonymous_id,channel_id,webhook_url,timestamp,content,attachment_url FROM anonymous_messages WHERE timestamp>now()-interval '90 days'");
    bundle.messages = { ...bundle.messages, ...Object.fromEntries(result.rows.map(row => [row.message_id, row])) };
  } finally { await source.end(); }
}
if (option('--kind') === 'image') bundle.channels = Object.fromEntries(Object.entries(bundle.channels).map(([id, value]) => [id, { ...(value as object), source: 'image' }]));
const mapping = JSON.parse(await readFile(path.resolve(mappingFile), 'utf8'));
const plan = planLegacy(bundle, mapping);
console.info(JSON.stringify({ mode: args.includes('--apply') ? 'apply' : 'dryrun', ...migrationSummary(plan) }, null, 2));
if (args.includes('--apply')) {
  const target = process.env.MIGRATION_TARGET_DATABASE_URL; const key = process.env.ENCRYPTION_KEY;
  if (!target || !key) throw new Error('移行先は MIGRATION_TARGET_DATABASE_URL と ENCRYPTION_KEY を明示してください。既存のDATABASE_URLは自動使用しません。');
  const store = new Store(target);
  try { await store.initialize(); await applyLegacy(store, new SecretBox(key), plan); console.info('移行データを保存しました。匿名投稿の受付は停止したままです。'); }
  finally { await store.close(); }
}
