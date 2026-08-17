import { DevSession } from '../core/session.js';
import type { ChatFn } from '../llm/client.js';
import type { TestRunner } from '../runners/types.js';

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function runHeadlessDev(opts: {
  feature: string;
  runner: TestRunner;
  chat: ChatFn;
  cwd?: string;
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
  });
  session.on('log', (line: string) => console.log(`  ${line}`));

  await session.start();
  const s = session.snapshot();
  console.log(
    s.finalGreen
      ? 'GREEN - all suites pass.'
      : `RED - session finished with ${s.result?.failed ?? 0} failing tests.`,
  );
  process.exitCode = s.finalGreen ? 0 : 1;
}