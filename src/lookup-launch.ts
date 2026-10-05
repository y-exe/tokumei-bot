const token=process.env.LOOKUP_ADMIN_TOKEN;
if(!token)throw new Error('Bot管理者用lookupが有効になっていません。');
const origin=`http://127.0.0.1:${Number(process.env.LOOKUP_PORT??8765)}`;
const response=await fetch(`${origin}/launch`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token}),signal:AbortSignal.timeout(5000)});
if(!response.ok)throw new Error('lookupの接続リンクを発行できませんでした。');
const result=await response.json() as {ticket?:string};
if(!result.ticket || !/^[a-f0-9]{64}$/.test(result.ticket))throw new Error('lookupの接続リンクが不正です。');
process.stdout.write(result.ticket);
