import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadConfig,
  saveConfig,
  getApiKey,
  PROVIDER_ENV,
} from './config.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redgreen-config-test-'));
process.env.REDGREEN_CONFIG_DIR = tmpDir;

test('config round-trips through obfuscated storage', () => {
  const { path: p } = saveConfig({ provider: 'openai', apiKey: 'sk-test-123' });
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok(String(raw.apiKey).startsWith('b64:'));

  const { config } = loadConfig();
  assert.ok(config);
  assert.notEqual(String(config.apiKey), 'sk-test-123');
  assert.equal(getApiKey(config), 'sk-test-123');
});

test('env var takes precedence over stored key', () => {
  saveConfig({ provider: 'openai', apiKey: 'sk-stored' });
  process.env.OPENAI_API_KEY = 'sk-env';
  const { config } = loadConfig() as { config: NonNullable<ReturnType<typeof loadConfig>['config']> };
  assert.equal(getApiKey(config), 'sk-env');
  delete process.env.OPENAI_API_KEY;
});

test('loadConfig returns null when no config exists', () => {
  process.env.REDGREEN_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'redgreen-empty-'));
  const { config } = loadConfig();
  assert.equal(config, null);
});

test('ollama needs no api key env var', () => {
  assert.equal(PROVIDER_ENV.ollama, '');
});