import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idleBaselineOf, turnCompleted } from '../dist/opencode.js';
import type { MessageInfo } from '../dist/types.js';

function idle(created: number, id = `idle_${created}`): MessageInfo {
  return { id, type: 'idle', time: { created } };
}

test('baseline records the newest idle time', () => {
  const baseline = idleBaselineOf([idle(100), { id: 'u', type: 'user' }, idle(250)]);
  assert.deepEqual(baseline, { count: 2, at: 250 });
});

test('a newer idle completes the turn', () => {
  const baseline = idleBaselineOf([idle(100)]);
  assert.ok(turnCompleted([idle(100), idle(300)], baseline));
});

test('an old idle does not complete the turn', () => {
  const baseline = idleBaselineOf([idle(100), idle(200)]);
  assert.equal(turnCompleted([idle(100), idle(200)], baseline), null);
});

test('no idle at all does not complete the turn', () => {
  assert.equal(turnCompleted([{ id: 'a', type: 'assistant' }], { count: 0, at: 0 }), null);
});

test('falls back to the count when payloads carry no timestamp', () => {
  const baseline = idleBaselineOf([{ id: 'i1', type: 'idle' }]);
  assert.equal(baseline.at, 0);
  assert.ok(turnCompleted([{ id: 'i1', type: 'idle' }, { id: 'i2', type: 'idle' }], baseline));
});
