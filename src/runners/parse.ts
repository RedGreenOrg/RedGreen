import type { TestFailure, TestRunResult, TestRunner } from './types.js';

const ANSI_RE = /\u001b\[[0-9;]*m/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, '');
}

interface JsonAssertion {
  ancestorTitles?: string[];
  fullName?: string;
  title?: string;
  status?: string;
  failureMessages?: string[];
  location?: { file?: string };
}

interface JsonTestResultFile {
  name?: string;
  assertionResults?: JsonAssertion[];
}

export interface JsonReport {
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  numTotalTests?: number;
  testResults?: JsonTestResultFile[];
}

export function parseJsonReport(
  json: JsonReport,
  runner: TestRunner,
  rawOutput: string,
  durationMs: number,
): TestRunResult {
  const passed = json.numPassedTests ?? 0;
  const failed = json.numFailedTests ?? 0;
  const skipped = json.numPendingTests ?? 0;
  const total = json.numTotalTests ?? passed + failed + skipped;

  const failures: TestFailure[] = [];
  for (const suite of json.testResults ?? []) {
    for (const assertion of suite.assertionResults ?? []) {
      if (assertion.status !== 'failed') continue;
      const title = [...(assertion.ancestorTitles ?? []), assertion.title ?? assertion.fullName ?? 'unknown test'].join(
        ' › ',
      );
      failures.push({
        title,
        message: stripAnsi(assertion.failureMessages?.[0] ?? '').slice(0, 400),
        file: assertion.location?.file ?? suite.name ?? '',
      });
    }
  }

  return { runner, passed, failed, skipped, total, failures, durationMs, rawOutput };
}

export type PartialResult = Partial<Omit<TestRunResult, 'runner'>>;

export function parseVitestText(output: string): PartialResult | null {
  const line = stripAnsi(output).match(/Tests\s+([^\n]+)/);
  if (!line) return null;
  const text = line[1];
  const failed = Number(text.match(/(\d+)\s+failed/)?.[1] ?? 0);
  const passed = Number(text.match(/(\d+)\s+passed/)?.[1] ?? 0);
  const total = Number(text.match(/\(\s*(\d+)\s*\)/)?.[1] ?? failed + passed);

  const failures: TestFailure[] = [];
  for (const m of stripAnsi(output).matchAll(/^\s*[×✗✖]\s+(.+)$/gm)) {
    failures.push({ title: m[1].trim(), message: '', file: '' });
  }

  return {
    passed,
    failed,
    skipped: Math.max(0, total - passed - failed),
    total,
    failures,
  };
}

export function parseJestText(output: string): PartialResult | null {
  const line = stripAnsi(output).match(/Tests:\s*([^\n]+)/);
  if (!line) return null;
  const text = line[1].replace(',', ' ');
  const failed = Number(text.match(/(\d+)\s+failed/)?.[1] ?? 0);
  const passed = Number(text.match(/(\d+)\s+passed/)?.[1] ?? 0);
  const total = Number(text.match(/(\d+)\s+total/)?.[1] ?? failed + passed);

  const failures: TestFailure[] = [];
  for (const m of stripAnsi(output).matchAll(/^\s*●\s+(.+)$/gm)) {
    if (m[1].startsWith(' ')) continue;
    failures.push({ title: m[1].trim(), message: '', file: '' });
  }

  return {
    passed,
    failed,
    skipped: Math.max(0, total - passed - failed),
    total,
    failures,
  };
}