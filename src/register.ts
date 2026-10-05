import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { commands } from './commands.js';

const token = process.env.DISCORD_BOT_TOKEN ?? process.env.token;
const application = process.env.DISCORD_APPLICATION_ID;
if (!token || !application) throw new Error('DISCORD_BOT_TOKENとDISCORD_APPLICATION_IDを指定してください。');
const guild = process.argv.includes('--global') ? undefined : process.env.DISCORD_GUILD_ID;
if (!guild && !process.argv.includes('--global')) throw new Error('サーバー内への登録はDISCORD_GUILD_ID、全サーバーへの登録は --global を指定してください。');
if (guild && !/^\d{17,20}$/.test(guild)) throw new Error('DISCORD_GUILD_IDにはサーバーIDを指定してください。');
await new REST({ version: '10' }).setToken(token).put(guild ? Routes.applicationGuildCommands(application, guild) : Routes.applicationCommands(application), { body: commands });
console.info(`${commands.length}個のコマンドを${guild ? '指定サーバー内' : '全サーバー向け'}に登録しました。`);
