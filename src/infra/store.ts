import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { configSchema, defaults, overridesSchema, resolveConfig,isRequestMode, type Config, type Overrides } from '../domain/config.js';
import { UserError } from '../domain/errors.js';
import { nextAvatar } from '../domain/avatar.js';

export interface ChannelSettings {
  guildId: string; channelId: string; base: Config; overrides: Overrides; config: Config;
  guildVersion: number; channelVersion: number; enabled: boolean;
  panelId: string | null; webhook: string | null;
}
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
CREATE TABLE IF NOT EXISTS v2_guilds (
  guild_id text PRIMARY KEY, config jsonb NOT NULL, version integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS v2_channels (
  guild_id text NOT NULL REFERENCES v2_guilds(guild_id), channel_id text PRIMARY KEY,
  overrides jsonb NOT NULL DEFAULT '{}', version integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT false, panel_id text, webhook text
);
CREATE TABLE IF NOT EXISTS v2_revisions (
  id bigserial PRIMARY KEY, guild_id text NOT NULL, channel_id text, config jsonb NOT NULL,
  actor_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
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
CREATE TABLE IF NOT EXISTS v2_request_restrictions (
  guild_id text NOT NULL,user_id text NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(guild_id,user_id)
);
CREATE TABLE IF NOT EXISTS v2_actions (
  id bigserial PRIMARY KEY, guild_id text NOT NULL, actor_id text NOT NULL,
  action text NOT NULL, message_id text, created_at timestamptz NOT NULL DEFAULT now()
);`;

const reportRetrySchema = `
ALTER TABLE v2_posts ADD COLUMN IF NOT EXISTS video_links jsonb;
ALTER TABLE v2_reports ADD COLUMN IF NOT EXISTS notification_retry_at timestamptz;
ALTER TABLE v2_reports ADD COLUMN IF NOT EXISTS moderation_token text;
ALTER TABLE v2_actions ADD COLUMN IF NOT EXISTS reason text;
CREATE INDEX IF NOT EXISTS v2_posts_anonymous_reference ON v2_posts(guild_id,channel_id,anonymous_id,created_at DESC) WHERE status='sent';
CREATE INDEX IF NOT EXISTS v2_reports_pending ON v2_reports(notification_retry_at) WHERE status='open';`;

export class Store {
  readonly pool: Pool;
  private cache = new Map<string, { settings: ChannelSettings; expires: number }>();
  constructor(databaseUrl?: string) { this.pool = new Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 5000 }); }
  async initialize(): Promise<void> { await this.pool.query(schema); await this.pool.query(reportRetrySchema); }
  async close(): Promise<void> { await this.pool.end(); }
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
  async saveSettings(previous: ChannelSettings, scope: 'guild' | 'channel', value: Config | Overrides, actor: string): Promise<void> {
    const parsed = scope === 'guild' ? configSchema.parse(value) : overridesSchema.parse(value);
    await this.transaction(async client => {
      await client.query('INSERT INTO v2_guilds(guild_id,config) VALUES($1,$2) ON CONFLICT DO NOTHING', [previous.guildId, defaults]);
      const guild = (await client.query('SELECT version FROM v2_guilds WHERE guild_id=$1 FOR UPDATE', [previous.guildId])).rows[0];
      if (guild.version !== previous.guildVersion) throw new UserError('ほかの管理者がサーバー設定を変更しました。/settings から開き直してください。');
      if (scope === 'guild') {
        const channels = await client.query('SELECT overrides FROM v2_channels WHERE guild_id=$1', [previous.guildId]);
        for (const channel of channels.rows) resolveConfig(parsed as Config, channel.overrides);
        await client.query('INSERT INTO v2_revisions(guild_id,config,actor_id) SELECT guild_id,config,$2 FROM v2_guilds WHERE guild_id=$1', [previous.guildId, actor]);
        await client.query('UPDATE v2_guilds SET config=$2,version=version+1 WHERE guild_id=$1', [previous.guildId, parsed]);
      } else {
        await client.query('INSERT INTO v2_channels(guild_id,channel_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [previous.guildId, previous.channelId]);
        const channel = (await client.query('SELECT * FROM v2_channels WHERE guild_id=$1 AND channel_id=$2 FOR UPDATE', [previous.guildId, previous.channelId])).rows[0];
        if (!channel || channel.version !== previous.channelVersion) throw new UserError('このチャンネルの設定が更新されました。/settings から開き直してください。');
        resolveConfig(previous.base, parsed as Overrides);
        await client.query('INSERT INTO v2_revisions(guild_id,channel_id,config,actor_id) VALUES($1,$2,$3,$4)', [previous.guildId, previous.channelId, channel.overrides, actor]);
        await client.query('UPDATE v2_channels SET overrides=$3,version=version+1 WHERE guild_id=$1 AND channel_id=$2', [previous.guildId, previous.channelId, parsed]);
      }
      const base=(await client.query('SELECT config FROM v2_guilds WHERE guild_id=$1',[previous.guildId])).rows[0].config;
      const channels=(await client.query('SELECT channel_id,overrides FROM v2_channels WHERE guild_id=$1',[previous.guildId])).rows;
      for(const channel of channels){
        const policy=resolveConfig(base,channel.overrides).policy;
        if(policy.retentionDays===0){
          await client.query('DELETE FROM v2_posts WHERE channel_id=$1',[channel.channel_id]);
          await client.query('DELETE FROM v2_reports WHERE channel_id=$1',[channel.channel_id]);
          await client.query('DELETE FROM v2_sessions WHERE channel_id=$1',[channel.channel_id]);
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
  async setPanel(guildId: string, channelId: string, panelId: string, webhook: string): Promise<void> {
    await this.pool.query('UPDATE v2_channels SET panel_id=$3,webhook=$4,enabled=true WHERE guild_id=$1 AND channel_id=$2', [guildId, channelId, panelId, webhook]);
    this.invalidate(guildId);
  }
  async disable(guildId: string, channelId: string): Promise<void> {
    await this.pool.query('UPDATE v2_channels SET enabled=false WHERE guild_id=$1 AND channel_id=$2', [guildId, channelId]); this.invalidate(guildId);
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
      ) SELECT n.guild_id,n.channel_id,n.message_id,n.count,n.content,n.reason,n.nonce
      FROM notices n JOIN v2_guilds g ON g.guild_id=n.guild_id
      LEFT JOIN v2_channels c ON c.guild_id=n.guild_id AND c.channel_id=n.channel_id
      WHERE n.count >= COALESCE(c.overrides#>>'{moderation,reportThreshold}',g.config#>>'{moderation,reportThreshold}')::integer
        AND CASE WHEN c.overrides->'moderation' ? 'reportChannel'
          THEN c.overrides#>>'{moderation,reportChannel}' ELSE g.config#>>'{moderation,reportChannel}' END IS NOT NULL
      ORDER BY n.oldest LIMIT 20`, [guildId, messageId])).rows;
  }
  async reserve(input: { operationId: string; guildId: string; channelId: string; userId: string; text: string; source?: string; replyTo?: string; videoLinks?: string[] }, config: Config, deliveryWebhook?: string): Promise<StoredPost> {
    if(config.policy.retentionDays===0)throw new UserError('保存しない設定では投稿ログを作成できません。');
    return this.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`post:${input.guildId}:${input.channelId}`]);
      const guild=(await client.query('SELECT config FROM v2_guilds WHERE guild_id=$1 FOR SHARE',[input.guildId])).rows[0];
      if(guild){
        const channel=(await client.query('SELECT overrides FROM v2_channels WHERE channel_id=$1',[input.channelId])).rows[0];
        if(resolveConfig(guild.config,channel?.overrides??{}).policy.retentionDays===0)throw new UserError('保存しない設定では投稿ログを作成できません。');
      }
      const old = (await client.query('SELECT * FROM v2_posts WHERE operation_id=$1', [input.operationId])).rows[0];
      if (old) throw new UserError(old.status === 'sent' ? 'この投稿は送信済みです。' : 'この投稿は処理中か送信結果の確認中です。再送せず少しお待ちください。');
      const restriction = (await client.query('SELECT 1 FROM v2_restrictions WHERE guild_id=$1 AND user_id=$2 AND (expires_at IS NULL OR expires_at>now())', [input.guildId, input.userId])).rows[0];
      if (restriction) throw new UserError('このサーバーでは匿名投稿の利用が制限されています。');
      if(isRequestMode(config)&&(await client.query('SELECT 1 FROM v2_request_restrictions WHERE guild_id=$1 AND user_id=$2',[input.guildId,input.userId])).rowCount)throw new UserError('このサーバーでは匿名要望の使用権が剥奪されています。');
      const session = (await client.query('SELECT * FROM v2_sessions WHERE guild_id=$1 AND channel_id=$2 AND user_id=$3', [input.guildId, input.channelId, input.userId])).rows[0];
      const now = new Date();
      const age = session ? now.getTime() - new Date(session.last_post).getTime() : Infinity;
      if (age < config.policy.cooldown * 1000) throw new UserError(`連続投稿は${Math.ceil(config.policy.cooldown - age / 1000)}秒後にできます。`);
      await client.query('INSERT INTO v2_counters(channel_id) VALUES($1) ON CONFLICT DO NOTHING', [input.channelId]);
      const counter = (await client.query('SELECT * FROM v2_counters WHERE channel_id=$1', [input.channelId])).rows[0];
      const inherit = session && counter.last_user === input.userId && age < config.identity.minutes * 60_000;
      const anonymousId = inherit ? session.anonymous_id : counter.counter % 1000 + 1;
      const lastAvatar = counter.last_avatar ?? (await client.query('SELECT avatar FROM v2_sessions WHERE channel_id=$1 AND user_id=$2', [input.channelId, counter.last_user])).rows[0]?.avatar
        ?? (await client.query('SELECT avatar FROM v2_posts WHERE channel_id=$1 ORDER BY created_at DESC LIMIT 1', [input.channelId])).rows[0]?.avatar;
      const avatar = inherit ? session.avatar : nextAvatar(lastAvatar);
      await client.query('UPDATE v2_counters SET counter=$2,last_user=$3,last_avatar=$4 WHERE channel_id=$1', [input.channelId, inherit ? counter.counter : anonymousId, input.userId, avatar]);
      await client.query(`INSERT INTO v2_sessions VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(guild_id,channel_id,user_id)
        DO UPDATE SET anonymous_id=$4,avatar=$5,last_post=$6`, [input.guildId, input.channelId, input.userId, anonymousId, avatar, now]);
      const expires = config.policy.retentionDays===null?'infinity':new Date(now.getTime() + config.policy.retentionDays * 86_400_000);
      const row = (await client.query(`INSERT INTO v2_posts(operation_id,guild_id,channel_id,content,source,reply_to,anonymous_id,avatar,expires_at,delivery_webhook,layout,video_links)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'plain',$11::jsonb) RETURNING *`, [input.operationId, input.guildId, input.channelId, input.text, input.source ?? null, input.replyTo ?? null, anonymousId, avatar, expires, deliveryWebhook ?? null, JSON.stringify(input.videoLinks ?? [])])).rows[0];
      await client.query('INSERT INTO v2_authors VALUES($1,$2,$3)', [input.operationId, input.userId, expires]);
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
      ORDER BY p.created_at DESC LIMIT 20`, [guildId, channelId, userId])).rows;
  }
  async ownOperation(guildId: string, channelId: string, userId: string, operationId: string): Promise<StoredPost | null> {
    return (await this.pool.query(`SELECT p.* FROM v2_posts p JOIN v2_authors a USING(operation_id)
      WHERE p.guild_id=$1 AND p.channel_id=$2 AND a.user_id=$3 AND p.operation_id=$4
        AND a.expires_at>now() AND p.expires_at>now() AND p.status IN ('sending','uncertain','sent')`, [guildId,channelId,userId,operationId])).rows[0] ?? null;
  }
  async post(guildId: string, channelId: string, messageId: string): Promise<StoredPost | null> {
    const row = (await this.pool.query(`SELECT p.*, a.user_id FROM v2_posts p LEFT JOIN v2_authors a ON a.operation_id=p.operation_id AND a.expires_at>now()
      WHERE p.guild_id=$1 AND p.channel_id=$2 AND p.message_id=$3 AND p.expires_at>now() AND p.status='sent'`, [guildId, channelId, messageId])).rows[0];
    const post = row ? { ...row, videoLinks: Array.isArray(row.video_links) ? row.video_links : [] } : null;
    return post;
  }
  async ownPosts(guildId: string, channelId: string, userId: string): Promise<StoredPost[]> {
    return (await this.pool.query(`SELECT p.* FROM v2_posts p JOIN v2_authors a USING(operation_id)
      WHERE p.guild_id=$1 AND p.channel_id=$2 AND a.user_id=$3 AND a.expires_at>now() AND p.status='sent'
      ORDER BY p.created_at DESC LIMIT 20`, [guildId, channelId, userId])).rows;
  }
  async anonymousReferences(guildId:string,channelId:string,numbers:number[],before:Date):Promise<Map<number,string>>{
    if(!numbers.length)return new Map();
    const rows=(await this.pool.query(`SELECT DISTINCT ON(anonymous_id) anonymous_id,message_id FROM v2_posts
      WHERE guild_id=$1 AND channel_id=$2 AND anonymous_id=ANY($3::integer[]) AND status='sent' AND expires_at>now() AND created_at<$4 AND message_id IS NOT NULL
      ORDER BY anonymous_id,created_at DESC,message_id DESC`,[guildId,channelId,numbers,before])).rows;
    return new Map(rows.map(row=>[row.anonymous_id,row.message_id]));
  }
  async lookupAuthor(messageId: string): Promise<{user_id:string;guild_id:string;channel_id:string} | null> {
    return (await this.pool.query(`SELECT a.user_id,p.guild_id,p.channel_id FROM v2_posts p JOIN v2_authors a USING(operation_id)
      JOIN v2_channels c ON c.guild_id=p.guild_id AND c.channel_id=p.channel_id JOIN v2_guilds g ON g.guild_id=p.guild_id
      WHERE p.message_id=$1 AND p.status='sent' AND p.expires_at>now() AND a.expires_at>now()
        AND COALESCE(CASE WHEN c.overrides->'policy' ? 'retentionDays' THEN c.overrides#>>'{policy,retentionDays}' ELSE g.config#>>'{policy,retentionDays}' END,'infinity')<>'0'`,[messageId])).rows[0]??null;
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
    const result = await client.query(`INSERT INTO v2_reports(guild_id,channel_id,message_id,reporter_id,reason,evidence,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $7::integer IS NULL THEN 'infinity'::timestamptz ELSE now()+$7*interval '1 day' END) ON CONFLICT DO NOTHING RETURNING id`,
      [post.guild_id, post.channel_id, post.message_id, reporter, reason, JSON.stringify({ content: post.content, source: post.source, media: post.media, userId: post.user_id }), days]);
    if (!result.rowCount) throw new UserError('この投稿はすでに通報しています。');
    return (await client.query("SELECT count(*)::int AS count FROM v2_reports WHERE guild_id=$1 AND message_id=$2 AND status='open' AND expires_at>now()", [post.guild_id, post.message_id])).rows[0].count;
    });
  }
  async restrict(guildId: string, messageId: string, actor: string, hours: number): Promise<void> {
    await this.transaction(async client => {
      const report = (await client.query("SELECT evidence FROM v2_reports WHERE guild_id=$1 AND message_id=$2 AND status='open' AND expires_at>now() ORDER BY id LIMIT 1", [guildId, messageId])).rows[0];
      const userId = report?.evidence?.userId;
      if (!userId) throw new UserError('投稿者対応の保存期限が過ぎているため、利用停止できません。');
      await client.query(`INSERT INTO v2_restrictions VALUES($1,$2,now()+$3*interval '1 hour',$4)
        ON CONFLICT(guild_id,user_id) DO UPDATE SET expires_at=EXCLUDED.expires_at,reason=EXCLUDED.reason`, [guildId, userId, hours, '通報に基づく匿名機能の利用停止']);
      await client.query("INSERT INTO v2_actions(guild_id,actor_id,action,message_id) VALUES($1,$2,'restrict',$3)", [guildId, actor, messageId]);
      await client.query("UPDATE v2_reports SET status='resolved' WHERE guild_id=$1 AND message_id=$2", [guildId, messageId]);
    });
  }
  async reportDetail(guildId:string,channelId:string,messageId:string):Promise<ReportDetail|null>{
    const rows=(await this.pool.query(`SELECT reporter_id,reason,evidence,notification_id FROM v2_reports
      WHERE guild_id=$1 AND channel_id=$2 AND message_id=$3 AND status='open' AND expires_at>now() ORDER BY id`,[guildId,channelId,messageId])).rows;
    if(!rows.length)return null;
    const evidence=rows[0].evidence;const post=await this.post(guildId,channelId,messageId);
    return {guild_id:guildId,channel_id:channelId,message_id:messageId,count:rows.length,content:evidence.content??'',reason:rows.map(row=>row.reason).filter(reason=>reason.trim()).join('\n'),nonce:'',
      reporters:rows.map(row=>row.reporter_id),userId:evidence.userId??'',anonymousId:post?.anonymous_id??0,notificationId:rows[0].notification_id?.startsWith('pending:')?null:rows[0].notification_id??null};
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
      if(targetUser)await client.query('INSERT INTO v2_request_restrictions(guild_id,user_id,reason) VALUES($1,$2,$3) ON CONFLICT(guild_id,user_id) DO UPDATE SET reason=$3',[guildId,targetUser,reason]);
      const result=await client.query("UPDATE v2_reports SET status='resolved',moderation_token=NULL WHERE guild_id=$1 AND message_id=$2 AND moderation_token=$3 AND status='processing'",[guildId,messageId,token]);
      if(!result.rowCount)throw new UserError('処罰の実行後に通報履歴を更新できませんでした。再実行せず運用者へ確認してください。');
      await client.query('INSERT INTO v2_actions(guild_id,actor_id,action,message_id,reason) VALUES($1,$2,$3,$4,$5)',[guildId,actor,action,messageId,reason]);
    });
  }
  async resolveReport(guildId: string, messageId: string, actor: string): Promise<void> {
    await this.pool.query("UPDATE v2_reports SET status='resolved' WHERE guild_id=$1 AND message_id=$2", [guildId, messageId]);
    await this.pool.query("INSERT INTO v2_actions(guild_id,actor_id,action,message_id) VALUES($1,$2,'resolve',$3)", [guildId, actor, messageId]);
  }
  async previousSettings(guildId: string, channelId: string | null): Promise<Config | Overrides | null> {
    const row = (await this.pool.query('SELECT config FROM v2_revisions WHERE guild_id=$1 AND channel_id IS NOT DISTINCT FROM $2 ORDER BY id DESC LIMIT 1', [guildId, channelId])).rows[0];
    return row ? channelId ? overridesSchema.parse(row.config) : configSchema.parse(row.config) : null;
  }
  async openReports(guildId: string, channelId: string): Promise<{ message_id: string; reason: string; content: string; count: number }[]> {
    return (await this.pool.query(`SELECT message_id,max(reason) AS reason,max(evidence->>'content') AS content,count(*)::int AS count
      FROM v2_reports WHERE guild_id=$1 AND channel_id=$2 AND status='open' AND expires_at>now()
      GROUP BY message_id ORDER BY min(created_at) DESC LIMIT 20`, [guildId, channelId])).rows;
  }
  async cleanup(): Promise<void> {
    await this.transaction(async client => {
      await client.query('DELETE FROM v2_reports WHERE expires_at<=now()');
      await client.query('DELETE FROM v2_posts WHERE expires_at<=now()');
      await client.query("DELETE FROM v2_sessions WHERE last_post<now()-interval '1 day'");
      await client.query('DELETE FROM v2_restrictions WHERE expires_at<=now()');
      await client.query("DELETE FROM v2_revisions WHERE created_at<now()-interval '90 days'");
      await client.query("DELETE FROM v2_actions WHERE created_at<now()-interval '90 days'");
    });
  }
}
