import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { completeStructured, extractJsonObject } from './structured.js';
import type { ChatFn } from './client.js';

test('extractJsonObject parses fenced json block', () => {
  const text = 'Here you go:\n```json\n{"module":"rateLimiter","ok":true}\n```\n';
  assert.deepEqual(extractJsonObject(text), { module: 'rateLimiter', ok: true });
});

test('extractJsonObject parses plain json with trailing prose', () => {
  const text = '{"a": 1, "b": [2, 3]}\nI think this is fine.';
  assert.deepEqual(extractJsonObject(text), { a: 1, b: [2, 3] });
});

test('extractJsonObject finds json after fenced markdown fails', () => {
  const text = '```ts\nconst x = 1;\n```\n{"answer": 42}';
  assert.deepEqual(extractJsonObject(text), { answer: 42 });
});

test('extractJsonObject tolerates braces inside strings', () => {
  const text = '{"msg": "closing } } brace", "n": 1}';
  assert.deepEqual(extractJsonObject(text), { msg: 'closing } } brace', n: 1 });
});

test('extractJsonObject returns null on garbage', () => {
  assert.equal(extractJsonObject('no json here'), null);
});

test('completeStructured succeeds on first valid response', async () => {
  const chat: ChatFn = async () => '```json\n{"name":"x"}\n```';
  const { value, text } = await completeStructured({
    chat,
    system: 's',
    user: 'u',
    schema: z.object({ name: z.string() }),
  });
  assert.deepEqual(value, { name: 'x' });
  assert.ok(text.startsWith('```json'));
});

test('completeStructured retries when schema mismatches, using feedback', async () => {
  const calls: string[] = [];
  const chat: ChatFn = async ({ user }) => {
    calls.push(user);
    return calls.length === 1 ? '{"name": 42}' : '{"name": "fixed"}';
  };
  const { value } = await completeStructured({
    chat,
    system: 's',
    user: 'u',
    schema: z.object({ name: z.string() }),
    attempts: 3,
  });
  assert.equal(value.name, 'fixed');
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes('schema'));
});

test('completeStructured exhausts attempts then throws', async () => {
  const chat: ChatFn = async () => 'not json at all';
  await assert.rejects(
    completeStructured({
      chat,
      system: 's',
      user: 'u',
      schema: z.object({ name: z.string() }),
      attempts: 2,
    }),
    /schema-valid output/,
  );
});