import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFileStorage, resolveSupabaseEnv } from './supabase.js';
import { DEFAULT_SUPABASE_ANON_KEY, DEFAULT_SUPABASE_URL } from './defaults.js';
import { saveConfig } from '../config/config.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redgreen-telemetry-'));
process.env.REDGREEN_CONFIG_DIR = tmpDir;

test('file storage round-trips sessions', () => {
  const storage = createFileStorage(tmpDir);
  assert.equal(storage.getItem('supabase.auth.token'), null);
  storage.setItem('supabase.auth.token', '{"access_token":"abc"}');
  assert.equal(storage.getItem('supabase.auth.token'), '{"access_token":"abc"}');
  storage.removeItem('supabase.auth.token');
  assert.equal(storage.getItem('supabase.auth.token'), null);
});

test('resolveSupabaseEnv reads from stored config', () => {
  saveConfig({
    provider: 'stub',
    supabase: { url: 'https://demo.supabase.co', anonKey: 'anon-123' },
  });
  const env = resolveSupabaseEnv();
  assert.ok(env);
  assert.equal(env.url, 'https://demo.supabase.co');
  assert.equal(env.anonKey, 'anon-123');
});

test('env vars take precedence over stored config', () => {
  saveConfig({
    provider: 'stub',
    supabase: { url: 'https://demo.supabase.co', anonKey: 'anon-123' },
  });
  process.env.SUPABASE_URL = 'https://local.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon-local';
  const env = resolveSupabaseEnv();
  assert.ok(env);
  assert.equal(env.url, 'https://local.supabase.co');
  assert.equal(env.anonKey, 'anon-local');
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
});

test('resolveSupabaseEnv falls back to compiled-in defaults when nothing is configured', () => {
  process.env.REDGREEN_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'redgreen-nocfg-'));
  const env = resolveSupabaseEnv();
  assert.ok(env);
  assert.equal(env.url, DEFAULT_SUPABASE_URL);
  assert.equal(env.anonKey, DEFAULT_SUPABASE_ANON_KEY);
});