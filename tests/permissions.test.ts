import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BotAdminDirectory, initializeBotAdmins, isBotAdmin } from '../src/domain/permissions.js';

const first = '300000000000000001', second = '300000000000000002';

test('URL未設定では固定IDへのフォールバックをせず、誰にも運営者権限を付けない',async()=>{
  await initializeBotAdmins(undefined,async()=>{throw new Error('呼び出し禁止');});
  assert.equal(isBotAdmin('483307286513582090'),false);assert.equal(isBotAdmin(first),false);
});

test('URLの応答が変わると新しい運営者へ切り替え、以前の運営者を直ちに外す',async()=>{
  let value=first;const directory=new BotAdminDirectory('https://admin.example/id',async url=>{assert.equal(url,'https://admin.example/id');return ` ${value}\n`;});
  assert.equal(directory.has(first),false);
  await directory.refresh();assert.equal(directory.has(first),true);assert.equal(directory.has(second),false);
  value=second;await directory.refresh();assert.equal(directory.has(first),false);assert.equal(directory.has(second),true);
});

test('通信失敗・不正な応答が続いても運営者権限は2分で失効する',async()=>{
  let now=0,fail=false;
  const directory=new BotAdminDirectory('https://admin.example/id',async()=>{if(fail)throw new Error('取得失敗');return first;},()=>now);
  await directory.refresh();fail=true;now=60_000;
  await assert.rejects(directory.refresh());assert.equal(directory.has(first),true);
  now=120_000;assert.equal(directory.has(first),false);
  for(const value of ['<html>error</html>',`${first}\n${second}`,'18446744073709551616','00000000000000000','']) {
    const invalid=new BotAdminDirectory('https://admin.example/id',async()=>value);
    await assert.rejects(invalid.refresh(),/1件だけ/);assert.equal(invalid.has(first),false);
  }
});

test('更新が重なってもURLへの取得は1回だけで、初回失敗は起動処理へ伝える',async()=>{
  let count=0;let finish!:(id:string)=>void;
  const directory=new BotAdminDirectory('https://admin.example/id',()=>{count++;return new Promise(resolve=>{finish=resolve;});});
  const a=directory.refresh(),b=directory.refresh();assert.equal(a,b);
  await Promise.resolve();finish(first);await a;assert.equal(count,1);
  await assert.rejects(initializeBotAdmins('https://admin.example/id',async()=>{throw new Error('取得失敗');}),/取得失敗/);
  assert.equal(isBotAdmin(first),false);
  assert.throws(()=>new BotAdminDirectory('http://admin.example/id',async()=>first),/HTTPS/);
  assert.throws(()=>new BotAdminDirectory('https://user:password@admin.example/id',async()=>first),/HTTPS/);
});
