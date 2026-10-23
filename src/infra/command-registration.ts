import { commands } from '../commands.js';

export interface RegisteredCommand { id?: string; name: string; type?: number; }
export interface CommandRegistrationApi {
  global(): Promise<RegisteredCommand[]>;
  registerGlobal(): Promise<RegisteredCommand[]>;
  guildIds(): AsyncIterable<string>;
  guild(guildId: string): Promise<RegisteredCommand[]>;
  registerGuild(guildId: string, body: RegisteredCommand[]): Promise<unknown>;
  removeGuild(guildId: string, commandId: string): Promise<unknown>;
}
function key(command: RegisteredCommand): string { return `${command.type ?? 1}:${command.name}`; }

export async function registerGlobalCommands(api: CommandRegistrationApi) {
  const global = await api.registerGlobal();
  const names = new Set(global.map(key));
  if (!commands.every(command => names.has(key(command)))) throw new Error('全体向けの登録を確認できないため、サーバー個別の登録は変更しません。');
  let removed = 0;
  for await (const guildId of api.guildIds()) {
    const local = await api.guild(guildId);
    for (const command of local.filter(command => names.has(key(command)))) {
      if (!command.id) throw new Error('サーバー個別コマンドのIDを確認できません。');
      await api.removeGuild(guildId, command.id);
      removed++;
    }
  }
  return { registered: global.length, removed };
}

export async function registerGuildCommands(api: CommandRegistrationApi, guildId: string): Promise<void> {
  const global = new Set((await api.global()).map(key));
  if (commands.some(command => global.has(key(command))))
    throw new Error('全体向けに同じコマンドが登録済みです。重複を防ぐため、--guildを外して登録してください。');
  await api.registerGuild(guildId, commands);
}
