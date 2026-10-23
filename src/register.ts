import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { commands } from './commands.js';
import { registerGlobalCommands, registerGuildCommands, type RegisteredCommand } from './infra/command-registration.js';

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
const api = {
  global: () => rest.get(Routes.applicationCommands(application)) as Promise<RegisteredCommand[]>,
  registerGlobal: () => rest.put(Routes.applicationCommands(application), { body: commands }) as Promise<RegisteredCommand[]>,
  guildIds: async function* () {
    let after: string | undefined;
    for (;;) {
      const query = new URLSearchParams({ limit: '200', ...(after ? { after } : {}) });
      const guilds = await rest.get(Routes.userGuilds(), { query }) as { id: string }[];
      for (const item of guilds) yield item.id;
      if (guilds.length < 200) return;
      after = guilds.at(-1)!.id;
    }
  },
  guild: (guildId: string) => rest.get(Routes.applicationGuildCommands(application, guildId)) as Promise<RegisteredCommand[]>,
  registerGuild: (guildId: string, body: RegisteredCommand[]) => rest.put(Routes.applicationGuildCommands(application, guildId), { body }),
  removeGuild: (guildId: string, commandId: string) => rest.delete(Routes.applicationGuildCommand(application, guildId, commandId)),
};
if (guild) {
  await registerGuildCommands(api, guild);
  console.info(`${commands.length}個のコマンドを指定サーバー内に登録しました。`);
} else {
  const result = await registerGlobalCommands(api);
  console.info(`全体向けに${result.registered}個を登録し、サーバー個別の重複${result.removed}個を解消しました。`);
}
