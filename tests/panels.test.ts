import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, type Client } from 'discord.js';
import { Panels } from '../src/services/panels.js';
import { defaults } from '../src/domain/config.js';
import type { Store } from '../src/infra/store.js';

function fixture(replace=true) {
  const actions:string[]=[];let enabled=true;let latest:string|undefined;let panelDeleted=false;
  const config=structuredClone(defaults);config.panel.style='embed';
  const store={settings:async()=>({guildId:'g',channelId:'c',enabled,panelId:panelDeleted?null:'old',config}),
    replacePanel:async()=>{actions.push('save:new');return replace;}} as unknown as Store;
  const channel={
    send:async()=>{actions.push('send:new');return {id:'new',delete:async()=>{actions.push('delete:new');}};},
    messages:{fetch:async(query?:{limit?:number})=>{
      if(query?.limit===1)return {first:()=>latest?{id:latest}:undefined};
      if(panelDeleted)throw new Error('Unknown Message');
      return {id:'old'};
    },delete:async(id:string)=>{actions.push('delete:'+id);}}};
  const client={channels:{fetch:async()=>({type:ChannelType.GuildText,guild:{id:'g'},...channel})}} as unknown as Client;
  return {service:new Panels(client,store),actions,config,disable:()=>{enabled=false;},setLatest:(id?:string)=>{latest=id;},deletePanel:()=>{panelDeleted=true;}};
}
test('案内の再送は新しい案内を送信・保存してから古い案内だけを削除する',async()=>{
  const f=fixture();await f.service.bump('g','c');
  assert.deepEqual(f.actions,['send:new','save:new','delete:old']);
});
test('案内がすでに末尾にあるときは再送せずそのまま使う',async()=>{
  const f=fixture();f.setLatest('old');await f.service.bump('g','c');
  assert.deepEqual(f.actions,[]);
});
test('停止中・再送offでは案内を送信せず、設定競合時は新しい案内だけを取り消す',async()=>{
  const f=fixture();f.disable();await f.service.bump('g','c');assert.equal(f.actions.length,0);
  const off=fixture();off.config.panel.repost=false;await off.service.bump('g','c');assert.equal(off.actions.length,0);
  const race=fixture(false);await assert.rejects(race.service.bump('g','c'),/再送を取り消し/);
  assert.deepEqual(race.actions,['send:new','save:new','delete:new']);
});
test('同じチャンネルの複数投稿で案内の再送・削除処理が交差しない',async()=>{
  const f=fixture();await Promise.all([f.service.bump('g','c'),f.service.bump('g','c')]);
  assert.deepEqual(f.actions,['send:new','save:new','delete:old','send:new','save:new','delete:old']);
});
test('起動時の確認は末尾の案内をそのまま保持する',async()=>{
  const f=fixture();f.setLatest('old');await f.service.restore('g','c');
  assert.deepEqual(f.actions,[]);
});
test('起動時は末尾にない・消えている案内を送り直してボタンを復活させる',async()=>{
  const f=fixture();f.setLatest('other');await f.service.restore('g','c');
  assert.deepEqual(f.actions,['send:new','save:new','delete:old']);
  const gone=fixture();gone.deletePanel();await gone.service.restore('g','c');
  assert.deepEqual(gone.actions,['send:new','save:new']);
});
test('起動時は停止中・チャンネル不明の場合は何もしない',async()=>{
  const f=fixture();f.disable();f.setLatest('other');await f.service.restore('g','c');assert.equal(f.actions.length,0);
  const broken=new Panels({channels:{fetch:async()=>{throw new Error('missing access');}}} as unknown as Client,
    {settings:async()=>({guildId:'g',channelId:'c',enabled:true,panelId:'old',config:structuredClone(defaults)})} as unknown as Store);
  await assert.doesNotReject(broken.restore('g','c'));
});
test('再送offでも案内が消えていれば起動時にだけ再設置する',async()=>{
  const off=fixture();off.config.panel.repost=false;off.setLatest('other');await off.service.restore('g','c');
  assert.deepEqual(off.actions,[]);
  const gone=fixture();gone.config.panel.repost=false;gone.deletePanel();await gone.service.restore('g','c');
  assert.deepEqual(gone.actions,['send:new','save:new']);
});