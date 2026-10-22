import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../dist/redact.js';
import { formatForTelegram, escapeMd } from '../dist/markdown.js';
import { retry, jitter, duration, ago } from '../dist/util.js';

test('redacts bot tokens', () => {
  const result = redactSecrets('token 123456789:AAH-abcdefghijklmnopqrstuvwxyz012345678 here');
  assert.equal(result.text.includes('AAH-abcdefghijklmnopqrstuvwxyz'), false);
  assert.ok(result.hits.includes('telegram-bot-token'));
});

test('redacts api keys and env assignments', () => {
  const result = redactSecrets('OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx\nkey sk-ant-abcdefghijklmnopqrstuvwx');
  assert.equal(result.text.includes('sk-abcdefghijklmnopqrstuvwx'), false);
  assert.equal(result.text.includes('sk-ant-abcdefghijklmnopqrstuvwx'), false);
});

test('redaction can be disabled', () => {
  const input = 'sk-abcdefghijklmnopqrstuvwx';
  assert.equal(redactSecrets(input, false).text, input);
});

test('redacts private key blocks and bearer tokens', () => {
  const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----';
  assert.equal(redactSecrets(key).text.includes('MIIEow'), false);
  assert.equal(redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123').text.includes('abcdefghijklmnopqrstuvwxyz'), false);
});

test('tables become bullets', () => {
  const table = '| name | value |\n|---|---|\n| a | 1 |\n| b | 2 |';
  const out = formatForTelegram(table);
  assert.ok(out.includes('- a: 1'));
  assert.ok(!out.includes('|---|'));
});

test('escapeMd escapes formatting characters', () => {
  assert.equal(escapeMd('a*b_c'), 'a\\*b\\_c');
});

test('retry honors retryAfterMs', async () => {
  let attempts = 0;
  const started = Date.now();
  const value = await retry(
    async () => {
      attempts += 1;
      if (attempts < 2) {
        const error = new Error('429') as Error & { retryAfterMs: number };
        error.retryAfterMs = 30;
        throw error;
      }
      return 'ok';
    },
    { attempts: 3, baseMs: 5000 },
  );
  assert.equal(value, 'ok');
  assert.equal(attempts, 2);
  assert.ok(Date.now() - started < 1000, 'should not use the 5s base delay');
});

test('retry stops on non-retryable errors', async () => {
  let attempts = 0;
  await assert.rejects(
    retry(
      async () => {
        attempts += 1;
        throw new Error('fatal');
      },
      { attempts: 5, retryable: () => false },
    ),
  );
  assert.equal(attempts, 1);
});

test('jitter stays inside the band', () => {
  for (let index = 0; index < 50; index++) {
    const value = jitter(1000);
    assert.ok(value >= 750 && value <= 1250);
  }
});

test('duration and ago format sensibly', () => {
  assert.equal(duration(500), '500ms');
  assert.equal(duration(65_000), '1m 5s');
  assert.equal(ago(Date.now() - 120_000), '2m');
});

