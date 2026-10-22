import { randomBytes } from 'node:crypto';

export function diagnosticCode(): string { return randomBytes(4).toString('hex'); }
export function parseDiagnosticCode(value: string): string | undefined {
  const code = value.trim();
  if (/^[a-f0-9]{8}$/i.test(code)) return code.toLowerCase();
  if (/^ERR-[a-f0-9]{16}$/i.test(code)) return code.toUpperCase();
  return undefined;
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
  return result.replace(/https?:\/\/[^\s"'<>]+|postgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[URLを秘匿]').slice(0, 12_000);
}
