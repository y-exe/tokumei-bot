import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { configSchema, defaults, overridesSchema, resolveConfig, type Config, type Overrides } from '../domain/config.js';
import { UserError, FloodControlError } from '../domain/errors.js';
import { nextAvatar } from '../domain/avatar.js';
import { floodDecision, type FloodEvent, type FloodState } from '../domain/flood-control.js';
import { IdentityPrivacy } from './identity-privacy.js';
import type { SecretBox } from './secrets.js';

export interface ChannelSettings {
  guildId: string; channelId: string; base: Config; overrides: Overrides; config: Config;
  guildVersion: number; channelVersion: number; enabled: boolean;
  panelId: string | null; webhook: string | null;
}
export interface SavedSetup { channelId: string; name: string | null; title: string; enabled: boolean; savedAt: Date | null; }
export interface SettingsBackup { id: string; createdAt: Date; channelId: string | null; channelName: string; }
export interface StoredPost {
  operation_id: string; guild_id: string; channel_id: string; message_id: string | null;
  user_id?: string; content: string; source: string | null; reply_to: string | null;
  layout: 'v2' | 'legacy' | 'plain'; legacy_webhook: string | null;
  delivery_webhook: string | null;
  anonymous_id: number; avatar: number; status: string; created_at: Date;
  media: { url: string; name: string; kind: string }[];
  videoLinks: string[];
}
export interface ReportNotice {
  guild_id: string; channel_id: string; message_id: string; count: number;
  content: string; reason: string; nonce: string;
}
export interface ReportDetail extends ReportNotice {reporters:string[];userId:string;anonymousId:number;notificationId:string|null;}

const schema = `
CREATE TABLE IF NOT EXISTS v2_flood_control (
  subject text PRIMARY KEY, state jsonb NOT NULL, expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS v2_flood_control_expiry ON v2_flood_control(expires_at);
CREATE TABLE IF NOT EXISTS v2_diagnostics (
  code text PRIMARY KEY, guild_id text, channel_id text, interaction_id text NOT NULL,
  action text NOT NULL, details text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS v2_guilds (
  guild_id text PRIMARY KEY, config jsonb NOT NULL, version integer NOT NULL DEFAULT 0
);
ALTER TABLE v2_guilds ADD COLUMN IF NOT EXISTS left_at timestamptz;
CREATE TABLE IF NOT EXISTS v2_channels (
  guild_id text NOT NULL REFERENCES v2_guilds(guild_id), channel_id text PRIMARY KEY,
  overrides jsonb NOT NULL DEFAULT '{}', version integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT false, panel_id text, webhook text
);
ALTER TABLE v2_channels ADD COLUMN IF NOT EXISTS channel_name text;
ALTER TABLE v2_channels ADD COLUMN IF NOT EXISTS settings_saved_at timestamptz;
CREATE TABLE IF NOT EXISTS v2_revisions (
  id bigserial PRIMARY KEY, guild_id text NOT NULL, channel_id text, config jsonb NOT NULL,
  actor_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE v2_revisions ADD COLUMN IF NOT EXISTS snapshot boolean NOT NULL DEFAULT false;
ALTER TABLE v2_revisions ADD COLUMN IF NOT EXISTS channel_name text;
CREATE INDEX IF NOT EXISTS v2_revisions_scope ON v2_revisions(guild_id,channel_id,id DESC);
CREATE INDEX IF NOT EXISTS v2_revisions_guild ON v2_revisions(guild_id,id DESC);
CREATE INDEX IF NOT EXISTS v2_revisions_created ON v2_revisions(created_at);
DELETE FROM v2_revisions WHERE created_at<=now()-interval '60 days';
CREATE TABLE IF NOT EXISTS v2_counters (
  channel_id text PRIMARY KEY, counter integer NOT NULL DEFAULT 0, last_user text
);
CREATE TABLE IF NOT EXISTS v2_sessions (
  guild_id text NOT NULL, channel_id text NOT NULL, user_id text NOT NULL,
  anonymous_id integer NOT NULL, avatar integer NOT NULL, last_post timestamptz NOT NULL,
  PRIMARY KEY (guild_id, channel_id, user_id)
);
ALTER TABLE v2_counters ADD COLUMN IF NOT EXISTS last_avatar integer;
CREATE TABLE IF NOT EXISTS v2_posts (
  operation_id text PRIMARY KEY, guild_id text NOT NULL, channel_id text NOT NULL,
  message_id text UNIQUE, content text NOT NULL, source text, reply_to text,
  anonymous_id integer NOT NULL, avatar integer NOT NULL,
  status text NOT NULL DEFAULT 'sending', media jsonb NOT NULL DEFAULT '[]',
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS v2_authors (
  operation_id text PRIMARY KEY REFERENCES v2_posts(operation_id) ON DELETE CASCADE,
  user_id text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS v2_authors_user ON v2_authors(user_id);
CREATE INDEX IF NOT EXISTS v2_posts_channel ON v2_posts(guild_id, channel_id, created_at DESC);
ALTER TABLE v2_posts ADD COLUMN IF NOT EXISTS layout text NOT NULL DEFAULT 'v2';
ALTER TABLE v2_posts ADD COLUMN IF NOT EXISTS legacy_webhook text;
ALTER TABLE v2_posts ADD COLUMN IF NOT EXISTS delivery_webhook text;
CREATE TABLE IF NOT EXISTS v2_reports (
  id bigserial PRIMARY KEY, guild_id text NOT NULL, channel_id text NOT NULL,
  message_id text NOT NULL, reporter_id text NOT NULL, reason text NOT NULL,
  evidence jsonb NOT NULL, status text NOT NULL DEFAULT 'open',
  notification_id text, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(guild_id, message_id, reporter_id)
);
CREATE TABLE IF NOT EXISTS v2_restrictions (
  guild_id text NOT NULL, user_id text NOT NULL, expires_at timestamptz, reason text NOT NULL,
  PRIMARY KEY(guild_id, user_id)
);
CREATE TABLE IF NOT EXISTS v2_channel_restrictions (
  guild_id text NOT NULL,channel_id text NOT NULL,user_id text NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(guild_id,channel_id,user_id)
);
CREATE TABLE IF NOT EXISTS v2_actions (
  id bigserial PRIMARY KEY, guild_id text NOT NULL, actor_id text NOT NULL,
  action text NOT NULL, message_id text, created_at timestamptz NOT NULL DEFAULT now()
);`;

const reportRetrySchema = `
CREATE TABLE IF NOT EXISTS v2_legacy_lookup_blocks(channel_id text PRIMARY KEY);
CREATE TABLE IF NOT EXISTS v2_legacy_lookup_denials(message_key text PRIMARY KEY);
CREATE TABLE IF NOT EXISTS v2_identity_keys(name text PRIMARY KEY,key_tag text NOT NULL);
ALTER TABLE v2_authors ADD COLUMN IF NOT EXISTS user_ciphertext text;
ALTER TABLE v2_reports ADD COLUMN IF NOT EXISTS reporter_ciphertext text;
ALTER TABLE v2_diagnostics ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE v2_posts ADD COLUMN IF NOT EXISTS video_links jsonb;
ALTER TABLE v2_reports ADD COLUMN IF NOT EXISTS notification_retry_at timestamptz;
ALTER TABLE v2_reports ADD COLUMN IF NOT EXISTS moderation_token text;
ALTER TABLE v2_actions ADD COLUMN IF NOT EXISTS reason text;
CREATE INDEX IF NOT EXISTS v2_posts_anonymous_reference ON v2_posts(guild_id,channel_id,anonymous_id,created_at DESC) WHERE status='sent';
CREATE INDEX IF NOT EXISTS v2_reports_pending ON v2_reports(notification_retry_at) WHERE status='open';`;

function readPoolMax(): number {
  const value = Number(process.env.DB_POOL_MAX || 5);
  if (!Number.isInteger(value) || value < 1 || value > 30) throw new Error('DB_POOL_MAXは1〜30の整数で指定してください。');
  return value;
}
function readGraceDays(): number {
  const value = Number(process.env.GUILD_DELETE_GRACE_DAYS || 30);
  if (!Number.isInteger(value) || value < 1 || value > 365) throw new Error('GUILD_DELETE_GRACE_DAYSは1〜365の整数で指定してください。');
  return value;
}

export class Store {
  readonly pool: Pool;
  private identities?: IdentityPrivacy;
  private cache = new Map<string, { settings: ChannelSettings; expires: number }>();
  private guildGraceDays = readGraceDays();
  constructor(databaseUrl?: string, box?: SecretBox) {
    if (!box && process.env.NODE_ENV === 'production') throw new Error('本番DBの利用にはID保護用の暗号鍵が必要です。');
    this.pool = new Pool({ connectionString: databaseUrl, max: readPoolMax(), connectionTimeoutMillis: 5000 });
    if (box) this.identities = new IdentityPrivacy(box);
  }
  identityKey(guildId: string, userId: string): string { return this.identities?.key(guildId, userId) ?? userId; }
  sealIdentity(userId: string): string | null { return this.identities?.seal(userId) ?? null; }
  openIdentity(userId: string, ciphertext?: string | null): string { return this.identities?.open(userId, ciphertext) ?? userId; }
  async initialize(): Promise<void> {
    await this.pool.query(schema); await this.pool.query(reportRetrySchema);
    await this.transaction(async client => {
      if (this.identities) await this.identities.migrate(client);
      else if ((await client.query('SELECT 1 FROM v2_identity_keys LIMIT 1')).rowCount) throw new Error('保護済みDBには既存の暗号鍵を指定してください。');
    });
    await this.transaction(client => this.blockUnloggedLegacy(client));
    this.cache.clear();
  }
  private async blockUnloggedLegacy(client: Pick<Pool, 'query'>): Promise<void> {
    await client.query(`INSERT INTO v2_legacy_lookup_blocks(channel_id)
      SELECT c.channel_id FROM v2_channels c JOIN v2_guilds g USING(guild_id)
      WHERE CASE WHEN c.overrides->'policy' ? 'retentionDays' THEN c.overrides#>>'{policy,retentionDays}' ELSE g.config#>>'{policy,retentionDays}' END='0'
      ON CONFLICT DO NOTHING`);
    const rows = (await client.query(`SELECT p.message_id FROM v2_posts p LEFT JOIN v2_authors a USING(operation_id)
      WHERE p.message_id IS NOT NULL AND (p.status<>'sent' OR p.expires_at<=now() OR a.operation_id IS NULL OR a.expires_at<=now())`)).rows;
    if (rows.length) await client.query('INSERT INTO v2_legacy_lookup_denials(message_key) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING',
      [rows.map(row => this.identityKey('legacy-lookup-message', row.message_id))]);
  }
  async checkRestrictions(guildId: string, userId: string, channelId: string): Promise<void> {
    const key = this.identityKey(guildId, userId);
    if ((await this.pool.query('SELECT 1 FROM v2_restrictions WHERE guild_id=$1 AND user_id=$2 AND (expires_at IS NULL OR expires_at>now())', [guildId, key])).rowCount)
      throw new UserError('このサーバーでは匿名投稿の利用が制限されています。');
    if ((await this.pool.query('SELECT 1 FROM v2_channel_restrictions WHERE guild_id=$1 AND channel_id=$2 AND user_id=$3', [guildId,channelId,key])).rowCount)
      throw new UserError('このチャンネルでは匿名投稿の利用が停止されています。');
  }
  async close(): Promise<void> { await this.pool.end(); }
  async checkFlood(subject: string, input: Omit<FloodEvent, 'at'>, policy: Config['policy'], consume = false): Promise<void> {
    const result = await this.transaction(async client => {
      const row = (await client.query(`INSERT INTO v2_flood_control(subject,state,expires_at) VALUES($1,$2,now())
        ON CONFLICT(subject) DO UPDATE SET subject=EXCLUDED.subject RETURNING state`,
        [subject, JSON.stringify({ events: [], blockedUntil: 0 })])).rows[0];
      const now = Date.now();
      const decision = floodDecision(row.state as FloodState, input, policy, now, consume);
      if (!decision.state.events.length && !decision.state.blockedUntil) {
        await client.query('DELETE FROM v2_flood_control WHERE subject=$1', [subject]);
        return decision;
      }
      const last = decision.state.events.at(-1)?.at ?? now;
      const expires = new Date(Math.max(now + 60_000, decision.state.blockedUntil, last + Math.max(300, policy.duplicateSeconds, policy.cooldown) * 1000));
      await client.query('UPDATE v2_flood_control SET state=$2,expires_at=$3 WHERE subject=$1', [subject, JSON.stringify(decision.state), expires]);
      return decision;
    });
    if (result.cooldown) throw new UserError(`連続投稿は${result.cooldown}秒後にできます。`);
    if (result.denied) throw new FloodControlError();
  }
  async saveDiagnostic(code: string, guildId: string | null, channelId: string | null, interactionId: string, action: string, details: string, privateMode = false): Promise<void> {
    await this.pool.query(`INSERT INTO v2_diagnostics(code,guild_id,channel_id,interaction_id,action,details,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,now()+$7*interval '1 day')`, [code, guildId, channelId, interactionId, action, details, privateMode ? 1 : 30]);
  }
  async diagnostic(code: string, guildId: string): Promise<{code: string; action: string; details: string; created_at: Date} | null> {
    return (await this.pool.query("SELECT code,action,details,created_at FROM v2_diagnostics WHERE code=$1 AND guild_id=$2 AND created_at>now()-interval '30 days' AND (expires_at IS NULL OR expires_at>now())", [code, guildId])).rows[0] ?? null;
  }
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async settings(guildId: string, channelId: string, fresh = false): Promise<ChannelSettings> {
    const cached = this.cache.get(`${guildId}:${channelId}`);
    if (!fresh && cached && cached.expires > Date.now()) return structuredClone(cached.settings);
    const result = await this.pool.query(`SELECT g.config, g.version AS gv, c.* FROM v2_guilds g
      LEFT JOIN v2_channels c ON c.guild_id=g.guild_id AND c.channel_id=$2 WHERE g.guild_id=$1`, [guildId, channelId]);
    const row = result.rows[0];
    const base = configSchema.parse(row?.config ?? structuredClone(defaults));
    const overrides = overridesSchema.parse(row?.overrides ?? {});
    const settings: ChannelSettings = { guildId, channelId, base, overrides, config: resolveConfig(base, overrides),
      guildVersion: row?.gv ?? 0, channelVersion: row?.version ?? 0, enabled: row?.enabled ?? false,
      panelId: row?.panel_id ?? null, webhook: row?.webhook ?? null };
    this.cache.set(`${guildId}:${channelId}`, { settings, expires: Date.now() + 30_000 });
    return structuredClone(settings);
  }
  invalidate(guildId: string): void {
    for (const key of this.cache.keys()) if (key.startsWith(`${guildId}:`)) this.cache.delete(key);
  }
  async saveSettings(previous: ChannelSettings, scope: 'guild' | 'channel', value: Config | Overrides, actor: string, channelName?: string): Promise<void> {
    actor = this.identityKey(previous.guildId, actor);
    const parsed = scope === 'guild' ? configSchema.parse(value) : overridesSchema.parse(value);
    await this.transaction(async client => {
      await client.query('INSERT INTO v2_guilds(guild_id,config) VALUES($1,$2) ON CONFLICT DO NOTHING', [previous.guildId, defaults]);
      const guild = (await client.query('SELECT version FROM v2_guilds WHERE guild_id=$1 FOR UPDATE', [previous.guildId])).rows[0];
      if (guild.version !== previous.guildVersion) throw new UserError('ほかの管理者がサーバー設定を変更しました。/settings から開き直してください。');
      if (scope === 'guild') {
        const channels = await client.query('SELECT overrides FROM v2_channels WHERE guild_id=$1', [previous.guildId]);
        for (const channel of channels.rows) resolveConfig(parsed as Config, channel.overrides);
        await client.query("INSERT INTO v2_revisions(guild_id,config,actor_id,snapshot,channel_name) VALUES($1,$2,$3,true,'サーバー標準')", [previous.guildId, parsed, actor]);
        await client.query('UPDATE v2_guilds SET config=$2,version=version+1 WHERE guild_id=$1', [previous.guildId, parsed]);
      } else {
        await client.query('INSERT INTO v2_channels(guild_id,channel_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [previous.guildId, previous.channelId]);
        const channel = (await client.query('SELECT * FROM v2_channels WHERE guild_id=$1 AND channel_id=$2 FOR UPDATE', [previous.guildId, previous.channelId])).rows[0];
        if (!channel || channel.version !== previous.channelVersion) throw new UserError('このチャンネルの設定が更新されました。/settings から開き直してください。');
        resolveConfig(previous.base, parsed as Overrides);
        await client.query('INSERT INTO v2_revisions(guild_id,channel_id,config,actor_id,snapshot,channel_name) VALUES($1,$2,$3,$4,true,$5)', [previous.guildId, previous.channelId, resolveConfig(previous.base, parsed as Overrides), actor, channelName?.slice(0,100) ?? channel.channel_name]);
        await client.query('UPDATE v2_channels SET overrides=$3,version=version+1,channel_name=COALESCE($4,channel_name),settings_saved_at=now() WHERE guild_id=$1 AND channel_id=$2', [previous.guildId, previous.channelId, parsed, channelName?.slice(0,100) ?? null]);
      }
      await client.query("DELETE FROM v2_revisions WHERE guild_id=$1 AND created_at<=now()-interval '60 days'",[previous.guildId]);
      const base=(await client.query('SELECT config FROM v2_guilds WHERE guild_id=$1',[previous.guildId])).rows[0].config;
      const channels=(await client.query('SELECT channel_id,overrides FROM v2_channels WHERE guild_id=$1',[previous.guildId])).rows;
      for(const channel of channels){
        const policy=resolveConfig(base,channel.overrides).policy;
        if(policy.retentionDays===0){
          await client.query('INSERT INTO v2_legacy_lookup_blocks(channel_id) VALUES($1) ON CONFLICT DO NOTHING', [channel.channel_id]);
          await client.query('DELETE FROM v2_posts WHERE channel_id=$1',[channel.channel_id]);
          await client.query('DELETE FROM v2_reports WHERE channel_id=$1',[channel.channel_id]);
          await client.query('DELETE FROM v2_sessions WHERE channel_id=$1',[channel.channel_id]);
          await client.query('DELETE FROM v2_diagnostics WHERE channel_id=$1',[channel.channel_id]);
          await client.query('UPDATE v2_counters SET last_user=NULL WHERE channel_id=$1',[channel.channel_id]);
        }else{
          await client.query("UPDATE v2_posts SET expires_at=CASE WHEN $2::integer IS NULL THEN 'infinity'::timestamptz ELSE created_at+$2*interval '1 day' END WHERE channel_id=$1",[channel.channel_id,policy.retentionDays]);
          await client.query('UPDATE v2_authors a SET expires_at=p.expires_at FROM v2_posts p WHERE p.operation_id=a.operation_id AND p.channel_id=$1',[channel.channel_id]);
          if(policy.reportRetentionDays===0)await client.query('DELETE FROM v2_reports WHERE channel_id=$1',[channel.channel_id]);
          else await client.query("UPDATE v2_reports SET expires_at=CASE WHEN $2::integer IS NULL THEN 'infinity'::timestamptz ELSE created_at+$2*interval '1 day' END WHERE channel_id=$1",[channel.channel_id,policy.reportRetentionDays]);
        }
      }
    });
    this.invalidate(previous.guildId);
  }
  async setPanel(guildId: string, channelId: string, panelId: string, webhook: string, previous?: ChannelSettings): Promise<boolean> {
    const result = await this.pool.query('UPDATE v2_channels SET panel_id=$3,webhook=$4,enabled=true WHERE guild_id=$1 AND channel_id=$2 AND ($5::int IS NULL OR version=$5) AND ($6::int IS NULL OR (SELECT version FROM v2_guilds WHERE guild_id=$1)=$6)', [guildId, channelId, panelId, webhook, previous?.channelVersion ?? null, previous?.guildVersion ?? null]);
    this.invalidate(guildId);
    return !!result.rowCount;
  }
  async disable(guildId: string, channelId: string): Promise<void> {
    await this.pool.query('UPDATE v2_channels SET enabled=false,version=version+1 WHERE guild_id=$1 AND channel_id=$2', [guildId, channelId]); this.invalidate(guildId);
  }
  async replacePanel(previous: ChannelSettings, panelId: string): Promise<boolean> {
    const result = await this.pool.query(`UPDATE v2_channels SET panel_id=$3
      WHERE guild_id=$1 AND channel_id=$2 AND panel_id IS NOT DISTINCT FROM $4
        AND enabled=true AND version=$5
        AND (SELECT version FROM v2_guilds WHERE guild_id=$1)=$6`,
      [previous.guildId,previous.channelId,panelId,previous.panelId,previous.channelVersion,previous.guildVersion]);
    this.invalidate(previous.guildId); return !!result.rowCount;
  }
  async configuredChannels(guildId: string): Promise<string[]> {
    return (await this.pool.query('SELECT channel_id FROM v2_channels WHERE guild_id=$1 AND enabled=true', [guildId])).rows.map(row => row.channel_id);
  }
  async savedSetups(guildId: string, currentChannelId: string, offset = 0, roles?: string[]): Promise<SavedSetup[]> {
    const result = await this.pool.query(`SELECT c.channel_id,c.channel_name,c.enabled,c.settings_saved_at,
      COALESCE(c.overrides->'panel'->>'title',g.config->'panel'->>'title','匿名投稿') AS title
      FROM v2_channels c JOIN v2_guilds g ON g.guild_id=c.guild_id
      WHERE c.guild_id=$1 AND (c.version>0 OR c.panel_id IS NOT NULL OR c.webhook IS NOT NULL OR c.overrides<>'{}'::jsonb)
      AND ($4::text[] IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(
        COALESCE(c.overrides->'moderation'->'managerRoles',g.config->'moderation'->'managerRoles','[]'::jsonb)) AS r(role) WHERE r.role=ANY($4)))
      ORDER BY (c.channel_id=$2) DESC,c.settings_saved_at DESC NULLS LAST,c.channel_id LIMIT 26 OFFSET $3`, [guildId,currentChannelId,Math.max(0,offset),roles ?? null]);
    return result.rows.map(row=>({channelId:row.channel_id,name:row.channel_name,title:row.title,enabled:row.enabled,savedAt:row.settings_saved_at}));
  }
  async savedSetup(guildId: string, channelId: string): Promise<Config | null> {
    const row = (await this.pool.query(`SELECT c.overrides,g.config FROM v2_channels c JOIN v2_guilds g ON g.guild_id=c.guild_id
      WHERE c.guild_id=$1 AND c.channel_id=$2 AND (c.version>0 OR c.panel_id IS NOT NULL OR c.webhook IS NOT NULL OR c.overrides<>'{}'::jsonb)`, [guildId,channelId])).rows[0];
    return row ? resolveConfig(configSchema.parse(row.config),overridesSchema.parse(row.overrides)) : null;
  }
  async configuredPanels(): Promise<{ guildId: string; channelId: string; panelId: string }[]> {
    return (await this.pool.query(`SELECT c.guild_id,c.channel_id,c.panel_id FROM v2_channels c
      JOIN v2_guilds g ON g.guild_id=c.guild_id WHERE c.enabled=true AND c.panel_id IS NOT NULL AND g.left_at IS NULL`))
      .rows.map(row => ({ guildId: row.guild_id, channelId: row.channel_id, panelId: row.panel_id }));
  }
  async touchGuild(guildId: string): Promise<void> {
    await this.pool.query('INSERT INTO v2_guilds(guild_id,config) VALUES($1,$2) ON CONFLICT(guild_id) DO UPDATE SET left_at=NULL', [guildId, defaults]);
  }
  async markGuildLeft(guildId: string): Promise<boolean> {
    return !!(await this.pool.query('UPDATE v2_guilds SET left_at=now() WHERE guild_id=$1 AND left_at IS NULL', [guildId])).rowCount;
  }
  private async deleteExpiredGuilds(client: PoolClient): Promise<string[]> {
    const guildIds = (await client.query(`SELECT guild_id FROM v2_guilds WHERE left_at IS NOT NULL AND left_at<=now()-$1::integer*interval '1 day' FOR UPDATE`,
      [this.guildGraceDays])).rows.map(row => row.guild_id as string);
    if (!guildIds.length) return [];
    await client.query('DELETE FROM v2_posts WHERE guild_id=ANY($1)', [guildIds]);
    await client.query('DELETE FROM v2_reports WHERE guild_id=ANY($1)', [guildIds]);
    await client.query('DELETE FROM v2_sessions WHERE guild_id=ANY($1)', [guildIds]);
    await client.query('DELETE FROM v2_restrictions WHERE guild_id=ANY($1)', [guildIds]);
    await client.query('DELETE FROM v2_channel_restrictions WHERE guild_id=ANY($1)', [guildIds]);
    await client.query('DELETE FROM v2_actions WHERE guild_id=ANY($1)', [guildIds]);
    await client.query('DELETE FROM v2_revisions WHERE guild_id=ANY($1)', [guildIds]);
    await client.query(`DELETE FROM v2_diagnostics WHERE guild_id=ANY($1)
      OR channel_id IN (SELECT channel_id FROM v2_channels WHERE guild_id=ANY($1))`, [guildIds]);
    await client.query('DELETE FROM v2_legacy_lookup_blocks WHERE channel_id IN (SELECT channel_id FROM v2_channels WHERE guild_id=ANY($1))', [guildIds]);
    await client.query('DELETE FROM v2_counters WHERE channel_id IN (SELECT channel_id FROM v2_channels WHERE guild_id=ANY($1))', [guildIds]);
    await client.query('DELETE FROM v2_channels WHERE guild_id=ANY($1)', [guildIds]);
    await client.query('DELETE FROM v2_guilds WHERE guild_id=ANY($1)', [guildIds]);
    for (const guildId of guildIds) this.invalidate(guildId);
    return guildIds;
  }
  async claimReportNotification(guildId: string, messageId: string): Promise<string | null> {
    return this.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`report:${guildId}:${messageId}`]);
      const existing = (await client.query(`SELECT 1 FROM v2_reports WHERE guild_id=$1 AND message_id=$2 AND
        ((notification_id IS NOT NULL AND notification_id NOT LIKE 'pending%') OR notification_retry_at>now())`, [guildId, messageId])).rowCount;
      if (existing) return null;
      const token = `pending:${randomUUID()}`;
      const claimed = await client.query(`UPDATE v2_reports SET notification_id=$3,notification_retry_at=now()+interval '5 minutes'
        WHERE guild_id=$1 AND message_id=$2 AND status='open' AND expires_at>now()`, [guildId, messageId, token]);
      return claimed.rowCount ? token : null;
    });
  }
  async reportNotification(guildId: string, messageId: string, token: string, notificationId: string | null): Promise<void> {
    await this.pool.query(`UPDATE v2_reports SET notification_id=$4,
      notification_retry_at=CASE WHEN $4::text IS NULL THEN now()+interval '5 minutes' ELSE NULL END
      WHERE guild_id=$1 AND message_id=$2 AND notification_id=$3`, [guildId, messageId, token, notificationId]);
  }
  async pendingReportNotices(guildId: string | null = null, messageId: string | null = null): Promise<ReportNotice[]> {
    return (await this.pool.query(`WITH notices AS (
      SELECT guild_id,channel_id,message_id,count(*)::int AS count,
        max(evidence->>'content') AS content,max(reason) AS reason,'r'||min(id)::text AS nonce,
        min(created_at) AS oldest
      FROM v2_reports WHERE status='open' AND expires_at>now()
        AND ($1::text IS NULL OR guild_id=$1) AND ($2::text IS NULL OR message_id=$2)
      GROUP BY guild_id,channel_id,message_id
      HAVING bool_and(notification_id IS NULL OR notification_id LIKE 'pending%')
        AND bool_and(notification_retry_at IS NULL OR notification_retry_at<=now())
      ), qualified AS (
      SELECT n.guild_id,n.channel_id,n.message_id,n.count,n.content,n.reason,n.nonce,n.oldest
      FROM notices n JOIN v2_guilds g ON g.guild_id=n.guild_id AND g.left_at IS NULL
      LEFT JOIN v2_channels c ON c.guild_id=n.guild_id AND c.channel_id=n.channel_id
      WHERE n.count >= COALESCE(c.overrides#>>'{moderation,reportThreshold}',g.config#>>'{moderation,reportThreshold}')::integer
        AND CASE WHEN c.overrides->'moderation' ? 'reportChannel'
          THEN c.overrides#>>'{moderation,reportChannel}' ELSE g.config#>>'{moderation,reportChannel}' END IS NOT NULL
      ), ranked AS (
      SELECT guild_id,channel_id,message_id,count,content,reason,nonce,oldest,
        ROW_NUMBER() OVER (PARTITION BY guild_id ORDER BY oldest,message_id) AS position
      FROM qualified
      ) SELECT guild_id,channel_id,message_id,count,content,reason,nonce
      FROM ranked WHERE position<=5
      ORDER BY oldest LIMIT 20`, [guildId, messageId])).rows;
  }
  async reserve(input: { operationId: string; guildId: string; channelId: string; userId: string; text: string; source?: string; replyTo?: string; videoLinks?: string[] }, config: Config, deliveryWebhook?: string): Promise<StoredPost> {
    if(config.policy.retentionDays===0)throw new UserError('保存しない設定では投稿ログを作成できません。');
    const userKey = this.identityKey(input.guildId, input.userId);
    return this.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`post:${input.guildId}:${input.channelId}`]);
      const guild=(await client.query('SELECT config FROM v2_guilds WHERE guild_id=$1 FOR SHARE',[input.guildId])).rows[0];
      if(guild){
        const channel=(await client.query('SELECT overrides FROM v2_channels WHERE channel_id=$1',[input.channelId])).rows[0];
        if(resolveConfig(guild.config,channel?.overrides??{}).policy.retentionDays===0)throw new UserError('保存しない設定では投稿ログを作成できません。');
      }
      const old = (await client.query('SELECT * FROM v2_posts WHERE operation_id=$1', [input.operationId])).rows[0];
      if (old) throw new UserError(old.status === 'sent' ? 'この投稿は送信済みです。' : 'この投稿は処理中か送信結果の確認中です。再送せず少しお待ちください。');
      const restriction = (await client.query('SELECT 1 FROM v2_restrictions WHERE guild_id=$1 AND user_id=$2 AND (expires_at IS NULL OR expires_at>now())', [input.guildId, userKey])).rows[0];
      if (restriction) throw new UserError('このサーバーでは匿名投稿の利用が制限されています。');
      if((await client.query('SELECT 1 FROM v2_channel_restrictions WHERE guild_id=$1 AND channel_id=$2 AND user_id=$3',[input.guildId,input.channelId,userKey])).rowCount)throw new UserError('このチャンネルでは匿名投稿の利用が停止されています。');
      const session = (await client.query('SELECT * FROM v2_sessions WHERE guild_id=$1 AND channel_id=$2 AND user_id=$3', [input.guildId, input.channelId, userKey])).rows[0];
      const now = new Date();
      const age = session ? now.getTime() - new Date(session.last_post).getTime() : Infinity;
      if (age < config.policy.cooldown * 1000) throw new UserError(`連続投稿は${Math.ceil(config.policy.cooldown - age / 1000)}秒後にできます。`);
      await client.query('INSERT INTO v2_counters(channel_id) VALUES($1) ON CONFLICT DO NOTHING', [input.channelId]);
      const counter = (await client.query('SELECT * FROM v2_counters WHERE channel_id=$1', [input.channelId])).rows[0];
      const inherit = session && counter.last_user === userKey && age < config.identity.minutes * 60_000;
      const anonymousId = inherit ? session.anonymous_id : counter.counter % 1000 + 1;
      const lastAvatar = counter.last_avatar ?? (await client.query('SELECT avatar FROM v2_sessions WHERE channel_id=$1 AND user_id=$2', [input.channelId, counter.last_user])).rows[0]?.avatar
        ?? (await client.query('SELECT avatar FROM v2_posts WHERE channel_id=$1 ORDER BY created_at DESC LIMIT 1', [input.channelId])).rows[0]?.avatar;
      const avatar = inherit ? session.avatar : nextAvatar(lastAvatar);
      await client.query('UPDATE v2_counters SET counter=$2,last_user=$3,last_avatar=$4 WHERE channel_id=$1', [input.channelId, inherit ? counter.counter : anonymousId, userKey, avatar]);
      await client.query(`INSERT INTO v2_sessions VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(guild_id,channel_id,user_id)
        DO UPDATE SET anonymous_id=$4,avatar=$5,last_post=$6`, [input.guildId, input.channelId, userKey, anonymousId, avatar, now]);
      const expires = config.policy.retentionDays===null?'infinity':new Date(now.getTime() + config.policy.retentionDays * 86_400_000);
      const row = (await client.query(`INSERT INTO v2_posts(operation_id,guild_id,channel_id,content,source,reply_to,anonymous_id,avatar,expires_at,delivery_webhook,layout,video_links)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'plain',$11::jsonb) RETURNING *`, [input.operationId, input.guildId, input.channelId, input.text, input.source ?? null, input.replyTo ?? null, anonymousId, avatar, expires, deliveryWebhook ?? null, JSON.stringify(input.videoLinks ?? [])])).rows[0];
      await client.query('INSERT INTO v2_authors(operation_id,user_id,expires_at,user_ciphertext) VALUES($1,$2,$3,$4)', [input.operationId, userKey, expires, this.sealIdentity(input.userId)]);
      return row;
    });
  }
  async markSent(operationId: string, messageId: string, media: StoredPost['media']): Promise<void> {
    const result = await this.pool.query(`UPDATE v2_posts SET status='sent',message_id=$2,media=$3
      WHERE operation_id=$1 AND status IN ('sending','uncertain','sent') AND expires_at>now()
        AND (message_id IS NULL OR message_id=$2)`, [operationId, messageId, JSON.stringify(media)]);
    if (!result.rowCount) throw new UserError('この投稿は削除済みか保存期限を過ぎているため、送信結果を保存できません。');
  }
  async markUncertain(operationId: string, delivery?: { messageId: string; media: StoredPost['media'] }): Promise<void> {
    await this.pool.query(`UPDATE v2_posts SET status='uncertain',message_id=COALESCE($2,message_id),
      media=CASE WHEN $2::text IS NULL THEN media ELSE $3::jsonb END
      WHERE operation_id=$1 AND status='sending'`, [operationId, delivery?.messageId ?? null, JSON.stringify(delivery?.media ?? [])]);
  }
  async uncertainPosts(guildId: string, channelId: string, userId: string): Promise<StoredPost[]> {
    return (await this.pool.query(`SELECT p.* FROM v2_posts p JOIN v2_authors a USING(operation_id)
      WHERE p.guild_id=$1 AND p.channel_id=$2 AND a.user_id=$3 AND a.expires_at>now() AND p.expires_at>now()
        AND (p.status='uncertain' OR (p.status='sending' AND p.created_at<now()-interval '2 minutes'))
      ORDER BY p.created_at DESC LIMIT 20`, [guildId, channelId, this.identityKey(guildId, userId)])).rows;
  }
  async ownOperation(guildId: string, channelId: string, userId: string, operationId: string): Promise<StoredPost | null> {
    return (await this.pool.query(`SELECT p.* FROM v2_posts p JOIN v2_authors a USING(operation_id)
      WHERE p.guild_id=$1 AND p.channel_id=$2 AND a.user_id=$3 AND p.operation_id=$4
        AND a.expires_at>now() AND p.expires_at>now() AND p.status IN ('sending','uncertain','sent')`, [guildId,channelId,this.identityKey(guildId,userId),operationId])).rows[0] ?? null;
  }
  async post(guildId: string, channelId: string, messageId: string): Promise<StoredPost | null> {
    const row = (await this.pool.query(`SELECT p.*, a.user_id,a.user_ciphertext FROM v2_posts p LEFT JOIN v2_authors a ON a.operation_id=p.operation_id AND a.expires_at>now()
      WHERE p.guild_id=$1 AND p.channel_id=$2 AND p.message_id=$3 AND p.expires_at>now() AND p.status='sent'`, [guildId, channelId, messageId])).rows[0];
    if (row?.user_id) row.user_id = this.openIdentity(row.user_id, row.user_ciphertext);
    if (row) delete row.user_ciphertext;
    const post = row ? { ...row, videoLinks: Array.isArray(row.video_links) ? row.video_links : [] } : null;
    return post;
  }
  async ownPosts(guildId: string, channelId: string, userId: string): Promise<StoredPost[]> {
    return (await this.pool.query(`SELECT p.* FROM v2_posts p JOIN v2_authors a USING(operation_id)
      WHERE p.guild_id=$1 AND p.channel_id=$2 AND a.user_id=$3 AND a.expires_at>now() AND p.status='sent'
      ORDER BY p.created_at DESC LIMIT 20`, [guildId, channelId, this.identityKey(guildId, userId)])).rows;
  }
  async anonymousReferences(guildId:string,channelId:string,numbers:number[],before:Date):Promise<Map<number,string>>{
    if(!numbers.length)return new Map();
    const rows=(await this.pool.query(`SELECT DISTINCT ON(anonymous_id) anonymous_id,message_id FROM v2_posts
      WHERE guild_id=$1 AND channel_id=$2 AND anonymous_id=ANY($3::integer[]) AND status='sent' AND expires_at>now() AND created_at<$4 AND message_id IS NOT NULL
      ORDER BY anonymous_id,created_at DESC,message_id DESC`,[guildId,channelId,numbers,before])).rows;
    return new Map(rows.map(row=>[row.anonymous_id,row.message_id]));
  }
  async lookupAuthor(messageId: string): Promise<{user_id:string;guild_id:string;channel_id:string} | null> {
    const row = (await this.pool.query(`SELECT a.user_id,a.user_ciphertext,p.guild_id,p.channel_id FROM v2_posts p JOIN v2_authors a USING(operation_id)
      JOIN v2_channels c ON c.guild_id=p.guild_id AND c.channel_id=p.channel_id JOIN v2_guilds g ON g.guild_id=p.guild_id
      WHERE p.message_id=$1 AND p.status='sent' AND p.expires_at>now() AND a.expires_at>now()
        AND COALESCE(CASE WHEN c.overrides->'policy' ? 'retentionDays' THEN c.overrides#>>'{policy,retentionDays}' ELSE g.config#>>'{policy,retentionDays}' END,'infinity')<>'0'`,[messageId])).rows[0];
    if (row) return { user_id: this.openIdentity(row.user_id, row.user_ciphertext), guild_id: row.guild_id, channel_id: row.channel_id };
    if ((await this.pool.query('SELECT 1 FROM v2_posts WHERE message_id=$1 LIMIT 1', [messageId])).rowCount) return null;
    return this.lookupLegacyAuthor(messageId);
  }
  private async lookupLegacyAuthor(messageId: string): Promise<{user_id:string;guild_id:string;channel_id:string} | null> {
    if (!/^\d{17,20}$/.test(messageId)) return null;
    if ((await this.pool.query('SELECT 1 FROM v2_legacy_lookup_denials WHERE message_key=$1', [this.identityKey('legacy-lookup-message', messageId)])).rowCount) return null;
    const tables = (await this.pool.query("SELECT to_regclass('public.anonymous_messages') IS NOT NULL AS legacy,to_regclass('public.messages') IS NOT NULL AS analytics")).rows[0];
    if (!tables.legacy) return null;
    const old = (await this.pool.query('SELECT user_id,channel_id,timestamp FROM anonymous_messages WHERE message_id=$1', [messageId])).rows[0];
    if (!old || !/^\d{17,20}$/.test(old.user_id ?? '')) return null;
    let channelId: string | undefined = old.channel_id ?? undefined;
    let createdAt: Date | undefined = old.timestamp ? new Date(old.timestamp) : undefined;
    if ((!channelId || !createdAt) && tables.analytics && BigInt(messageId) <= 9223372036854775807n) {
      const metadata = (await this.pool.query('SELECT channel_id::text AS channel_id,created_at FROM messages WHERE message_id=$1::bigint', [messageId])).rows[0];
      channelId ??= metadata?.channel_id;
      createdAt ??= metadata?.created_at ? new Date(metadata.created_at) : undefined;
    }
    if (!channelId) return null;
    const settings = (await this.pool.query(`SELECT c.guild_id,
      CASE WHEN c.overrides->'policy' ? 'retentionDays' THEN c.overrides#>>'{policy,retentionDays}' ELSE g.config#>>'{policy,retentionDays}' END AS days,
      EXISTS(SELECT 1 FROM v2_legacy_lookup_blocks b WHERE b.channel_id=c.channel_id) AS blocked
      FROM v2_channels c JOIN v2_guilds g USING(guild_id) WHERE c.channel_id=$1`, [channelId])).rows[0];
    if (!settings || settings.blocked || settings.days === '0') return null;
    if (settings.days !== null) {
      const days = Number(settings.days);
      if (!Number.isInteger(days) || days < 1 || days > 90 || !createdAt || !Number.isFinite(createdAt.getTime()) || createdAt.getTime() + days * 86400000 <= Date.now()) return null;
    }
    return { user_id: old.user_id, guild_id: settings.guild_id, channel_id: channelId };
  }
  async updatePost(guildId: string, channelId: string, messageId: string, text: string): Promise<void> {
    await this.pool.query('UPDATE v2_posts SET content=$4 WHERE guild_id=$1 AND channel_id=$2 AND message_id=$3', [guildId, channelId, messageId, text]);
  }
  async hydratePost(guildId: string, channelId: string, messageId: string, content: string, media: StoredPost['media']): Promise<void> {
    await this.pool.query('UPDATE v2_posts SET content=$4,media=$5 WHERE guild_id=$1 AND channel_id=$2 AND message_id=$3', [guildId, channelId, messageId, content, JSON.stringify(media)]);
  }
  async deletePost(guildId: string, channelId: string, messageId: string): Promise<void> {
    await this.pool.query("UPDATE v2_posts SET status='deleted',content='',media='[]' WHERE guild_id=$1 AND channel_id=$2 AND message_id=$3", [guildId, channelId, messageId]);
  }
  async addReport(post: StoredPost, reporter: string, reason: string, days: number|null): Promise<number> {
    if(days===0)throw new UserError('このチャンネルは通報内容を保存しない設定です。');
    return this.transaction(async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`report:${post.guild_id}:${post.message_id}`]);
    if((await client.query("SELECT 1 FROM v2_reports WHERE guild_id=$1 AND message_id=$2 AND status IN ('processing','resolved') LIMIT 1",[post.guild_id,post.message_id])).rowCount)throw new UserError('この通報は処理中か対応済みです。');
    const evidence = { content: post.content, source: post.source, media: post.media,
      ...(this.identities ? { userCiphertext: post.user_id ? this.sealIdentity(post.user_id) : null } : { userId: post.user_id }) };
    const result = await client.query(`INSERT INTO v2_reports(guild_id,channel_id,message_id,reporter_id,reason,evidence,expires_at,reporter_ciphertext)
      VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $7::integer IS NULL THEN 'infinity'::timestamptz ELSE now()+$7*interval '1 day' END,$8) ON CONFLICT DO NOTHING RETURNING id`,
      [post.guild_id, post.channel_id, post.message_id, this.identityKey(post.guild_id, reporter), reason, JSON.stringify(evidence), days, this.sealIdentity(reporter)]);
    if (!result.rowCount) throw new UserError('この投稿はすでに通報しています。');
    return (await client.query("SELECT count(*)::int AS count FROM v2_reports WHERE guild_id=$1 AND message_id=$2 AND status='open' AND expires_at>now()", [post.guild_id, post.message_id])).rows[0].count;
    });
  }
  async restrict(guildId: string, messageId: string, actor: string, hours: number): Promise<void> {
    await this.transaction(async client => {
      const report = (await client.query("SELECT evidence FROM v2_reports WHERE guild_id=$1 AND message_id=$2 AND status='open' AND expires_at>now() ORDER BY id LIMIT 1", [guildId, messageId])).rows[0];
      const userId = report?.evidence?.userCiphertext ? this.openIdentity('', report.evidence.userCiphertext) : report?.evidence?.userId;
      if (!userId) throw new UserError('投稿者対応の保存期限が過ぎているため、利用停止できません。');
      await client.query(`INSERT INTO v2_restrictions VALUES($1,$2,now()+$3*interval '1 hour',$4)
        ON CONFLICT(guild_id,user_id) DO UPDATE SET expires_at=EXCLUDED.expires_at,reason=EXCLUDED.reason`, [guildId, this.identityKey(guildId, userId), hours, '通報に基づく匿名機能の利用停止']);
      await client.query("INSERT INTO v2_actions(guild_id,actor_id,action,message_id) VALUES($1,$2,'restrict',$3)", [guildId, this.identityKey(guildId, actor), messageId]);
      await client.query("UPDATE v2_reports SET status='resolved' WHERE guild_id=$1 AND message_id=$2", [guildId, messageId]);
    });
  }
  async reportDetail(guildId:string,channelId:string,messageId:string):Promise<ReportDetail|null>{
    const rows=(await this.pool.query(`SELECT reporter_id,reporter_ciphertext,reason,evidence,notification_id FROM v2_reports
      WHERE guild_id=$1 AND channel_id=$2 AND message_id=$3 AND status='open' AND expires_at>now() ORDER BY id`,[guildId,channelId,messageId])).rows;
    if(!rows.length)return null;
    const evidence=rows[0].evidence;const post=await this.post(guildId,channelId,messageId);
    return {guild_id:guildId,channel_id:channelId,message_id:messageId,count:rows.length,content:evidence.content??'',reason:rows.map(row=>row.reason).filter(reason=>reason.trim()).join('\n'),nonce:'',
      reporters:rows.map(row=>this.openIdentity(row.reporter_id,row.reporter_ciphertext)),userId:evidence.userCiphertext?this.openIdentity('',evidence.userCiphertext):evidence.userId??'',anonymousId:post?.anonymous_id??0,notificationId:rows[0].notification_id?.startsWith('pending:')?null:rows[0].notification_id??null};
  }
  async claimReportAction(guildId:string,channelId:string,messageId:string):Promise<string>{
    return this.transaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`report:${guildId}:${messageId}`]);
      if((await client.query("SELECT 1 FROM v2_reports WHERE guild_id=$1 AND message_id=$2 AND status='processing' LIMIT 1",[guildId,messageId])).rowCount)throw new UserError('この通報は処理中です。');
      const token=randomUUID();const result=await client.query(`UPDATE v2_reports SET status='processing',moderation_token=$4
        WHERE guild_id=$1 AND channel_id=$2 AND message_id=$3 AND status='open' AND expires_at>now()`,[guildId,channelId,messageId,token]);
      if(!result.rowCount)throw new UserError('この通報は対応済みか、処理中・送信結果の確認が必要な状態です。');
      return token;
    });
  }
  async releaseReportAction(guildId:string,messageId:string,token:string):Promise<void>{await this.pool.query("UPDATE v2_reports SET status='open',moderation_token=NULL WHERE guild_id=$1 AND message_id=$2 AND moderation_token=$3 AND status='processing'",[guildId,messageId,token]);}
  async finishReportAction(guildId:string,messageId:string,token:string,actor:string,action:string,reason:string,targetUser?:string):Promise<void>{
    await this.transaction(async client=>{
      const result=await client.query("UPDATE v2_reports SET status='resolved',moderation_token=NULL WHERE guild_id=$1 AND message_id=$2 AND moderation_token=$3 AND status='processing' RETURNING channel_id",[guildId,messageId,token]);
      if(!result.rowCount)throw new UserError('処罰の実行後に通報履歴を更新できませんでした。再実行せず運用者へ確認してください。');
      if(targetUser)await client.query('INSERT INTO v2_channel_restrictions(guild_id,channel_id,user_id,reason) VALUES($1,$2,$3,$4) ON CONFLICT(guild_id,channel_id,user_id) DO UPDATE SET reason=$4',[guildId,result.rows[0].channel_id,this.identityKey(guildId,targetUser),reason]);
      await client.query('INSERT INTO v2_actions(guild_id,actor_id,action,message_id,reason) VALUES($1,$2,$3,$4,$5)',[guildId,this.identityKey(guildId,actor),action,messageId,reason]);
    });
  }
  async releaseChannelRestriction(guildId:string,channelId:string,userId:string,actor:string):Promise<void>{
    await this.transaction(async client=>{
      const result=await client.query('DELETE FROM v2_channel_restrictions WHERE guild_id=$1 AND channel_id=$2 AND user_id=$3',[guildId,channelId,this.identityKey(guildId,userId)]);
      if(!result.rowCount)throw new UserError('このチャンネルで、そのユーザーは利用停止されていません。');
      await client.query("INSERT INTO v2_actions(guild_id,actor_id,action,reason) VALUES($1,$2,'release-channel',$3)",[guildId,this.identityKey(guildId,actor),`対象チャンネル:${channelId}`]);
    });
  }
  async resolveReport(guildId: string, messageId: string, actor: string): Promise<void> {
    await this.pool.query("UPDATE v2_reports SET status='resolved' WHERE guild_id=$1 AND message_id=$2", [guildId, messageId]);
    await this.pool.query("INSERT INTO v2_actions(guild_id,actor_id,action,message_id) VALUES($1,$2,'resolve',$3)", [guildId, this.identityKey(guildId,actor), messageId]);
  }
  async settingsBackups(guildId: string, roles?: string[], beforeId?: string): Promise<SettingsBackup[]> {
    if (beforeId !== undefined && !/^[1-9]\d{0,18}$/.test(beforeId)) return [];
    const result = await this.pool.query(`SELECT r.id::text,r.created_at,r.channel_id,
      CASE WHEN r.channel_id IS NULL THEN 'サーバー標準' ELSE COALESCE(r.channel_name,c.channel_name,'保存元のチャンネル') END AS channel_name
      FROM v2_revisions r JOIN v2_guilds g ON g.guild_id=r.guild_id
      LEFT JOIN v2_channels c ON c.guild_id=r.guild_id AND c.channel_id=r.channel_id
      WHERE r.guild_id=$1 AND r.created_at>now()-interval '60 days' AND ($3::bigint IS NULL OR r.id<$3)
      AND ($2::text[] IS NULL OR (r.channel_id IS NOT NULL AND EXISTS(
        SELECT 1 FROM jsonb_array_elements_text(COALESCE(c.overrides->'moderation'->'managerRoles',g.config->'moderation'->'managerRoles','[]'::jsonb)) AS role(value) WHERE role.value=ANY($2))))
      ORDER BY r.id DESC LIMIT 26`, [guildId, roles ?? null, beforeId ?? null]);
    return result.rows.map(row => ({ id: row.id, createdAt: row.created_at, channelId: row.channel_id, channelName: row.channel_name }));
  }
  async settingsBackup(guildId: string, channelId: string | null, id: string): Promise<Config | Overrides | null> {
    if (!/^[1-9]\d{0,18}$/.test(id)) return null;
    const row = (await this.pool.query("SELECT config,snapshot FROM v2_revisions WHERE guild_id=$1 AND channel_id IS NOT DISTINCT FROM $2 AND id=$3 AND created_at>now()-interval '60 days'", [guildId, channelId, id])).rows[0];
    if (!row) return null;
    return row.snapshot || channelId === null ? configSchema.parse(row.config) : resolveConfig((await this.settings(guildId,channelId,true)).base,overridesSchema.parse(row.config));
  }
  async deleteSettingsBackup(guildId: string, channelId: string | null, id: string): Promise<boolean> {
    if (!/^[1-9]\d{0,18}$/.test(id)) return false;
    return !!(await this.pool.query('DELETE FROM v2_revisions WHERE guild_id=$1 AND channel_id IS NOT DISTINCT FROM $2 AND id=$3', [guildId, channelId, id])).rowCount;
  }
  async openReports(guildId: string, channelId: string): Promise<{ message_id: string; reason: string; content: string; count: number }[]> {
    return (await this.pool.query(`SELECT message_id,max(reason) AS reason,max(evidence->>'content') AS content,count(*)::int AS count
      FROM v2_reports WHERE guild_id=$1 AND channel_id=$2 AND status='open' AND expires_at>now()
      GROUP BY message_id ORDER BY min(created_at) DESC LIMIT 20`, [guildId, channelId])).rows;
  }
  async *openReportNotices(guildId?:string,channelId?:string){
    let cursor='0';
    for(;;){
      const rows=(await this.pool.query(`SELECT guild_id,channel_id,message_id,notification_id,min(id)::text AS cursor FROM v2_reports
        WHERE status='open' AND expires_at>now() AND notification_id IS NOT NULL AND notification_id NOT LIKE 'pending:%'
          AND ($2::text IS NULL OR guild_id=$2) AND ($3::text IS NULL OR channel_id=$3)
        GROUP BY guild_id,channel_id,message_id,notification_id HAVING min(id)>$1 ORDER BY min(id) LIMIT 25`,[cursor,guildId??null,channelId??null])).rows;
      for(const row of rows)yield row as {guild_id:string;channel_id:string;message_id:string;notification_id:string;cursor:string};
      if(rows.length<25)return;cursor=rows.at(-1)!.cursor;
    }
  }
  async cleanup(): Promise<void> {
    await this.transaction(async client => {
      await this.blockUnloggedLegacy(client);
      await this.deleteExpiredGuilds(client);
      await client.query('DELETE FROM v2_flood_control WHERE expires_at<=now()');
      await client.query('DELETE FROM v2_reports WHERE expires_at<=now()');
      await client.query(`DELETE FROM v2_diagnostics d USING v2_channels c,v2_guilds g
        WHERE d.channel_id=c.channel_id AND c.guild_id=g.guild_id AND
          CASE WHEN c.overrides->'policy' ? 'retentionDays' THEN c.overrides#>>'{policy,retentionDays}' ELSE g.config#>>'{policy,retentionDays}' END='0'`);
      await client.query("DELETE FROM v2_diagnostics WHERE created_at<now()-interval '30 days' OR expires_at<=now()");
      await client.query('DELETE FROM v2_posts WHERE expires_at<=now()');
      await client.query("DELETE FROM v2_sessions WHERE last_post<now()-interval '1 day'");
      await client.query('DELETE FROM v2_restrictions WHERE expires_at<=now()');
      await client.query("DELETE FROM v2_revisions WHERE created_at<=now()-interval '60 days'");
      await client.query("DELETE FROM v2_actions WHERE created_at<now()-interval '90 days'");
    });
  }
}
