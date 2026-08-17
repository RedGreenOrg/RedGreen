import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DevSession } from './session.js';
import type { TestExecutor } from './session.js';
import type { ChatFn } from '../llm/client.js';

const SCAFFOLD = JSON.stringify({
  moduleName: 'rateLimiter',
  summary: 'sliding window rate limiter',
  typesFile: 'export interface RateLimiter {\n  check(key: string): boolean;\n}',
  implFile:
    "import type { RateLimiter } from './rateLimiter.types';\n" +
    "export function createRateLimiter(): RateLimiter {\n  throw new Error('Not implemented');\n}",
});

const RED_TESTS =
  "import { describe, it, expect } from 'vitest';\n" +
  "import { createRateLimiter } from '../src/rateLimiter';\n" +
  "it('is red', () => { expect(() => createRateLimiter()).toThrow(); });\n";

const ATTACK_TESTS =
  "import { describe, it, expect } from 'vitest';\n" +
  "import { createRateLimiter } from '../src/rateLimiter';\n" +
  "it('survives 1000 calls', () => { createRateLimiter(); expect(1).toBe(1); });\n";

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'redgreen-session-'));
}

function fakeChat(): ChatFn {
  return async (turn) => {
    const user = turn.user ?? '';
    if (user.includes('REDGREEN:TASK=scaffold')) return SCAFFOLD;
    if (user.includes('REDGREEN:TASK=attack')) return JSON.stringify({ testFile: ATTACK_TESTS });
    return JSON.stringify({ testFile: RED_TESTS });
  };
}

function queueExecutor(sequence: Array<'red' | 'green'>): TestExecutor {
  const queue = [...sequence];
  return async (runner) => {
    const kind = queue.shift() ?? 'green';
    if (kind === 'green') {
      return {
        runner,
        passed: 2,
        failed: 0,
        skipped: 0,
        total: 2,
        failures: [],
        durationMs: 10,
        rawOutput: '',
      };
    }
    return {
      runner,
      passed: 0,
      failed: 1,
      skipped: 0,
      total: 1,
      failures: [{ title: 'is red', message: 'Not implemented', file: '' }],
      durationMs: 10,
      rawOutput: '',
    };
  };
}

test('runs the full scaffold -> red -> green -> attack cycle headlessly', async () => {
  const cwd = tempProject();
  const session = new DevSession({
    feature: 'Build a rate limiter',
    runner: 'vitest',
    chat: fakeChat(),
    execute: queueExecutor(['red', 'green', 'green', 'green']),
    headless: true,
    greenTimeoutMs: 50,
    cwd,
  });

  await session.start();

  const snap = session.snapshot();
  assert.equal(snap.moduleName, 'rateLimiter');
  assert.equal(snap.finalGreen, true);
  assert.equal(snap.attackRoundsSurvived, 1);
  assert.equal(snap.finished, true);

  const types = fs.readFileSync(path.join(cwd, 'src', 'rateLimiter.types.ts'), 'utf8');
  const impl = fs.readFileSync(path.join(cwd, 'src', 'rateLimiter.ts'), 'utf8');
  const tests = fs.readFileSync(path.join(cwd, 'tests', 'rateLimiter.test.ts'), 'utf8');
  const attack = fs.readFileSync(path.join(cwd, 'tests', 'rateLimiter.attack.1.test.ts'), 'utf8');

  assert.ok(types.includes('export interface RateLimiter'));
  assert.ok(impl.includes("throw new Error('Not implemented')"));
  assert.ok(tests.includes('is red'));
  assert.ok(attack.includes('survives 1000 calls'));
  assert.ok(snap.logs.join('\n').includes('RED confirmed'));
  assert.ok(snap.logs.join('\n').includes('Attack round 1 survived'));
});

test('reuses an existing module on disk instead of calling the LLM', async () => {
  const cwd = tempProject();
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'existing.ts'), 'export const a = 1;\n');

  const stated = { scaffold: 0 };
  const chat: ChatFn = async (turn) => {
    if (turn.user.includes('REDGREEN:TASK=scaffold')) {
      stated.scaffold++;
      throw new Error('Scaffold LLM must not be called when module exists');
    }
    return JSON.stringify({ testFile: RED_TESTS });
  };

  const session = new DevSession({
    feature: 'random feature',
    runner: 'vitest',
    chat,
    execute: queueExecutor(['red', 'green', 'green']),
    headless: true,
    greenTimeoutMs: 50,
    cwd,
  });

  await session.start();
  assert.equal(stated.scaffold, 0);
  const snap = session.snapshot();
  assert.equal(snap.moduleName, 'existing');
  assert.ok(snap.logs.join('\n').includes('Reusing existing module'));
});

test('headless scaffold skips the review gate automatically', async () => {
  const cwd = tempProject();
  const session = new DevSession({
    feature: 'Build a rate limiter',
    runner: 'vitest',
    chat: fakeChat(),
    execute: queueExecutor(['red', 'green', 'green']),
    headless: true,
    greenTimeoutMs: 50,
    cwd,
  });
  const reviews: string[] = [];
  session.on('update', (s: ReturnType<DevSession['snapshot']>) => {
    if (s.prompt?.includes('approve')) reviews.push(s.prompt);
  });

  await session.start();
  assert.equal(reviews.length, 0);
  assert.equal(session.snapshot().finalGreen, true);
});