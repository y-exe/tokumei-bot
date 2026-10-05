import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, type Client } from 'discord.js';
import { Panels } from '../src/services/panels.js';
import { defaults } from '../src/domain/config.js';
import type { Store } from '../src/infra/store.js';

function fixture(replace=true) {
  const actions:string[]=[];let enabled=true;
  const config=structuredClone(defaults);config.panel.style='embed';
  const store={settings:async()=>({guildId:'g',channelId:'c',enabled,panelId:'old',config}),
    replacePanel:async()=>{actions.push('save:new');return replace;}} as unknown as Store;
  const client={channels:{fetch:async()=>({type:ChannelType.GuildText,guild:{id:'g'},
    send:async()=>{actions.push('send:new');return {id:'new',delete:async()=>{actions.push('delete:new');}};},
    messages:{delete:async(id:string)=>{actions.push('delete:'+id);}}})}} as unknown as Client;
  return {service:new Panels(client,store),actions,config,disable:()=>{enabled=false;}};
}
test('案内の再送は新しい案内を送信・保存してから古い案内だけを削除する',async()=>{
  const f=fixture();await f.service.bump('g','c');
  assert.deepEqual(f.actions,['send:new','save:new','delete:old']);
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
