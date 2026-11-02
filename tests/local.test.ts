import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localCredentials, localEnvironment } from '../src/local.js';

const settings = { DISCORD_BOT_TOKEN: 'test-only-token', DISCORD_APPLICATION_ID: '1566798409627861072' };

test('ローカル起動は本番Bot・ID未設定を拒否する', () => {
  assert.throws(() => localCredentials({ ...settings, DISCORD_APPLICATION_ID: '1400799112529449000' }), /本番Bot/);
  assert.throws(() => localCredentials({ DISCORD_BOT_TOKEN: 'test-only-token' }), /設定/);
  assert.throws(() => localCredentials({ ...settings, DISCORD_BOT_TOKEN: '' }), /設定/);
  assert.deepEqual(localCredentials(settings), { token: settings.DISCORD_BOT_TOKEN, applicationId: settings.DISCORD_APPLICATION_ID });
});

test('本番のDB・トークン・鍵・監視・lookup・Cookieはローカル環境へ引き継がない', () => {
  const production = { BOT_ADMIN_ID_URL: 'https://production.example/id', DATABASE_URL: 'postgresql://production/db', PGHOST: 'production', PGPASSWORD: 'production-password', DISCORD_BOT_TOKEN: 'production-token',
    ENCRYPTION_KEY: 'production-key', NODE_ENV: 'production', WATCHER_PUSH_URL: 'https://production.example', LOOKUP_TAILSCALE_ORIGIN: 'https://production.example',
    PIXIV_PHPSESSID: 'production-cookie', DOTENV_CONFIG_PATH: '.env', PATH: 'test-path', SystemRoot: 'test-windows', NODE_OPTIONS: '--require unwanted.js' };
  const environment = localEnvironment({ ...settings, DATABASE_URL: 'postgresql://wrong/db' }, production, 'local-key');
  assert.equal(environment.DISCORD_BOT_TOKEN, settings.DISCORD_BOT_TOKEN); assert.equal(environment.ENCRYPTION_KEY, 'local-key');
  assert.equal(environment.LOCAL_DEVELOPMENT, '1'); assert.equal(environment.NODE_ENV, 'development'); assert.equal(environment.HEALTH_PORT, '0');
  assert.equal(environment.PATH, 'test-path'); assert.equal(environment.SystemRoot, 'test-windows');
  for (const name of ['BOT_ADMIN_ID_URL','DATABASE_URL', 'PGHOST', 'PGPASSWORD', 'WATCHER_PUSH_URL', 'LOOKUP_TAILSCALE_ORIGIN', 'PIXIV_PHPSESSID', 'DOTENV_CONFIG_PATH', 'NODE_OPTIONS']) assert.equal(environment[name], undefined, name);
  assert.equal(localEnvironment({...settings,BOT_ADMIN_ID_URL:'https://test.example/id'},production,'local-key').BOT_ADMIN_ID_URL,'https://test.example/id');
});
