import type { PoolClient } from 'pg';
import { upgradeCommonSettings } from '../migration/common.js';
import { configSchema, overridesSchema } from '../domain/config.js';

export async function migrateCommonSettings(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('common-settings-v1'))");
  if ((await client.query("SELECT 1 FROM v2_migrations WHERE name='common-settings-v1'")).rowCount) return;
  const guilds = (await client.query('SELECT guild_id,config FROM v2_guilds FOR UPDATE')).rows;
  const bases = new Map(guilds.map(row => [row.guild_id,row.config]));
  const legacy = (await client.query("SELECT to_regclass('public.v2_request_restrictions') IS NOT NULL AS present")).rows[0].present;
  const channels = (await client.query('SELECT guild_id,channel_id,overrides FROM v2_channels FOR UPDATE')).rows;
  for (const row of channels) {
    const settings = overridesSchema.parse(upgradeCommonSettings(row.overrides,bases.get(row.guild_id)));
    const inherited=upgradeCommonSettings(bases.get(row.guild_id));
    if (legacy && (settings.moderation?.allowChannelRestriction ?? inherited.moderation?.allowChannelRestriction)) await client.query(`INSERT INTO v2_channel_restrictions(guild_id,channel_id,user_id,reason,created_at)
      SELECT guild_id,$2,user_id,reason,created_at FROM v2_request_restrictions WHERE guild_id=$1 ON CONFLICT DO NOTHING`,[row.guild_id,row.channel_id]);
    await client.query('UPDATE v2_channels SET overrides=$3,version=version+1 WHERE guild_id=$1 AND channel_id=$2',[row.guild_id,row.channel_id,settings]);
  }
  for (const row of guilds) await client.query('UPDATE v2_guilds SET config=$2,version=version+1 WHERE guild_id=$1',[row.guild_id,configSchema.parse(upgradeCommonSettings(row.config))]);
  const backups = (await client.query('SELECT id,guild_id,channel_id,config,snapshot FROM v2_revisions FOR UPDATE')).rows;
  for (const row of backups) {
    const settings=upgradeCommonSettings(row.config,row.snapshot || row.channel_id === null ? undefined : bases.get(row.guild_id));
    await client.query('UPDATE v2_revisions SET config=$2 WHERE id=$1',[row.id,row.snapshot || row.channel_id===null ? configSchema.parse(settings) : overridesSchema.parse(settings)]);
  }
  if (legacy) await client.query('DROP TABLE v2_request_restrictions');
  await client.query("INSERT INTO v2_migrations(name) VALUES('common-settings-v1')");
}
