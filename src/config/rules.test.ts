import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCustomRules, RULES_FILE } from './rules.js';

function tempProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redgreen-rules-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('loadCustomRules returns no rules when the file is absent', () => {
  const dir = tempProject({});
  try {
    assert.deepEqual(loadCustomRules(dir), { rules: [], error: null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadCustomRules reads and normalizes a valid file', () => {
  const dir = tempProject({
    [RULES_FILE]: JSON.stringify({
      rules: ['  explicit return types ', '', 'never throw strings'],
    }),
  });
  try {
    const { rules, error } = loadCustomRules(dir);
    assert.equal(error, null);
    assert.deepEqual(rules, ['explicit return types', 'never throw strings']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadCustomRules caps rules at 10 entries', () => {
  const dir = tempProject({
    [RULES_FILE]: JSON.stringify({ rules: Array.from({ length: 14 }, (_, i) => `rule ${i}`) }),
  });
  try {
    const { rules } = loadCustomRules(dir);
    assert.equal(rules.length, 10);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadCustomRules reports malformed files without throwing', () => {
  const broken = tempProject({ [RULES_FILE]: '{ not json' });
  const wrongShape = tempProject({ [RULES_FILE]: JSON.stringify({ rules: 'nope' }) });
  const mixed = tempProject({ [RULES_FILE]: JSON.stringify({ rules: ['ok', 42] }) });
  try {
    assert.match(loadCustomRules(broken).error ?? '', /valid JSON/);
    assert.match(loadCustomRules(wrongShape).error ?? '', /array of strings/);
    assert.match(loadCustomRules(mixed).error ?? '', /array of strings/);
  } finally {
    for (const dir of [broken, wrongShape, mixed]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
