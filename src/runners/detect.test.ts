import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectPackageManager, detectRunner, installArgs } from './detect.js';

function tempProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redgreen-detect-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('detectPackageManager picks the package manager from the lockfile', () => {
  const pnpm = tempProject({ 'pnpm-lock.yaml': '' });
  const yarn = tempProject({ 'yarn.lock': '' });
  const bun = tempProject({ 'bun.lockb': '' });
  const npm = tempProject({ 'package-lock.json': '{}' });
  const bare = tempProject({});

  try {
    assert.equal(detectPackageManager(pnpm), 'pnpm');
    assert.equal(detectPackageManager(yarn), 'yarn');
    assert.equal(detectPackageManager(bun), 'bun');
    assert.equal(detectPackageManager(npm), 'npm');
    assert.equal(detectPackageManager(bare), 'npm');
  } finally {
    for (const dir of [pnpm, yarn, bun, npm, bare]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectPackageManager prefers pnpm over npm when both locks exist', () => {
  const dir = tempProject({ 'pnpm-lock.yaml': '', 'package-lock.json': '{}' });
  try {
    assert.equal(detectPackageManager(dir), 'pnpm');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installArgs builds the dev-dependency install command per manager', () => {
  assert.deepEqual(installArgs('npm', ['vitest']), ['npm', 'install', '--save-dev', 'vitest']);
  assert.deepEqual(installArgs('pnpm', ['vitest']), ['pnpm', 'add', '-D', 'vitest']);
  assert.deepEqual(installArgs('yarn', ['vitest']), ['yarn', 'add', '--dev', 'vitest']);
  assert.deepEqual(installArgs('bun', ['vitest']), ['bun', 'add', '--dev', 'vitest']);
});

test('detectRunner finds runners via deps and config files', () => {
  const vitest = tempProject({
    'package.json': JSON.stringify({ devDependencies: { vitest: '^1.0.0' } }),
  });
  const jestConfig = tempProject({ 'jest.config.js': 'module.exports = {};' });
  const none = tempProject({ 'package.json': JSON.stringify({ scripts: { test: 'tap' } }) });

  try {
    assert.equal(detectRunner(vitest), 'vitest');
    assert.equal(detectRunner(jestConfig), 'jest');
    assert.equal(detectRunner(none), null);
  } finally {
    for (const dir of [vitest, jestConfig, none]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectRunner recognizes mocha via dep, script, and rc file', () => {
  const byDep = tempProject({
    'package.json': JSON.stringify({ devDependencies: { mocha: '^10' } }),
  });
  const byScript = tempProject({
    'package.json': JSON.stringify({ scripts: { test: 'mocha --recursive' } }),
  });
  const byRc = tempProject({ '.mocharc.json': '{"spec":"tests/**/*.ts"}' });

  try {
    assert.equal(detectRunner(byDep), 'mocha');
    assert.equal(detectRunner(byScript), 'mocha');
    assert.equal(detectRunner(byRc), 'mocha');
  } finally {
    for (const dir of [byDep, byScript, byRc]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectRunner recognizes node:test scripts and respects precedence', () => {
  const nodeTest = tempProject({
    'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
  });
  const withFlag = tempProject({
    'package.json': JSON.stringify({ scripts: { test: 'node --experimental-strip-types --test tests/' } }),
  });
  const vitestWins = tempProject({
    'package.json': JSON.stringify({
      devDependencies: { vitest: '^1' },
      scripts: { test: 'node --test' },
    }),
  });

  try {
    assert.equal(detectRunner(nodeTest), 'node-test');
    assert.equal(detectRunner(withFlag), 'node-test');
    assert.equal(detectRunner(vitestWins), 'vitest');
  } finally {
    for (const dir of [nodeTest, withFlag, vitestWins]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
