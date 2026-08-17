export type TestRunner = 'vitest' | 'jest';

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