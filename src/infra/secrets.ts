import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export class SecretBox {
  private key: Buffer;
  constructor(value: string) {
    this.key = Buffer.from(value, 'base64');
    if (this.key.length !== 32) throw new Error('ENCRYPTION_KEYは32バイトのbase64鍵を指定してください。');
  }
  seal(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map(part => part.toString('base64')).join('.');
  }
  open(value: string): string {
    const [iv, tag, data] = value.split('.').map(part => Buffer.from(part, 'base64'));
    if (!iv || !tag || !data) throw new Error('保存済み資格情報の形式が不正です。');
    const cipher = createDecipheriv('aes-256-gcm', this.key, iv);
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8');
  }
}
