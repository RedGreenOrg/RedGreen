import fs from 'node:fs';
import path from 'node:path';
import type { TestRunner } from './types.js';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

const LOCKFILES: readonly [string, PackageManager][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
];

export function detectPackageManager(cwd: string = process.cwd()): PackageManager {
  for (const [file, pm] of LOCKFILES) {
    if (fs.existsSync(path.join(cwd, file))) return pm;
  }
  return 'npm';
}

export function installArgs(pm: PackageManager, packages: string[]): string[] {
  switch (pm) {
    case 'npm':
      return ['npm', 'install', '--save-dev', ...packages];
    case 'pnpm':
      return ['pnpm', 'add', '-D', ...packages];
    case 'yarn':
      return ['yarn', 'add', '--dev', ...packages];
    case 'bun':
      return ['bun', 'add', '--dev', ...packages];
  }
}

export function detectRunner(cwd: string = process.cwd()): TestRunner | null {
  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.vitest) return 'vitest';
      if (deps.jest) return 'jest';
      if (deps.mocha) return 'mocha';
      const testScript = String(pkg.scripts?.test ?? '');
      if (/\bvitest\b/.test(testScript)) return 'vitest';
      if (/\bjest\b/.test(testScript)) return 'jest';
      if (/\bmocha\b/.test(testScript)) return 'mocha';
      if (/node\s+\S*\s*--test\b/.test(testScript)) return 'node-test';
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
  if (hasAny(['.mocharc.json', '.mocharc.yml', '.mocharc.yaml', '.mocharc.js', '.mocharc.cjs'])) {
    return 'mocha';
  }
  return null;
}