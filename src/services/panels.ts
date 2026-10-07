import { ChannelType, MessageFlags, type Client, type TextChannel } from 'discord.js';
import type { Store, ChannelSettings } from '../infra/store.js';
import { SerialQueue } from '../infra/serial.js';
import { UserError } from '../domain/errors.js';
import { panelPayload } from '../ui/components.js';

export class Panels {
  private queue = new SerialQueue();
  constructor(readonly client: Client, readonly store: Store) {}
  async bump(guildId: string, channelId: string): Promise<void> {
    return this.queue.run(`${guildId}:${channelId}`, 0, async () => {
      const settings = await this.store.settings(guildId, channelId, true);
      if (!settings.enabled || settings.config.panel.repost === false) return;
      const channel = await this.channel(guildId, channelId);
      if (!channel) throw new UserError('案内の再送先を確認できませんでした。');
      if (await this.isLatest(channel, settings.panelId)) return;
      await this.resend(channel, settings);
    });
  }
  async restore(guildId: string, channelId: string): Promise<void> {
    return this.queue.run(`${guildId}:${channelId}`, 0, async () => {
      const settings = await this.store.settings(guildId, channelId, true);
      if (!settings.enabled) return;
      const channel = await this.channel(guildId, channelId);
      if (!channel) return;
      const panel = await this.fetchPanel(channel, settings.panelId);
      if (panel) {
        if (await this.isLatest(channel, settings.panelId)) return;
        if (settings.config.panel.repost === false) return;
      }
      await this.resend(channel, settings);
    });
  }
  private async channel(guildId: string, channelId: string): Promise<TextChannel | null> {
    const channel = await this.client.channels.fetch(channelId).catch(() => undefined);
    if (!channel || channel.type !== ChannelType.GuildText || channel.guild.id !== guildId) return null;
    return channel;
  }
  private async fetchPanel(channel: TextChannel, panelId: string | null) {
    if (!panelId) return undefined;
    return channel.messages.fetch(panelId).catch(() => undefined);
  }
  private async isLatest(channel: TextChannel, panelId: string | null): Promise<boolean> {
    if (!panelId) return false;
    try { return (await channel.messages.fetch({ limit: 1 })).first()?.id === panelId; }
    catch { return false; }
  }
  private async resend(channel: TextChannel, settings: ChannelSettings): Promise<void> {
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
  }
}