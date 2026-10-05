import {
  ActionRowBuilder, AttachmentBuilder, ButtonStyle, ChannelType, ContainerBuilder, GuildMember,
  MessageFlags, ModalBuilder, PermissionFlagsBits, StringSelectMenuBuilder, ComponentType,
  type Client, type Interaction, type RepliableInteraction, type TextChannel, type ModalSubmitInteraction,
} from 'discord.js';
import { ZodError } from 'zod';
import { defaults, exportTemplate, importTemplate, presetOverrides, resolveConfig, parseRetention, allowsDirectPosts,isRequestMode, type Config, type Preset } from './domain/config.js';
import { UserError, errorMessage } from './domain/errors.js';
import { validateText, type PostInput } from './domain/validation.js';
import type { Store, ReportNotice } from './infra/store.js';
import type { SecretBox } from './infra/secrets.js';
import type { MediaService } from './media/service.js';
import { Posting } from './services/posting.js';
import { Panels } from './services/panels.js';
import { button, card, colors, help, panelPayload, payload, row, text } from './ui/components.js';
import { editSection, editorConfig, editorModal, editorView, managementView, buttonSettingsView, type EditorSession } from './ui/editor.js';
import { input, postModal } from './ui/modals.js';
import { previewView, type PreviewSession } from './ui/post.js';
import { Sessions } from './ui/sessions.js';
import {reportView} from './ui/report.js';
import {Moderation,punishmentLabels,type Punishment} from './services/moderation.js';

const emptyMentions = { parse: [] as ('users' | 'roles' | 'everyone')[] };
type UIInteraction = RepliableInteraction;

export class App {
  private retryingReports = false;
  readonly posting: Posting;
  readonly panels: Panels;
  readonly moderation:Moderation;
  readonly editors = new Sessions<EditorSession>();
  readonly previews = new Sessions<PreviewSession>(10 * 60_000, Number.POSITIVE_INFINITY);
  constructor(readonly client: Client, readonly store: Store, readonly secrets: SecretBox, readonly media: MediaService) {
    this.posting = new Posting(store, secrets);
    this.panels = new Panels(client,store);
    this.moderation=new Moderation(store,this.posting);
  }
  roles(interaction: UIInteraction): string[] {
    return interaction.member instanceof GuildMember ? [...interaction.member.roles.cache.keys()] : interaction.member?.roles ?? [];
  }
  async requireManager(interaction: UIInteraction, channelId = interaction.channelId!): Promise<void> {
    const settings = await this.store.settings(interaction.guildId!, channelId, true);
    if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) || this.roles(interaction).some(role => settings.config.moderation.managerRoles.includes(role))) return;
    throw new UserError('サーバー管理権限、または設定された管理ロールが必要です。');
  }
  async channel(guildId: string, channelId: string): Promise<TextChannel> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText || channel.guild.id !== guildId) throw new UserError('サーバー内のテキストチャンネルで操作してください。');
    return channel;
  }
  async respond(interaction: UIInteraction, components: ContainerBuilder[]): Promise<void> {
    if (interaction.deferred || interaction.replied) await interaction.editReply({ components, flags: MessageFlags.IsComponentsV2, allowedMentions: emptyMentions });
    else await interaction.reply(payload(components));
  }
  async handle(interaction: Interaction): Promise<void> {
    if (!interaction.isRepliable()) return;
    try {
      if (!interaction.guildId || !interaction.channelId) throw new UserError('サーバーのテキストチャンネルで操作してください。');
      if (interaction.isChatInputCommand()) await this.command(interaction);
      else if (interaction.isMessageContextMenuCommand()) await this.context(interaction);
      else if (interaction.isModalSubmit()) await this.modal(interaction);
      else if (interaction.isButton() || interaction.isAnySelectMenu()) await this.component(interaction);
    } catch (error) {
      let message = errorMessage(error);
      if (error instanceof ZodError) message = error.issues.map(issue => issue.message).slice(0, 3).join('\n');
      if (!(error instanceof UserError) && !(error instanceof ZodError)) {
        console.error('interaction failed', { kind: error instanceof Error ? error.name : 'unknown', interactionId: interaction.id });
      }
      if (interaction.replied && !interaction.deferred) await interaction.followUp(payload([card('操作を確認してください', message, colors.danger)])).catch(() => undefined);
      else await this.respond(interaction, [card('操作を確認してください', message, colors.danger)]).catch(() => undefined);
    }
  }
  async command(interaction: import('discord.js').ChatInputCommandInteraction): Promise<void> {
    const settings = await this.store.settings(interaction.guildId!, interaction.channelId!);
    switch (interaction.commandName) {
      case 'setup':
      case 'settings': {
        await this.requireManager(interaction);
        const setup = interaction.commandName === 'setup';
        const scope = setup ? 'channel' : interaction.options.getString('scope') === 'guild' ? 'guild' : 'channel';
        const value = setup ? presetOverrides(interaction.options.getString('mode', true) as Preset) : scope === 'guild' ? settings.base : settings.overrides;
        const session: EditorSession = { owner: interaction.user.id, guildId: interaction.guildId!, channelId: interaction.channelId!, original: settings, scope, value: structuredClone(value), installing: setup };
        const id = this.editors.create(session);
        await this.respond(interaction, editorView(id, session)); return;
      }
      case 'help': await this.respond(interaction, [help(settings.config)]); return;
      case 'stop': {
        await this.requireManager(interaction);
        await this.store.disable(interaction.guildId!, interaction.channelId!);
        const channel = await this.channel(interaction.guildId!, interaction.channelId!);
        if (settings.panelId) await channel.messages.edit(settings.panelId, { content:null,embeds:[], components: [card('匿名投稿は停止中です', '管理者が受付を再開するまで投稿できません。', colors.warning)], flags: MessageFlags.IsComponentsV2 }).catch(() => undefined);
        await this.respond(interaction, [card('受付を停止しました', '過去の投稿の本人操作は引き続き利用できます。再開は /setup から行えます。', colors.success)]); return;
      }
      case 'mine': await this.mine(interaction); return;
      case 'reports': {
        await this.requireManager(interaction);
        const reports = await this.store.openReports(interaction.guildId!, interaction.channelId!);
        const view = card('未対応の通報', reports.length ? '確認する通報を選んでください。投稿者の実名は表示しません。' : '未対応の通報はありません。', reports.length ? colors.warning : colors.info);
        if (reports.length) view.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
          .setCustomId('reports:select').setPlaceholder('通報を選ぶ').addOptions(reports.map(report => ({ label: `${report.count}件 · ${report.content.slice(0, 60) || '画像投稿'}`, description: report.reason.trim().slice(0, 80) || '理由の記載なし', value: report.message_id })))));
        await this.respond(interaction, [view]); return;
      }
      case 'post': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await this.send(interaction, interaction.options.getString('text', true), []); return;
      }
      case 'image': {
        if (!settings.enabled || !settings.config.content.images) throw new UserError('このチャンネルでは画像投稿を利用できません。');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const attachment = interaction.options.getAttachment('file') ?? interaction.options.getAttachment('attachment');
        if (!attachment) throw new UserError('投稿する画像を添付してください。');
        const files = await this.media.attachments([attachment.url], settings.config);
        await this.send(interaction, interaction.options.getString('text') ?? interaction.options.getString('content') ?? '', files); return;
      }
      case 'url': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await this.prepareUrl(interaction, interaction.options.getString('link', true), interaction.options.getString('text') ?? ''); return;
      }
    }
  }
  async send(interaction: UIInteraction, content: string, media: PostInput['media'], source?: string, replyTo?: string): Promise<void> {
    const link = await this.posting.publish({ operationId: interaction.id, guildId: interaction.guildId!, channelId: interaction.channelId!,
      userId: interaction.user.id, roles: this.roles(interaction), text: content, media, source, replyTo });
    let notice = '';
    try { await this.panels.bump(interaction.guildId!, interaction.channelId!); }
    catch { notice = '\n案内の再送に失敗しました。投稿は送信済みです。管理者に案内の権限を確認してもらってください。'; }
    if (notice) await this.respond(interaction, [card('案内を確認してください', `[投稿を開く](${link})${notice}`, colors.warning)]);
    else await interaction.deleteReply().catch(() => console.error('投稿済みの操作画面を閉じられませんでした。'));
  }
  async prepareUrl(interaction: UIInteraction, url: string, content: string): Promise<void> {
    const settings = await this.store.settings(interaction.guildId!, interaction.channelId!, true);
    if (!settings.enabled) throw new UserError('このチャンネルには匿名投稿が設置されていません。');
    validateText(url, settings.config); validateText(content, settings.config);
    if (!settings.config.content.caption && content.trim()) throw new UserError('このチャンネルでは画像に説明文を付けられません。');
    const result = await this.media.fromUrl(url, settings.config);
    const session: PreviewSession = { owner: interaction.user.id, guildId: interaction.guildId!, channelId: interaction.channelId!,
      files: result.files, source: result.source, text: content, warnings: result.warnings, selected: result.files.map((_, index) => index), sending: false };
    const id = this.previews.create(session, result.files.reduce((sum, file) => sum + file.data.length, 0));
    await interaction.editReply({ ...payload(previewView(id, session, settings.config.content.caption)), flags: MessageFlags.IsComponentsV2,
      files: session.files.map(file => new AttachmentBuilder(file.data, { name: file.name })) });
  }
  async component(interaction: import('discord.js').ButtonInteraction | import('discord.js').AnySelectMenuInteraction): Promise<void> {
    const [prefix, id, action] = interaction.customId.split(':');
    if (prefix === 'post') {
      const settings = await this.store.settings(interaction.guildId!, interaction.channelId!, true);
      if (id === 'help') { await this.respond(interaction, [help(settings.config)]); return; }
      if (!settings.enabled) throw new UserError('このチャンネルの匿名投稿は現在停止しています。');
      if (id !== 'text' && id !== 'image' && id !== 'url') return;
      if (!settings.config.content[id === 'image' ? 'images' : id === 'url' ? 'urls' : 'text']) throw new UserError('この投稿方法は現在無効です。');
      await interaction.showModal(postModal(id, settings.config)); return;
    }
    if (prefix === 'cfg' && id && action) { await this.configure(interaction, id, action); return; }
    if (prefix === 'preview' && id && action) {
      const session = this.previews.get(id, interaction.user.id, interaction.guildId!);
      if (session.sending) throw new UserError('この投稿は送信処理中です。');
      if (action === 'select' && interaction.isStringSelectMenu()) {
        session.selected = interaction.values.map(Number).filter(index => Number.isInteger(index) && index >= 0 && index < session.files.length);
        const settings = await this.store.settings(session.guildId, session.channelId,true);
        await interaction.update({ components: previewView(id, session, settings.config.content.caption), allowedMentions: emptyMentions }); return;
      }
      if (action === 'cancel') {
        this.previews.delete(id); await interaction.update({ components: [card('投稿をキャンセルしました', '画像は公開されていません。')], attachments: [] }); return;
      }
      if (action === 'edit') {
        const settings = await this.store.settings(session.guildId, session.channelId);
        if (!settings.config.content.caption) throw new UserError('このチャンネルでは説明文を付けられません。');
        await interaction.showModal(new ModalBuilder().setCustomId(`caption:${id}`).setTitle('説明文を変更').addLabelComponents(input('text', '説明文（任意）', session.text, 1800, true, false))); return;
      }
      if (action === 'send') {
        session.sending = true;
        await interaction.deferUpdate();
        try { await this.send(interaction, session.text, session.selected.map(index => session.files[index]!), session.source); this.previews.delete(id); }
        catch (error) { session.sending = false; throw error; }
        return;
      }
    }
    if (prefix === 'recover' && interaction.isStringSelectMenu()) {
      await interaction.deferUpdate();
      const link = await this.posting.reconcile(interaction.guildId!, interaction.channelId!, interaction.user.id, interaction.values[0]!);
      await this.respond(interaction, [card('送信を確認しました', `[投稿を開く](${link})\n/mine から編集・削除できます。`, colors.success)]);
      return;
    }
    if (prefix === 'own' && id && action) {
      const post = await this.posting.own(interaction.guildId!, interaction.channelId!, id, interaction.user.id);
      if (action === 'delete') {
        const confirm = card('この投稿を削除しますか？', '公開中の投稿を削除します。すでに通報された内容は保存期限まで保持されます。', colors.warning);
        confirm.addActionRowComponents(row(button(`own:${id}:confirm`, '削除する', ButtonStyle.Danger), button(`own:${id}:cancel`, 'キャンセル')));
        await this.respond(interaction, [confirm]); return;
      }
      if (action === 'confirm') { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); await this.posting.remove(interaction.guildId!, interaction.channelId!, id, interaction.user.id); await this.respond(interaction, [card('削除しました', '投稿は公開チャンネルから削除されました。', colors.success)]); return; }
      if (action === 'edit') {
        const settings=await this.store.settings(interaction.guildId!,interaction.channelId!,true);
        if(post.media.length&&!settings.config.content.caption)throw new UserError('このチャンネルでは画像に説明文を付けられません。');
        await interaction.showModal(new ModalBuilder().setCustomId(`selfedit:${id}`).setTitle('自分の投稿を編集').addLabelComponents(input('text', '本文', post.content, post.layout === 'legacy' ? 2000 : 1800, true, false))); return;
      }
      if (action === 'cancel') { await this.respond(interaction, [card('キャンセルしました', '投稿は変更されていません。')]); return; }
    }
    if (prefix === 'mine' && interaction.isStringSelectMenu()) {
      const message = interaction.values[0]!;
      const post = await this.posting.own(interaction.guildId!, interaction.channelId!, message, interaction.user.id);
      const result = card('自分の投稿', `${post.content.slice(0, 1000) || '画像投稿'}\n[投稿を開く](https://discord.com/channels/${interaction.guildId}/${interaction.channelId}/${message})`);
      const settings=await this.store.settings(interaction.guildId!,interaction.channelId!,true);
      result.addActionRowComponents(row(...(post.media.length&&!settings.config.content.caption?[]:[button(`own:${message}:edit`, '編集')]), button(`own:${message}:delete`, '削除', ButtonStyle.Danger)));
      await interaction.update({ components: [result], allowedMentions: emptyMentions }); return;
    }
    if (prefix === 'reports' && interaction.isStringSelectMenu()) {
      await this.requireManager(interaction);
      const report = (await this.store.openReports(interaction.guildId!, interaction.channelId!)).find(item => item.message_id === interaction.values[0]);
      if (!report) throw new UserError('この通報は対応済みか保存期限を過ぎています。');
      const detail=await this.store.reportDetail(interaction.guildId!,interaction.channelId!,report.message_id);
      if(!detail)throw new UserError('この通報は対応済みか保存期限を過ぎています。');
      const settings=await this.store.settings(interaction.guildId!,interaction.channelId!,true);
      const view=reportView(detail,isRequestMode(settings.config));
      await interaction.update({ components: [view], allowedMentions: emptyMentions }); return;
    }
    if(prefix==='punish'&&id&&action){
      const channelId=interaction.customId.split(':')[3]!;await this.requireManager(interaction,channelId);
      if(!Object.hasOwn(punishmentLabels,action))throw new UserError('処罰操作を確認してください。');
      await interaction.showModal(new ModalBuilder().setCustomId(`punishconfirm:${id}:${action}:${channelId}`).setTitle(`${punishmentLabels[action as Punishment]}を実行しますか？`).addLabelComponents(input('reason','理由（任意・確定すると実行します）','',500,true,false)));return;
    }
    if ((prefix === 'mod' || prefix === 'moderate') && id && action) {
      const targetChannel = interaction.customId.split(':')[3]!;
      await this.requireManager(interaction, targetChannel);
      if (prefix === 'mod' && action !== 'resolve') {
        const view = card(action === 'delete' ? '投稿を削除しますか？' : '匿名機能を利用停止にしますか？', action === 'delete' ? '公開投稿を削除します。通報された証拠は保存期限まで保持します。' : 'このサーバーの匿名投稿を24時間利用停止にします。サーバーのBANやタイムアウトは実行しません。', colors.warning);
        view.addActionRowComponents(row(button(`moderate:${id}:${action}:${targetChannel}`, '実行する', ButtonStyle.Danger), button(`dismiss:confirm`, 'キャンセル')));
        await this.respond(interaction, [view]); return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (action === 'delete') { await this.posting.remove(interaction.guildId!, targetChannel, id); await this.store.resolveReport(interaction.guildId!, id, interaction.user.id); }
      else if (action === 'restrict') await this.store.restrict(interaction.guildId!, id, interaction.user.id, 24);
      else if (action === 'resolve') await this.store.resolveReport(interaction.guildId!, id, interaction.user.id);
      else return;
      await this.respond(interaction, [card('対応を記録しました', action === 'restrict' ? 'このサーバーの匿名機能を24時間利用停止にしました。' : action === 'delete' ? '投稿を削除しました。' : '通報を対応済みにしました。', colors.success)]);
      const settings = await this.store.settings(interaction.guildId!, targetChannel);
      if (settings.config.moderation.logChannel) {
        const channel = await this.channel(interaction.guildId!, settings.config.moderation.logChannel);
        await channel.send(payload([card('匿名投稿の対応', `操作: ${action}\n担当: <@${interaction.user.id}>\n投稿ID: ${id}`)], false));
      }
    }
    if (prefix === 'dismiss') { await this.respond(interaction, [card('キャンセルしました', '処置は実行されていません。')]); return; }
  }
  async configure(interaction: import('discord.js').ButtonInteraction | import('discord.js').AnySelectMenuInteraction, id: string, action: string): Promise<void> {
    const session = this.editors.get(id, interaction.user.id, interaction.guildId!);
    await this.requireManager(interaction, session.channelId);
    if (session.scope === 'guild' && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new UserError('サーバー標準の変更にはサーバー管理権限が必要です。');
    if (action === 'save') {
      await interaction.deferUpdate();
      await this.saveEditor(interaction, id, session); return;
    }
    if (action === 'cancel') { this.editors.delete(id); await interaction.update({ components: [card('設定をキャンセルしました', '公開中の設定は変更されていません。')] }); return; }
    if (action === 'reset') session.value = session.scope === 'guild' ? structuredClone(defaults) : {};
    else if (action === 'restore') {
      const previous = await this.store.previousSettings(session.guildId, session.scope === 'guild' ? null : session.channelId);
      if (!previous) throw new UserError('復元できる過去の設定がありません。');
      editorConfig({ ...session, value: previous }); session.value = previous;
    }
    else if (action === 'content' && interaction.isStringSelectMenu()) editSection(session, 'content', {
      text: interaction.values.includes('text'), images: interaction.values.includes('images'), urls: interaction.values.includes('urls'),
      caption: interaction.values.includes('caption'), animation: interaction.values.includes('animation'),
    });
    else if (action === 'providers' && interaction.isStringSelectMenu()) editSection(session, 'content', { providers: interaction.values as Config['content']['providers'] });
    else if (action === 'roles' && interaction.isRoleSelectMenu()) editSection(session, 'moderation', { managerRoles: interaction.values });
    else if (action === 'directposts') editSection(session, 'moderation', { allowDirectPosts: !allowsDirectPosts(editorConfig(session)) });
    else if (action === 'allowedroles' && interaction.isRoleSelectMenu()) editSection(session, 'policy', { allowedRoles: interaction.values });
    else if ((action === 'reportchannel' || action === 'logchannel') && interaction.isChannelSelectMenu()) editSection(session, 'moderation', { [action === 'reportchannel' ? 'reportChannel' : 'logChannel']: interaction.values[0] ?? null });
    else if (action === 'export') {
      await interaction.reply({ content: 'この下書きの設定です。Webhookなどの秘密情報は含まれません。', flags: MessageFlags.Ephemeral,
        files: [new AttachmentBuilder(Buffer.from(exportTemplate(session.value)), { name: 'anonymous.json' })] }); return;
    } else if (!['back', 'management','buttons'].includes(action)) { await interaction.showModal(editorModal(id, action, editorConfig(session))); return; }
    const management = ['management', 'roles', 'allowedroles', 'reportchannel', 'logchannel', 'directposts'].includes(action);
    await interaction.update({ components: action==='buttons'?buttonSettingsView(id,session):management ? managementView(id, session) : editorView(id, session), allowedMentions: emptyMentions });
  }
  async saveEditor(interaction: UIInteraction, id: string, session: EditorSession): Promise<void> {
    const channel = await this.channel(session.guildId, session.channelId);
    const me = await channel.guild.members.fetchMe();
    const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageWebhooks];
    if (!allowsDirectPosts(editorConfig(session))) required.push(PermissionFlagsBits.ManageMessages);
    if (!channel.permissionsFor(me)?.has(required)) throw new UserError('Botに「チャンネルを見る・送信・履歴を見る・ファイル添付・埋め込みリンク・Webhook管理」を付与してください。');
    const config = editorConfig(session);
    for (const target of [config.moderation.reportChannel, config.moderation.logChannel].filter(Boolean)) {
      const destination = await this.channel(session.guildId, target!);
      if (!destination.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) throw new UserError('通報先・処置ログ先にBotが送信できる権限を付与してください。');
    }
    const affected = session.scope === 'guild' ? await this.store.configuredChannels(session.guildId) : [session.channelId];
    await this.store.saveSettings(session.original, session.scope, session.value, session.owner);
    const failed: string[] = [];
    for (const channelId of affected) {
      try {
        const destination = await this.channel(session.guildId, channelId);
        const settings = await this.store.settings(session.guildId, channelId, true);
        if (!settings.enabled && !session.installing) continue;
        const webhook = await this.posting.createWebhook(destination);
        const panelId = (await destination.send({ ...panelPayload(settings.config),flags:MessageFlags.IsComponentsV2 | MessageFlags.SuppressNotifications })).id;
        await this.store.setPanel(session.guildId, channelId, panelId, webhook);
        if (settings.panelId) await destination.messages.delete(settings.panelId).catch(() => undefined);
      } catch { failed.push(channelId); }
    }
    this.editors.delete(id);
    await this.respond(interaction, [card(failed.length ? '設定は保存しました' : '設定を反映しました', failed.length ?
      `案内の更新に失敗したチャンネル: ${failed.map(channelId => `<#${channelId}>`).join(' ')}\n権限を確認し、/setup または /settings から再反映してください。` :
      `${session.scope === 'guild' ? `サーバー標準を保存し、${affected.length}チャンネルの案内を更新しました。` : `<#${session.channelId}> の設定を保存しました。`}\n案内は投稿のたびに末尾へ再送されます。`, failed.length ? colors.warning : colors.success)]);
  }
  async modal(interaction: ModalSubmitInteraction): Promise<void> {
    const [prefix, id, action] = interaction.customId.split(':');
    const field = (name: string) => interaction.fields.getTextInputValue(name);
    const selected = (name:string) => interaction.fields.fields.get(name)?.type===ComponentType.StringSelect
      ? interaction.fields.getStringSelectValues(name)[0]??'' : field(name);
    if (prefix === 'submit' || prefix === 'reply' || prefix === 'replyimage') {
      const settings = await this.store.settings(interaction.guildId!, interaction.channelId!, true);
      const kind = prefix === 'reply' ? 'text' : prefix === 'replyimage' ? 'image' : id;
      const content = interaction.fields.fields.has('text') ? field('text') : '';
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (kind === 'url') { await this.prepareUrl(interaction, field('url'), content); return; }
      const files = kind === 'image' ? await this.media.attachments([...interaction.fields.getUploadedFiles('files', true).values()].map(file => file.url), settings.config) : [];
      await this.send(interaction, content, files, undefined, prefix === 'reply' || prefix === 'replyimage' ? id : undefined); return;
    }
    if (prefix === 'selfedit' && id) { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); await this.posting.edit(interaction.guildId!, interaction.channelId!, id, interaction.user.id, field('text')); await this.respond(interaction, [card('編集しました', '投稿の本文を更新しました。', colors.success)]); return; }
    if (prefix === 'report' && id) { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); await this.report(interaction, id, field('reason')); return; }
    if(prefix==='punishconfirm'&&id&&action){
      const channelId=interaction.customId.split(':')[3]!;await this.requireManager(interaction,channelId);
      await interaction.deferReply({flags:MessageFlags.Ephemeral});
      const guild=await this.client.guilds.fetch(interaction.guildId!);
      const reason=field('reason').trim();
      const result=await this.moderation.execute(guild,channelId,id,interaction.user.id,action as Punishment,reason);
      const settings=await this.store.settings(interaction.guildId!,channelId,true);let warning=result.warning;
      if(result.report.notificationId&&settings.config.moderation.reportChannel){
        try{const destination=await this.channel(interaction.guildId!,settings.config.moderation.reportChannel);await destination.messages.edit(result.report.notificationId,{content:null,embeds:[],components:[reportView(result.report,isRequestMode(settings.config),punishmentLabels[action as Punishment])],flags:MessageFlags.IsComponentsV2,allowedMentions:emptyMentions});}
        catch{warning+='\n処罰は実行済みですが、通報通知の表示を更新できませんでした。';}
      }
      if(settings.config.moderation.logChannel){
        try{const destination=await this.channel(interaction.guildId!,settings.config.moderation.logChannel);await destination.send(payload([card(action==='none'?'匿名つぶやき通報の対応記録':'匿名つぶやき処罰通知',`対象番号：匿名${String(result.report.anonymousId).padStart(3,'0')}\n対応理由：${reason || '未記入'}\n${punishmentLabels[action as Punishment]}\n元メッセージ：[匿名つぶやき](https://discord.com/channels/${interaction.guildId}/${channelId}/${id})`,action==='none'?colors.info:colors.danger)],false));}
        catch{warning+='\n処罰ログを送信できませんでした。';}
      }
      await this.respond(interaction,[card('対応を記録しました',`${punishmentLabels[action as Punishment]}で処理を終了しました。${warning?'\n'+warning:''}`,warning?colors.warning:colors.success)]);return;
    }
    if (prefix === 'caption' && id) {
      const session = this.previews.get(id, interaction.user.id, interaction.guildId!);
      if (session.sending) throw new UserError('送信中は説明文を変更できません。');
      const settings = await this.store.settings(session.guildId, session.channelId,true);
      if (!settings.config.content.caption) throw new UserError('このチャンネルでは説明文を付けられません。');
      validateText(field('text'), settings.config); session.text = field('text');
      if (interaction.isFromMessage()) await interaction.update({ components: previewView(id, session, settings.config.content.caption), allowedMentions: emptyMentions });
      return;
    }
    if (prefix === 'edit' && id && action) {
      const session = this.editors.get(id, interaction.user.id, interaction.guildId!);
      await this.requireManager(interaction, session.channelId);
      if (session.scope === 'guild' && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new UserError('サーバー標準の変更にはサーバー管理権限が必要です。');
      const copy = structuredClone(session);
      switch (action) {
        case 'display': {
          const repost = selected('repost').trim().toLowerCase();
          const urlButton=selected('urlButton').trim().toLowerCase();const metadata=selected('metadata').trim().toLowerCase();
          const urlAutoLabel=selected('urlAutoLabel').trim().toLowerCase();
          if ([repost,urlButton,metadata,urlAutoLabel].some(value=>!['on','off'].includes(value))) throw new UserError('切り替え項目を選択してください。');
          editSection(copy, 'panel', { style:'v2', repost: repost === 'on',urlButton:urlButton==='on',metadata:metadata==='on',urlAutoLabel:urlAutoLabel==='on' }); break;
        }
        case 'caption': {
          const value=selected('caption');if(!['on','off'].includes(value))throw new UserError('説明文の許可を選択してください。');
          editSection(copy,'content',{caption:value==='on'});break;
        }
        case 'styles': {
          const changes=Object.fromEntries(['text','image','url','help'].map(kind=>[`${kind}Style`,selected(`${kind}Style`).trim().toLowerCase()]));
          editSection(copy,'panel',changes);break;
        }
        case 'emojis': {
          const changes=Object.fromEntries(['text','image','url','help'].map(kind=>[`${kind}Emoji`,field(`${kind}Emoji`).trim()]));
          editSection(copy,'panel',changes);break;
        }
        case 'appearance': {
          if (!/^#[0-9a-f]{6}$/i.test(field('color'))) throw new UserError('色は #5865f2 のように入力してください。');
          editSection(copy, 'panel', { title: field('title'), description: field('description'), color: parseInt(field('color').slice(1), 16), footer: field('footer') }); break;
        }
        case 'images': editSection(copy, 'panel', { image: field('image'), thumbnail: field('thumbnail') }); break;
        case 'labels': editSection(copy, 'panel', { textLabel: field('textLabel'), imageLabel: field('imageLabel'), urlLabel: field('urlLabel'), helpLabel: field('helpLabel'), ...(field('urlLabel')!==editorConfig(copy).panel.urlLabel?{urlAutoLabel:false}:{}) }); break;
        case 'rules': editSection(copy, 'policy', { rules: field('rules'), rulesUrl: field('rulesUrl') }); break;
        case 'limits': editSection(copy, 'content', { maxFiles: Number(field('maxFiles')) }); editSection(copy, 'policy', { cooldown: Number(field('cooldown')) }); editSection(copy, 'moderation', { reportThreshold: Number(field('threshold')) }); break;
        case 'identity': {
          if (!['on', 'off'].includes(selected('showId').toLowerCase())) throw new UserError('匿名IDの表示を選択してください。');
          editSection(copy, 'identity', { showId: selected('showId').toLowerCase() === 'on', minutes: Number(field('minutes')) });
          editSection(copy, 'policy', { retentionDays: parseRetention(field('retention')), reportRetentionDays: parseRetention(field('reportRetention')) }); break;
        }
        case 'filter': editSection(copy, 'policy', { blockedWords: field('words').split('\n').map(value => value.trim()).filter(Boolean), blockedDomains: field('domains').split('\n').map(value => value.trim().toLowerCase()).filter(Boolean) }); break;
        case 'import': {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const attachment = interaction.fields.getUploadedFiles('template', true).first();
          if (!attachment || attachment.size > 64 * 1024) throw new UserError('64KB以内の設定JSONを添付してください。');
          const result = await this.media.http.get(attachment.url, 64 * 1024);
          let imported: unknown; try { imported = JSON.parse(result.data.toString('utf8')); } catch { throw new UserError('JSONファイルの形式を確認してください。'); }
          const overrides = importTemplate(imported, session.original.base);
          copy.value = session.scope === 'guild' ? resolveConfig(session.original.base, overrides) : overrides;
          session.value = copy.value;
          await this.respond(interaction, editorView(id, session)); return;
        }
        default: return;
      }
      session.value = copy.value;
      if (interaction.isFromMessage()) await interaction.update({ components: editorView(id, session), allowedMentions: emptyMentions });
    }
  }
  async context(interaction: import('discord.js').MessageContextMenuCommandInteraction): Promise<void> {
    const id = interaction.targetId;
    if (interaction.commandName === '埋め込みを編集（Admin）') {
      await this.requireManager(interaction);
      const settings = await this.store.settings(interaction.guildId!, interaction.channelId!, true);
      if (settings.panelId !== id) throw new UserError('このBotが設置した匿名投稿の案内を選択してください。');
      const session: EditorSession = { owner: interaction.user.id, guildId: interaction.guildId!, channelId: interaction.channelId!,
        scope: 'channel', original: settings, value: structuredClone(settings.overrides), installing: false };
      const key = this.editors.create(session);
      await this.respond(interaction, editorView(key, session)); return;
    }
    const post = await this.store.post(interaction.guildId!, interaction.channelId!, id);
    if (!post) throw new UserError('このBotの保存期間内の匿名投稿を選択してください。');
    const settings = await this.store.settings(interaction.guildId!, interaction.channelId!);
    if (interaction.commandName === 'メッセージに返信') {
      await interaction.showModal(postModal(settings.config.content.text ? 'text' : 'image', settings.config, `${settings.config.content.text ? 'reply' : 'replyimage'}:${id}`)); return;
    }
    if (interaction.commandName === '匿名つぶやき通報') {
      if (!settings.config.moderation.reportChannel) throw new UserError('このサーバーの通報先がまだ設定されていません。管理者に連絡してください。');
      await interaction.showModal(new ModalBuilder().setCustomId(`report:${id}`).setTitle('投稿を通報').addLabelComponents(input('reason', '通報の理由（任意）', '', 1000, true, false))); return;
    }
    await this.posting.own(interaction.guildId!, interaction.channelId!, id, interaction.user.id);
    if (interaction.commandName === 'メッセージを編集') {
      const settings=await this.store.settings(interaction.guildId!,interaction.channelId!,true);
      if(post.media.length&&!settings.config.content.caption)throw new UserError('このチャンネルでは画像に説明文を付けられません。');
      await interaction.showModal(new ModalBuilder().setCustomId(`selfedit:${id}`).setTitle('自分の投稿を編集').addLabelComponents(input('text', '本文', post.content, post.layout === 'legacy' ? 2000 : 1800, true, false))); return;
    }
    const confirm = card('この投稿を削除しますか？', '削除後も、すでに通報された内容は保存期限まで保持されます。', colors.warning);
    confirm.addActionRowComponents(row(button(`own:${id}:confirm`, '削除する', ButtonStyle.Danger), button(`own:${id}:cancel`, 'キャンセル')));
    await this.respond(interaction, [confirm]);
  }
  async mine(interaction: UIInteraction): Promise<void> {
    const settings=await this.store.settings(interaction.guildId!,interaction.channelId!,true);
    if(settings.config.policy.retentionDays===0){
      await this.respond(interaction,[card('投稿履歴を保存していません','このチャンネルでは投稿ログを保存しないため、Botによる本人編集・削除・送信結果照合は利用できません。')]);return;
    }
    const posts = await this.store.ownPosts(interaction.guildId!, interaction.channelId!, interaction.user.id);
    const pending = await this.store.uncertainPosts(interaction.guildId!, interaction.channelId!, interaction.user.id);
    const result = card('自分の投稿', posts.length ? '操作する投稿を選んでください。この一覧はあなただけに表示されています。' : pending.length ? '送信結果の確認が必要な投稿があります。下の一覧から確認してください。' : '保存期間内の投稿はありません。');
    if (posts.length) result.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
      .setCustomId('mine:select').setPlaceholder('投稿を選ぶ').addOptions(posts.map(post => ({
        label: (post.content.replace(/\s+/g, ' ').slice(0, 65) || '画像投稿'),
        description: new Date(post.created_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }), value: post.message_id!,
      })))));
    const views = [result];
    if (pending.length) {
      const recovery = card('送信結果を確認', '通信が途切れた投稿です。再送せず、Discordに届いた投稿を確認します。投稿番号を受け取れなかった場合は自動確認できません。', colors.warning);
      recovery.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
        .setCustomId('recover:select').setPlaceholder('確認する投稿を選ぶ').addOptions(pending.map(post => ({
          label: post.content.replace(/\s+/g, ' ').slice(0, 65) || '画像投稿',
          description: new Date(post.created_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }), value: post.operation_id,
        })))));
      views.push(recovery);
    }
    await this.respond(interaction, views);
  }
  async report(interaction: UIInteraction, messageId: string, reason: string): Promise<void> {
    const post = await this.store.post(interaction.guildId!, interaction.channelId!, messageId);
    if (!post) throw new UserError('この投稿は削除済みか保存期限を過ぎています。');
    const settings = await this.store.settings(interaction.guildId!, interaction.channelId!, true);
    if (!settings.config.moderation.reportChannel) throw new UserError('通報先が設定されていません。');
    const count = await this.store.addReport(post, interaction.user.id, reason.trim(), settings.config.policy.reportRetentionDays);
    if (count >= settings.config.moderation.reportThreshold) {
      try {
        for (const notice of await this.store.pendingReportNotices(interaction.guildId!, messageId)) await this.sendReportNotice(notice);
        const detail=await this.store.reportDetail(interaction.guildId!,interaction.channelId!,messageId);
        if(detail?.notificationId){
          const destination=await this.channel(interaction.guildId!,settings.config.moderation.reportChannel);
          await destination.messages.edit(detail.notificationId,{content:null,embeds:[],components:[reportView(detail,isRequestMode(settings.config))],flags:MessageFlags.IsComponentsV2,allowedMentions:emptyMentions});
        }
      } catch (error) {
        throw new UserError('通報は保存しました。管理者への通知に失敗したため、5分後に再試行します。');
      }
    }
    await this.respond(interaction, [card('通報を受け付けました', `通報者の名前は通報先の管理者に表示されます。${settings.config.moderation.reportThreshold}人の通報が集まると管理者へ通知します。`, colors.success)]);
  }
  async sendReportNotice(notice: ReportNotice): Promise<void> {
    const { guild_id: guildId, channel_id: channelId, message_id: messageId } = notice;
    const settings = await this.store.settings(guildId, channelId, true);
    if (!settings.config.moderation.reportChannel || notice.count < settings.config.moderation.reportThreshold) return;
    const token = await this.store.claimReportNotification(guildId, messageId);
    if (!token) return;
    try {
      const destination = await this.channel(guildId, settings.config.moderation.reportChannel);
      const detail=await this.store.reportDetail(guildId,channelId,messageId);
      const notification=reportView(detail??notice,isRequestMode(settings.config));
      const sent = await destination.send({ ...payload([notification], false), nonce: notice.nonce, enforceNonce: true });
      await this.store.reportNotification(guildId, messageId, token, sent.id);
    } catch (error) {
      await this.store.reportNotification(guildId, messageId, token, null).catch(() => undefined);
      throw error;
    }
  }
  async retryReportNotices(): Promise<void> {
    if (this.retryingReports || !this.client.isReady()) return;
    this.retryingReports = true;
    try {
      for (const notice of await this.store.pendingReportNotices()) {
        await this.sendReportNotice(notice).catch(() => console.error('通報通知の再試行に失敗しました。'));
      }
    } finally { this.retryingReports = false; }
  }
}
