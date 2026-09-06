import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createChat } from '../llm/client.js';
import { detectPackageManager, detectRunner, installArgs } from '../runners/detect.js';
import { runPhaseTui, type TutorialConfig } from '../tui/PhaseTui.js';
import { isInteractive, runHeadlessDev } from '../tui/nonInteractive.js';

export const TUTORIAL_DIR = 'redgreen-tutorial';
export const TUTORIAL_FEATURE = 'create a sliding window rate limiter';

// The stub provider only knows the rate-limiter feature, so the guided loop
// completes deterministically with zero API keys and zero network.
export const TUTORIAL_STEPS: TutorialConfig['steps'] = {
  scaffold: {
    what: 'The AI designs the module: interface, types, and a stub.',
    why: 'Contracts first - agree on the shape before building anything.',
    do: 'Review the contract, then approve it. Nothing runs on your code yet.',
    keys: 'enter approve · s skip · q quit',
  },
  red: {
    what: 'The AI writes failing tests for the rate limiter.',
    why: 'A failing test is the spec - it proves the suite actually detects bugs.',
    do: 'Approve the tests, then watch them FAIL. A red suite you did not write is still your ground truth.',
    keys: 'enter approve · v review the test file · h hints',
  },
  green: {
    what: 'Your turn: implement createRateLimiter() until every test passes.',
    why: 'The AI watches the suite on every save and only advances when it is green.',
    do: 'Edit src/rateLimiter.ts. Save and keep going until the suite is green. Stuck? Press h for escalating hints (never full solutions).',
    keys: 'h hints (small → medium → big) · S reference once green · x expand the failing run',
  },
  attack: {
    what: 'The AI throws adversarial edge cases at your implementation.',
    why: 'Attack tests harden the code against bursts and boundary conditions the happy path misses.',
    do: 'Approve each attack round. If one breaks your code, the session pauses - fix it and re-run.',
    keys: 'enter approve each round · r retry after a fix',
  },
  refactor: {
    what: 'The AI proposes behavior-preserving cleanup and suite-verifies it.',
    why: 'Structure improves while every test stays green - regressions turn red the moment they happen.',
    do: 'Read the proposal, then let the AI apply it (a). The suite runs against it first; accept or reject the result.',
    keys: 'a accept apply · r reject · v view suggestions · q quit',
  },
};

/**
 * Creates a self-contained sample project in `dir` ready for the guided loop:
 * package.json (vitest dev dependency), a vitest config, and an empty src/.
 * Throws when the directory already exists and is not empty.
 */
export function scaffoldTutorial(dir: string): void {
  if (fs.existsSync(dir)) {
    const entries = fs.readdirSync(dir);
    if (entries.length > 0) {
      throw new Error(`${dir} already exists and is not empty - remove it or pass --dir`);
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'redgreen-tutorial',
        version: '0.0.0',
        private: true,
        type: 'module',
        scripts: { test: 'vitest run' },
        devDependencies: { vitest: '^3.0.0' },
      },
      null,
      2,
    ) + '\n',
  );
  fs.writeFileSync(
    path.join(dir, 'vitest.config.ts'),
    "import { defineConfig } from 'vitest/config';\n\n" +
      'export default defineConfig({\n' +
      '  test: { include: [\'tests/**/*.test.ts\'] },\n' +
      '});\n',
  );
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
}

function printGuide(): void {
  console.log('  redgreen tutorial');
  console.log('  -----------------');
  console.log('  Build a sliding-window rate limiter with the AI, one phase at a time.');
  console.log('  No API keys needed - a deterministic stub drives the AI partner.\n');
  console.log('  1. Scaffold  the AI writes the types and stubs');
  console.log('  2. Red       the AI writes failing tests (watch them fail)');
  console.log('  3. Green     you implement it until the tests pass');
  console.log('  4. Attack    the AI tries to break your code');
  console.log('  5. Refactor  the AI proposes cleanups, suite stays green\n');
  console.log('  Keys: enter approve · s skip · h hints · i command · q quit\n');
}

async function runTutorialLoop(dir: string): Promise<void> {
  const runner = detectRunner(dir);
  if (!runner) {
    console.error(`No test runner detected in ${dir} - install vitest and retry.`);
    process.exit(1);
  }
  const chat = createChat({ provider: 'stub' });
  if (isInteractive()) {
    runPhaseTui({
      feature: TUTORIAL_FEATURE,
      runner,
      chat,
      cwd: dir,
      provider: 'stub',
      tutorial: { steps: TUTORIAL_STEPS },
    });
  } else {
    // Non-TTY: run the identical loop headlessly so `tutorial --headless` is CI-friendly.
    await runHeadlessDev({ feature: TUTORIAL_FEATURE, runner, chat, cwd: dir });
  }
}

interface TutorialOptions {
  dir?: string;
  install: boolean;
  headless?: boolean;
}

export const tutorialCommand = new Command('tutorial')
  .description('Step-by-step walkthrough of the TDD loop, key-free (stub AI)')
  .option('--dir <path>', 'sandbox directory to scaffold and run in', TUTORIAL_DIR)
  .option('--no-install', 'skip installing vitest (install it yourself first)')
  .option('--headless', 'non-interactive demo run (for CI)')
  .action(async (options: TutorialOptions) => {
    const dir = options.dir ?? TUTORIAL_DIR;
    try {
      scaffoldTutorial(dir);
    } catch (err) {
      console.error(String(err instanceof Error ? err.message : err));
      process.exit(1);
    }

    if (options.install) {
      const pm = detectPackageManager(dir);
      const [cmd, ...args] = installArgs(pm, ['vitest']);
      console.log(`  $ ${[cmd, ...args].join(' ')}`);
      try {
        execSync([cmd, ...args].join(' '), { stdio: 'inherit', cwd: dir });
      } catch {
        console.error('  Install failed - run it manually and retry.');
        process.exit(1);
      }
    }

    if (!options.headless && isInteractive()) printGuide();
    await runTutorialLoop(dir);
  });