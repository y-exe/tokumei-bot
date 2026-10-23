import 'dotenv/config';
import sharp from 'sharp';
import { Client, Events, GatewayIntentBits, Options } from 'discord.js';
import { App } from './app.js';
import { Store } from './infra/store.js';
import { SecretBox } from './infra/secrets.js';
import { SafeHttp, WorkQueue } from './media/http.js';
import { MediaService } from './media/service.js';
import { initializeSafety } from './media/safety.js';
import { initializeNudity } from './media/nudity.js';
import { initializeAnimeNudity } from './media/anime-nudity.js';
import { healthServer, heartbeat } from './infra/health.js';
import { uiEmoji } from './ui/components.js';
import { syncApplicationEmojis } from './ui/emoji-sync.js';
import { guardChannel } from './services/channel-guard.js';
import { lookupServer } from './infra/lookup.js';
import { commandRegistrationApi, registerGlobalCommands } from './infra/command-registration.js';
import { diagnosticDetails } from './infra/diagnostics.js';

const token = process.env.DISCORD_BOT_TOKEN ?? process.env.token;
const database = process.env.DATABASE_URL;
const key = process.env.ENCRYPTION_KEY;
if (!token || (!database && !process.env.PGHOST) || !key) throw new Error('Botトークン・PostgreSQL接続設定・ENCRYPTION_KEYを指定してください。');
const concurrency = Number(process.env.MEDIA_CONCURRENCY ?? 2);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('MEDIA_CONCURRENCYは1〜8を指定してください。');
sharp.cache(false);
sharp.concurrency(1);
const store = new Store(database);
const secrets = new SecretBox(key);
await store.initialize();
await initializeSafety();
await initializeNudity();
await initializeAnimeNudity();
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], makeCache: Options.cacheWithLimits({ ...Options.DefaultMakeCacheSettings, MessageManager: 0 }) });
const app = new App(client, store, secrets, new MediaService(new SafeHttp(), new WorkQueue(concurrency)));
const health = healthServer(client, store, Number(process.env.HEALTH_PORT ?? 3000));
const lookup = process.env.LOOKUP_TAILSCALE_ORIGIN ? lookupServer(store,client,process.env.LOOKUP_TAILSCALE_ORIGIN,(process.env.LOOKUP_ALLOWED_TAILSCALE_LOGINS??'').split(',').map(login=>login.trim()).filter(Boolean),Number(process.env.LOOKUP_PORT??8765)) : undefined;
client.on(Events.MessageCreate, message => {
  void guardChannel(message, store, app.panels).catch(() => console.error('匿名チャンネルの通常投稿を確認できませんでした。'));
});
client.on(Events.InteractionCreate, interaction => {
  void app.handle(interaction);
});
client.once(Events.ClientReady, async ready => {
  try {
    const result = await registerGlobalCommands(commandRegistrationApi(ready.rest, ready.application.id));
    console.info(`コマンド同期: ${result.updated ? `${result.registered}個を更新` : '変更なし'} / 重複削除 ${result.removed}個`);
  } catch (error) { console.error('コマンド自動同期に失敗しました。Botの起動を続けます。', diagnosticDetails(error)); }
  try {
    const result = await syncApplicationEmojis({
      list: async () => [...(await ready.application.emojis.fetch()).values()],
      create: (name, image) => ready.application.emojis.create({ name, attachment: image }),
    });
    Object.assign(uiEmoji, result.mappings);
    console.info(`案内用絵文字: 追加 ${result.created} / 再利用 ${result.reused}`);
    if (result.failed.length) console.error(`絵文字を追加できなかったため標準表示を使用します: ${result.failed.join('・')}`);
  } catch { console.error('案内用絵文字の同期に失敗したため標準表示を使用します。'); }
  await app.auditPanels().catch(() => console.error('起動時の案内確認に失敗しました。'));
  console.info(`匿名Bot v2 起動完了: ${ready.user.username}`);
});
await store.cleanup();
const cleanup = setInterval(() => {
  app.editors.sweep(); app.previews.sweep(); app.textRecoveries.sweep(); app.posting.sweep();
  void store.cleanup().catch(() => console.error('保存期限の削除処理に失敗しました。'));
  void app.retryReportNotices().catch(() => console.error('未通知の通報を確認できませんでした。'));
  void Promise.all([...new Set([process.env.WATCHER_PUSH_URL,process.env.WATCHER_IMAGE_PUSH_URL])]
    .map(url=>heartbeat(url,client.isReady()))).catch(() => console.error('監視への応答に失敗しました。'));
}, 60_000);
cleanup.unref();
async function shutdown(): Promise<void> { clearInterval(cleanup); health.close(); lookup?.close(); client.destroy(); await store.close(); }
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
await client.login(token);
