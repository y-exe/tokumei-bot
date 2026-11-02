import { mkdir, readFile, writeFile, unlink, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { parse } from 'dotenv';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, '.local', 'dev');
const statePath = join(dir, 'run.json');
const lockPath = join(dir, 'run.lock');
type State = { pid: number; port: number; secret: string; applicationId: string; databasePort: number };

export function localCredentials(settings: Record<string, string>): { token: string; applicationId: string } {
  const token = settings.DISCORD_BOT_TOKEN; const applicationId = settings.DISCORD_APPLICATION_ID;
  if (!token || !/^\d{17,20}$/.test(applicationId ?? '')) throw new Error('.env.localにテストBotのトークンとアプリケーションIDを設定してください。');
  if (applicationId === '1400799112529449000') throw new Error('本番BotのIDではローカル環境を起動できません。');
  return { token, applicationId: applicationId! };
}

export function localEnvironment(settings: Record<string, string>, ambient: NodeJS.ProcessEnv, key: string): NodeJS.ProcessEnv {
  const { token, applicationId } = localCredentials(settings);
  const system = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']);
  const result = Object.fromEntries(Object.entries(ambient).filter(([name]) => system.has(name.toUpperCase())));
  for (const name of ['PIXIV_PHPSESSID', 'FFMPEG_PATH', 'FFPROBE_PATH', 'GALLERY_DL_PYTHON', 'BOT_ADMIN_ID_URL']) if (settings[name]) result[name] = settings[name];
  return { ...result, DISCORD_BOT_TOKEN: token, DISCORD_APPLICATION_ID: applicationId, LOCAL_DEVELOPMENT: '1', NODE_ENV: 'development',
    ENCRYPTION_KEY: key, MEDIA_CONCURRENCY: settings.MEDIA_CONCURRENCY || '1', HEALTH_PORT: '0' };
}

async function main(): Promise<void> {
  if (process.argv.includes('--stop')) {
    let state: State;
    try { state = JSON.parse(await readFile(statePath, 'utf8')); }
    catch { throw new Error('ローカルBotは起動していません。'); }
    const response = await fetch(`http://127.0.0.1:${state.port}/stop`, { method: 'POST', headers: { Authorization: `Bearer ${state.secret}` }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('ローカルBotを停止できませんでした。');
    console.info('ローカルBotの停止を受け付けました。'); return;
  }
  process.chdir(root);
  let settings: Record<string, string>;
  try { settings = parse(await readFile(join(root, '.env.local'))); }
  catch { throw new Error('.env.local.exampleを.env.localへコピーし、テストBotのトークンとアプリケーションIDを設定してください。'); }
  const { token, applicationId } = localCredentials(settings);
  const response = await fetch('https://discord.com/api/v10/oauth2/applications/@me', { headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`テストBotの認証を確認できませんでした（HTTP ${response.status}）。`);
  const application = await response.json() as { id: string };
  if (application.id !== applicationId) throw new Error('トークンとテストBotのアプリケーションIDが一致しません。');
  await mkdir(dir, { recursive: true });
  try {
    const pid = Number(await readFile(lockPath, 'utf8'));
    let alive = true;
    try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; else throw error; }
    if (alive) throw new Error('ローカルBotは起動済みです。停止する場合はnpm run local:stopを使ってください。');
    await unlink(lockPath);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await writeFile(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
  let db: PGlite | undefined; let socket: PGLiteSocketServer | undefined;
  let app: { shutdown(): Promise<void> } | undefined;
  let stopping: Promise<void> | undefined;
  const secret = randomBytes(32).toString('hex');
  const control = createServer((request, result) => {
    if (request.method !== 'POST' || request.url !== '/stop' || request.headers.authorization !== `Bearer ${secret}`) { result.writeHead(404).end(); return; }
    result.writeHead(202).end('stopping');
    void stop().then(() => process.exit(0));
  });
  const stop = (): Promise<void> => stopping ??= (async () => {
    await app?.shutdown();
    await socket?.stop(); await db?.close(); control.close();
    await unlink(statePath).catch(() => {}); await unlink(lockPath).catch(() => {});
  })();
  const onSignal = (): void => { void stop().then(() => process.exit(0)); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    let key: string;
    const keyPath = join(dir, 'encryption.key');
    try { key = await readFile(keyPath, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      key = randomBytes(32).toString('base64'); await writeFile(keyPath, key, { flag: 'wx', mode: 0o600 });
    }
    const environment = localEnvironment(settings, process.env, key);
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, environment);
    if(!process.env.GALLERY_DL_PYTHON){
      const python=join(root,'.local','gallery-dl',process.platform==='win32'?'Scripts/python.exe':'bin/python');
      try{await access(python);process.env.GALLERY_DL_PYTHON=python;}catch{}
    }
    db = await PGlite.create(join(dir, 'pglite'));
    socket = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1', maxConnections: 5 }); await socket.start();
    process.env.DATABASE_URL = `postgresql://postgres:postgres@${socket.getServerConn()}/postgres`;
    app = await import('./index.js');
    await new Promise<void>((done, reject) => { control.once('error', reject); control.listen(0, '127.0.0.1', done); });
    const address = control.address(); if (!address || typeof address === 'string') throw new Error('停止用ポートを開けませんでした。');
    const databasePort = Number(new URL(process.env.DATABASE_URL).port);
    await writeFile(statePath, JSON.stringify({ pid: process.pid, port: address.port, secret, applicationId, databasePort } satisfies State), { mode: 0o600 });
    console.info(`ローカル環境: テストBot ${applicationId} / PGlite .local/dev/pglite / 停止: npm run local:stop`);
  } catch (error) { await stop(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => { console.error(error instanceof Error ? error.message : 'ローカル環境を起動できませんでした。'); process.exit(1); });
}
