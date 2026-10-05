import { FileUploadBuilder, LabelBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder } from 'discord.js';
import { urlMethodLabel, type Config } from '../domain/config.js';

export function input(id: string, label: string, value = '', max = 1000, paragraph = false, required = true): LabelBuilder {
  const field = new TextInputBuilder().setCustomId(id).setStyle(paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setMaxLength(max).setRequired(required);
  if (value) field.setValue(value);
  return new LabelBuilder().setLabel(label).setTextInputComponent(field);
}
export function choice(id:string,label:string,value:string,options:{label:string;value:string;description?:string}[]):LabelBuilder {
  return new LabelBuilder().setLabel(label).setStringSelectMenuComponent(new StringSelectMenuBuilder()
    .setCustomId(id).setMinValues(1).setMaxValues(1).setRequired(true)
    .addOptions(options.map(option=>({...option,default:option.value===value}))));
}
export function postModal(kind: 'text' | 'image' | 'url', config: Config, customId = `submit:${kind}`): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(kind === 'text' ? '匿名で投稿' : kind === 'image' ? '匿名で画像を送る' : urlMethodLabel(config));
  if (kind === 'url') modal.addLabelComponents(input('url', urlMethodLabel(config), '', 1000));
  if (kind === 'image') modal.addLabelComponents(new LabelBuilder().setLabel(`画像を選択（${config.content.maxFiles}枚まで）`)
    .setDescription('ファイル名や位置情報は投稿時に取り除きます。')
    .setFileUploadComponent(new FileUploadBuilder().setCustomId('files').setMinValues(1).setMaxValues(config.content.maxFiles).setRequired(true)));
  if (kind === 'text' || config.content.caption)
    modal.addLabelComponents(input('text', kind === 'text' ? '本文' : '説明文（任意）', '', 1800, true, kind === 'text'));
  return modal;
}
