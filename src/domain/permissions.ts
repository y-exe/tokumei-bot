type IdLoader = (url: string) => Promise<string>;

export class BotAdminDirectory {
  private id?: string;
  private validUntil = 0;
  private pending?: Promise<void>;
  constructor(private readonly url: string | undefined, private readonly load: IdLoader, private readonly now: () => number = Date.now) {
    if (url) {
      const source = new URL(url);
      if (source.protocol !== 'https:' || source.username || source.password || source.port && source.port !== '443') throw new Error('BOT_ADMIN_ID_URLには認証情報を含まないHTTPSのURLを設定してください。');
    }
  }
  has(userId: string): boolean { return this.now() < this.validUntil && this.id === userId; }
  refresh(): Promise<void> {
    if (!this.url) return Promise.resolve();
    return this.pending ??= Promise.resolve().then(() => this.load(this.url!)).then(value => {
      const id = value.trim();
      if (!/^[1-9]\d{16,19}$/.test(id) || BigInt(id) > 18446744073709551615n) throw new Error('Bot運営者IDの取得先はDiscordユーザーIDを1件だけ返す必要があります。');
      this.id = id; this.validUntil = this.now() + 120_000;
    }).finally(() => { this.pending = undefined; });
  }
}

let directory: BotAdminDirectory | undefined;
export async function initializeBotAdmins(url: string | undefined, load: IdLoader): Promise<void> {
  directory = new BotAdminDirectory(url?.trim() || undefined, load);
  await directory.refresh();
}
export async function refreshBotAdmins(): Promise<void> { await directory?.refresh(); }
export function isBotAdmin(userId: string): boolean { return directory?.has(userId) ?? false; }
