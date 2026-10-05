import {PermissionFlagsBits,type Guild} from 'discord.js';
import {UserError} from '../domain/errors.js';
import {isRequestMode} from '../domain/config.js';
import type {Store,ReportDetail} from '../infra/store.js';
import type {Posting} from './posting.js';
export type Punishment='ban'|'timeout'|'revoke'|'none';
export const punishmentLabels={ban:'サーバーBAN',timeout:'1ヶ月TO（28日間）',revoke:'匿名要望の使用権剥奪',none:'処罰なし'};
export class Moderation{
  constructor(readonly store:Store,readonly posting:Posting){}
  async execute(guild:Guild,channelId:string,messageId:string,actorId:string,action:Punishment,reason:string):Promise<{report:ReportDetail;warning:string}>{
    if(!Object.hasOwn(punishmentLabels,action))throw new UserError('処罰操作を確認してください。');
    const config=(await this.store.settings(guild.id,channelId,true)).config;
    if(config.policy.retentionDays===0||config.policy.reportRetentionDays===0)throw new UserError('保存しない設定のチャンネルでは通報処罰を利用できません。');
    const actor=await guild.members.fetch(actorId);
    if(!actor.permissions.has(PermissionFlagsBits.ManageGuild)&&!actor.roles.cache.some(role=>config.moderation.managerRoles.includes(role.id)))throw new UserError('通報対応の管理権限が必要です。');
    if(action==='revoke'&&!isRequestMode(config))throw new UserError('使用権剥奪は匿名要望の通報だけに実行できます。');
    const report=await this.store.reportDetail(guild.id,channelId,messageId);
    if(!report)throw new UserError('この通報は対応済みか、処理中・保存期限切れです。');
    if(action!=='none'&&!report.userId)throw new UserError('投稿者対応が保存されていないため処罰できません。');
    let target;
    if(action==='ban'||action==='timeout'){
      const permission=action==='ban'?PermissionFlagsBits.BanMembers:PermissionFlagsBits.ModerateMembers;
      if(!actor.permissions.has(permission))throw new UserError('この処罰に必要なDiscordの権限がありません。');
      const me=await guild.members.fetchMe();if(!me.permissions.has(permission))throw new UserError('Botにこの処罰に必要なDiscordの権限がありません。');
      target=await guild.members.fetch(report.userId).catch(()=>null);
      if(!target)throw new UserError('処罰対象がサーバー内に見つかりません。');
      if(target.id===actor.id||target.id===guild.ownerId||(actor.id!==guild.ownerId&&actor.roles.highest.comparePositionTo(target.roles.highest)<=0)||!(action==='ban'?target.bannable:target.moderatable))throw new UserError('ロールの順位などにより、この投稿者への処罰は実行できません。');
    }
    const token=await this.store.claimReportAction(guild.id,channelId,messageId);
    let external=false,warning='';
    try{
      if(action==='ban'){await target!.ban({reason:reason||undefined,deleteMessageSeconds:0});external=true;}
      if(action==='timeout'){await target!.timeout(28*86_400_000-60_000,reason||undefined);external=true;}
      await this.store.finishReportAction(guild.id,messageId,token,actorId,action,reason,action==='revoke'?report.userId:undefined);
    }catch(error){
      if(!external&&(action==='none'||action==='revoke'||(typeof error==='object'&&error&&'code' in error&&typeof error.code==='number')))await this.store.releaseReportAction(guild.id,messageId,token).catch(()=>undefined);
      throw new UserError(external?'処罰は実行されましたが履歴の更新に失敗しました。再実行せずBot管理者へ確認してください。':'処罰の結果を確認できませんでした。二重実行を避けるため、Bot管理者へ確認してください。');
    }
    if(action==='ban'||action==='timeout'){
      try{await this.posting.remove(guild.id,channelId,messageId);}catch{warning='処罰は実行済みですが、元メッセージを削除できませんでした。';}
    }
    return {report,warning};
  }
}
