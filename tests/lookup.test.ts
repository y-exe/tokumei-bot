import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {request} from 'node:http';
import type {AddressInfo} from 'node:net';
import type {Client} from 'discord.js';
import {lookupServer} from '../src/infra/lookup.js';

const fetch=(url:string,options:{method?:string;headers?:Record<string,string>;body?:URLSearchParams}={})=>new Promise<Response>((resolve,reject)=>{
  const req=request(url,{method:options.method??'GET',headers:options.headers},response=>{
    const parts:Buffer[]=[];response.on('data',part=>parts.push(part));response.on('error',reject);
    response.on('end',()=>{
      const headers=new Headers();for(const [key,value] of Object.entries(response.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(','):value);
      resolve(new Response(Buffer.concat(parts).toString(),{status:response.statusCode!,headers}));
    });
  });req.on('error',reject);req.end(options.body?.toString());
});

test('lookupはTailscale本人情報で認証し、旧ログイン・CSRF・別アカウントのセッションを拒否する',async()=>{
  let searches=0;
  const origin='https://server.example.ts.net';const login='owner@example.com';
  const server=lookupServer({lookupAuthor:async()=>{searches++;return{user_id:'300000000000000001',guild_id:'g',channel_id:'c'};}},
    {users:{fetch:async()=>({globalName:'<script>alert(1)</script>',username:'user'})}} as unknown as Pick<Client,'users'>,origin,[login,'other@example.com'],0);
  await once(server,'listening');const address=server.address() as AddressInfo;assert.equal(address.address,'127.0.0.1');
  const backend=`http://127.0.0.1:${address.port}`;
  const headers={Host:'server.example.ts.net','Tailscale-User-Login':login};
  const post=(form:Record<string,string>,cookie:string,requestOrigin=origin,requestLogin=login)=>fetch(backend+'/lookup/search',{method:'POST',headers:{...headers,'Tailscale-User-Login':requestLogin,'Content-Type':'application/x-www-form-urlencoded',Origin:requestOrigin,Cookie:cookie},body:new URLSearchParams(form)});
  try{
    assert.equal((await fetch(backend+'/lookup/',{headers:{Host:headers.Host}})).status,403);
    assert.equal((await fetch(backend+'/lookup/',{headers:{...headers,'Tailscale-User-Login':'tagged-devices'}})).status,403);
    assert.equal((await fetch(backend+'/lookup/',{headers:{...headers,Host:'evil.example'}})).status,403);
    assert.equal((await post({id:'400000000000000001'},'')).status,401);assert.equal(searches,0);
    const redirect=await fetch(backend+'/lookup',{headers});assert.equal(redirect.status,308);assert.equal(redirect.headers.get('location'),'/lookup/');
    for(const path of ['/','/login','/launch','/open?ticket=old','/logout','/other/'])assert.equal((await fetch(backend+path,{headers})).status,404);
    const homeResponse=await fetch(backend+'/lookup/',{headers});assert.equal(homeResponse.status,200);
    const cookie=homeResponse.headers.get('set-cookie')!;
    assert.ok(cookie.includes('Path=/lookup/'));assert.ok(cookie.includes('Secure'));assert.ok(cookie.includes('HttpOnly'));assert.ok(cookie.includes('SameSite=Strict'));
    const home=await homeResponse.text();assert.ok(!home.includes('password'));assert.ok(!home.includes('name="token"'));
    const csrf=home.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
    assert.equal((await post({id:'400000000000000001',csrf},cookie,'https://evil.example')).status,403);
    assert.equal((await post({id:'400000000000000001',csrf},cookie,'null')).status,403);
    assert.equal((await post({id:'400000000000000001',csrf:'wrong'},cookie)).status,403);
    assert.equal((await post({id:'400000000000000001',csrf},cookie,origin,'other@example.com')).status,401);
    assert.equal(searches,0);
    const result=await post({id:'400000000000000001',csrf},cookie);assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'no-store');
    const html=await result.text();assert.ok(html.includes('300000000000000001'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));assert.equal(searches,1);
    await post({id:'not-an-id',csrf},cookie);assert.equal(searches,1);
    const future=Date.now()+30*60_000+1;const clock=mock.method(Date,'now',()=>future);
    try{
      assert.equal((await post({id:'400000000000000001',csrf},cookie)).status,401);
      const refreshed=await fetch(backend+'/lookup/',{headers:{...headers,Cookie:cookie}});assert.equal(refreshed.status,200);assert.ok(refreshed.headers.get('set-cookie'));
    }finally{clock.mock.restore();}
  }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

test('Tailscale HTTPS接続先と許可アカウントが不正なら起動しない',()=>{
  const store={lookupAuthor:async()=>null};const client={users:{}} as Pick<Client,'users'>;
  assert.throws(()=>lookupServer(store,client,'http://server.example.ts.net',['owner'],0));
  assert.throws(()=>lookupServer(store,client,'https://public.example.com',['owner'],0));
  assert.throws(()=>lookupServer(store,client,'https://server.example.ts.net',[],0));
});
