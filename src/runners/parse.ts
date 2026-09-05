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

// Mocha's json reporter prints a single object to stdout; user test code may
// console.log around it, so scan balanced {...} blocks and return the first
// one that parses (optionally matching a predicate).
function findJsonObjects(text: string): Record<string, unknown>[] {
  const objs: Record<string, unknown>[] = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('{', i);
    if (start === -1) break;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = start; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') {
        inStr = true;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end !== -1) {
      try {
        const parsed: unknown = JSON.parse(text.slice(start, end + 1));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          objs.push(parsed as Record<string, unknown>);
        }
      } catch {
        // not valid JSON on its own - keep scanning after this brace
      }
      i = end + 1;
    } else {
      i = start + 1;
    }
  }
  return objs;
}

function firstJsonObject(
  text: string,
  predicate?: (obj: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  const clean = stripAnsi(text);
  for (const obj of findJsonObjects(clean)) {
    if (!predicate || predicate(obj)) return obj;
  }
  return null;
}

interface MochaFailureLike {
  fullTitle?: string;
  title?: string;
  err?: { message?: string };
}

export function parseMochaText(output: string): PartialResult | null {
  const report = firstJsonObject(output, (o) => {
    const s = o.stats;
    return !!s && typeof s === 'object' && !Array.isArray(s);
  });
  if (!report) return null;
  const stats = report.stats as
    | { passes?: number; failures?: number; pending?: number; tests?: number }
    | undefined;
  if (!stats || typeof stats !== 'object') return null;

  const passed = Number(stats.passes ?? 0);
  const failed = Number(stats.failures ?? 0);
  const skipped = Number(stats.pending ?? 0);
  const total = Number(stats.tests ?? passed + failed + skipped);

  const failures: TestFailure[] = ((report.failures as MochaFailureLike[] | undefined) ?? []).map(
    (f) => ({
      title: f.fullTitle ?? f.title ?? 'unknown test',
      message: stripAnsi(f.err?.message ?? '').slice(0, 400),
      file: '',
    }),
  );

  return { passed, failed, skipped, total, failures };
}

// node:test emits TAP by default in non-TTY spawns; the trailer comments carry
// the counts. The spec reporter (TTY / --test-reporter=spec) uses ℹ lines.
export function parseNodeTestText(output: string): PartialResult | null {
  const clean = stripAnsi(output);
  const num = (re: RegExp): number => {
    const raw = clean.match(re)?.[1];
    return raw === undefined ? NaN : Number(raw);
  };
  // num() yields NaN when a counter is absent; treat missing as zero.
  const sum = (a: number, b: number): number =>
    (Number.isFinite(a) ? a : 0) + (Number.isFinite(b) ? b : 0);

  let total = num(/#\s+tests\s+(\d+)/);
  let passed = num(/#\s+pass(?:ed)?\s+(\d+)/);
  let failed = num(/#\s+fail(?:ed)?\s+(\d+)/);
  // cancelled and skipped are distinct counters in TAP; both are neutral to
  // the loop, so they share the skipped bucket.
  let skipped = sum(num(/#\s+skipped\s+(\d+)/), num(/#\s+cancelled\s+(\d+)/));

  if (!Number.isFinite(total)) {
    total = num(/[ℹ]?\s*tests\s+(\d+)/i);
    passed = num(/[ℹ]?\s*pass(?:ed)?\s+(\d+)/i);
    failed = num(/[ℹ]?\s*fail(?:ure[s]?|ed)?\s+(\d+)/i);
    skipped = sum(num(/[ℹ]?\s*skipped\s+(\d+)/i), num(/[ℹ]?\s*(?:cancelled|todo)\s+(\d+)/i));
  }
  if (!Number.isFinite(total)) return null;

  const safe = (v: number): number => (Number.isFinite(v) ? v : 0);
  const failures: TestFailure[] = [];
  for (const m of clean.matchAll(/^not ok\s+\d+\s*-?\s*(.+)$/gm)) {
    failures.push({ title: m[1].trim(), message: '', file: '' });
  }

  return {
    passed: safe(passed),
    failed: safe(failed),
    skipped: safe(skipped),
    total: safe(total),
    failures,
  };
}