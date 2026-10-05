import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from 'discord.js';
import type { Store } from '../src/infra/store.js';
import { defaults } from '../src/domain/config.js';
import { guardChannel } from '../src/services/channel-guard.js';
import {colors,uiEmoji} from '../src/ui/components.js';

function fixture(options: {enabled?:boolean;bot?:boolean;webhook?:boolean;manager?:boolean;role?:boolean;direct?:boolean;dmFails?:boolean;deleteFails?:boolean} = {}) {
  const events:string[]=[]; const notices:unknown[]=[];
  const message={guildId:'g',channelId:'c',webhookId:options.webhook?'w':null,content:'誤投稿',
    author:{bot:!!options.bot,id:'u',send:async(value:unknown)=>{events.push('dm');notices.push(value);if(options.dmFails)throw new Error('closed');}},
    member:{permissions:{has:()=>!!options.manager},roles:{cache:new Map([['role',{id:options.role?'manager':'other'}]])}},
    delete:async()=>{events.push('delete');if(options.deleteFails)throw new Error('forbidden');}};
  const roles = {some:(predicate:(role:{id:string})=>boolean)=>predicate({id:options.role?'manager':'other'})};
  message.member.roles.cache=roles as unknown as typeof message.member.roles.cache;
  const config=structuredClone(defaults);config.moderation.managerRoles=['manager'];
  config.moderation.allowDirectPosts=options.direct??false;
  const store={settings:async()=>({enabled:options.enabled??true,config})};
  return {message:message as unknown as Message,store:store as unknown as Store,events,notices};
}
test('匿名チャンネルへの通常投稿を削除してからDMで警告する',async()=>{
  const f=fixture();await guardChannel(f.message,f.store);assert.deepEqual(f.events,['delete','dm']);
  const payload=f.notices[0] as {embeds:{toJSON:()=>{title:string;fields:{value:string}[]}}[];allowedMentions:unknown};
  assert.equal(payload.embeds[0]!.toJSON().title,`${uiEmoji.error} メッセージを削除しました`);
  assert.equal((payload.embeds[0]!.toJSON() as {color:number}).color,colors.danger);
  assert.equal(payload.embeds[0]!.toJSON().fields[0]!.value,'誤投稿');
  assert.deepEqual(payload.allowedMentions,{parse:[]});
});
test('未設定チャンネル・Bot・Webhook・管理者の投稿は削除しない',async()=>{
  for(const options of [{enabled:false},{bot:true},{webhook:true},{manager:true},{role:true},{direct:true}]){
    const f=fixture(options);await guardChannel(f.message,f.store);assert.deepEqual(f.events,[]);
  }
});
test('DM拒否でも削除は完了し、削除失敗時は削除済み通知を送らない',async()=>{
  const closed=fixture({dmFails:true});await guardChannel(closed.message,closed.store);assert.deepEqual(closed.events,['delete','dm']);
  const forbidden=fixture({deleteFails:true});await guardChannel(forbidden.message,forbidden.store);assert.deepEqual(forbidden.events,['delete']);
});
