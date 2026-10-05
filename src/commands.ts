import { ApplicationCommandType, ContextMenuCommandBuilder, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

const guildCommand = (name: string, description: string) => new SlashCommandBuilder().setName(name).setDescription(description).setDMPermission(false);
export const commands = [
  guildCommand('setup', 'このチャンネルに匿名投稿を設置する').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(option => option.setName('mode').setDescription('投稿モード').setRequired(true).addChoices(
      { name: '匿名チャット', value: 'chat' }, { name: '匿名画像', value: 'image' }, { name: '画像アップロード専用', value: 'upload' }, { name: '匿名要望', value: 'request' })),
  guildCommand('settings', '案内・ルール・投稿方法をプレビューしながら設定する').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(option => option.setName('scope').setDescription('設定する範囲').addChoices({ name: 'このチャンネル', value: 'channel' }, { name: 'サーバー標準', value: 'guild' })),
  guildCommand('post', '匿名でメッセージを投稿する').addStringOption(option => option.setName('text').setDescription('本文').setRequired(true).setMaxLength(1800)),
  guildCommand('image', '匿名で画像を投稿する').addAttachmentOption(option => option.setName('file').setDescription('画像').setRequired(true))
    .addStringOption(option => option.setName('text').setDescription('説明文（任意）').setMaxLength(1800)),
  guildCommand('url', '公開URLから画像を取得して匿名投稿する').addStringOption(option => option.setName('link').setDescription('投稿または画像のURL').setRequired(true).setMaxLength(1000))
    .addStringOption(option => option.setName('text').setDescription('説明文（任意）').setMaxLength(1800)),
  guildCommand('mine', 'このチャンネルの自分の投稿を確認・編集・削除する'),
  guildCommand('reports', 'このチャンネルの未対応の通報を確認する').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  guildCommand('help', 'このチャンネルのルールと使い方を見る'),
  guildCommand('stop', 'このチャンネルの匿名投稿受付を停止する').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  ...['メッセージに返信', 'メッセージを編集', 'メッセージを削除', '匿名つぶやき通報', '埋め込みを編集（Admin）'].map(name => new ContextMenuCommandBuilder().setName(name).setType(ApplicationCommandType.Message).setDMPermission(false)),
].map(command => command.toJSON());
