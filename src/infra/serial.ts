import { UserError } from '../domain/errors.js';

export class SerialQueue {
  private tails = new Map<string, Promise<void>>();
  private bytes = 0;
  private count = 0;
  constructor(private maxBytes = 64 * 1024 * 1024, private maxCount = 32) {}
  async run<T>(key: string, bytes: number, action: () => Promise<T>): Promise<T> {
    if (this.count >= this.maxCount || this.bytes + bytes > this.maxBytes) throw new UserError('投稿処理が混み合っています。少し待ってからお試しください。');
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>(resolve => release = resolve);
    this.tails.set(key, tail); this.bytes += bytes; this.count++;
    await previous;
    try { return await action(); }
    finally {
      this.bytes -= bytes; this.count--; release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
