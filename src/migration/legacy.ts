import { z } from 'zod';
import { configSchema, defaults, presetOverrides, resolveConfig, snowflake, type Config, type Overrides } from '../domain/config.js';
import type { Store } from '../infra/store.js';
import type { SecretBox } from '../infra/secrets.js';

export const mappingSchema = z.object({ channels: z.record(snowflake, snowflake), globalsGuild: snowflake.optional() }).strict();
export type Mapping = z.infer<typeof mappingSchema>;
export interface LegacyBundle {
  channels: Record<string, unknown>; guildSettings?: Record<string, unknown>;
  keywords?: unknown; domains?: unknown; thresholds?: unknown; bans?: Record<string, unknown>;
  anonymous?: Record<string, unknown>; users?: Record<string, unknown>;
  messages?: Record<string, unknown>;
}
interface LegacyChannel { guildId: string; channelId: string; overrides: Overrides; webhook: string; }
interface LegacyPost { guildId: string; channelId: string; messageId: string; userId: string; anonymousId: number;
  createdAt: Date; content: string; media: { url: string; name: string; kind: string }[]; webhook: string; expires: Date|string; }
interface Restriction { guildId: string; userId: string; expires: Date | null; }
export interface MigrationPlan {
  guilds: Map<string, Config>; channels: LegacyChannel[]; posts: LegacyPost[]; restrictions: Restriction[];
  counters: { channelId: string; counter: number; lastUser: string | null }[];
  sessions: { guildId: string; channelId: string; userId: string; anonymousId: number; avatar: number; lastPost: Date }[];
  warnings: string[]; skippedExpired: number;
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
const validId = (value: unknown): value is string => typeof value === 'string' && snowflake.safeParse(value).success;
function validWebhook(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { const url = new URL(value); return ['discord.com', 'discordapp.com'].includes(url.hostname) && url.protocol === 'https:' && /^\/api\/webhooks\/\d+\/[\w.-]+$/.test(url.pathname); }
  catch { return false; }
}

export function planLegacy(bundle: LegacyBundle, mappingInput: unknown, now = new Date()): MigrationPlan {
  const mapping = mappingSchema.parse(mappingInput);
  const plan: MigrationPlan = { guilds: new Map(), channels: [], posts: [], restrictions: [], counters: [], sessions: [], warnings: [], skippedExpired: 0 };
  for (const [channelId, raw] of Object.entries(bundle.channels)) {
    const guildId = mapping.channels[channelId];
    if (!validId(channelId) || !guildId) { plan.warnings.push(`チャンネル ${channelId}: サーバー対応がないため保留`); continue; }
    const channel = object(raw);
    if (!validWebhook(channel.webhook_url)) { plan.warnings.push(`チャンネル ${channelId}: 有効なWebhook資格情報がないため保留`); continue; }
    const base = structuredClone(defaults);
    const guild = object(bundle.guildSettings?.[guildId]);
    if (validId(guild.report_channel_id)) base.moderation.reportChannel = guild.report_channel_id;
    if (validId(guild.punish_log_channel_id)) base.moderation.logChannel = guild.punish_log_channel_id;
    if (mapping.globalsGuild === guildId) {
      base.policy.blockedWords = strings(bundle.keywords);
      base.policy.blockedDomains = strings(bundle.domains);
      const threshold = object(bundle.thresholds)[guildId] ?? object(bundle.thresholds).report;
      if (typeof threshold === 'number') base.moderation.reportThreshold = threshold;
    }
    configSchema.parse(base);
    plan.guilds.set(guildId, base);
    const overrides = presetOverrides(channel.channel_type === 'request' ? 'request' : 'chat');
    if (channel.mode === 'image' || channel.source === 'image') Object.assign(overrides, presetOverrides('image'));
    plan.channels.push({ guildId, channelId, overrides, webhook: channel.webhook_url });
    const state = object(bundle.anonymous?.[channelId]);
    if (typeof state.counter === 'number' && Number.isInteger(state.counter) && state.counter >= 0 && state.counter <= 1000)
      plan.counters.push({ channelId, counter: state.counter, lastUser: validId(state.last_user_id) ? state.last_user_id : null });
    if (channel.logging_enabled === false) plan.warnings.push(`チャンネル ${channelId}: 旧ログOFFとv2の本人確認保存の違いを確認してください`);
    if (channel.button_message_id) plan.warnings.push(`チャンネル ${channelId}: 旧案内は削除せず保持。切り替え時に新案内を設置してください`);
  }
  if (!mapping.globalsGuild && (strings(bundle.keywords).length || strings(bundle.domains).length || Object.keys(bundle.bans ?? {}).length))
    plan.warnings.push('旧共通の禁止語・禁止ドメイン・利用制限は、globalsGuild未指定のため保留します');
  for (const [userId, raw] of Object.entries(bundle.users ?? {})) {
    if (!validId(userId)) continue;
    for (const [channelId, entry] of Object.entries(object(raw))) {
      const channel = plan.channels.find(item => item.channelId === channelId);
      const session = object(entry);
      if (!channel || typeof session.timestamp !== 'string' || typeof session.anonymous_id !== 'number') continue;
      const lastPost = new Date(session.timestamp);
      if (!Number.isFinite(lastPost.getTime()) || lastPost > now || now.getTime() - lastPost.getTime() > 86_400_000) continue;
      const avatar = typeof session.avatar_url === 'string' ? Number(session.avatar_url.match(/\/avatars\/([0-5])\.png/)?.[1] ?? 0) : 0;
      if (!Number.isInteger(session.anonymous_id) || session.anonymous_id < 0 || session.anonymous_id > 1000) continue;
      plan.sessions.push({ guildId: channel.guildId, channelId, userId, anonymousId: session.anonymous_id, avatar, lastPost });
    }
  }
  for (const [messageId, raw] of Object.entries(bundle.messages ?? {})) {
    const message = object(raw); const channelId = String(message.channel_id ?? '');
    const channel = plan.channels.find(item => item.channelId === channelId);
    if (!channel || !validId(messageId) || !validId(message.user_id)) { plan.warnings.push(`投稿 ${messageId}: チャンネルまたは投稿者対応が不足しているため保留`); continue; }
    const dateValue = message.timestamp;
    if (typeof dateValue !== 'string' && !(dateValue instanceof Date)) { plan.warnings.push(`投稿 ${messageId}: 作成日時がないため保留`); continue; }
    const createdAt = new Date(dateValue);
    if (!Number.isFinite(createdAt.getTime()) || createdAt > now) { plan.warnings.push(`投稿 ${messageId}: 作成日時が不正のため保留`); continue; }
    const config = resolveConfig(plan.guilds.get(channel.guildId)!, channel.overrides);
    if(config.policy.retentionDays===0){plan.skippedExpired++;continue;}
    const expires = config.policy.retentionDays===null?'infinity':new Date(createdAt.getTime() + config.policy.retentionDays * 86_400_000);
    if (expires instanceof Date&&expires <= now) { plan.skippedExpired++; continue; }
    const attachment = typeof message.attachment_url === 'string' ? message.attachment_url : '';
    if (attachment && !/^https:\/\//.test(attachment)) { plan.warnings.push(`投稿 ${messageId}: 添付URLが不正のため保留`); continue; }
    const media = attachment ? [{ url: attachment, name: 'legacy_image', kind: 'image' }] : [];
    const anonymousId = typeof message.anonymous_id === 'number' && Number.isInteger(message.anonymous_id) ? message.anonymous_id : 0;
    plan.posts.push({ guildId: channel.guildId, channelId, messageId, userId: message.user_id, anonymousId, createdAt,
      content: typeof message.content === 'string' ? message.content : '', media, webhook: validWebhook(message.webhook_url) ? message.webhook_url : channel.webhook, expires });
  }
  if (mapping.globalsGuild) for (const [userId, raw] of Object.entries(bundle.bans ?? {})) {
    if (!validId(userId)) { plan.warnings.push('旧利用制限に不正なユーザーIDがあるため保留'); continue; }
    const value = object(raw).expires_at;
    const expires = typeof value === 'string' ? new Date(value) : null;
    if (expires && !Number.isFinite(expires.getTime())) { plan.warnings.push(`利用制限 ${userId}: 期限が不正のため保留`); continue; }
    if (expires && expires <= now) continue;
    plan.restrictions.push({ guildId: mapping.globalsGuild, userId, expires });
  }
  return plan;
}

export function migrationSummary(plan: MigrationPlan) {
  return { guilds: plan.guilds.size, channels: plan.channels.length, posts: plan.posts.length,
    counters: plan.counters.length, sessions: plan.sessions.length, restrictions: plan.restrictions.length,
    skippedExpired: plan.skippedExpired, warningCount: plan.warnings.length, warnings: plan.warnings.slice(0, 50) };
}

export async function applyLegacy(store: Store, box: SecretBox, plan: MigrationPlan): Promise<void> {
  await store.transaction(async client => {
    for (const channel of plan.channels) {
      const old = (await client.query('SELECT guild_id FROM v2_channels WHERE channel_id=$1', [channel.channelId])).rows[0];
      if (old && old.guild_id !== channel.guildId) throw new Error('移行先のチャンネルとサーバー対応が衝突しています。');
    }
    for (const [guildId, config] of plan.guilds)
      await client.query('INSERT INTO v2_guilds(guild_id,config) VALUES($1,$2) ON CONFLICT DO NOTHING', [guildId, config]);
    for (const channel of plan.channels) {
      await client.query('INSERT INTO v2_channels(guild_id,channel_id,overrides,webhook,enabled) VALUES($1,$2,$3,$4,false) ON CONFLICT DO NOTHING',
        [channel.guildId, channel.channelId, channel.overrides, box.seal(channel.webhook)]);
    }
    for (const post of plan.posts) {
      const operation = `legacy:${post.messageId}`;
      await client.query(`INSERT INTO v2_posts(operation_id,guild_id,channel_id,message_id,content,anonymous_id,avatar,status,media,expires_at,created_at,layout,legacy_webhook)
        VALUES($1,$2,$3,$4,$5,$6,0,'sent',$7,$8,$9,'legacy',$10) ON CONFLICT DO NOTHING`,
        [operation, post.guildId, post.channelId, post.messageId, post.content, post.anonymousId, JSON.stringify(post.media), post.expires, post.createdAt, box.seal(post.webhook)]);
      await client.query('INSERT INTO v2_authors(operation_id,user_id,expires_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [operation, post.userId, post.expires]);
    }
    for (const counter of plan.counters)
      await client.query('INSERT INTO v2_counters(channel_id,counter,last_user) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [counter.channelId, counter.counter, counter.lastUser]);
    for (const session of plan.sessions)
      await client.query('INSERT INTO v2_sessions(guild_id,channel_id,user_id,anonymous_id,avatar,last_post) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [session.guildId, session.channelId, session.userId, session.anonymousId, session.avatar, session.lastPost]);
    for (const restriction of plan.restrictions)
      await client.query("INSERT INTO v2_restrictions(guild_id,user_id,expires_at,reason) VALUES($1,$2,$3,'旧Botから移行') ON CONFLICT DO NOTHING", [restriction.guildId, restriction.userId, restriction.expires]);
  });
  for (const guildId of plan.guilds.keys()) store.invalidate(guildId);
}
