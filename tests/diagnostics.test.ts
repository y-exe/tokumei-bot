import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticCode, diagnosticDetails } from '../src/infra/diagnostics.js';

test('エラーコードは照会可能な形式で重複しない', () => {
  const codes = Array.from({ length: 100 }, diagnosticCode);
  assert.equal(new Set(codes).size, 100);
  assert.ok(codes.every(code => /^ERR-[A-F0-9]{16}$/.test(code)));
});
test('エラー詳細は原因とコードを残しトークンとURLを秘匿する', () => {
  const previous = process.env.DIAGNOSTIC_TEST_TOKEN;
  process.env.DIAGNOSTIC_TEST_TOKEN = 'private-token-for-test';
  try {
    const cause = Object.assign(new Error('選択肢が4件で最大値が5件'), { code: 50035 });
    const result = diagnosticDetails(new Error('private-token-for-test https://discord.com/api/webhooks/id/token postgresql://user:password@localhost/db', { cause }));
    assert.ok(result.includes('code=50035'));
    assert.ok(result.includes('選択肢が4件'));
    assert.ok(!result.includes('private-token-for-test'));
    assert.ok(!result.includes('password@'));
    assert.ok(!result.includes('/webhooks/'));
  } finally {
    if (previous === undefined) delete process.env.DIAGNOSTIC_TEST_TOKEN;
    else process.env.DIAGNOSTIC_TEST_TOKEN = previous;
  }
});
