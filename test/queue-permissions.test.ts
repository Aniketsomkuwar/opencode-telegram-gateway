import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionQueue } from '../dist/queue.js';
import { Logger } from '../dist/logger.js';
import { decodeCallback, encodeCallback, riskOf, summarisePermission, PermissionBroker } from '../dist/permissions.js';
import { nextCronRun, parseCron, parseWhen } from '../dist/scheduler.js';

const logger = new Logger({ level: 'error', mirror: false });

test('queue runs one job at a time in order', async () => {
  const queue = new SessionQueue(10, logger);
  const order: number[] = [];
  const job = (index: number) => async () => {
    order.push(index);
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  queue.enqueue('s1', { chatId: 1, userId: 1, sessionId: 's1', text: 'a', files: [] }, job(1));
  queue.enqueue('s1', { chatId: 1, userId: 1, sessionId: 's1', text: 'b', files: [] }, job(2));
  const third = queue.enqueue('s1', { chatId: 1, userId: 1, sessionId: 's1', text: 'c', files: [] }, job(3));
  assert.equal(third.position, 3);
  assert.equal(third.queued, true);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(order, [1, 2, 3]);
});

test('queue isolates different sessions', async () => {
  const queue = new SessionQueue(10, logger);
  let concurrent = 0;
  let peak = 0;
  const run = async () => {
    concurrent += 1;
    peak = Math.max(peak, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 30));
    concurrent -= 1;
  };
  queue.enqueue('a', { chatId: 1, userId: 1, sessionId: 'a', text: 'x', files: [] }, run);
  queue.enqueue('b', { chatId: 1, userId: 1, sessionId: 'b', text: 'y', files: [] }, run);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(peak, 2);
});

test('queue enforces the per-session limit', () => {
  const queue = new SessionQueue(1, logger);
  queue.enqueue('s', { chatId: 1, userId: 1, sessionId: 's', text: 'a', files: [] }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  assert.throws(
    () => queue.enqueue('s', { chatId: 1, userId: 1, sessionId: 's', text: 'b', files: [] }, async () => undefined),
    /queue full/,
  );
});

test('cancel drops waiting jobs only', async () => {
  const queue = new SessionQueue(10, logger);
  queue.enqueue('s', { chatId: 1, userId: 1, sessionId: 's', text: 'a', files: [] }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  queue.enqueue('s', { chatId: 1, userId: 1, sessionId: 's', text: 'b', files: [] }, async () => undefined);
  assert.equal(queue.cancel('s'), 1);
  await new Promise((resolve) => setTimeout(resolve, 80));
});

test('risk labels classify shell as high', () => {
  assert.equal(riskOf('bash', ['rm -rf build']), 'high');
  assert.equal(riskOf('edit', ['src/a.ts']), 'medium');
  assert.equal(riskOf('read', ['src/a.ts']), 'low');
});

test('permission summary carries a risk label and the resource', () => {
  const text = summarisePermission({ action: 'bash', resources: ['npm test'] }, 'C:/proj');
  assert.match(text, /HIGH RISK/);
  assert.match(text, /npm test/);
  assert.match(text, /C:\/proj/);
});

test('callback payloads round-trip and fit in 64 bytes', () => {
  const key = 'a1b2c3d4e5f6';
  for (const decision of ['once', 'always', 'reject'] as const) {
    const data = encodeCallback(key, decision);
    assert.ok(data.length <= 64);
    assert.deepEqual(decodeCallback(data), { key, decision });
  }
  assert.equal(decodeCallback('garbage'), null);
});

test('broker dedupes by request id and resolves once', async () => {
  const decisions: string[] = [];
  const broker = new PermissionBroker({
    timeoutSeconds: 300,
    logger,
    onDecision: (context) => {
      decisions.push(context.decision);
    },
  });
  const request = { id: 'req_1', sessionID: 'ses', action: 'bash', resources: ['ls'] };
  const pending = broker.register(request, 1);
  assert.equal(broker.isTracked('req_1'), true);
  assert.equal(await broker.resolve('missing', 'once'), null);
  await broker.resolve(pending.key, 'once', { userId: 1 });
  assert.deepEqual(decisions, ['once']);
  assert.equal(broker.isTracked('req_1'), false);
  assert.equal(await broker.resolve(pending.key, 'once'), null);
  broker.dispose();
});

test('parseWhen understands relative and clock forms', () => {
  const now = new Date('2026-10-23T08:00:00').getTime();
  assert.deepEqual(parseWhen('in 10m', now), { at: now + 600_000 });
  assert.deepEqual(parseWhen('in 2h', now), { at: now + 7_200_000 });
  const at = parseWhen('at 09:30', now);
  assert.ok('at' in at && at.at > now);
  assert.ok('error' in parseWhen('tomorrow'));
});

test('cron parsing and next-run calculation', () => {
  assert.ok(parseCron('*/5 * * * *'));
  assert.equal(parseCron('bad'), null);
  const from = new Date('2026-10-23T10:02:00').getTime();
  const next = nextCronRun('*/5 * * * *', from);
  assert.equal(new Date(next as number).getMinutes(), 5);
});

