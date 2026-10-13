import {createServer,type Server,type IncomingMessage,type ServerResponse} from 'node:http';
import {randomBytes} from 'node:crypto';
import type {Client} from 'discord.js';
import type {Store} from './store.js';

const escape=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
const ttl=30*60_000;
export function lookupServer(store:Pick<Store,'lookupAuthor'>,client:Pick<Client,'users'>,origin:string,allowedLogins:readonly string[],port=8765):Server {
  const address=new URL(origin);
  if(address.protocol!=='https:' || !address.hostname.endsWith('.ts.net') || address.origin!==origin || !allowedLogins.length || allowedLogins.some(login=>!login.trim()))
    throw new Error('lookupのTailscale HTTPS接続先と許可アカウントを指定してください。');
  const sessions=new Map<string,{expires:number;csrf:string;login:string}>();
  const send=(response:ServerResponse,status:number,body:string)=>{
    response.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'same-origin','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});
    response.end(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>匿名lookup!!!</title><h1>匿名lookup!!!</h1>${body}</html>`);
  };
  const read=async(request:IncomingMessage)=>{
    if(request.headers['content-type']?.split(';')[0]!=='application/x-www-form-urlencoded')throw new Error('形式が違います。');
    let body='';for await(const part of request){body+=part.toString();if(Buffer.byteLength(body)>4096)throw new Error('入力が長すぎます。');}return new URLSearchParams(body);
  };
  const server=createServer((request,response)=>{void(async()=>{
    const now=Date.now();for(const [key,session] of sessions)if(session.expires<=now)sessions.delete(key);
    const login=request.headers['tailscale-user-login'];
    if(request.headers.host!==address.host || typeof login!=='string' || !allowedLogins.includes(login)){
      send(response,403,'このTailscaleアカウントではアクセスできません。');return;
    }
    if(request.method==='POST' && request.headers.origin!==origin){send(response,403,'<p>ページを開き直してください。</p><a href="/">検索画面に戻る</a>');return;}
    const path=new URL(request.url??'/',origin).pathname;
    if(path!=='/' && path!=='/lookup'){send(response,404,'見つかりませんでした。');return;}
    const cookie=request.headers.cookie?.match(/(?:^|;\s*)lookup_session=([a-f0-9]{64})(?:;|$)/)?.[1];
    let session=cookie?sessions.get(cookie):undefined;
    if(session?.login!==login)session=undefined;
    if(request.method==='GET' && path==='/'){
      if(!session){
        if(sessions.size>=20)sessions.delete(sessions.keys().next().value!);
        const key=randomBytes(32).toString('hex');session={expires:now+ttl,csrf:randomBytes(32).toString('hex'),login};sessions.set(key,session);
        response.setHeader('Set-Cookie',`lookup_session=${key}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`);
      }
    }else if(!session){send(response,401,'<p>ページを開き直してください。</p><a href="/">検索画面に戻る</a>');return;}
    let result='';
    if(request.method==='POST' && path==='/lookup'){
      const form=await read(request);
      if(form.get('csrf')!==session!.csrf){send(response,403,'<p>ページを開き直してください。</p><a href="/">検索画面に戻る</a>');return;}
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
    send(response,200,`<p>Tailscaleで認証済み。</p><form method="post" action="/lookup"><input type="hidden" name="csrf" value="${session!.csrf}"><input name="id" placeholder="メッセージID" inputmode="numeric" required><button>検索</button></form>${result}`);
  })().catch(()=>{if(!response.headersSent)send(response,500,'検索に失敗しました。しばらく待ってからやり直してください。');else response.end();});});
  server.requestTimeout=10_000;server.headersTimeout=10_000;server.maxConnections=10;
  server.listen(port,'127.0.0.1');return server;
}
