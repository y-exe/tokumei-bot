import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PermissionFlagsBits,PermissionsBitField,type Guild} from 'discord.js';
import {Moderation} from '../src/services/moderation.js';
import {reportView} from '../src/ui/report.js';
import {colors,uiEmoji} from '../src/ui/components.js';
import {defaults} from '../src/domain/config.js';
import type {Store,ReportDetail} from '../src/infra/store.js';
import type {Posting} from '../src/services/posting.js';
const detail:ReportDetail={guild_id:'g',channel_id:'c',message_id:'1401157007691743312',content:'本文```',reason:'理由',nonce:'n',count:1,reporters:['reporter'],userId:'secret-author',anonymousId:5,notificationId:'notice'};
function fixture(){
  const calls:unknown[]=[];const config=structuredClone(defaults);
  const permissions=new PermissionsBitField([PermissionFlagsBits.ManageGuild,PermissionFlagsBits.BanMembers,PermissionFlagsBits.ModerateMembers]);
  const actor={id:'actor',permissions,roles:{cache:[],highest:{comparePositionTo:()=>1}}};
  const target={id:detail.userId,bannable:true,moderatable:true,roles:{highest:{}},ban:async(options:unknown)=>{calls.push(['ban',options]);},timeout:async(duration:number,reason:string)=>{calls.push(['timeout',duration,reason]);}};
  const guild={id:'g',ownerId:'owner',members:{fetch:async(id:string)=>id==='actor'?actor:target,fetchMe:async()=>({permissions})}} as unknown as Guild;
  const store={settings:async()=>({config}),reportDetail:async()=>detail,claimReportAction:async()=>{calls.push('claim');return 'token';},finishReportAction:async(...args:unknown[])=>{calls.push(['finish',...args]);},releaseReportAction:async()=>{calls.push('release');}} as unknown as Store;
  const posting={remove:async()=>{calls.push('remove');}} as unknown as Posting;
  return {service:new Moderation(store,posting),store,posting,guild,actor,target,config,calls};
}
test('旧通報の絵文字・色・ボタンをV2で再現し、匿名投稿者は表示しない',()=>{
  const normal=reportView(detail,false).toJSON();const json=JSON.stringify(normal);
  assert.equal(normal.accent_color,colors.report);assert.ok(json.includes(uiEmoji.flag));
  for(const value of ['匿名メッセージの通報','1407591216459153460','サーバーBAN','1ヶ月TO(28日間)','処罰なし','利用規約'])assert.ok(json.includes(value));
  assert.ok(!json.includes('secret-author'));assert.ok(!json.includes('使用権剥奪'));assert.ok(json.includes('ˋˋˋ'));
  assert.ok(JSON.stringify(reportView(detail,true).toJSON()).includes('使用権剥奪'));
  const ended=JSON.stringify(reportView(detail,true,'処罰なし').toJSON());assert.ok(ended.includes('終了済み'));assert.ok(!ended.includes('punish:'));
});
test('BANは過去メッセージの一括削除をせず、完了後に対象投稿だけを削除する',async()=>{
  const f=fixture();await f.service.execute(f.guild,'c',detail.message_id,'actor','ban','理由');
  assert.deepEqual(f.calls[1],['ban',{reason:'理由',deleteMessageSeconds:0}]);assert.equal(f.calls.at(-1),'remove');
});
test('タイムアウトは旧版同様28日間から1分引いた期間で実行する',async()=>{
  const f=fixture();await f.service.execute(f.guild,'c',detail.message_id,'actor','timeout','理由');
  assert.deepEqual(f.calls[1],['timeout',28*86400000-60000,'理由']);
});
test('処罰なしはDiscord処罰・投稿削除をせず、使用権剥奪は要望のみ許可する',async()=>{
  const f=fixture();await f.service.execute(f.guild,'c',detail.message_id,'actor','none','理由');assert.equal(f.calls.length,2);
  await assert.rejects(f.service.execute(f.guild,'c',detail.message_id,'actor','revoke','理由'),/匿名要望/);
  f.config.identity.kind='request';await f.service.execute(f.guild,'c',detail.message_id,'actor','revoke','理由');
  assert.equal((f.calls.at(-1) as unknown[]).at(-1),detail.userId);assert.ok(!f.calls.includes('remove'));
});
test('権限不足・ロール順位・処理済みなら処罰APIを呼ばない',async()=>{
  const f=fixture();f.actor.permissions.remove(PermissionFlagsBits.BanMembers);
  await assert.rejects(f.service.execute(f.guild,'c',detail.message_id,'actor','ban','理由'),/権限/);assert.deepEqual(f.calls,[]);
  f.actor.permissions.add(PermissionFlagsBits.BanMembers);f.actor.roles.highest.comparePositionTo=()=>0;
  await assert.rejects(f.service.execute(f.guild,'c',detail.message_id,'actor','ban','理由'),/順位/);assert.deepEqual(f.calls,[]);
  f.actor.roles.highest.comparePositionTo=()=>1;f.store.claimReportAction=async()=>{throw new Error('対応済み');};
  await assert.rejects(f.service.execute(f.guild,'c',detail.message_id,'actor','ban','理由'),/対応済み/);assert.deepEqual(f.calls,[]);
});
test('処罰成功後のDB失敗・結果不明の通信失敗は再実行可能に戻さない',async()=>{
  const f=fixture();f.store.finishReportAction=async()=>{throw new Error('db');};
  await assert.rejects(f.service.execute(f.guild,'c',detail.message_id,'actor','ban','理由'),/実行されました/);assert.ok(!f.calls.includes('release'));
  const network=fixture();network.target.ban=async()=>{throw new Error('network');};
  await assert.rejects(network.service.execute(network.guild,'c',detail.message_id,'actor','ban','理由'),/結果を確認/);assert.ok(!network.calls.includes('release'));
});
test('Discordが明示的に拒否した場合のみリースを戻し、削除失敗は処罰成功として返す',async()=>{
  const denied=fixture();denied.target.ban=async()=>{throw {code:50013};};
  await assert.rejects(denied.service.execute(denied.guild,'c',detail.message_id,'actor','ban','理由'));assert.ok(denied.calls.includes('release'));
  const deleted=fixture();deleted.posting.remove=async()=>{throw new Error('delete');};
  assert.match((await deleted.service.execute(deleted.guild,'c',detail.message_id,'actor','ban','理由')).warning,/実行済み/);
});
