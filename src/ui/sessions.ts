import { randomBytes } from 'node:crypto';
import { UserError } from '../domain/errors.js';

export interface OwnedSession { owner: string; guildId: string; channelId: string; }
export class Sessions<T extends OwnedSession> {
  private values = new Map<string, { value: T; expires: number; bytes: number }>();
  constructor(private ttl = 10 * 60_000, private maxBytes = 64 * 1024 * 1024) {}
  create(value: T, bytes = 0): string {
    this.sweep();
    const total = [...this.values.values()].reduce((sum, item) => sum + item.bytes, 0);
    if (this.values.size >= 100 || total + bytes > this.maxBytes) throw new UserError('現在プレビューが混み合っています。少し待ってからお試しください。');
    const id = randomBytes(12).toString('hex');
    this.values.set(id, { value, expires: Date.now() + this.ttl, bytes }); return id;
  }
  get(id: string, owner: string, guildId: string): T {
    this.sweep(); const session = this.values.get(id);
    if (!session) throw new UserError('この画面の有効期限が切れました。コマンドから開き直してください。');
    if (session.value.owner !== owner || session.value.guildId !== guildId) throw new UserError('この画面は開いた本人だけが操作できます。');
    return session.value;
  }
  delete(id: string): void { this.values.delete(id); }
  sweep(): void { for (const [id, session] of this.values) if (session.expires <= Date.now()) this.values.delete(id); }
}
