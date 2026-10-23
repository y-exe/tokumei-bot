import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commands } from '../src/commands.js';
import { commandDefinitionsEqual, registerGlobalCommands, registerGuildCommands, type RegisteredCommand } from '../src/infra/command-registration.js';

function fixture() {
  let global: RegisteredCommand[] = [];
  const local = new Map<string, RegisteredCommand[]>();
  const changes: string[] = [];
  const api = {
    global: async () => global,
    registerGlobal: async () => { changes.push('global'); global = [...commands]; return global; },
    guildIds: async function* () { yield* local.keys(); },
    guild: async (id: string) => local.get(id) ?? [],
    registerGuild: async (id: string, body: RegisteredCommand[]) => { changes.push(`guild:${id}`); local.set(id, body.map((command,index)=>({...command,id:String(index)}))); },
    removeGuild: async (id: string, commandId: string) => {
      changes.push(`remove:${id}:${commandId}`);
      local.set(id, local.get(id)!.filter(command => command.id !== commandId));
    },
  };
  return { api, local, changes };
}

test('全体への登録成功後に各サーバーの重複だけを削除し、独自コマンドは変更しない', async () => {
  const f=fixture();
  const unique={id:'unique',name:'development',type:1};
  f.local.set('a',[{id:'duplicate',name:'setup',type:1},unique]);
  f.local.set('b',[{id:'context',name:'メッセージに返信',type:3}]);
  const result=await registerGlobalCommands(f.api);
  assert.deepEqual(result,{registered:commands.length,removed:2,updated:true});
  assert.equal(f.changes[0],'global');assert.deepEqual(f.local.get('a'),[unique]);assert.deepEqual(f.local.get('b'),[]);
  const writes=f.changes.length;
  const restart=await registerGlobalCommands(f.api);
  assert.equal(restart.removed,0);assert.equal(restart.updated,false);assert.equal(f.changes.length,writes);
});

test('Discord側のID・順序・既定値の補完を定義の変更と扱わない',()=>{
  const current=commands.map((command,index)=>({
    ...command,id:String(index),application_id:'app',version:'version',description:'description' in command?command.description:'',
    default_member_permissions:null,nsfw:false,integration_types:[0],contexts:null,
    name_localizations:null,description_localizations:null,
  })).reverse();
  assert.equal(commandDefinitionsEqual(current),true);
});

test('説明・引数・選択肢・既定権限の変更と、コマンドの追加・削除を検出する',()=>{
  const changed=()=>structuredClone(commands) as unknown as Record<string,any>[];
  const description=changed();description.find(command=>command.name==='setup')!.description='変更した説明';
  assert.equal(commandDefinitionsEqual(description as RegisteredCommand[]),false);
  const choice=changed();choice.find(command=>command.name==='setup')!.options[0].choices[0].value='different';
  assert.equal(commandDefinitionsEqual(choice as RegisteredCommand[]),false);
  const option=changed();option.find(command=>command.name==='post')!.options[0].max_length=100;
  assert.equal(commandDefinitionsEqual(option as RegisteredCommand[]),false);
  const permission=changed();permission.find(command=>command.name==='setup')!.default_member_permissions='32';
  assert.equal(commandDefinitionsEqual(permission as RegisteredCommand[]),false);
  assert.equal(commandDefinitionsEqual([...commands,{name:'old',type:1}]),false);
  assert.equal(commandDefinitionsEqual(commands.slice(1)),false);
});

test('削除した旧コマンドがサーバー個別側に残っていても整理する',async()=>{
  const f=fixture();
  f.api.global=async()=>[...commands,{id:'old-global',name:'old',type:1}];
  f.local.set('a',[{id:'old-local',name:'old',type:1},{id:'unique',name:'development',type:1}]);
  const result=await registerGlobalCommands(f.api);
  assert.equal(result.updated,true);assert.equal(result.removed,1);assert.equal(f.local.get('a')![0]!.name,'development');
});

test('変更がない場合も残っているサーバー個別の重複は削除する',async()=>{
  const f=fixture();f.api.global=async()=>commands;
  f.local.set('a',[{id:'duplicate',name:'setup',type:1}]);
  const result=await registerGlobalCommands(f.api);
  assert.equal(result.updated,false);assert.equal(result.removed,1);assert.deepEqual(f.changes,['remove:a:duplicate']);
});

test('全体向けの登録が失敗・不完全ならサーバー個別の登録を削除しない', async () => {
  const f=fixture();f.local.set('a',[{id:'duplicate',name:'setup'}]);
  f.api.registerGlobal=async()=>{throw new Error('通信失敗');};
  await assert.rejects(registerGlobalCommands(f.api),/通信失敗/);assert.deepEqual(f.changes,[]);
  f.api.registerGlobal=async()=>[];
  await assert.rejects(registerGlobalCommands(f.api),/確認できない/);assert.equal(f.local.get('a')!.length,1);
});

test('全体向けと重複するサーバー個別登録を拒否し、別のBotでは個別登録できる', async () => {
  const f=fixture();await registerGuildCommands(f.api,'a');assert.equal(f.local.get('a')!.length,commands.length);
  await registerGlobalCommands(f.api);
  const before=[...f.changes];await assert.rejects(registerGuildCommands(f.api,'a'),/重複/);assert.deepEqual(f.changes,before);
});
