import { AuditLogEvent, PermissionFlagsBits, type Client, type Guild, type User } from 'discord.js';
import type { Store } from './infra/store.js';
import type { Panels } from './services/panels.js';

const joinMessage = `
匿名チャットBotを追加ありがとう!
- \`/setup\` で匿名投稿を設置できます。機能とルールを選んで保存するだけで使えます。
- 使い方や設定の詳細は \`/help\` から確認できます。
- 匿名投稿への通報が一定数集まると、サーバー管理者へ通知します。`.trim();

export class Lifecycle {
  constructor(private client: Client, private store: Store, private panels: Panels) {}
  async join(guild: Guild): Promise<void> {
    await this.store.touchGuild(guild.id).catch(error => console.error('サーバー参加の記録に失敗しました。', error));
    const configured = await this.store.configuredChannels(guild.id);
    if (configured.length) for (const channelId of configured) await this.panels.restore(guild.id, channelId).catch(() => console.error(`再参加後の案内再送に失敗しました(チャンネル:${channelId})`));
    const inviter = await this.inviter(guild);
    const user = inviter ?? await guild.members.fetch(guild.ownerId).then(member => member.user).catch(async () => await this.client.users.fetch(guild.ownerId).catch(() => undefined));
    console.info(`サーバーに参加しました: ${guild.name} (${guild.id}) / ${configured.length ? '既存設置あり' : '設置なし'} / ${user ? `案内先:${user.id}` : '案内先なし'}`);
    if (!user) return;
    const text = configured.length ?
      `${guild.name}へ匿名チャットBotを追加しました!\n過去の設定はそのまま使えます。案内が消えている場合は /panel で再送できます。` : joinMessage;
    await user.send({ content: text }).catch(() => console.info(`参加案内のDMを送れませんでした(ユーザー:${user.id})`));
  }
  async leave(guild: Guild): Promise<void> {
    const removed = await this.store.markGuildLeft(guild.id).catch(error => { console.error('サーバー離脱の記録に失敗しました。', error); return false; });
    if (removed) console.info(`サーバーから離脱しました: ${guild.name} (${guild.id}) / 設定・投稿データは一定期間の削除を待機します`);
  }
  private async inviter(guild: Guild): Promise<User | undefined> {
    if (!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) return undefined;
    try {
      const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 25 });
      const entry = [...logs.entries.values()].find(entry => entry.targetId === this.client.user?.id);
      if (!entry?.executor) return undefined;
      return await this.client.users.fetch(entry.executor.id).catch(() => undefined);
    } catch { return undefined; }
  }
}
