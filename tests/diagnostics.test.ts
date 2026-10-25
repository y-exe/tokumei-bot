import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticCode, diagnosticDetails, minimalDiagnosticDetails, parseDiagnosticCode } from '../src/infra/diagnostics.js';

test('エラーコードは照会可能な形式で重複しない', () => {
  const codes = Array.from({ length: 100 }, diagnosticCode);
  assert.equal(new Set(codes).size, 100);
  assert.ok(codes.every(code => /^[a-f0-9]{8}$/.test(code)));
});

test('新しいエラーIDと保存済みの旧コードを検索できる形式にする', () => {
  assert.equal(parseDiagnosticCode(' 0A4DCAF0 '), '0a4dcaf0');
  assert.equal(parseDiagnosticCode('err-0123456789abcdef'), 'ERR-0123456789ABCDEF');
  for (const value of ['1234567', '123456789', 'ERR-0a4dcaf0', 'abcdefgh', '']) assert.equal(parseDiagnosticCode(value), undefined);
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

test('PixivのセッションCookieをエラー詳細に残さない', () => {
  const previous=process.env.PIXIV_PHPSESSID;process.env.PIXIV_PHPSESSID='test-private-pixiv-session';
  try {assert.ok(!diagnosticDetails(new Error('Cookie: PHPSESSID=test-private-pixiv-session')).includes('test-private-pixiv-session'));}
  finally {if(previous===undefined)delete process.env.PIXIV_PHPSESSID;else process.env.PIXIV_PHPSESSID=previous;}
});

test('保存0のエラー記録は本文・ID・スタックを捨て、種類と安全なコードだけを残す', () => {
  const error = Object.assign(new Error('300000000000000123 非公開の本文 https://example.com/private'), { code: '23505' });
  error.name = '非公開の名前';
  const result = minimalDiagnosticDetails(new AggregateError([error], '非公開の集約メッセージ'));
  assert.ok(result.includes('code=23505')); assert.ok(result.includes('AggregateError'));
  for (const secret of ['300000000000000123', '非公開', 'example.com', 'diagnostics.test.ts']) assert.ok(!result.includes(secret));
  assert.ok(!minimalDiagnosticDetails(Object.assign(new Error('秘密'), { code: '300000000000000123' })).includes('300000000000000123'));
  assert.ok(!diagnosticDetails(new Error('user=300000000000000123 code=50035')).includes('300000000000000123'));
});
