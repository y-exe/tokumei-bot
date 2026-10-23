import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { commands } from './commands.js';
import { registerGlobalCommands, registerGuildCommands, commandRegistrationApi } from './infra/command-registration.js';

const token = process.env.DISCORD_BOT_TOKEN ?? process.env.token;
const application = process.env.DISCORD_APPLICATION_ID;
if (!token || !application) throw new Error('DISCORD_BOT_TOKENとDISCORD_APPLICATION_IDを指定してください。');
if (process.argv.includes('--global') && process.argv.includes('--guild')) throw new Error('--globalと--guildは同時に指定できません。');
const guild = process.argv.includes('--guild') ? process.env.DISCORD_GUILD_ID : undefined;
if (process.argv.includes('--guild') && !guild) throw new Error('サーバー個別の登録にはDISCORD_GUILD_IDを指定してください。');
if (guild && !/^\d{17,20}$/.test(guild)) throw new Error('DISCORD_GUILD_IDにはサーバーIDを指定してください。');
const rest = new REST({ version: '10' }).setToken(token);
const current = await rest.get(Routes.oauth2CurrentApplication()) as { id: string };
if (current.id !== application) throw new Error('トークンとDISCORD_APPLICATION_IDの対象が一致しません。');
const api = commandRegistrationApi(rest, application);
if (guild) {
  await registerGuildCommands(api, guild);
  console.info(`${commands.length}個のコマンドを指定サーバー内に登録しました。`);
} else {
  const result = await registerGlobalCommands(api);
  console.info(`全体向けに${result.registered}個を登録し、サーバー個別の重複${result.removed}個を解消しました。`);
}
