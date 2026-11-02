import { FileUploadBuilder, LabelBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder } from 'discord.js';
import { urlMethodLabel, type Config } from '../domain/config.js';

export function input(id: string, label: string, value = '', max = 1000, paragraph = false, required = true): LabelBuilder {
  const field = new TextInputBuilder().setCustomId(id).setStyle(paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setMaxLength(max).setRequired(required);
  if (value) field.setValue(value);
  return new LabelBuilder().setLabel(label).setTextInputComponent(field);
}
export function choice(id:string,label:string,value:string,options:{label:string;value:string;description?:string}[]):LabelBuilder {
  const toggles: Record<string, [string, string]> = {
    repost: ['投稿後に案内をチャンネルの最下部へ移動し、次の人が使いやすくします。', '投稿後も案内を元の位置に残します。'],
    urlAutoLabel: ['許可したSNS名をURL送信ボタンに自動表示します。', '「ボタン名」で設定した固定のラベルを表示します。'],
    showId: ['投稿に匿名IDを表示します。実際のDiscordユーザーIDではありません。', '投稿上の匿名IDを非表示にします。ログの保存期間とは別の設定です。'],
    caption: ['画像・動画に説明文を添えられます。送信前の編集も利用できます。', '画像や動画だけを送信し、説明文の入力・編集欄を隠します。'],
  };
  const styles: Record<string, string> = { primary: '青色のボタンにします。投稿ボタンの機能は変わりません。', secondary: '灰色のボタンにします。投稿ボタンの機能は変わりません。', success: '緑色のボタンにします。投稿ボタンの機能は変わりません。', danger: '赤色のボタンにします。投稿ボタンの機能は変わりません。' };
  return new LabelBuilder().setLabel(label).setStringSelectMenuComponent(new StringSelectMenuBuilder()
    .setCustomId(id).setMinValues(1).setMaxValues(1).setRequired(true)
    .addOptions(options.map(option=>({...option, description: option.description ?? toggles[id]?.[option.value === 'on' ? 0 : 1] ?? styles[option.value] ?? `${option.label}を選択します。`, default:option.value===value}))));
}
export function postModal(kind: 'text' | 'image' | 'url', config: Config, customId = `submit:${kind}`): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(kind === 'text' ? '匿名で投稿' : kind === 'image' ? '匿名で画像を送る' : 'URLから画像を送る');
  if (kind === 'url') {
    const field = new TextInputBuilder().setCustomId('url').setStyle(TextInputStyle.Short).setMaxLength(1000).setRequired(true);
    const label = new LabelBuilder().setLabel('URLを入力').setTextInputComponent(field);
    const services = urlMethodLabel(config);
    if (services && services !== '対応URLなし') label.setDescription(`${services} に対応しています。`);
    modal.addLabelComponents(label);
  }
  if (kind === 'image') modal.addLabelComponents(new LabelBuilder().setLabel('ファイルを選択（10個まで）')
    .setDescription('画像は位置情報を取り除いて最適化し、その他のファイルはそのまま送ります。')
    .setFileUploadComponent(new FileUploadBuilder().setCustomId('files').setMinValues(1).setMaxValues(10).setRequired(true)));
  if (kind === 'text' || config.content.caption)
    modal.addLabelComponents(input('text', kind === 'text' ? '本文' : '説明文（任意）', '', 1800, true, kind === 'text'));
  return modal;
}
