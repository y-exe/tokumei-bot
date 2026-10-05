import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import type {Client} from 'discord.js';
import {lookupServer} from '../src/infra/lookup.js';

test('Web lookupはループバック限定・認証必須で、CSRFを拒否し結果をエスケープする',async()=>{
  let searches=0;const token='test-admin-secret-'.repeat(3);
  const server=lookupServer({lookupAuthor:async()=>{searches++;return{user_id:'300000000000000001',guild_id:'g',channel_id:'c'};}},
    {users:{fetch:async()=>({globalName:'<script>alert(1)</script>',username:'user'})}} as unknown as Pick<Client,'users'>,token,0);
  await once(server,'listening');const address=server.address() as AddressInfo;assert.equal(address.address,'127.0.0.1');
  const origin=`http://127.0.0.1:${address.port}`;
  const post=(path:string,form:Record<string,string>,cookie?:string,requestOrigin=origin)=>fetch(origin+path,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:requestOrigin,...(cookie?{Cookie:cookie}:{})},body:new URLSearchParams(form)});
  try{
    assert.equal((await post('/lookup',{id:'400000000000000001'})).status,401);assert.equal(searches,0);
    assert.equal((await post('/login',{token:'wrong'})).status,401);
    assert.equal((await post('/login',{token},undefined,'https://evil.example')).status,403);
    assert.equal((await post('/login',{token},undefined,'null')).status,403);
    assert.equal((await post('/launch',{token:'wrong'})).status,401);
    const launch=await post('/launch',{token});const ticket=(await launch.json() as {ticket:string}).ticket;
    const open=await fetch(`${origin}/open?ticket=${ticket}`,{redirect:'manual'});assert.equal(open.status,303);assert.ok(open.headers.get('set-cookie')?.includes('HttpOnly'));
    assert.equal((await fetch(`${origin}/open?ticket=${ticket}`,{redirect:'manual'})).status,401);
    const launchedHome=await (await fetch(origin,{headers:{Cookie:open.headers.get('set-cookie')!}})).text();assert.ok(launchedHome.includes('placeholder="メッセージID"'));assert.ok(!launchedHome.includes('name="token"'));
    const expiredTicket=(await (await post('/launch',{token})).json() as {ticket:string}).ticket;
    const future=Date.now()+31_000;const clock=mock.method(Date,'now',()=>future);
    try{assert.equal((await fetch(`${origin}/open?ticket=${expiredTicket}`,{redirect:'manual'})).status,401);}finally{clock.mock.restore();}
    const login=await post('/login',{token});assert.equal(login.status,303);
    const cookie=login.headers.get('set-cookie')!;assert.ok(cookie.includes('HttpOnly'));assert.ok(cookie.includes('SameSite=Strict'));
    const homeResponse=await fetch(origin,{headers:{Cookie:cookie}});assert.equal(homeResponse.headers.get('referrer-policy'),'same-origin');
    const home=await homeResponse.text();const csrf=home.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
    assert.equal((await post('/lookup',{id:'400000000000000001',csrf:'wrong'},cookie)).status,403);assert.equal(searches,0);
    const result=await post('/lookup',{id:'400000000000000001',csrf},cookie);assert.equal(result.headers.get('cache-control'),'no-store');
    const html=await result.text();assert.ok(html.includes('300000000000000001'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));assert.equal(searches,1);
    await post('/logout',{csrf},cookie);assert.equal((await post('/lookup',{id:'400000000000000001',csrf},cookie)).status,401);
    for(let n=0;n<5;n++)assert.equal((await post('/login',{token:'wrong'})).status,401);
    assert.equal((await post('/login',{token})).status,429);
  }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
