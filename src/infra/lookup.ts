import {createServer,type Server,type IncomingMessage,type ServerResponse} from 'node:http';
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import type {Client} from 'discord.js';
import type {Store} from './store.js';

const escape=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
const hash=(value:string)=>createHash('sha256').update(value).digest();
const ttl=30*60_000;
export function lookupServer(store:Pick<Store,'lookupAuthor'>,client:Pick<Client,'users'>,token:string,port=8765):Server {
  if(token.length<32)throw new Error('LOOKUP_ADMIN_TOKENは32文字以上の専用キーを指定してください。');
  const sessions=new Map<string,{expires:number;csrf:string}>();
  const tickets=new Map<string,number>();
  const startSession=(response:ServerResponse,now:number)=>{
    if(sessions.size>=20)sessions.delete(sessions.keys().next().value!);
    const key=randomBytes(32).toString('hex');sessions.set(key,{expires:now+ttl,csrf:randomBytes(32).toString('hex')});
    response.writeHead(303,{'Location':'/','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Set-Cookie':`lookup_session=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`});response.end();
  };
  let failures=0,blockedUntil=0;
  const send=(response:ServerResponse,status:number,body:string)=>{
    response.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'same-origin','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});
    response.end(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>匿名lookup!!!</title><h1>匿名lookup!!!</h1>${body}</html>`);
  };
  const read=async(request:IncomingMessage)=>{
    if(request.headers['content-type']?.split(';')[0]!=='application/x-www-form-urlencoded')throw new Error('形式が違います。');
    let body='';for await(const part of request){body+=part.toString();if(Buffer.byteLength(body)>4096)throw new Error('入力が長すぎます。');}return new URLSearchParams(body);
  };
  const server=createServer((request,response)=>{void(async()=>{
    const now=Date.now();for(const [key,session] of sessions)if(session.expires<now)sessions.delete(key);
    for(const [key,expires] of tickets)if(expires<=now)tickets.delete(key);
    if(!/^localhost(?::\d+)?$|^127\.0\.0\.1(?::\d+)?$/.test(request.headers.host??'')){send(response,403,'アクセスできません。');return;}
    if(request.method==='POST' && request.headers.origin!==`http://${request.headers.host}`){send(response,403,'<p>ページを開き直してください。</p><a href="/">検索画面に戻る</a>');return;}
    const url=new URL(request.url??'/',`http://${request.headers.host}`);const path=url.pathname;
    if(!['/','/login','/launch','/open','/lookup','/logout'].includes(path)){send(response,404,'見つかりませんでした。');return;}
    if(request.method==='GET' && path==='/open'){
      const ticket=url.searchParams.get('ticket')??'';const expires=tickets.get(ticket);tickets.delete(ticket);
      if(!expires || expires<=now){send(response,401,'接続リンクの期限が切れました。デスクトップの「匿名lookup」をもう一度開いてください。');return;}
      startSession(response,now);return;
    }
    const cookie=request.headers.cookie?.match(/(?:^|;\s*)lookup_session=([a-f0-9]{64})(?:;|$)/)?.[1];
    const session=cookie?sessions.get(cookie):undefined;
    if(request.method==='GET' && path==='/'){
      if(!session){send(response,200,'<p>Bot管理者専用。SSHトンネル経由で利用してください。</p><form method="post" action="/login"><label>管理者キー <input name="token" type="password" autocomplete="off" required></label><button>ログイン</button></form>');return;}
    }else if(request.method==='POST' && (path==='/login' || path==='/launch')){
      if(now<blockedUntil){send(response,429,'しばらく待ってからログインしてください。');return;}
      const form=await read(request);
      if(!timingSafeEqual(hash(form.get('token')??''),hash(token))){if(++failures>=5){blockedUntil=now+60_000;failures=0;}send(response,401,'管理者キーが違います。');return;}
      failures=0;
      if(path==='/launch'){
        if(tickets.size>=20)tickets.delete(tickets.keys().next().value!);
        const ticket=randomBytes(32).toString('hex');tickets.set(ticket,now+30_000);
        response.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify({ticket}));return;
      }
      startSession(response,now);return;
    }else if(!session){send(response,401,'ログインしてください。');return;}
    let result='';
    if(request.method==='POST'){
      const form=await read(request);
      if(form.get('csrf')!==session!.csrf){send(response,403,'<p>ページを開き直してください。</p><a href="/">検索画面に戻る</a>');return;}
      if(path==='/logout'){sessions.delete(cookie!);response.writeHead(303,{'Location':'/','Cache-Control':'no-store','Set-Cookie':'lookup_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});response.end();return;}
      if(path!=='/lookup'){send(response,405,'この操作は利用できません。');return;}
      const id=(form.get('id')??'').trim();
      if(!/^\d{17,20}$/.test(id)){result='<p>メッセージIDは17〜20桁の数字で入力してください。</p>';}
      else{
        const author=await store.lookupAuthor(id);
        if(!author)result='<p>見つかりませんでした。保存0・削除済み・保存期限切れの投稿は開示できません。</p>';
        else{
          const user=await client.users.fetch(author.user_id).catch(()=>null);
          result=`<hr><dl><dt>ユーザーID</dt><dd>${escape(author.user_id)}</dd><dt>表示名</dt><dd>${escape(user?.globalName??user?.username??'取得不可')}</dd></dl>`;
        }
      }
    }else if(request.method!=='GET' || path!=='/'){send(response,405,'この操作は利用できません。');return;}
    send(response,200,`<p>Bot管理者専用。ログインは30分で終了します。</p><form method="post" action="/lookup"><input type="hidden" name="csrf" value="${session!.csrf}"><input name="id" placeholder="メッセージID" required><button>検索</button></form>${result}<form method="post" action="/logout"><input type="hidden" name="csrf" value="${session!.csrf}"><button>ログアウト</button></form>`);
  })().catch(()=>{if(!response.headersSent)send(response,500,'検索に失敗しました。しばらく待ってからやり直してください。');else response.end();});});
  server.requestTimeout=10_000;server.headersTimeout=10_000;server.maxConnections=10;
  server.listen(port,'127.0.0.1');return server;
}
