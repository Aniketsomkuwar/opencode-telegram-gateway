import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasOpenFence, splitMessage } from '../dist/split.js';

test('short text is returned unchanged', () => {
  assert.deepEqual(splitMessage('hello', 4000), ['hello']);
});

test('splits on paragraph boundaries and keeps every part under the limit', () => {
  const paragraph = 'a'.repeat(900);
  const text = [paragraph, paragraph, paragraph, paragraph].join('\n\n');
  const parts = splitMessage(text, 1000);
  assert.ok(parts.length >= 4);
  for (const part of parts) assert.ok(part.length <= 1000, `part too long: ${part.length}`);
});

test('never leaves a code fence open', () => {
  const code = Array.from({ length: 120 }, (_, index) => `const value${index} = ${index};`).join('\n');
  const text = `before\n\`\`\`ts\n${code}\n\`\`\`\nafter`;
  const parts = splitMessage(text, 900);
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.equal(hasOpenFence(part), false, 'part ends with an open fence');
    assert.ok(part.length <= 900);
  }
  assert.ok(parts[0]?.includes('```ts'));
});

test('hard-splits a single very long line', () => {
  const line = 'x'.repeat(5000);
  const parts = splitMessage(line, 800);
  assert.ok(parts.length >= 6);
  for (const part of parts) assert.ok(part.length <= 800);
  assert.equal(parts.join('').includes('x'), true);
});

test('respects the limit with margin for the part counter', () => {
  const parts = splitMessage('word '.repeat(3000), 4000);
  for (const part of parts) assert.ok(part.length <= 4000);
  assert.ok(parts.length > 1);
});

