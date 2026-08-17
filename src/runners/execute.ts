import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseJsonReport, parseVitestText, parseJestText } from './parse.js';
import type { JsonReport } from './parse.js';
import type { TestRunResult, TestRunner } from './types.js';

export interface RunOptions {
  files?: string[];
  cwd?: string;
  timeoutMs?: number;
}

const RUNNER_ENTRY: Record<TestRunner, string> = {
  vitest: path.join('vitest', 'vitest.mjs'),
  jest: path.join('jest', 'bin', 'jest.js'),
};

function resolveRunnerEntry(runner: TestRunner, cwd: string): string | null {
  const entry = path.join(cwd, 'node_modules', RUNNER_ENTRY[runner]);
  if (fs.existsSync(entry)) return entry;
  return null;
}

export function runTests(runner: TestRunner, opts: RunOptions = {}): Promise<TestRunResult> {
  const cwd = opts.cwd ?? process.cwd();
  const entry = resolveRunnerEntry(runner, cwd);
  if (!entry) {
    return Promise.reject(
      new Error(
        `No local ${runner} install found in ${path.join(cwd, 'node_modules')}. ` +
          `Install it with: npm install -D ${runner}`,
      ),
    );
  }

  const targetFiles = opts.files ?? [];
  const tmpJson = path.join(os.tmpdir(), `redgreen-${runner}-${process.pid}-${Date.now()}.json`);
  const args =
    runner === 'vitest'
      ? ['run', ...targetFiles, '--reporter=json', `--outputFile=${tmpJson}`, '--no-color']
      : [...targetFiles, '--json', `--outputFile=${tmpJson}`];

  return new Promise((resolve, reject) => {
    const start = performance.now();
    const timeoutMs = opts.timeoutMs ?? 300_000;
    const child = spawn(process.execPath, [entry, ...args], {
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
      settle(() => {
        const durationMs = Math.round(performance.now() - start);
        try {
          const json = JSON.parse(fs.readFileSync(tmpJson, 'utf8')) as JsonReport;
          resolve(parseJsonReport(json, runner, output, durationMs));
        } catch {
          const parsed = runner === 'vitest' ? parseVitestText(output) : parseJestText(output);
          const base: TestRunResult = {
            runner,
            passed: 0,
            failed: 0,
            skipped: 0,
            total: 0,
            failures: [],
            durationMs,
            rawOutput: output,
          };
          resolve(parsed ? { ...base, ...parsed } : base);
        } finally {
          fs.rmSync(tmpJson, { force: true });
        }
      });
    });
  });
}