import fs from 'node:fs';
import path from 'node:path';
import type { TestRunner } from './types.js';

export function detectRunner(cwd: string = process.cwd()): TestRunner | null {
  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.vitest) return 'vitest';
      if (deps.jest) return 'jest';
      const testScript = String(pkg.scripts?.test ?? '');
      if (/\bvitest\b/.test(testScript)) return 'vitest';
      if (/\bjest\b/.test(testScript)) return 'jest';
    } catch {
      // malformed package.json — fall through to config file detection
    }
  }
  const hasAny = (names: string[]) =>
    names.some((n) => fs.existsSync(path.join(cwd, n)));
  if (hasAny(['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js'])) return 'vitest';
  if (
    hasAny([
      'jest.config.ts',
      'jest.config.js',
      'jest.config.mjs',
      'jest.config.cjs',
      'jest.config.json',
    ])
  ) {
    return 'jest';
  }
  return null;
}