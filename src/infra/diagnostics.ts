import { randomBytes } from 'node:crypto';

export function diagnosticCode(): string { return randomBytes(4).toString('hex'); }
export function parseDiagnosticCode(value: string): string | undefined {
  const code = value.trim();
  if (/^[a-f0-9]{8}$/i.test(code)) return code.toLowerCase();
  if (/^ERR-[a-f0-9]{16}$/i.test(code)) return code.toUpperCase();
  return undefined;
}
export function minimalDiagnosticDetails(error: unknown): string {
  const seen = new Set<unknown>();
  const describe = (value: unknown, depth: number): string => {
    if (!(value instanceof Error) || depth > 3 || seen.has(value)) return '';
    seen.add(value);
    const name = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'DiscordAPIError', 'HTTPError', 'AbortError', 'AggregateError', 'TimeoutError'].includes(value.name) ? value.name : 'Error';
    const coded = value as Error & { code?: unknown; errors?: unknown[] };
    const code = typeof coded.code === 'number' || typeof coded.code === 'string' ? String(coded.code) : '';
    return [name, /^[A-Z0-9_]{1,8}$/.test(code) ? `code=${code}` : '',
      describe(value.cause, depth + 1), ...(Array.isArray(coded.errors) ? coded.errors.slice(0, 5).map(child => describe(child, depth + 1)) : [])].filter(Boolean).join('\n');
  };
  return `プライバシー保護のため、メッセージ・スタック・投稿内容は記録していません。\n${describe(error, 0) || '詳細不明'}`;
}
export function diagnosticDetails(error: unknown): string {
  const seen = new Set<unknown>();
  const describe = (value: unknown, depth: number): string => {
    if (depth > 3 || seen.has(value)) return '';
    seen.add(value);
    if (!(value instanceof Error)) return '詳細不明';
    const coded = value as Error & { code?: unknown; errors?: unknown[] };
    return [value.stack ?? `${value.name}: ${value.message}`, typeof coded.code === 'number' || typeof coded.code === 'string' ? `code=${coded.code}` : '',
      value.cause ? describe(value.cause, depth + 1) : '', ...(Array.isArray(coded.errors) ? coded.errors.slice(0, 5).map(child => describe(child, depth + 1)) : [])].filter(Boolean).join('\n');
  };
  let result = describe(error, 0);
  for (const [name, value] of Object.entries(process.env)) {
    if (value && value.length >= 8 && /TOKEN|SECRET|PASSWORD|COOKIE|PHPSESSID|ENCRYPTION_KEY|DATABASE_URL/i.test(name)) result = result.replaceAll(value, '[秘匿]');
  }
  return result.replace(/https?:\/\/[^\s"'<>]+|postgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[URLを秘匿]')
    .replace(/(?<!\d)\d{17,20}(?!\d)/g, '[IDを秘匿]').slice(0, 12_000);
}
