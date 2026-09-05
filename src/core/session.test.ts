import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DevSession } from './session.js';
import type { TestExecutor } from './session.js';
import type { SessionSnapshot } from './session.js';
import type { ChatFn } from '../llm/client.js';
import { RULES_FILE } from '../config/rules.js';

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

  const summaryEv = snap.events.find((e) => e.type === 'summary');
  assert.ok(summaryEv && summaryEv.type === 'summary' && summaryEv.green);
  assert.ok(summaryEv.message.includes('attacks 1/3'));
  assert.ok(summaryEv.message.includes('total'));
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

test('hints are gated by failed edits while GREEN is not reached', async () => {
  const cwd = tempProject();
  const chat: ChatFn = async (turn) => {
    const user = turn.user ?? '';
    if (user.includes('REDGREEN:TASK=scaffold')) return SCAFFOLD;
    if (user.includes('REDGREEN:TASK=attack')) return JSON.stringify({ testFile: ATTACK_TESTS });
    return JSON.stringify({
      testFile: RED_TESTS,
      hints: { small: 'one-liner', medium: 'explanation', big: 'pseudocode' },
    });
  };
  const alwaysRed: TestExecutor = async (runner) => ({
    runner,
    passed: 0,
    failed: 1,
    skipped: 0,
    total: 1,
    failures: [{ title: 'is red', message: 'Not implemented', file: '' }],
    durationMs: 10,
    rawOutput: '',
  });

  const session = new DevSession({
    feature: 'Build a rate limiter',
    runner: 'vitest',
    chat,
    execute: alwaysRed,
    headless: true,
    greenTimeoutMs: 20,
    cwd,
  });
  await session.start();

  const snap: SessionSnapshot = session.snapshot();
  assert.equal(snap.greenReached, false);
  assert.ok(snap.hints);
  assert.equal(snap.hintUnlocks.small, true);
  assert.equal(snap.hintUnlocks.medium, false);
  assert.equal(snap.hintUnlocks.big, false);
  assert.equal(await session.revealHint('small'), 'one-liner');
  assert.equal(await session.revealHint('medium'), null);
  assert.equal(await session.revealHint('big'), null);
});

test('nudges regenerate against the current failing assertion', async () => {
  const cwd = tempProject();
  const chat: ChatFn = async (turn) => {
    const user = turn.user ?? '';
    if (user.includes('REDGREEN:TASK=scaffold')) return SCAFFOLD;
    if (user.includes('REDGREEN:TASK=attack')) return JSON.stringify({ testFile: ATTACK_TESTS });
    if (user.includes('REDGREEN:TASK=nudge')) {
      return JSON.stringify({
        small: 'fresh-small',
        medium: 'fresh-medium',
        big: 'fresh-big',
      });
    }
    return JSON.stringify({ testFile: RED_TESTS, hints: { small: 'stale', medium: 'stale', big: 'stale' } });
  };
  let runs = 0;
  const executor: TestExecutor = async (runner) => {
    runs += 1;
    const failures =
      runs === 1
        ? [{ title: 'is red', message: 'Not implemented', file: '' }]
        : [{ title: 'boundary over max', message: 'off by one', file: '' }];
    return {
      runner,
      passed: 0,
      failed: 1,
      skipped: 0,
      total: 1,
      failures,
      durationMs: 10,
      rawOutput: '',
    };
  };

  const session = new DevSession({
    feature: 'Build a rate limiter',
    runner: 'vitest',
    chat,
    execute: executor,
    headless: true,
    greenTimeoutMs: 20,
    cwd,
  });
  await session.start();

  let snap = session.snapshot();
  assert.equal(snap.greenReached, false);
  assert.equal(snap.hints?.small, 'stale');
  assert.equal(snap.nudgesRegenerated, 0);

  assert.equal(await session.revealHint('small'), 'fresh-small');
  snap = session.snapshot();
  assert.equal(snap.hints?.small, 'fresh-small');
  assert.equal(snap.nudgesRegenerated, 1);
  assert.ok(snap.logs.some((l) => l.includes('regenerating nudges')));
});

test('solution stays locked until GREEN, then generates', async () => {
  const cwd = tempProject();
  const chat: ChatFn = async (turn) => {
    const user = turn.user ?? '';
    if (user.includes('REDGREEN:TASK=scaffold')) return SCAFFOLD;
    if (user.includes('REDGREEN:TASK=solution')) {
      return JSON.stringify({ solutionFile: 'export const a = 1;\n', explanation: 'a note' });
    }
    if (user.includes('REDGREEN:TASK=attack')) return JSON.stringify({ testFile: ATTACK_TESTS });
    return JSON.stringify({
      testFile: RED_TESTS,
      hints: { small: 's', medium: 'm', big: 'b' },
    });
  };

  const session = new DevSession({
    feature: 'Build a rate limiter',
    runner: 'vitest',
    chat,
    execute: queueExecutor(['red', 'green', 'green', 'green']),
    headless: true,
    greenTimeoutMs: 50,
    cwd,
  });
  await session.start();

  const snap: SessionSnapshot = session.snapshot();
  assert.equal(snap.finalGreen, true);
  assert.equal(snap.greenReached, true);
  assert.equal(snap.hintUnlocks.small, true);
  assert.equal(snap.hintUnlocks.medium, true);
  assert.equal(snap.hintUnlocks.big, true);

  await session.requestSolution();
  const after: SessionSnapshot = session.snapshot();
  assert.ok(after.solution?.includes('export const a = 1'));
  assert.equal(after.solutionExplanation, 'a note');
});

test('requestSolution is a no-op before GREEN is reached', async () => {
  const cwd = tempProject();
  const chat: ChatFn = async (turn) => {
    const user = turn.user ?? '';
    if (user.includes('REDGREEN:TASK=scaffold')) return SCAFFOLD;
    if (user.includes('REDGREEN:TASK=solution')) throw new Error('must not be called');
    if (user.includes('REDGREEN:TASK=attack')) return JSON.stringify({ testFile: ATTACK_TESTS });
    return JSON.stringify({ testFile: RED_TESTS });
  };
  const alwaysRed: TestExecutor = async (runner) => ({
    runner,
    passed: 0,
    failed: 1,
    skipped: 0,
    total: 1,
    failures: [{ title: 'is red', message: 'Not implemented', file: '' }],
    durationMs: 10,
    rawOutput: '',
  });

  const session = new DevSession({
    feature: 'Build a rate limiter',
    runner: 'vitest',
    chat,
    execute: alwaysRed,
    headless: true,
    greenTimeoutMs: 20,
    cwd,
  });
  await session.start();

  await session.requestSolution();
  const snap: SessionSnapshot = session.snapshot();
  assert.equal(snap.solution, null);
  assert.ok(snap.logs.join('\n').includes('Solution locked'));
});

test('restart scaffolds a fresh module for the new feature instead of reusing', async () => {
  const cwd = tempProject();
  let scaffoldCalls = 0;
  const chat: ChatFn = async (turn) => {
    const user = turn.user ?? '';
    if (user.includes('REDGREEN:TASK=scaffold')) {
      scaffoldCalls += 1;
      const name = scaffoldCalls === 1 ? 'rateLimiter' : 'todo';
      return JSON.stringify({
        moduleName: name,
        summary: name,
        typesFile: `export interface ${name} {}`,
        implFile: `export function make${name}() { throw new Error('Not implemented'); }`,
      });
    }
    if (user.includes('REDGREEN:TASK=attack')) return JSON.stringify({ testFile: ATTACK_TESTS });
    return JSON.stringify({ testFile: RED_TESTS });
  };

  const session = new DevSession({
    feature: 'Build a rate limiter',
    runner: 'vitest',
    chat,
    execute: queueExecutor(['red', 'green', 'green', 'green']),
    headless: true,
    greenTimeoutMs: 50,
    cwd,
  });
  await session.start();
  assert.equal(session.snapshot().moduleName, 'rateLimiter');
  assert.equal(scaffoldCalls, 1);

  await session.restart('Build a to-do list');
  assert.equal(session.snapshot().moduleName, 'todo');
  assert.equal(scaffoldCalls, 2);
  assert.ok(fs.existsSync(path.join(cwd, 'src', 'todo.ts')));
});

test('pauses with a recoverable error when the AI keeps failing, then resumes on retry', async () => {
  const cwd = tempProject();
  let failScaffold = true;
  const chat: ChatFn = async (turn) => {
    const user = turn.user ?? '';
    if (user.includes('REDGREEN:TASK=scaffold')) {
      if (failScaffold) throw new Error('quota exceeded');
      return SCAFFOLD;
    }
    if (user.includes('REDGREEN:TASK=attack')) return JSON.stringify({ testFile: ATTACK_TESTS });
    return JSON.stringify({ testFile: RED_TESTS });
  };

  const session = new DevSession({
    feature: 'Build a rate limiter',
    runner: 'vitest',
    chat,
    execute: queueExecutor(['red', 'green', 'green', 'green']),
    headless: true,
    greenTimeoutMs: 50,
    retryAttempts: 0,
    retryBaseDelayMs: 1,
    cwd,
  });

  await session.start();

  const paused: SessionSnapshot = session.snapshot();
  assert.match(paused.recoverableError ?? '', /quota exceeded/);
  assert.equal(paused.finished, false);
  assert.ok(paused.events.some((e) => e.type === 'error'));
  assert.ok(paused.logs.join('\n').includes('Scaffold failed'));

  failScaffold = false;
  await session.retryFailedStep();

  const done: SessionSnapshot = session.snapshot();
  assert.equal(done.finished, true);
  assert.equal(done.finalGreen, true);
  assert.equal(done.moduleName, 'rateLimiter');
  assert.equal(done.recoverableError, null);
});

test('auto-retries transient provider errors with backoff before surfacing anything', async () => {
  const cwd = tempProject();
  let scaffoldCalls = 0;
  const chat: ChatFn = async (turn) => {
    const user = turn.user ?? '';
    if (user.includes('REDGREEN:TASK=scaffold')) {
      scaffoldCalls += 1;
      if (scaffoldCalls < 3) throw new Error('503 service unavailable');
      return SCAFFOLD;
    }
    if (user.includes('REDGREEN:TASK=attack')) return JSON.stringify({ testFile: ATTACK_TESTS });
    return JSON.stringify({ testFile: RED_TESTS });
  };

  const session = new DevSession({
    feature: 'Build a rate limiter',
    runner: 'vitest',
    chat,
    execute: queueExecutor(['red', 'green', 'green', 'green']),
    headless: true,
    greenTimeoutMs: 50,
    retryAttempts: 3,
    retryBaseDelayMs: 5,
    cwd,
  });

  await session.start();

  const snap: SessionSnapshot = session.snapshot();
  assert.equal(scaffoldCalls, 3);
  assert.equal(snap.finalGreen, true);
  assert.equal(snap.recoverableError, null);
  assert.ok(snap.logs.join('\n').includes('retrying in'));
});

test('requestSolution records a visible solutionError and retries after failure', async () => {
  const cwd = tempProject();
  let failSolution = true;
  const chat: ChatFn = async (turn) => {
    const user = turn.user ?? '';
    if (user.includes('REDGREEN:TASK=scaffold')) return SCAFFOLD;
    if (user.includes('REDGREEN:TASK=solution')) {
      if (failSolution) throw new Error('provider down');
      return JSON.stringify({ solutionFile: 'export const a = 1;\n', explanation: 'note' });
    }
    if (user.includes('REDGREEN:TASK=attack')) return JSON.stringify({ testFile: ATTACK_TESTS });
    return JSON.stringify({ testFile: RED_TESTS });
  };

  const session = new DevSession({
    feature: 'Build a rate limiter',
    runner: 'vitest',
    chat,
    execute: queueExecutor(['red', 'green', 'green', 'green']),
    headless: true,
    greenTimeoutMs: 50,
    retryAttempts: 0,
    retryBaseDelayMs: 1,
    cwd,
  });
  await session.start();
  assert.equal(session.snapshot().greenReached, true);

  await session.requestSolution();
  let snap: SessionSnapshot = session.snapshot();
  assert.equal(snap.solution, null);
  assert.match(snap.solutionError ?? '', /provider down/);
  // pipeline stays untouched by solution failures
  assert.equal(snap.finished, true);

  failSolution = false;
  await session.requestSolution();
  snap = session.snapshot();
  assert.ok(snap.solution?.includes('export const a = 1'));
  assert.equal(snap.solutionError, null);
});

test('custom rules from .redgreen.json are announced and injected into prompts', async () => {
  const cwd = tempProject();
  fs.writeFileSync(
    path.join(cwd, RULES_FILE),
    JSON.stringify({ rules: ['Always use explicit return types'] }),
  );

  const captured: string[] = [];
  const chat: ChatFn = async (turn) => {
    captured.push(turn.user ?? '');
    const user = turn.user ?? '';
    if (user.includes('REDGREEN:TASK=scaffold')) return SCAFFOLD;
    if (user.includes('REDGREEN:TASK=attack')) return JSON.stringify({ testFile: ATTACK_TESTS });
    return JSON.stringify({ testFile: RED_TESTS });
  };

  const session = new DevSession({
    feature: 'Build a rate limiter',
    runner: 'vitest',
    chat,
    execute: queueExecutor(['red', 'green', 'green', 'green']),
    headless: true,
    greenTimeoutMs: 50,
    retryAttempts: 0,
    retryBaseDelayMs: 1,
    cwd,
  });
  await session.start();

  const snap: SessionSnapshot = session.snapshot();
  assert.ok(snap.logs.join('\n').includes('Loaded 1 project rule'));
  // scaffold + red + attack prompts all carry the rule
  assert.equal(captured.length >= 3, true);
  for (const prompt of captured) {
    assert.ok(prompt.includes('Project rules'), `rule block missing in: ${prompt.slice(0, 80)}`);
    assert.ok(prompt.includes('Always use explicit return types'));
  }
});

test('session memory feeds past features into the next scaffold prompt', async () => {
  const cwd = tempProject();

  const first = new DevSession({
    feature: 'Build a rate limiter',
    runner: 'vitest',
    chat: fakeChat(),
    execute: queueExecutor(['red', 'green', 'green', 'green']),
    headless: true,
    greenTimeoutMs: 50,
    cwd,
  });
  await first.start();
  assert.ok(fs.existsSync(path.join(cwd, '.redgreen', 'history.jsonl')));

  // Remove the generated code (but keep .redgreen/) so the next session
  // actually runs a fresh scaffold instead of reusing the module on disk.
  fs.rmSync(path.join(cwd, 'src'), { recursive: true, force: true });
  fs.rmSync(path.join(cwd, 'tests'), { recursive: true, force: true });

  const captured: string[] = [];
  const baseChat = fakeChat();
  const second = new DevSession({
    feature: 'Add rate limit metrics to the dashboard',
    runner: 'vitest',
    chat: async (turn) => {
      captured.push(turn.user ?? '');
      return baseChat(turn);
    },
    execute: queueExecutor(['red', 'green', 'green']),
    headless: true,
    greenTimeoutMs: 50,
    cwd,
  });
  await second.start();

  const scaffoldPrompt = captured.find((p) => p.includes('REDGREEN:TASK=scaffold')) ?? '';
  assert.ok(
    scaffoldPrompt.includes('Previously built in this project'),
    'expected memory block in scaffold prompt',
  );
  assert.ok(scaffoldPrompt.includes('rateLimiter'));
});

test('resumes an interrupted session: existing module + tests skip scaffold and red', async () => {
  const cwd = tempProject();
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'tests'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, 'src', 'rateLimiter.ts'),
    "export function createRateLimiter() { return true; }\n",
  );
  fs.writeFileSync(path.join(cwd, 'tests', 'rateLimiter.test.ts'), RED_TESTS);

  let forbiddenCalls = 0;
  const chat: ChatFn = async (turn) => {
    const user = turn.user ?? '';
    if (
      user.includes('REDGREEN:TASK=scaffold') ||
      user.includes('REDGREEN:TASK=red-tests')
    ) {
      forbiddenCalls += 1;
      return SCAFFOLD; // would poison the run if actually used for tests
    }
    if (user.includes('REDGREEN:TASK=attack')) return JSON.stringify({ testFile: ATTACK_TESTS });
    return JSON.stringify({ testFile: RED_TESTS });
  };

  const session = new DevSession({
    feature: 'Build a rate limiter',
    runner: 'vitest',
    chat,
    execute: queueExecutor(['green', 'green', 'green']),
    headless: true,
    greenTimeoutMs: 50,
    cwd,
  });

  await session.start();

  const snap: SessionSnapshot = session.snapshot();
  assert.equal(forbiddenCalls, 0);
  assert.equal(snap.moduleName, 'rateLimiter');
  assert.equal(snap.files.tests, path.join(cwd, 'tests', 'rateLimiter.test.ts'));
  assert.ok(snap.logs.join('\n').includes('Resuming'));
  assert.equal(snap.finalGreen, true);
});

const REFACTOR_RESPONSE = JSON.stringify({
  note: 'The sliding-window filter is duplicated across check() calls.',
  suggestions: [
    {
      title: 'extract a prune helper',
      category: 'structure',
      what: 'pull the timestamp-pruning filter into a private helper',
      why: 'it appears twice and its intent is not obvious',
    },
    {
      title: 'avoid rebuilding the array every check',
      category: 'performance',
      what: 'reuse the in-place-pruned array instead of allocating a new one',
      why: 'check() is on the hot path',
    },
  ],
});

const REFACTOR_APPLY_RESPONSE = JSON.stringify({
  filePath: 'src/rateLimiter.ts',
  code:
    "import type { RateLimiter } from './rateLimiter.types';\n" +
    "export function createRateLimiter(): RateLimiter {\n" +
    "  const prune = (): void => {};\n" +
    "  return { check(key: string): boolean { return prune(); } };\n" +
    "}",
});

function refactorChat(): ChatFn {
  return async (turn) => {
    const user = turn.user ?? '';
    if (user.includes('REDGREEN:TASK=scaffold')) return SCAFFOLD;
    if (user.includes('REDGREEN:TASK=refactor-apply')) return REFACTOR_APPLY_RESPONSE;
    if (user.includes('REDGREEN:TASK=refactor')) return REFACTOR_RESPONSE;
    if (user.includes('REDGREEN:TASK=attack')) return JSON.stringify({ testFile: ATTACK_TESTS });
    return JSON.stringify({ testFile: RED_TESTS });
  };
}

async function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// Drives the interactive pipeline through contract review + attack rounds but
// leaves the refactor watch phase pending until the test drives it manually.
function refactorWatchDriver(session: DevSession): NodeJS.Timeout {
  return setInterval(() => {
    const p = session.snapshot().prompt ?? '';
    if (p.includes('Refactor freely')) return;
    if (p.includes('approve') || p.includes('another attack') || p.includes('Tests are RED')) {
      session.approve();
    }
  }, 5);
}

test('runs the refactor phase interactively: AI suggestions then a green watch', async () => {
  const cwd = tempProject();
  const session = new DevSession({
    feature: 'Build a rate limiter',
    runner: 'vitest',
    chat: refactorChat(),
    execute: queueExecutor(['red', 'green', 'green', 'green', 'green']),
    headless: false,
    greenTimeoutMs: 500,
    cwd,
  });

  // Non-interactive test driver: approve every interactive gate (review,
  // next attack round, refactor done) as soon as it appears.
  const timer = setInterval(() => {
    const s = session.snapshot();
    if (s.finished) return;
    const p = s.prompt ?? '';
    if (p.includes('approve') || p.includes('Refactor freely') || p.includes('another attack') || p.includes('Tests are RED')) {
      session.approve();
    }
  }, 5);
  try {
    await session.start();
  } finally {
    clearInterval(timer);
    session.dispose();
  }

  const snap: SessionSnapshot = session.snapshot();
  assert.equal(snap.finished, true);
  assert.equal(snap.finalGreen, true);
  assert.equal(snap.refactorDone, true);
  assert.ok(snap.refactor);
  assert.equal(snap.refactor.suggestions.length, 2);
  assert.ok(snap.events.some((e) => e.type === 'refactor'));
  assert.ok(snap.logs.join('\n').includes('Refactor complete'));
  const summaryEv = snap.events.find((e) => e.type === 'summary');
  assert.ok(summaryEv && summaryEv.type === 'summary');
  assert.ok(summaryEv.message.includes('refactor done'));
});

test('RED test-review gate verifies intent before GREEN (TiCoder)', async () => {
  const cwd = tempProject();
  const session = new DevSession({
    feature: 'Build a rate limiter',
    runner: 'vitest',
    chat: refactorChat(),
    execute: queueExecutor(['red', 'red', 'green', 'green', 'green', 'green', 'green']),
    headless: false,
    greenTimeoutMs: 500,
    cwd,
  });

  // Approve every interactive gate, including the RED test review and the
  // refactor watch itself, so the full cycle completes.
  const timer = setInterval(() => {
    const s = session.snapshot();
    if (s.finished) return;
    const p = s.prompt ?? '';
    if (p.includes('approve') || p.includes('another attack') || p.includes('Tests are RED') || p.includes('Refactor freely')) {
      session.approve();
    }
  }, 5);
  try {
    await session.start();
  } finally {
    clearInterval(timer);
    session.dispose();
  }

  const snap: SessionSnapshot = session.snapshot();
  assert.equal(snap.finished, true);
  assert.equal(snap.finalGreen, true);
  // The gate asked the developer to review the tests AND re-verified RED.
  assert.ok(snap.events.some((e) => e.type === 'result' && e.label === 'RED re-verify'));
  assert.ok(snap.logs.join('\n').includes('still RED as expected'));
});

test('RED test-review gate is skipped headlessly', async () => {
  const cwd = tempProject();
  const session = new DevSession({
    feature: 'Build a rate limiter',
    runner: 'vitest',
    chat: refactorChat(),
    execute: queueExecutor(['red', 'green', 'green', 'green']),
    headless: true,
    greenTimeoutMs: 50,
    cwd,
  });

  await session.start();

  const snap: SessionSnapshot = session.snapshot();
  assert.equal(snap.finished, true);
  assert.equal(snap.finalGreen, true);
  assert.equal(snap.refactorDone, false);
  assert.equal(snap.refactor, null);
  assert.ok(!snap.events.some((e) => e.type === 'refactor'));
  assert.ok(!snap.events.some((e) => e.type === 'result' && e.label === 'RED re-verify'));
  const summaryEv = snap.events.find((e) => e.type === 'summary');
  assert.ok(summaryEv && summaryEv.type === 'summary' && summaryEv.message.includes('refactor -'));
});

test('auto-applies a refactor, holds it until accepted, then records it', async () => {
  const cwd = tempProject();
  const session = new DevSession({
    feature: 'Build a rate limiter',
    runner: 'vitest',
    chat: refactorChat(),
    execute: queueExecutor(['red', 'red', 'green', 'green', 'green', 'green', 'green']),
    headless: false,
    greenTimeoutMs: 500,
    cwd,
  });

  const timer = refactorWatchDriver(session);
  const startP = session.start();
  try {
    await waitFor(() => session.snapshot().refactor !== null);
    await session.applyRefactor();

    let snap: SessionSnapshot = session.snapshot();
    assert.equal(snap.refactorPending, true);
    assert.equal(snap.refactorAccepted, 0);
    const implPath = path.join(cwd, 'src', 'rateLimiter.ts');
    assert.ok(fs.readFileSync(implPath, 'utf8').includes('const prune'));

    assert.equal(session.acceptRefactorProposal(), true);
    snap = session.snapshot();
    assert.equal(snap.refactorPending, false);
    assert.equal(snap.refactorAccepted, 1);
    assert.ok(fs.readFileSync(implPath, 'utf8').includes('const prune'));
    assert.ok(snap.logs.join('\n').includes('Refactor accepted'));

    session.approve();
    await startP;
  } finally {
    clearInterval(timer);
    session.dispose();
  }

  const snap: SessionSnapshot = session.snapshot();
  assert.equal(snap.finished, true);
  assert.equal(snap.finalGreen, true);
  assert.equal(snap.refactorDone, true);
  const summaryEv = snap.events.find((e) => e.type === 'summary');
  assert.ok(summaryEv && summaryEv.type === 'summary');
  assert.ok(summaryEv.message.includes('refactor done, 1 applied'));
});

test('auto-rejects a refactor when the suite breaks and restores the file', async () => {
  const cwd = tempProject();
  const session = new DevSession({
    feature: 'Build a rate limiter',
    runner: 'vitest',
    chat: refactorChat(),
    execute: queueExecutor(['red', 'red', 'green', 'green', 'green', 'green', 'green', 'red', 'green']),
    headless: false,
    greenTimeoutMs: 500,
    cwd,
  });

  const timer = refactorWatchDriver(session);
  const startP = session.start();
  try {
    await waitFor(() => session.snapshot().refactor !== null);
    await session.applyRefactor();

    const snap: SessionSnapshot = session.snapshot();
    assert.equal(snap.refactorPending, false);
    assert.equal(snap.refactorAccepted, 0);
    const implPath = path.join(cwd, 'src', 'rateLimiter.ts');
    const impl = fs.readFileSync(implPath, 'utf8');
    assert.ok(impl.includes("throw new Error('Not implemented')"));
    assert.ok(!impl.includes('const prune'));
    assert.ok(snap.logs.join('\n').includes('Refactor rejected'));
    assert.ok(snap.logs.join('\n').includes('Restored implementation confirmed GREEN'));

    session.approve();
    await startP;
  } finally {
    clearInterval(timer);
    session.dispose();
  }

  const done: SessionSnapshot = session.snapshot();
  assert.equal(done.finished, true);
  assert.equal(done.finalGreen, true);
  assert.equal(done.refactorPending, false);
  assert.equal(done.refactorAccepted, 0);
});

test('REDGREEN_REFACTOR runs the refactor phase and auto-applies headlessly', async () => {
  const cwd = tempProject();
  const session = new DevSession({
    feature: 'Build a rate limiter',
    runner: 'vitest',
    chat: refactorChat(),
    execute: queueExecutor(['red', 'red', 'green', 'green', 'green', 'green', 'green', 'green']),
    headless: true,
    greenTimeoutMs: 500,
    refactorEnabled: true,
    cwd,
  });

  await session.start();
  session.dispose();

  const snap: SessionSnapshot = session.snapshot();
  assert.equal(snap.finished, true);
  assert.equal(snap.finalGreen, true);
  assert.equal(snap.refactorDone, true);
  assert.ok(snap.refactor);
  assert.equal(snap.refactor.suggestions.length, 2);
  // Both suggestions were suite-verified and auto-accepted with no approval.
  assert.equal(snap.refactorAccepted, 2);
  assert.ok(snap.logs.join('\n').includes('Refactor complete - tests still green (2 applied)'));
  const summaryEv = snap.events.find((e) => e.type === 'summary');
  assert.ok(summaryEv && summaryEv.type === 'summary');
  assert.ok(summaryEv.message.includes('refactor done, 2 applied'));
});