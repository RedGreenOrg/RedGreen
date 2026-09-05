import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionMemory } from './memory.js';

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'redgreen-memory-'));
}

test('records finished features and reads them back', () => {
  const cwd = tempProject();
  try {
    const mem = new SessionMemory(cwd);
    mem.record({ feature: 'Build a rate limiter', moduleName: 'rateLimiter', outcome: 'green', attacksSurvived: 2 });
    mem.record({ feature: 'Create a worker pool', moduleName: 'workerPool', outcome: 'red', attacksSurvived: 0 });

    const all = mem.readAll();
    assert.equal(all.length, 2);
    assert.equal(all[0].moduleName, 'rateLimiter');
    assert.ok(all[0].ts);
    assert.ok(fs.existsSync(path.join(cwd, '.redgreen', 'history.jsonl')));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('relevant ranks by keyword overlap with the new feature', () => {
  const cwd = tempProject();
  try {
    const mem = new SessionMemory(cwd);
    mem.record({ feature: 'Sliding window rate limiter for HTTP', moduleName: 'rateLimiter', outcome: 'green', attacksSurvived: 1 });
    mem.record({ feature: 'Worker pool executor', moduleName: 'workerPool', outcome: 'green', attacksSurvived: 3 });
    mem.record({ feature: 'Rate limiter middleware', moduleName: 'limiterMiddleware', outcome: 'green', attacksSurvived: 0 });

    const top = mem.relevant('Add a token bucket rate limiter to the API gateway', 2);
    assert.equal(top.length, 2);
    assert.equal(top[0].feature.includes('Rate limiter'), true);
    assert.notEqual(top[1].moduleName, 'limiterMiddleware'); // second is the padded recent entry
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('tolerates missing and corrupt stores', () => {
  const empty = tempProject();
  const corrupt = tempProject();
  fs.mkdirSync(path.join(corrupt, '.redgreen'), { recursive: true });
  fs.writeFileSync(path.join(corrupt, '.redgreen', 'history.jsonl'), '{ broken\nalso bad\n');
  try {
    assert.deepEqual(new SessionMemory(empty).readAll(), []);
    assert.deepEqual(new SessionMemory(empty).relevant('anything'), []);
    assert.deepEqual(new SessionMemory(corrupt).readAll(), []);
    // recording still works on a corrupt store (append-only)
    const mem = new SessionMemory(corrupt);
    mem.record({ feature: 'x'.repeat(300), moduleName: 'mod', outcome: 'green', attacksSurvived: 0 });
    assert.equal(mem.readAll().length, 1);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
    fs.rmSync(corrupt, { recursive: true, force: true });
  }
});
