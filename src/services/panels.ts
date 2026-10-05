import { ChannelType, MessageFlags, type Client } from 'discord.js';
import type { Store } from '../infra/store.js';
import { SerialQueue } from '../infra/serial.js';
import { UserError } from '../domain/errors.js';
import { panelPayload } from '../ui/components.js';

export class Panels {
  private queue = new SerialQueue();
  constructor(readonly client: Client, readonly store: Store) {}
  async bump(guildId: string, channelId: string): Promise<void> {
    return this.queue.run(`${guildId}:${channelId}`, 0, async () => {
      const settings = await this.store.settings(guildId,channelId,true);
      if (!settings.enabled || settings.config.panel.repost === false) return;
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || channel.type !== ChannelType.GuildText || channel.guild.id !== guildId) throw new UserError('案内の再送先を確認できませんでした。');
      const sent = await channel.send({ ...panelPayload(settings.config), flags: MessageFlags.IsComponentsV2 | MessageFlags.SuppressNotifications });
      let replaced: boolean;
      try { replaced = await this.store.replacePanel(settings, sent.id); }
      catch (error) { await sent.delete().catch(() => undefined); throw error; }
      if (!replaced) {
        await sent.delete().catch(() => undefined);
        throw new UserError('案内の設定が更新されたため、再送を取り消しました。');
      }
      if (settings.panelId) {
        try { await channel.messages.delete(settings.panelId); }
        catch (error) {
          if (!(typeof error === 'object' && error && 'code' in error && error.code === 10008)) throw new UserError('新しい案内は再送しましたが、古い案内を削除できませんでした。');
        }
      }
    });
  }
}
