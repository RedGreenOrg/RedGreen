export type TestRunner = 'vitest' | 'jest' | 'mocha' | 'node-test';

export const RUNNER_INSTALL_HINT: Record<TestRunner, string> = {
  vitest: 'npm install -D vitest',
  jest: 'npm install -D jest',
  mocha: 'npm install -D mocha chai @types/chai',
  'node-test': 'node:test is built into Node 18+ (no install needed)',
};

export interface TestFailure {
  title: string;
  message: string;
  file: string;
}

export interface TestRunResult {
  runner: TestRunner;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  failures: TestFailure[];
  durationMs: number;
  rawOutput: string;
}

export function isGreen(result: TestRunResult): boolean {
  return result.failed === 0 && result.total > 0;
}