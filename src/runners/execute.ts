import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseJsonReport,
  parseVitestText,
  parseJestText,
  parseMochaText,
  parseNodeTestText,
} from './parse.js';
import type { JsonReport, PartialResult } from './parse.js';
import { RUNNER_INSTALL_HINT } from './types.js';
import type { TestRunResult, TestRunner } from './types.js';

export interface RunOptions {
  files?: string[];
  cwd?: string;
  timeoutMs?: number;
}

const RUNNER_ENTRY: Partial<Record<TestRunner, string>> = {
  vitest: path.join('vitest', 'vitest.mjs'),
  jest: path.join('jest', 'bin', 'jest.js'),
  mocha: path.join('mocha', 'bin', 'mocha.js'),
};

function resolveRunnerEntry(runner: TestRunner, cwd: string): string | null {
  const entry = RUNNER_ENTRY[runner];
  if (!entry) return null; // built-in runners (node-test) need no local install
  const full = path.join(cwd, 'node_modules', entry);
  return fs.existsSync(full) ? full : null;
}

function emptyResult(runner: TestRunner, durationMs: number, rawOutput: string): TestRunResult {
  return {
    runner,
    passed: 0,
    failed: 0,
    skipped: 0,
    total: 0,
    failures: [],
    durationMs,
    rawOutput,
  };
}

function withPartial(
  runner: TestRunner,
  durationMs: number,
  output: string,
  parsed: PartialResult | null,
): TestRunResult {
  return { ...emptyResult(runner, durationMs, output), ...(parsed ?? {}) };
}

/**
 * Spawns a test process and resolves with a parsed result. `build` receives
 * the combined stdout/stderr plus the wall-clock duration.
 */
function spawnSuite(
  cmdArgs: string[],
  runner: TestRunner,
  opts: RunOptions,
  build: (output: string, durationMs: number) => TestRunResult,
): Promise<TestRunResult> {
  const cwd = opts.cwd ?? process.cwd();
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const timeoutMs = opts.timeoutMs ?? 300_000;
    const child = spawn(cmdArgs[0], cmdArgs.slice(1), {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout?.on('data', (d: Buffer) => {
      output += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      output += d.toString('utf8');
    });

    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(() => reject(new Error(`${runner} run timed out after ${timeoutMs / 1000}s`)));
    }, timeoutMs);

    function settle(fn: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    }

    child.on('error', (err) => settle(() => reject(err)));
    child.on('close', () => {
      settle(() => resolve(build(output, Math.round(performance.now() - start))));
    });
  });
}

function nodeBinary(): string {
  // On Windows, process.execPath may traverse a junction (e.g. scoop's
  // "current" dir) which spawn cannot execute; resolve to the real binary.
  try {
    return fs.realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}

export async function runTests(runner: TestRunner, opts: RunOptions = {}): Promise<TestRunResult> {
  const cwd = opts.cwd ?? process.cwd();
  const targetFiles = opts.files ?? [];
  const node = nodeBinary();

  if (runner === 'node-test') {
    return spawnSuite(
      [node, '--test', ...targetFiles],
      runner,
      opts,
      (output, durationMs) => withPartial(runner, durationMs, output, parseNodeTestText(output)),
    );
  }

  const entry = resolveRunnerEntry(runner, cwd);
  if (!entry) {
    return Promise.reject(
      new Error(
        `No local ${runner} install found in ${path.join(cwd, 'node_modules')}. ` +
          `Install it with: ${RUNNER_INSTALL_HINT[runner]}`,
      ),
    );
  }

  if (runner === 'vitest' || runner === 'jest') {
    const tmpPath = path.join(
      os.tmpdir(),
      `redgreen-${runner}-${process.pid}-${Date.now()}.json`,
    );
    const args =
      runner === 'vitest'
        ? ['run', ...targetFiles, '--reporter=json', `--outputFile=${tmpPath}`, '--no-color']
        : [...targetFiles, '--json', `--outputFile=${tmpPath}`];

    return spawnSuite([node, entry, ...args], runner, opts, (output, durationMs) => {
      try {
        const json = JSON.parse(fs.readFileSync(tmpPath, 'utf8')) as JsonReport;
        return parseJsonReport(json, runner, output, durationMs);
      } catch {
        const textParsed =
          runner === 'vitest' ? parseVitestText(output) : parseJestText(output);
        return withPartial(runner, durationMs, output, textParsed);
      } finally {
        fs.rmSync(tmpPath, { force: true });
      }
    });
  }

  // mocha: json reporter prints straight to stdout
  return spawnSuite(
    [node, entry, ...targetFiles, '--reporter', 'json'],
    runner,
    opts,
    (output, durationMs) => withPartial(runner, durationMs, output, parseMochaText(output)),
  );
}
