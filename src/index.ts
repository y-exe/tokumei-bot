import './infra/environment.js';
import { fileURLToPath } from 'node:url';
import { ShardingManager } from 'discord.js';

const token = process.env.DISCORD_BOT_TOKEN;
const shards = process.env.DISCORD_SHARDS;
// 子プロセス(shard)と単一実行はbot.ts本体へ。DISCORD_SHARDSが指定された親プロセスだけがShardingManagerになる。
if (shards && process.env.SHARDS === undefined) {
  if (!token) throw new Error('Botトークンを指定してください。');
  const totalShards = shards === 'auto' ? 'auto' : (() => {
    const value = Number(shards);
    if (!Number.isInteger(value) || value < 1 || value > 32) throw new Error('DISCORD_SHARDSは「auto」または1〜32の整数で指定してください。');
    return value;
  })();
  const manager = new ShardingManager(fileURLToPath(import.meta.url), { token, respawn: true, totalShards });
  manager.on('shardCreate', shard => {
    console.info(`シャード${shard.id}を起動しました。`);
    shard.on('death', () => console.error(`シャード${shard.id}が停止しました。再起動します。`));
    shard.on('ready', () => console.info(`シャード${shard.id}は接続しました。`));
    shard.on('disconnect', () => console.error(`シャード${shard.id}の接続が切れました。`));
  });
  const stopping = () => {
    manager.respawn = false;
    console.info('停止を受け付けました。シャードを終了します。');
    for (const shard of manager.shards.values()) shard.kill();
  };
  process.once('SIGINT', stopping);
  process.once('SIGTERM', stopping);
  const spawned = await manager.spawn().catch(error => { console.error('シャードの起動に失敗しました。', error); process.exit(1); throw error; });
  console.info(`ShardingManager起動完了: ${spawned.size}シャード`);
} else await import('./bot.js');
