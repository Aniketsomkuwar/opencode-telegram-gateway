import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, ConfigError, resolvePaths, validateTokenShape } from '../dist/config.js';
import { migrateState, StateStore } from '../dist/state.js';

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-test-'));
}

function writeConfig(home: string, value: Record<string, unknown>): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(value));
}

const TOKEN = '123456789:AAH-abcdefghijklmnopqrstuvwxyz012345678';

test('loads a valid config and applies defaults', () => {
  const home = tempHome();
  writeConfig(home, { botToken: TOKEN, allowedUserIds: [42] });
  const { config } = loadConfig(home);
  assert.equal(config.allowedUserIds[0], 42);
  assert.equal(config.permissionTimeoutSeconds, 300);
  assert.equal(config.roles['42'], 'owner');
  assert.equal(config.redact, true);
});

test('env token overrides the file', () => {
  const home = tempHome();
  writeConfig(home, { botToken: 'PASTE_BOT_TOKEN', allowedUserIds: [1] });
  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
  try {
    const { config } = loadConfig(home);
    assert.equal(config.botToken, TOKEN);
  } finally {
    delete process.env.TELEGRAM_BOT_TOKEN;
  }
});

test('missing config is a clear error', () => {
  const home = tempHome();
  assert.throws(() => loadConfig(home), (error: unknown) => error instanceof ConfigError && /missing/.test(error.message));
});

test('invalid JSON is a clear error', () => {
  const home = tempHome();
  fs.writeFileSync(path.join(home, 'config.json'), '{ nope');
  assert.throws(() => loadConfig(home), /not valid JSON/);
});

test('placeholder token is rejected', () => {
  const home = tempHome();
  writeConfig(home, { botToken: 'PASTE_BOT_TOKEN_FROM_BOTFATHER', allowedUserIds: [1] });
  assert.throws(() => loadConfig(home), /placeholder/);
});

test('webhook cannot bind publicly', () => {
  const home = tempHome();
  writeConfig(home, { botToken: TOKEN, allowedUserIds: [1], webhook: { enabled: true, host: '0.0.0.0' } });
  assert.throws(() => loadConfig(home), /localhost/);
});

test('validateTokenShape accepts a real-looking token', () => {
  assert.equal(validateTokenShape(TOKEN), null);
  assert.ok(validateTokenShape('nope'));
});

test('migrates v1 state (top-level user keys and __offset)', () => {
  const migrated = migrateState({ __offset: 99, '123': { sessionId: 'ses_1' }, '456': { sessionId: 'ses_2', lastList: ['a'] } });
  assert.equal(migrated.version, 2);
  assert.equal(migrated.offset, 99);
  assert.equal(migrated.chats['123']?.sessionId, 'ses_1');
  assert.deepEqual(migrated.chats['456']?.lastList, ['a']);
});

test('state store persists offset and chats atomically', () => {
  const home = tempHome();
  const file = path.join(home, 'state.json');
  const store = new StateStore(file);
  store.offset = 7;
  store.chat(42).sessionId = 'ses_x';
  store.flush();
  const reloaded = new StateStore(file);
  assert.equal(reloaded.offset, 7);
  assert.equal(reloaded.chat(42).sessionId, 'ses_x');
});

test('offset never moves backwards', () => {
  const store = new StateStore(path.join(tempHome(), 'state.json'));
  store.offset = 10;
  store.offset = 3;
  assert.equal(store.offset, 10);
});

test('corrupt state is backed up, not fatal', () => {
  const home = tempHome();
  const file = path.join(home, 'state.json');
  fs.writeFileSync(file, 'not json');
  const store = new StateStore(file);
  assert.equal(store.offset, 0);
  assert.ok(fs.readdirSync(home).some((name) => name.startsWith('state.json.corrupt')));
});

test('resolvePaths keeps everything under the home', () => {
  const paths = resolvePaths('C:/tmp/gw');
  assert.equal(paths.config, path.join(path.resolve('C:/tmp/gw'), 'config.json'));
});

