import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchingBlockedWords, maskBlockedWords } from '../src/domain/blocked-words.js';
import { BlockedWordError } from '../src/domain/errors.js';
import { validateText } from '../src/domain/validation.js';
import { defaults, resolveConfig } from '../src/domain/config.js';

test('該当した禁止語をエラーで示し、含まれない禁止語は示さない', () => {
  const config=resolveConfig(defaults,{policy:{blockedWords:['改造','禁止','abc']}});
  assert.throws(()=>validateText('Switch2改造とＡＢＣ',config),error=>{
    assert.ok(error instanceof BlockedWordError);assert.deepEqual(error.words,['改造','abc']);
    assert.ok(error.message.includes('`改造`'));assert.ok(error.message.includes('`abc`'));
    assert.ok(!error.message.includes('`禁止`'));return true;
  });
});

test('複数箇所・大文字小文字・全半角・重複範囲を伏字にし、周囲の文字と改行は保つ', () => {
  assert.equal(maskBlockedWords('Switch2改造\n改造の話です',['改造']),'Switch2＊＊\n＊＊の話です');
  assert.equal(maskBlockedWords('ＡｂＣ abc ABC',['abc']),'＊＊＊ ＊＊＊ ＊＊＊');
  assert.equal(maskBlockedWords('abcde',['abc','bcd']),'＊＊＊＊e');
  assert.equal(maskBlockedWords('👨‍👩‍👧‍👦と改造',['改造']),'👨‍👩‍👧‍👦と＊＊');
  assert.deepEqual(matchingBlockedWords('そのまま',['改造']),[]);
});

test('正規化で文字数が変わっても元の文字位置に対応して伏字にする', () => {
  assert.equal(maskBlockedWords('xﬃy',['ffi']),'x＊y');
  assert.equal(maskBlockedWords('xか\u3099y',['が']),'x＊y');
  assert.equal(maskBlockedWords('x㍿y',['株式会社']),'x＊y');
  assert.equal(maskBlockedWords('Ⅰ改造Ⅱ',['改造']),'Ⅰ＊＊Ⅱ');
});

test('URL由来の拒否と旧投稿の文字数上限を本文由来の拒否と区別する', () => {
  const config=resolveConfig(defaults,{policy:{blockedWords:['改造']}});
  assert.throws(()=>validateText('https://example.com/改造',config,1800,'source'),error=>error instanceof BlockedWordError&&error.scope==='source');
  assert.throws(()=>validateText('改造',config,2000),error=>error instanceof BlockedWordError&&error.maxLength===2000);
});
