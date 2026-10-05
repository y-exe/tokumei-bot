import { EmbedBuilder, PermissionFlagsBits, type Message } from 'discord.js';
import type { Store } from '../infra/store.js';
import { allowsDirectPosts } from '../domain/config.js';
import { colors, uiEmoji } from '../ui/components.js';
import type { Panels } from './panels.js';

export async function guardChannel(message: Message, store: Store, panels?: Pick<Panels,'bump'>): Promise<void> {
  if (!message.guildId || message.author.bot || message.webhookId) return;
  const settings = await store.settings(message.guildId, message.channelId);
  if (!settings.enabled) return;
  try {
    if (allowsDirectPosts(settings.config)) return;
    const member = message.member ?? await message.guild!.members.fetch(message.author.id);
    if (member.permissions.has(PermissionFlagsBits.ManageGuild) || member.roles.cache.some(role => settings.config.moderation.managerRoles.includes(role.id))) return;
    try { await message.delete(); }
    catch { console.error('匿名チャンネルの通常投稿を削除できませんでした。'); return; }
    const warning = new EmbedBuilder().setTitle(`${uiEmoji.error} メッセージを削除しました`).setColor(colors.danger)
      .setDescription(`匿名チャンネル <#${message.channelId}> では、通常のメッセージ送信はできません。\n必ず案内のボタンからメッセージを送信してください。`)
      .setImage('https://i.gyazo.com/d383abacd30bc6afda9b94227d2af790.png');
    if (message.content) warning.addFields({ name: '送信しようとしたメッセージ', value: message.content.slice(0, 1000) });
    await message.author.send({ embeds: [warning], allowedMentions: { parse: [] } }).catch(() => {
      console.error('通常投稿の削除通知をDMへ送信できませんでした。');
    });
  } finally {
    if(panels)await panels.bump(message.guildId,message.channelId).catch(()=>console.error('通常投稿後の案内再送に失敗しました。'));
  }
}
