import { commands } from '../commands.js';
import { Routes, type REST } from 'discord.js';

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

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([name,item])=>[name,stable(item)]));
  return value;
}
function optionDefinition(input: unknown): unknown {
  const option = input as Record<string, unknown>;
  return {
    type: option.type, name: option.name, description: option.description ?? '',
    name_localizations: option.name_localizations ?? {}, description_localizations: option.description_localizations ?? {},
    required: option.required ?? false, autocomplete: option.autocomplete ?? false,
    choices: ((option.choices ?? []) as Record<string,unknown>[]).map(choice=>({name:choice.name,value:choice.value,name_localizations:choice.name_localizations??{}})),
    options: ((option.options ?? []) as unknown[]).map(optionDefinition),
    channel_types: [...((option.channel_types ?? []) as number[])].sort((a,b)=>a-b),
    min_value: option.min_value ?? null, max_value: option.max_value ?? null,
    min_length: option.min_length ?? null, max_length: option.max_length ?? null,
  };
}
export function commandDefinitionsEqual(current: RegisteredCommand[], desired: readonly RegisteredCommand[] = commands): boolean {
  const normalize = (items: readonly RegisteredCommand[]) => items.map(command=>{
    const item = command as unknown as Record<string,unknown>;
    return {
      type: command.type ?? 1, name: command.name, description: item.description ?? '',
      name_localizations: item.name_localizations ?? {}, description_localizations: item.description_localizations ?? {},
      dm_permission: item.dm_permission ?? true, default_member_permissions: item.default_member_permissions ?? null,
      nsfw: item.nsfw ?? false, integration_types: [...((item.integration_types ?? [0]) as number[])].sort(),
      contexts: item.contexts == null ? null : [...(item.contexts as number[])].sort(),
      options: ((item.options ?? []) as unknown[]).map(optionDefinition),
    };
  }).sort((a,b)=>key(a).localeCompare(key(b)));
  return JSON.stringify(stable(normalize(current))) === JSON.stringify(stable(normalize(desired)));
}

export function commandRegistrationApi(rest: REST, application: string): CommandRegistrationApi {
  return {
    global: () => rest.get(Routes.applicationCommands(application)) as Promise<RegisteredCommand[]>,
    registerGlobal: () => rest.put(Routes.applicationCommands(application), { body: commands }) as Promise<RegisteredCommand[]>,
    guildIds: async function* () {
      let after: string | undefined;
      for (;;) {
        const query = new URLSearchParams({ limit: '200', ...(after ? { after } : {}) });
        const guilds = await rest.get(Routes.userGuilds(), { query }) as { id: string }[];
        for (const guild of guilds) yield guild.id;
        if (guilds.length < 200) return;
        after = guilds.at(-1)!.id;
      }
    },
    guild: guildId => rest.get(Routes.applicationGuildCommands(application, guildId)) as Promise<RegisteredCommand[]>,
    registerGuild: (guildId, body) => rest.put(Routes.applicationGuildCommands(application, guildId), { body }),
    removeGuild: (guildId, commandId) => rest.delete(Routes.applicationGuildCommand(application, guildId, commandId)),
  };
}

export async function registerGlobalCommands(api: CommandRegistrationApi) {
  const previous = await api.global();
  const updated = !commandDefinitionsEqual(previous);
  const global = updated ? await api.registerGlobal() : previous;
  if (!commandDefinitionsEqual(global)) throw new Error('全体向けの登録を確認できないため、サーバー個別の登録は変更しません。');
  const names = new Set([...previous, ...global].map(key));
  let removed = 0;
  for await (const guildId of api.guildIds()) {
    const local = await api.guild(guildId);
    for (const command of local.filter(command => names.has(key(command)))) {
      if (!command.id) throw new Error('サーバー個別コマンドのIDを確認できません。');
      await api.removeGuild(guildId, command.id);
      removed++;
    }
  }
  return { registered: global.length, removed, updated };
}

export async function registerGuildCommands(api: CommandRegistrationApi, guildId: string): Promise<void> {
  const global = new Set((await api.global()).map(key));
  if (commands.some(command => global.has(key(command))))
    throw new Error('全体向けに同じコマンドが登録済みです。重複を防ぐため、--guildを外して登録してください。');
  await api.registerGuild(guildId, commands);
}
