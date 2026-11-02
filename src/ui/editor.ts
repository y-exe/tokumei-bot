import { ActionRowBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, ContainerBuilder, RoleSelectMenuBuilder,
  SeparatorBuilder, StringSelectMenuBuilder, SectionBuilder, ThumbnailBuilder } from 'discord.js';
import { allowsDirectPosts, providerNames, retentionLabel, resolveConfig, type Config, type Overrides } from '../domain/config.js';
import type { ChannelSettings, SavedSetup, SettingsBackup } from '../infra/store.js';
import { button, card, colors, panel, row, text, uiEmoji } from './components.js';
import { addProviders } from './providers.js';
import type { OwnedSession } from './sessions.js';
export { editorModal } from './editor-modals.js';

export interface EditorSession extends OwnedSession {
  scope: 'guild' | 'channel'; original: ChannelSettings; value: Config | Overrides; installing: boolean;
  setupPage?: 0 | 1 | 2;
  resetConfirmation?: boolean;
  setupAvatar?: string;
  setupSources?: SavedSetup[];
  setupSourcePage?: number;
  choosingSetup?: boolean;
  reuseSource?: string;
  pendingRevision?: Config | Overrides;
  backups?: SettingsBackup[];
  backupCursors?: string[];
  selectedBackup?: string;
  deletingBackup?: boolean;
  returnToOther?: boolean;
  resumeConfirmation?: boolean;
  resuming?: boolean;
}
export function editorConfig(session: EditorSession): Config {
  return session.scope === 'guild' ? session.value as Config : resolveConfig(session.original.base, session.value as Overrides);
}
export function editSection<K extends keyof Config>(session: EditorSession, section: K, changes: Partial<Config[K]>): void {
  const value = { ...session.value, [section]: { ...session.value[section], ...changes } };
  editorConfig({ ...session, value });
  session.value = value;
}
export function editorView(id: string, session: EditorSession): ContainerBuilder[] {
  const config = editorConfig(session);
  const inherited = session.scope === 'channel' ? Object.keys(session.value).length ? 'このチャンネルの上書きを編集中' : 'サーバー標準を継承中' : 'サーバー内の継承チャンネルに反映されます';
  const menu = card('匿名Botの設定', `${session.scope === 'guild' ? 'サーバー標準' : `<#${session.channelId}>`} · ${inherited}\n${session.resuming ? '変更は下書きです。「保存して再開」を押すと匿名投稿の受付を再開します。' : '変更は下書きです。「保存して反映」を押すまで公開されません。'}`, colors.settings);
  menu.addSeparatorComponents(new SeparatorBuilder());
  menu.addActionRowComponents(row(button(`cfg:${id}:appearance`, 'タイトル・説明', ButtonStyle.Primary), button(`cfg:${id}:images`, '画像・サムネイル'), button(`cfg:${id}:buttons`, 'ボタン設定'), button(`cfg:${id}:management`, '管理・投稿ロール')));
  menu.addActionRowComponents(row(button(`cfg:${id}:rules`, 'ルール', ButtonStyle.Primary), button(`cfg:${id}:safetyview`, '画像・動画の安全設定'), button(`cfg:${id}:filter`, '禁止語・ドメイン'), button(`cfg:${id}:other`, 'その他')));
  menu.addSeparatorComponents(new SeparatorBuilder());
  menu.addTextDisplayComponents(text(`### ${uiEmoji.check} 追加したい機能\n必要なものを選ぶと、上のプレビューに反映されます。`));
  const options = [
    { label: 'テキストだけの投稿', value: 'text', description: '画像なしでも投稿できる' },
    { label: 'ファイルの直接添付', value: 'images', description: 'フォームから画像や動画などを選択できる' },
    { label: 'URLから画像を取得', value: 'urls', description: '対応サイトの画像や動画を自動変換する' },
    { label: '画像に説明文を加えない', value: 'noCaption', description: '選択すると説明文の入力・編集を禁止する' },
    ].map(option => ({ ...option, default: option.value === 'noCaption' ? !config.content.caption : config.content[option.value as 'text' | 'images' | 'urls'] }));
  menu.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
    .setCustomId(`cfg:${id}:content`).setPlaceholder('追加したい機能を選ぶ').setMinValues(1).setMaxValues(options.length).addOptions(options)));
  if (config.content.urls) addProviders(menu, id, config);
  menu.addSeparatorComponents(new SeparatorBuilder());
  menu.addActionRowComponents(row(button(`cfg:${id}:save`, session.resuming ? '保存して再開' : session.installing ? '保存して設置' : '保存して反映', ButtonStyle.Success),
    button(`cfg:${id}:reset`, session.scope === 'channel' ? '標準に戻す' : '初期値に戻す'), button(`cfg:${id}:export`, '書き出し'), button(`cfg:${id}:import`, '読み込み'), button(`cfg:${id}:cancel`, 'キャンセル', ButtonStyle.Danger)));
  return [panel(config,true), menu];
}

export function otherView(id: string, session: EditorSession): ContainerBuilder[] {
  const config = editorConfig(session);
  const policy = config.policy;
  const menu = card('その他の設定', '左の説明を確認し、右のボタンから変更します。保存して反映するまで下書きです。', colors.settings);
  const entries = [
    ['limitsbasic','投稿間隔・通報',`投稿間隔：${policy.cooldown}秒 / 通報通知：${config.moderation.reportThreshold}人`,'投稿の待ち時間と、管理者へ通知する通報人数を設定します。'],
    ['spam','連投対策',`60秒：${policy.postsPerMinute || '無制限'}件・${policy.charsPerMinute || '無制限'}文字 / 300秒：${policy.charsPerFiveMinutes || '無制限'}文字`,`文字数超過時は${policy.spamTimeoutMinutes}分制限。同一本文は${policy.duplicateSeconds}秒禁止。各上限・同一本文は0で無効。サーバー内の匿名チャンネルで合算します。`],
    ['identity','匿名ID・保存期間',`匿名ID：${config.identity.showId ? '表示' : '非表示'} / 投稿ログ：${retentionLabel(policy.retentionDays)}`,'IDの保持時間と、投稿・通報ログの保存期間を設定します。'],
    ['urlcleanup','URLの不要な情報',policy.cleanUrls !== false ? '除去：有効' : '除去：無効','全サイトの既知の計測情報（utm_*等）とX投稿の共有情報を除去します。検索条件・画像形式・既知の署名付きURLは維持します。'],
    ['references','投稿番号の自動リンク',policy.linkReferences !== false ? '自動リンク：有効' : '自動リンク：無効','本文の >>番号 を保存済みの投稿へのリンクにします。投稿ログを保存しない場合は変換しません。'],
    ['restrictionview','匿名投稿の利用停止',config.moderation.allowChannelRestriction ? '通報からの利用停止：有効' : '通報からの利用停止：無効','通報からこのチャンネルだけの利用を無期限停止できます。利用停止の解除もここで行います。'],
    ['display','表示・再送','案内の再送・URLボタン名','投稿後に案内を再送するか、URLボタン名を許可したSNS名に合わせるかを設定します。'],
    ['restore','設定バックアップ','保存から60日間・件数制限なし','保存時の設定を自動で保持し、保存から60日以上たつと削除します。読み込みは下書きに反映し、手動削除には確認が必要です。'],
  ] as const;
  for (const [action,title,current,description] of entries) {
    menu.addSeparatorComponents(new SeparatorBuilder());
    menu.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(`### ${title}\n${current}\n${description}`)).setButtonAccessory(button(`cfg:${id}:${action}`, '設定する')));
  }
  menu.addSeparatorComponents(new SeparatorBuilder());
  menu.addActionRowComponents(row(button(`cfg:${id}:back`, '設定に戻る', ButtonStyle.Primary)));
  return [menu];
}

export function channelRestrictionView(id:string,session:EditorSession,note=''):ContainerBuilder[]{
  const config=editorConfig(session),enabled=!!config.moderation.allowChannelRestriction;
  return [card('匿名投稿の利用停止',`通報からの利用停止：**${enabled?'有効':'無効'}**\nこのチャンネルだけの匿名投稿を無期限停止します。投稿・通報ログの保存が必要です。BAN・タイムアウトや投稿削除は行いません。${note?`\n${note}`:''}`,colors.settings)
    .addSeparatorComponents(new SeparatorBuilder())
    .addSectionComponents(new SectionBuilder().addTextDisplayComponents(text('### 通報から利用停止する\n有効にすると通報画面に操作ボタンを表示します。変更は設定を保存するまで下書きです。無効にしても既存の利用停止は解除されません。')).setButtonAccessory(button(`cfg:${id}:channelrestriction`,enabled?'無効にする':'有効にする')))
    .addSeparatorComponents(new SeparatorBuilder())
    .addSectionComponents(new SectionBuilder().addTextDisplayComponents(text('### 利用停止を解除する\n対象ユーザーのDiscord IDを指定します。解除は送信直後に反映されます。')).setButtonAccessory(button(`cfg:${id}:restrictionrelease`,'解除する')))
    .addActionRowComponents(row(button(`cfg:${id}:other`,'その他の設定に戻る')))];
}

export function setupView(id: string, session: EditorSession): ContainerBuilder[] {
  const config = editorConfig(session); const page = session.setupPage ?? 0;
  const titles = ['使う機能を選ぶ', '投稿ルールを決める', '内容を確認して設置'];
  const progress = ['① 機能', '② ルール', '③ 確認'].map((label, index) => index === page ? `**${label}**` : label).join('　›　');
  const menu = new ContainerBuilder().setAccentColor(colors.settings);
  const heading = text(`## ${uiEmoji.info} 匿名投稿のセットアップ\n<#${session.channelId}> · **${page + 1}/3 ${titles[page]}**`);
  if (session.setupAvatar) menu.addSectionComponents(new SectionBuilder().addTextDisplayComponents(heading).setThumbnailAccessory(new ThumbnailBuilder().setURL(session.setupAvatar)));
  else menu.addTextDisplayComponents(heading);
  menu.addTextDisplayComponents(text(progress));
  menu.addSeparatorComponents(new SeparatorBuilder());
  if (page === 0) {
    menu.addTextDisplayComponents(text(`### ${uiEmoji.check} 追加したい機能\n必要なものを選ぶと、上のプレビューに反映されます。`));
    menu.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
      .setCustomId(`cfg:${id}:features`).setPlaceholder('追加したい機能を選ぶ').setMinValues(1).setMaxValues(3)
      .addOptions([
        { label: '匿名メッセージの送信', value: 'text', description: '文章を匿名で投稿できます。', default: config.content.text },
        { label: '画像・ファイルの直接送信', value: 'images', description: '端末の画像・動画などを送信できます。', default: config.content.images },
        { label: 'URLから画像・動画を取得', value: 'urls', description: 'SNSや公開ページのURLから取得します。', default: config.content.urls },
      ])));
    menu.addTextDisplayComponents(text('-# メッセージ・直接添付・URL取得は、それぞれ単独でも利用できます。'));
    if (config.content.urls) addProviders(menu, id, config);
  } else if (page === 1) {
    menu.addTextDisplayComponents(text(`### ${uiEmoji.reporter} 通常のメッセージ投稿\n${allowsDirectPosts(config) ? '**許可** · 自分の名前で送る通常投稿も残します。' : '**拒否** · 通常投稿は削除し、投稿者へDMで匿名投稿を案内します。'}\n管理者・許可した管理ロール・Bot・Webhookは削除対象外です。`));
    menu.addActionRowComponents(row(button(`cfg:${id}:directposts`, `通常投稿を${allowsDirectPosts(config) ? '拒否する' : '許可する'}`)));
    menu.addSeparatorComponents(new SeparatorBuilder());
    menu.addTextDisplayComponents(text(`### ${uiEmoji.flag} 画像・動画の制限\n**NSFW**：${config.content.allowNsfw ? '許可' : '拒否'} · 性器・女性の胸や乳首の露出\n**NSFL**：${config.content.allowNsfl ? '許可' : '拒否'} · グロ・流血\n許可するものだけ選択してください。腹・肩・下着のみの露出は拒否対象にしません。`));
    menu.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
      .setCustomId(`cfg:${id}:safety`).setPlaceholder('許可するカテゴリ（未選択は拒否）').setMinValues(0).setMaxValues(2)
      .addOptions({ label: 'NSFW（性的な露出）を許可', value: 'nsfw', description: '選択すると性器・女性の胸や乳首の露出を含む画像・動画を許可します。', default: config.content.allowNsfw ?? false },
        { label: 'NSFL（グロ・流血）を許可', value: 'nsfl', description: '選択するとグロ・流血を含む画像・動画を許可します。未選択は拒否です。', default: config.content.allowNsfl ?? false })));
  } else {
    menu.addTextDisplayComponents(text(`### ${uiEmoji.check} 設置内容\n**有効な機能**：${[config.content.text && '匿名メッセージ', config.content.images && '画像・ファイル', config.content.urls && 'URL取得'].filter(Boolean).join('・')}\n${config.content.urls ? `**URL取得先**：${config.content.providers.map(provider => providerNames[provider]).join('・') || '未選択（URL取得は停止）'}\n` : ''}**通常投稿**：${allowsDirectPosts(config) ? '許可' : '削除・DM案内'}\n**NSFW**：${config.content.allowNsfw ? '許可' : '拒否'} / **NSFL**：${config.content.allowNsfl ? '許可' : '拒否'}`));
    menu.addSeparatorComponents(new SeparatorBuilder());
    menu.addTextDisplayComponents(text(`### ${uiEmoji.time} 匿名表示と保存\n**匿名ID**：${config.identity.showId ? '表示' : '非表示'} / **投稿ログ**：${retentionLabel(config.policy.retentionDays)} / **通報内容**：${retentionLabel(config.policy.reportRetentionDays)}\nタイトル・画像・ルール・保存期間は「詳細設定」で変更できます。`));
    menu.addActionRowComponents(row(button(`cfg:${id}:save`, 'この内容で設置', ButtonStyle.Success), button(`cfg:${id}:advanced`, '詳細設定')));
  }
  menu.addSeparatorComponents(new SeparatorBuilder());
  menu.addTextDisplayComponents(text(`-# ${page === 2 ? '上の公開案内を確認し、「この内容で設置」を押すとチャンネルに反映されます。' : '変更は下書きです。前のページに戻っても選択内容は保持されます。'}`));
  menu.addActionRowComponents(row(...(page > 0 ? [button(`cfg:${id}:setupprev`, '前へ')] : []), ...(page < 2 ? [button(`cfg:${id}:setupnext`, '次へ', ButtonStyle.Primary)] : []), button(`cfg:${id}:cancel`, 'キャンセル', ButtonStyle.Danger)));
  return [panel(config, true), menu];
}

export function resetConfirmationView(id: string, session: EditorSession): ContainerBuilder[] {
  const guild = session.scope === 'guild';
  const menu = card(guild ? '初期値に戻しますか？' : '標準に戻しますか？', guild
    ? 'サーバー標準の下書きを初期値に戻します。保存すると、標準を継承するチャンネルにも反映されます。'
    : 'このチャンネルの上書きを外し、サーバー標準を使う下書きに戻します。', colors.warning);
  menu.addSeparatorComponents(new SeparatorBuilder());
  menu.addTextDisplayComponents(text('**編集中の下書きは置き換わります。**\n公開中の設定は「保存して反映」を押すまで変わりません。'));
  menu.addActionRowComponents(row(button(`cfg:${id}:resetconfirm`, guild ? '初期値に戻す' : '標準に戻す', ButtonStyle.Danger), button(`cfg:${id}:resetcancel`, '戻さず編集を続ける')));
  return [menu];
}

export function reuseSetupView(id: string, session: EditorSession): ContainerBuilder[] {
  const sources = (session.setupSources ?? []).slice(0,25);
  const menu = card('保存済みの設定を使いますか？', 'このチャンネルの設定を再開するか、同じサーバーの別チャンネルから設定をコピーできます。削除済みチャンネルの設定も候補に残ります。', colors.settings);
  menu.addSeparatorComponents(new SeparatorBuilder());
  if (sources.length) menu.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
    .setCustomId(`cfg:${id}:reusesource`).setPlaceholder('使いたい設定を選ぶ').addOptions(sources.map(source=>({
      label:`${source.name ?? source.channelId} · ${source.title}`.slice(0,100),value:source.channelId,default:source.channelId===session.reuseSource,
      description:`${source.channelId===session.channelId?'このチャンネル':'別チャンネル'} · ${source.enabled?'保存済み':'停止中'}${source.savedAt?` · ${new Date(source.savedAt).toLocaleDateString('ja-JP',{timeZone:'Asia/Tokyo'})}`:''}`.slice(0,100),
    })))));
  const page = session.setupSourcePage ?? 0;
  if (page>0 || (session.setupSources?.length ?? 0)>25) menu.addActionRowComponents(row(button(`cfg:${id}:reuseprev`,'前の候補').setDisabled(page===0),button(`cfg:${id}:reusenext`,'次の候補').setDisabled((session.setupSources?.length ?? 0)<=25)));
  menu.addTextDisplayComponents(text(session.reuseSource ? '**上のプレビューを確認してください。**\n「この設定で設置」で今のチャンネルに反映します。元のチャンネルの投稿・Webhookはコピーしません。' : '候補を選ぶとプレビューを表示します。一から設定する場合は「新しく設定する」を選んでください。'));
  menu.addActionRowComponents(row(...(session.reuseSource?[button(`cfg:${id}:reuseapply`,'この設定で設置',ButtonStyle.Success),button(`cfg:${id}:reuseedit`,'編集して使う')]:[]),button(`cfg:${id}:newsetup`,'新しく設定する',ButtonStyle.Primary),button(`cfg:${id}:cancel`,'キャンセル',ButtonStyle.Danger)));
  return session.reuseSource ? [panel(editorConfig(session),true),menu] : [menu];
}

export function backupsView(id: string, session: EditorSession): ContainerBuilder[] {
  const backups = (session.backups ?? []).slice(0,25);
  const page = session.backupCursors?.length ?? 0;
  const menu = card('設定バックアップ', `保存から60日間、件数制限なしで保持します。60日以上たつと自動削除します。操作できる保存元の設定だけ表示します。\n${page + 1}ページ目`, colors.settings);
  menu.addSeparatorComponents(new SeparatorBuilder());
  if (backups.length) menu.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
    .setCustomId(`cfg:${id}:restoreselect`).setPlaceholder('日時からバックアップを選ぶ').addOptions(backups.map(backup => ({
      label: backup.channelName.slice(0,100), value: backup.id,
      description: new Date(backup.createdAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',hour12:false}), default: backup.id === session.selectedBackup,
    })))));
  else menu.addTextDisplayComponents(text(page ? 'このページにバックアップはありません。「前のページ」で戻れます。' : '60日以内のバックアップはありません。設定を保存すると自動で作成されます。'));
  if (page || (session.backups?.length ?? 0)>25) menu.addActionRowComponents(row(button(`cfg:${id}:restoreprev`,'前のページ').setDisabled(!page),button(`cfg:${id}:restorenext`,'次のページ').setDisabled((session.backups?.length ?? 0)<=25)));
  if (session.pendingRevision) {
    menu.addTextDisplayComponents(text(session.deletingBackup ? '**選択中のバックアップを削除しますか？**\n削除は取り消せません。公開中の設定は変わりません。' : '上のプレビューの設定を下書きに読み込めます。保存して反映するまで公開中の設定は変わりません。'));
    menu.addActionRowComponents(session.deletingBackup
      ? row(button(`cfg:${id}:restoredeleteconfirm`,'削除する',ButtonStyle.Danger),button(`cfg:${id}:restoredeletecancel`,'削除しない'))
      : row(button(`cfg:${id}:restoreapply`,'下書きに読み込む',ButtonStyle.Primary),button(`cfg:${id}:restoredelete`,'このバックアップを削除',ButtonStyle.Danger)));
  }
  menu.addActionRowComponents(row(button(`cfg:${id}:restorecancel`,'設定に戻る')));
  return session.pendingRevision ? [panel(editorConfig({...session,value:session.pendingRevision}),true),menu] : [menu];
}

export function resumeConfirmationView(id: string): ContainerBuilder[] {
  return [card('匿名投稿の受付を再開しますか？', 'このチャンネルは停止中です。「再開する設定を編集」から内容を確認し、「保存して再開」で受付を再開できます。キャンセルすると停止状態を維持します。', colors.warning)
    .addActionRowComponents(row(button(`cfg:${id}:resumeconfirm`, '再開する設定を編集', ButtonStyle.Success),button(`cfg:${id}:cancel`, 'キャンセル', ButtonStyle.Danger)))];
}

export function managementView(id: string, session: EditorSession): ContainerBuilder[] {
  const config = editorConfig(session);
  const menu = card('管理と投稿権限', 'サーバー管理権限を持つ人は常に設定できます。選択は下書きに保存されます。', colors.settings, uiEmoji.reporter);
  menu.addSeparatorComponents(new SeparatorBuilder());
  const roles = new RoleSelectMenuBuilder().setCustomId(`cfg:${id}:roles`).setMinValues(0).setMaxValues(20).setPlaceholder('管理を任せるロール（任意）');
  if (config.moderation.managerRoles.length) roles.setDefaultRoles(config.moderation.managerRoles);
  menu.addTextDisplayComponents(text(`**${uiEmoji.reporter} 管理ロール**\n設定変更・通報対応を任せるロールです。`));
  menu.addActionRowComponents(new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roles));
  const allowed = new RoleSelectMenuBuilder().setCustomId(`cfg:${id}:allowedroles`).setMinValues(0).setMaxValues(20).setPlaceholder('投稿できるロール（空欄なら全員）');
  if (config.policy.allowedRoles.length) allowed.setDefaultRoles(config.policy.allowedRoles);
  menu.addTextDisplayComponents(text('**✍️ 投稿できるロール**\n未選択なら、チャンネルを利用できる全員が匿名投稿できます。'));
  menu.addActionRowComponents(new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(allowed));
  const channel = new ChannelSelectMenuBuilder().setCustomId(`cfg:${id}:reportchannel`).setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setMinValues(0).setMaxValues(1).setPlaceholder('通報を受け取るチャンネル');
  if (config.moderation.reportChannel) channel.setDefaultChannels(config.moderation.reportChannel);
  menu.addSeparatorComponents(new SeparatorBuilder());
  menu.addTextDisplayComponents(text(`**${uiEmoji.flag} 通報先**\n設定人数の通報が集まると、証拠と対応ボタンを送ります。`));
  menu.addActionRowComponents(new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(channel));
  const log = new ChannelSelectMenuBuilder().setCustomId(`cfg:${id}:logchannel`).setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setMinValues(0).setMaxValues(1).setPlaceholder('処置ログのチャンネル（任意）');
  if (config.moderation.logChannel) log.setDefaultChannels(config.moderation.logChannel);
  menu.addTextDisplayComponents(text('**📋 処置ログ先**\nBANなどを実行した記録を送ります。「処罰なし」は送りません。'));
  menu.addActionRowComponents(new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(log));
  menu.addSeparatorComponents(new SeparatorBuilder());
  menu.addActionRowComponents(row(button(`cfg:${id}:directposts`, `通常投稿: ${allowsDirectPosts(config) ? '許可' : '削除・DM警告'}`), button(`cfg:${id}:back`, 'プレビューに戻る', ButtonStyle.Primary)));
  return [menu];
}
export function safetyView(id: string, session: EditorSession): ContainerBuilder[] {
  const config = editorConfig(session);
  const menu = card('画像・動画の安全設定', `**現在の設定** · NSFW：${config.content.allowNsfw ? '許可' : '拒否'} / NSFL：${config.content.allowNsfl ? '許可' : '拒否'}`, colors.settings, uiEmoji.flag);
  menu.addSeparatorComponents(new SeparatorBuilder());
  menu.addTextDisplayComponents(text(`### ${uiEmoji.warning} 判定する内容\n**NSFW**：性器・女性の胸や乳首の露出\n**NSFL**：グロ・流血\n許可するものだけ選択してください。未選択は拒否です。腹・肩・下着のみの露出は拒否対象にしません。`));
  menu.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
    .setCustomId(`cfg:${id}:safety`).setPlaceholder('許可するカテゴリ').setMinValues(0).setMaxValues(2)
    .addOptions({ label: 'NSFW（性器・女性の胸の露出）を許可', value: 'nsfw', description: '性的な露出を含む画像・動画を投稿可能にします。未選択では安全判定で拒否します。', default: config.content.allowNsfw ?? false },
      { label: 'NSFL（グロ・流血）を許可', value: 'nsfl', description: 'グロ・流血を含む画像・動画を投稿可能にします。NSFWの許可とは別に設定します。', default: config.content.allowNsfl ?? false })));
  menu.addSeparatorComponents(new SeparatorBuilder());
  menu.addActionRowComponents(row(button(`cfg:${id}:caption`, '画像の説明文'), button(`cfg:${id}:back`, 'プレビューに戻る')));
  return [menu];
}
export function buttonSettingsView(id:string,session:EditorSession):ContainerBuilder[] {
  const menu=card('ボタンの設定','上のプレビューを見ながら、ボタン名・色・絵文字を変更できます。変更は保存するまで公開されません。',colors.settings);
  menu.addSeparatorComponents(new SeparatorBuilder());
  menu.addActionRowComponents(row(button(`cfg:${id}:labels`,'ボタン名'),button(`cfg:${id}:styles`,'ボタン色'),button(`cfg:${id}:emojis`,'絵文字')));
  menu.addActionRowComponents(row(button(`cfg:${id}:${session.returnToOther ? 'other' : 'back'}`,session.returnToOther ? 'その他の設定に戻る' : 'プレビューに戻る',ButtonStyle.Primary)));
  return [panel(editorConfig(session),true),menu];
}
