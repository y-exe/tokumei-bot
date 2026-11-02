import { ActionRowBuilder, ContainerBuilder, SeparatorBuilder, StringSelectMenuBuilder } from 'discord.js';
import type { Config } from '../domain/config.js';
import { text } from './components.js';

export function addProviders(menu: ContainerBuilder, id: string, config: Config): void {
  menu.addSeparatorComponents(new SeparatorBuilder());
  menu.addTextDisplayComponents(text('### 📎 送信できるSNSを設定\n取得を許可するサイトを選んでください。複数選択できます。未選択ならURL取得を停止します。'));
  menu.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
    .setCustomId(`cfg:${id}:providers`).setPlaceholder('URL変換するサイト').setMinValues(0).setMaxValues(9)
    .addOptions([{ label: 'X / Twitter', value: 'x', description: '公開投稿に添付された画像・動画・GIFを取得します。' },
      { label: 'Pixiv', value: 'pixiv', description: '作品URLから投稿画像を取得します。' },
      { label: 'Bluesky', value: 'bluesky', description: '公開投稿に添付された画像を取得します。投稿動画には未対応です。' },
      { label: 'Mastodon', value: 'mastodon', description: '公開・未収載の投稿に添付された画像・動画を取得します。' },
      { label: 'Misskey', value: 'misskey', description: '公開・ホーム投稿に添付された画像・動画を取得します。' },
      { label: 'TikTok', value: 'tiktok', description: '公開投稿の画像・動画を取得します。' },
      { label: 'Instagram', value: 'instagram', description: '公開投稿・リールの画像や動画を取得します。' },
      { label: 'Threads', value: 'threads', description: '公開投稿の画像・動画を取得します。' },
      { label: '直接URL・その他の公開ページ', value: 'direct', description: '画像・動画の直接URLや、公開ページの本文画像を取得します。' }].map(item => ({ ...item, default: config.content.providers.includes(item.value as Config['content']['providers'][number]) })))));
}
