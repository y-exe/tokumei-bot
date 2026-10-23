import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commands } from '../src/commands.js';
import { registerGlobalCommands, registerGuildCommands, type RegisteredCommand } from '../src/infra/command-registration.js';

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
  assert.deepEqual(result,{registered:commands.length,removed:2});
  assert.equal(f.changes[0],'global');assert.deepEqual(f.local.get('a'),[unique]);assert.deepEqual(f.local.get('b'),[]);
  assert.equal((await registerGlobalCommands(f.api)).removed,0);
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
