import {ContainerBuilder,ButtonStyle,SeparatorBuilder} from 'discord.js';
import {button,row,text,uiEmoji,legalLinks,colors} from './components.js';
import type {ReportNotice} from '../infra/store.js';
const code=(value:string)=>'```\n'+value.slice(0,1000).replace(/`/g,'ˋ')+'\n```';
export function reportView(notice:ReportNotice & {reporters?:string[]},request:boolean,completed?:string):ContainerBuilder{
  const timestamp=/^\d{17,20}$/.test(notice.message_id)?`<t:${Math.floor(Number((BigInt(notice.message_id)>>22n)+1420070400000n)/1000)}:F>`:'取得できませんでした';
  const result=new ContainerBuilder().setAccentColor(colors.report).addTextDisplayComponents(text(`## ${uiEmoji.flag} 匿名メッセージの通報`));
  result.addTextDisplayComponents(text(`**メッセージの情報**\n**${uiEmoji.time} 送信時刻**: ${timestamp}\n**${uiEmoji.content} 送信内容**: ${code(notice.content||'画像投稿')}`));
  if(notice.reason)result.addTextDisplayComponents(text(`**補足・詳細**\n${code(notice.reason)}`));
  result.addTextDisplayComponents(text(`**${uiEmoji.count} 報告人数**\n${notice.count}人`));
  result.addTextDisplayComponents(text(`**${uiEmoji.reporter} 報告者**\n${notice.reporters?.length?notice.reporters.map(id=>`<@${id}>`).join(' ').slice(0,2000):'非公開'}`));
  result.addTextDisplayComponents(text(`[元メッセージ](https://discord.com/channels/${notice.guild_id}/${notice.channel_id}/${notice.message_id}) · <#${notice.channel_id}>`));
  if(completed)result.addTextDisplayComponents(text(`**終了済み（${completed}）**`));
  else{
    result.addSeparatorComponents(new SeparatorBuilder());
    const controls=[...(request?[button(`punish:${notice.message_id}:revoke:${notice.channel_id}`,'使用権剥奪',ButtonStyle.Danger)]:[]),button(`punish:${notice.message_id}:ban:${notice.channel_id}`,'サーバーBAN',ButtonStyle.Danger),button(`punish:${notice.message_id}:timeout:${notice.channel_id}`,'1ヶ月TO(28日間)',ButtonStyle.Primary),button(`punish:${notice.message_id}:none:${notice.channel_id}`,'処罰なし',ButtonStyle.Secondary)];
    result.addActionRowComponents(row(...controls));
    result.addTextDisplayComponents(text(`-# ${legalLinks}`));
  }
  return result;
}
