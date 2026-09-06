import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { scaffoldTutorial } from './tutorial.js';
import { detectRunner } from '../runners/detect.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'redgreen-tutorial-'));
}

test('scaffolds a runnable sample project', () => {
  const dir = path.join(tempDir(), 'sandbox');
  scaffoldTutorial(dir);

  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
    type?: string;
    scripts?: { test?: string };
    devDependencies?: Record<string, string>;
  };
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.scripts?.test, 'vitest run');
  assert.ok(pkg.devDependencies?.vitest);

  assert.ok(fs.existsSync(path.join(dir, 'vitest.config.ts')));
  assert.ok(fs.existsSync(path.join(dir, 'src')));
  assert.equal(detectRunner(dir), 'vitest');
});

test('throws when the target directory exists and is not empty', () => {
  const dir = path.join(tempDir(), 'sandbox');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'stale.txt'), 'leftover');
  assert.throws(() => scaffoldTutorial(dir), /not empty/);
});

test('scaffolding into a pre-existing empty directory succeeds', () => {
  const dir = path.join(tempDir(), 'sandbox');
  fs.mkdirSync(dir, { recursive: true });
  scaffoldTutorial(dir);
  assert.ok(fs.existsSync(path.join(dir, 'package.json')));
});