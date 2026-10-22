import { ChannelType, type Channel, type TextChannel, type NewsChannel, type PublicThreadChannel, type PrivateThreadChannel, type ForumChannel, type MediaChannel } from 'discord.js';

export type PostingChannel = TextChannel | NewsChannel | PublicThreadChannel | PrivateThreadChannel;
export type WebhookParentChannel = TextChannel | NewsChannel | ForumChannel | MediaChannel;

export function isWebhookParentChannel(channel: Channel | null | undefined): channel is WebhookParentChannel {
  return !!channel && [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia].includes(channel.type);
}

export function isPostingChannel(channel: Channel | null | undefined): channel is PostingChannel {
  return !!channel && [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread,
    ChannelType.PrivateThread, ChannelType.AnnouncementThread].includes(channel.type);
}
