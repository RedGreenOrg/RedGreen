import { DevSession } from '../core/session.js';
import type { SessionSnapshot } from '../core/session.js';
import type { ChatFn } from '../llm/client.js';
import type { TestRunner } from '../runners/types.js';
import path from 'node:path';

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function printSummary(s: SessionSnapshot, cwd: string): void {
  const files = [s.files.types, s.files.impl, s.files.tests, ...s.files.attacks].filter(
    (f): f is string => Boolean(f),
  );
  const rel = (f: string): string => path.relative(cwd, f);
  console.log('  ---- session ----');
  if (s.moduleName) console.log(`  module: ${rel(path.join(cwd, 'src', s.moduleName))}`);
  console.log(`  result: ${s.finalGreen ? 'GREEN' : 'NOT GREEN'} - ${s.result?.passed ?? 0}/${s.result?.total ?? 0} passing`);
  console.log(`  attack rounds survived: ${s.attackRoundsSurvived}/3`);
  console.log(`  refactor: ${s.refactorDone ? 'done' : '-'}`);
  if (files.length > 0) console.log(`  files: ${files.map(rel).join(', ')}`);
}

export async function runHeadlessDev(opts: {
  feature: string;
  runner: TestRunner;
  chat: ChatFn;
  cwd?: string;
  stubComments?: boolean;
}): Promise<void> {
  const parsed = Number(process.env.REDGREEN_GREEN_TIMEOUT);
  const greenTimeoutMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;

  const session = new DevSession({
    feature: opts.feature,
    runner: opts.runner,
    chat: opts.chat,
    cwd: opts.cwd,
    headless: true,
    greenTimeoutMs,
    stubComments: opts.stubComments,
  });
  session.on('log', (line: string) => console.log(`  ${line}`));

  await session.start();
  const s = session.snapshot();
  if (s.recoverableError) {
    console.error(`  FAILED - ${s.recoverableError}`);
    console.error('  The AI provider kept failing. Fix your key/config and re-run');
    console.error('  (tune attempts with REDGREEN_LLM_RETRIES, default 2).');
    process.exitCode = 1;
    return;
  }
  printSummary(s, opts.cwd ?? process.cwd());
  process.exitCode = s.finalGreen ? 0 : 1;
}