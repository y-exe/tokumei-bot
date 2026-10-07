import { z } from 'zod';
import { UserError } from './errors.js';

export const snowflake = z.string().regex(/^\d{17,20}$/, 'DiscordのIDを指定してください。');
const publicUrl = z.string().max(1000).refine(value => {
  if (!value) return true;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }
  catch { return false; }
}, 'https:// で始まるURLを指定してください。');
const label = z.string().min(1).max(40);
const buttonStyle = z.enum(['primary','secondary','success','danger']);
const buttonEmoji = z.string().max(100).refine(value => !value || /^<a?:\w+:\d{17,20}>$/.test(value) || (/\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u.test(value) && [...new Intl.Segmenter('ja',{granularity:'grapheme'}).segment(value)].length===1), '絵文字を1つ指定してください。');
export const panelSchema = z.object({
  title: z.string().min(1).max(100), description: z.string().max(1500),
  color: z.number().int().min(0).max(0xffffff),
  style: z.enum(['v2', 'embed']).optional(), repost: z.boolean().optional(),
  metadata: z.boolean().optional(), urlButton: z.boolean().optional(), urlAutoLabel: z.boolean().optional(),
  textStyle:buttonStyle.optional(),imageStyle:buttonStyle.optional(),urlStyle:buttonStyle.optional(),helpStyle:buttonStyle.optional(),
  textEmoji:buttonEmoji.optional(),imageEmoji:buttonEmoji.optional(),urlEmoji:buttonEmoji.optional(),helpEmoji:buttonEmoji.optional(),
  image: publicUrl, thumbnail: publicUrl, footer: z.string().max(200),
  textLabel: label, imageLabel: label, urlLabel: label, helpLabel: label,
}).strict();
export const contentSchema = z.object({
  text: z.boolean(), images: z.boolean(), urls: z.boolean(), caption: z.boolean(),
  animation: z.boolean(), video: z.boolean(),
  maxFiles: z.number().int().min(1).max(10),
  maxFileMB: z.number().int().min(1).max(25),
  providers: z.array(z.enum(['x', 'pixiv', 'direct', 'bluesky', 'mastodon', 'misskey'])).max(6),
}).strict();
export const identitySchema = z.object({ showId: z.boolean(), minutes: z.number().int().min(0).max(1440), kind:z.enum(['chat','request']).optional() }).strict();
export const policySchema = z.object({
  rules: z.string().max(2500), rulesUrl: publicUrl,
  cooldown: z.number().int().min(0).max(3600),
  blockedWords: z.array(z.string().min(1).max(100)).max(200),
  blockedDomains: z.array(z.string().regex(/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i)).max(200),
  allowedRoles: z.array(snowflake).max(20),
  retentionDays: z.number().int().min(0).max(90).nullable(),
  reportRetentionDays: z.number().int().min(0).max(180).nullable(),
}).strict();
export const moderationSchema = z.object({
  allowDirectPosts: z.boolean().optional(),
  managerRoles: z.array(snowflake).max(20), reportChannel: snowflake.nullable(),
  logChannel: snowflake.nullable(), reportThreshold: z.number().int().min(1).max(50),
}).strict();
export const configSchema = z.object({
  panel: panelSchema, content: contentSchema, identity: identitySchema,
  policy: policySchema, moderation: moderationSchema,
}).strict().superRefine((config, ctx) => {
  if (!config.content.text && !config.content.images)
    ctx.addIssue({ code: 'custom', path: ['content'], message: 'テキストか画像のどちらかを有効にしてください。' });
  if (config.content.urls && !config.content.images)
    ctx.addIssue({ code: 'custom', path: ['content', 'urls'], message: 'URL変換には画像投稿を有効にしてください。' });
});
export const overridesSchema = z.object({
  panel: panelSchema.partial().optional(), content: contentSchema.partial().optional(),
  identity: identitySchema.partial().optional(), policy: policySchema.partial().optional(),
  moderation: moderationSchema.partial().optional(),
}).strict();
export type Config = z.infer<typeof configSchema>;
export type Overrides = z.infer<typeof overridesSchema>;
export type Provider = Config['content']['providers'][number];
export function allowsDirectPosts(config: Config): boolean { return config.moderation.allowDirectPosts ?? !config.identity.showId; }
export function isRequestMode(config:Config):boolean{return config.identity.kind?config.identity.kind==='request':!config.identity.showId;}
export function retentionLabel(days: number|null): string { return days===null?'無期限':days===0?'保存しない':`${days}日`; }
export function parseRetention(value: string): number|null {
  if (/^(無限|無期限|infinity)$/i.test(value.trim()))return null;
  if(!/^\d+$/.test(value.trim()))throw new UserError('保存期間は0、日数、または「無期限」を指定してください。');
  return Number(value.trim());
}
const providerNames: Record<Provider,string> = {x:'X',pixiv:'Pixiv',bluesky:'Bluesky',mastodon:'Mastodon',misskey:'Misskey',direct:'画像URL'};
export function automaticUrlLabel(config: Config): boolean {
  return config.panel.urlAutoLabel ?? ['URLから画像','URLから画像を送る'].includes(config.panel.urlLabel);
}
export function urlMethodLabel(config: Config): string {
  const names = (['x','pixiv','bluesky','mastodon','misskey','direct'] as const).filter(provider=>config.content.providers.includes(provider)).map(provider=>providerNames[provider]);
  if (!names.length) return '対応URLなし';
  const base = names.join('・');
  const suffix = names.at(-1)==='画像URL' ? '' : 'のURL';
  return base.length + suffix.length <= 45 ? `${base}${suffix}` : base;
}
export const presetNames = { chat: '匿名チャット', image: '匿名画像', upload: '画像アップロード専用', request: '匿名要望' } as const;
export type Preset = keyof typeof presetNames;

export const defaults: Config = {
  panel: { title: '匿名チャット', description: '名前を表示せずに投稿できます。', color: 0x2ca6a4, style: 'v2', repost: true,
    image: '', thumbnail: '', footer: '', textLabel: '投稿する', imageLabel: '画像を送る', urlLabel: 'URLから画像', helpLabel: 'ルール・使い方' },
  content: { text: true, images: true, urls: true, caption: true, animation: false, video: false,
    maxFiles: 5, maxFileMB: 10, providers: ['x', 'pixiv', 'direct', 'bluesky', 'mastodon', 'misskey'] },
  identity: { showId: true, minutes: 20, kind:'chat' },
  policy: { rules: '個人への攻撃や個人情報の投稿は禁止です。サーバーのルールに従ってご利用ください。',
    rulesUrl: '', cooldown: 5, blockedWords: [], blockedDomains: [], allowedRoles: [], retentionDays: null, reportRetentionDays: null },
  moderation: { managerRoles: [], reportChannel: null, logChannel: null, reportThreshold: 3, allowDirectPosts: false },
};

export function resolveConfig(base: Config, overrides: Overrides): Config {
  const result = Object.fromEntries(Object.entries(base).map(([key, value]) =>
    [key, { ...value, ...overrides[key as keyof Overrides] }]));
  return configSchema.parse(result);
}

export function presetOverrides(preset: Preset): Overrides {
  const content = { ...defaults.content };
  if (preset === 'image' || preset === 'upload') content.text = false;
  if (preset === 'upload') { content.urls = false; content.caption = false; }
  if (preset === 'request') content.urls = false;
  return { panel: { title: presetNames[preset] }, content, identity: { ...defaults.identity, showId: preset !== 'request',kind:preset==='request'?'request':'chat' }, moderation: { allowDirectPosts: preset === 'request' } };
}

export function importTemplate(input: unknown, base: Config): Overrides {
  const template = z.object({ version: z.literal(1), settings: overridesSchema }).strict().parse(input);
  resolveConfig(base, template.settings);
  return template.settings;
}

export function exportTemplate(settings: Overrides): string {
  return JSON.stringify({ version: 1, settings: overridesSchema.parse(settings) }, null, 2);
}
