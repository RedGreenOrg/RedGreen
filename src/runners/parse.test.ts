import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseJsonReport,
  parseVitestText,
  parseJestText,
  parseMochaText,
  parseNodeTestText,
  stripAnsi,
} from './parse.js';

const VITEST_JSON = {
  numTotalTestSuites: 1,
  numPassedTestSuites: 0,
  numFailedTestSuites: 1,
  numTotalTests: 4,
  numPassedTests: 1,
  numFailedTests: 3,
  numPendingTests: 0,
  startTime: 1700000000000,
  testResults: [
    {
      name: 'tests/rateLimiter.test.ts',
      status: 'failed',
      assertionResults: [
        {
          ancestorTitles: ['RateLimiter'],
          fullName: 'RateLimiter accepts burst under limit',
          status: 'passed',
          title: 'accepts burst under limit',
        },
        {
          ancestorTitles: ['RateLimiter'],
          fullName: 'RateLimiter rejects over limit',
          status: 'failed',
          title: 'rejects over limit',
          failureMessages: ['expect(release).toBe(false) - received: true'],
          location: { file: 'src/rateLimiter.ts' },
        },
        {
          ancestorTitles: ['RateLimiter'],
          fullName: 'RateLimiter enforces sliding window',
          status: 'failed',
          title: 'enforces sliding window',
          failureMessages: ['expected 10, got 13'],
        },
      ],
    },
  ],
};

test('parseJsonReport extracts vitest counts and failures', () => {
  const r = parseJsonReport(VITEST_JSON, 'vitest', '', 42);
  assert.equal(r.passed, 1);
  assert.equal(r.failed, 3);
  assert.equal(r.skipped, 0);
  assert.equal(r.total, 4);
  assert.equal(r.durationMs, 42);
  assert.equal(r.failures.length, 2);
  assert.equal(r.failures[0].title, 'RateLimiter \u203A rejects over limit');
  assert.equal(r.failures[0].file, 'src/rateLimiter.ts');
});

const JEST_JSON = {
  numTotalTests: 3,
  numPassedTests: 2,
  numFailedTests: 1,
  numPendingTests: 1,
  testResults: [
    {
      name: 'tests/queue.test.js',
      assertionResults: [
        { title: 'processes in order', status: 'passed' },
        { title: 'handles empty queue', status: 'failed', failureMessages: ['boom'] },
        { title: 'skipped inline', status: 'pending' },
      ],
    },
  ],
};

test('parseJsonReport handles jest pending tests as skipped', () => {
  const r = parseJsonReport(JEST_JSON as unknown as never, 'jest', '', 10);
  assert.equal(r.passed, 2);
  assert.equal(r.failed, 1);
  assert.equal(r.skipped, 1);
  assert.equal(r.total, 3);
  assert.equal(r.failures[0].title, 'handles empty queue');
});

test('parseVitestText parses summary lines', () => {
  const r = parseVitestText('Tests  1 failed | 3 passed (4)');
  assert.ok(r);
  assert.equal(r.failed, 1);
  assert.equal(r.passed, 3);
  assert.equal(r.total, 4);
  assert.equal(r.skipped, 0);
});

test('parseVitestText handles all-pass summary and ANSI codes', () => {
  const ESC = '\u001b[32m';
  const r = parseVitestText(ESC + 'Tests' + '\u001b[39m  4 passed (4)');
  assert.ok(r);
  assert.equal(r.failed, 0);
  assert.equal(r.passed, 4);
  assert.equal(r.total, 4);
});

test('parseVitestText extracts failing test symbols', () => {
  const r = parseVitestText(
    '\u00d7 RateLimiter rejects over limit\n  expected false\n\u2717 enforces window\n\nTests  2 failed (2)',
  );
  assert.ok(r);
  assert.equal(r.failures.length, 2);
});

test('parseJestText parses summary and failure blocks', () => {
  const r = parseJestText(
    '\u25cf RateLimiter \u203A rejects over limit\n\n  expect(release).toBe(false)\n\nTests: 1 failed, 2 passed, 3 total',
  );
  assert.ok(r);
  assert.equal(r.failed, 1);
  assert.equal(r.passed, 2);
  assert.equal(r.total, 3);
  assert.equal(r.failures[0].title, 'RateLimiter \u203A rejects over limit');
});

test('stripAnsi removes color codes', () => {
  assert.equal(stripAnsi('\u001b[32mgreen\u001b[39m text'), 'green text');
});

test('parse returns null on unknown output', () => {
  assert.equal(parseVitestText('nothing to see'), null);
  assert.equal(parseJestText('nothing to see'), null);
  assert.equal(parseMochaText('nothing to see'), null);
  assert.equal(parseNodeTestText('nothing to see'), null);
});

const MOCHA_JSON = JSON.stringify({
  stats: { suites: 1, tests: 4, passes: 2, failures: 1, pending: 1 },
  failures: [
    {
      fullTitle: 'Queue rejects over capacity',
      err: { message: 'expected false to be true' },
    },
  ],
  passes: [],
  skipped: [],
});

test('parseMochaText extracts mocha json report from noisy stdout', () => {
  const noisy = `some log line\n{"weird":true}\n${MOCHA_JSON}\nexit notes`;
  const r = parseMochaText(noisy);
  assert.ok(r);
  assert.equal(r.passed, 2);
  assert.equal(r.failed, 1);
  assert.equal(r.skipped, 1);
  assert.equal(r.total, 4);
  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0].title, 'Queue rejects over capacity');
  assert.equal(r.failures[0].message, 'expected false to be true');
});

test('parseNodeTestText parses TAP trailer counts and not-ok titles', () => {
  const tap = [
    'TAP version 13',
    '# Subtest: accepts burst',
    'ok 1 - accepts burst',
    '# Subtest: rejects over limit',
    'not ok 2 - rejects over limit',
    '  ---',
    '  error: expected 10, got 13',
    '  ...',
    'ok 3 - # SKIP flaky in ci',
    '1..3',
    '# tests 3',
    '# pass 1',
    '# fail 1',
    '# cancelled 0',
    '# skipped 1',
  ].join('\n');
  const r = parseNodeTestText(tap);
  assert.ok(r);
  assert.equal(r.total, 3);
  assert.equal(r.passed, 1);
  assert.equal(r.failed, 1);
  assert.equal(r.skipped, 1);
  assert.deepEqual(
    r.failures.map((f) => f.title),
    ['rejects over limit'],
  );
});

test('parseNodeTestText falls back to spec-reporter summary lines', () => {
  const spec = [
    '\u2716 rejects over limit (1.2ms)',
    '\u2714 accepts burst (0.4ms)',
    '\u2139 tests 3',
    '\u2139 suites 1',
    '\u2139 pass 2',
    '\u2139 fail 1',
    '\u2139 cancelled 0',
    '\u2139 skipped 0',
  ].join('\n');
  const r = parseNodeTestText(spec);
  assert.ok(r);
  assert.equal(r.total, 3);
  assert.equal(r.passed, 2);
  assert.equal(r.failed, 1);
});