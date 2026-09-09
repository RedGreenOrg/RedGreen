import test from 'node:test';
import assert from 'node:assert/strict';
import { createChat } from './client.js';
import type { RedGreenConfig } from '../config/config.js';
import { PROVIDER_ENV, PROVIDER_MODELS, LLM_PROVIDERS } from '../config/config.js';

function cfg(partial: Partial<RedGreenConfig>): RedGreenConfig {
  return { provider: 'openai', ...partial } as RedGreenConfig;
}

test('stub provider does not need a key and serves scaffold payloads', async () => {
  const chat = createChat(cfg({ provider: 'stub' }));
  const text = await chat({ user: 'REDGREEN:TASK=scaffold build a rate limiter' });
  assert.match(text, /"moduleName"/);
});

test('ollama provider is local and does not need a key', () => {
  const chat = createChat(cfg({ provider: 'ollama' }));
  assert.equal(typeof chat, 'function');
});

test('cloud provider without any key throws a labeled error', () => {
  assert.throws(
    () => createChat(cfg({ provider: 'openai' })),
    /No API key for provider "openai"/,
  );
});

test('unknown provider throws a labeled error mentioning the provider', () => {
  assert.throws(
    () => createChat(cfg({ provider: 'grok' as RedGreenConfig['provider'] })),
    /No API key for provider "grok"/,
  );
});

test('cloud provider with an env key returns a working chat function', () => {
  process.env.OPENAI_API_KEY = 'sk-env-test';
  try {
    const chat = createChat(cfg({ provider: 'openai' }));
    assert.equal(typeof chat, 'function');
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test('openrouter is OpenAI-compatible: works with OPENROUTER_API_KEY', () => {
  process.env.OPENROUTER_API_KEY = 'sk-or-env-test';
  try {
    const chat = createChat(cfg({ provider: 'openrouter' }));
    assert.equal(typeof chat, 'function');
  } finally {
    delete process.env.OPENROUTER_API_KEY;
  }
});

test('openrouter without a key throws a labeled error', () => {
  assert.throws(
    () => createChat(cfg({ provider: 'openrouter' })),
    /No API key for provider "openrouter".*OPENROUTER_API_KEY/,
  );
});

test('openai accepts a custom baseUrl for OpenAI-compatible endpoints', () => {
  process.env.OPENAI_API_KEY = 'sk-env-test';
  try {
    const chat = createChat(cfg({ provider: 'openai', baseUrl: 'https://api.groq.com/openai/v1' }));
    assert.equal(typeof chat, 'function');
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

// Regression guard for the hardcoded-model bug: every cloud default must be a
// current, still-valid model id and never a retired one.
test('provider model defaults are current, non-deprecated model ids', () => {
  const valid: Record<string, string> = {
    openai: 'gpt-5.2',
    anthropic: 'claude-sonnet-5',
    gemini: 'gemini-3.5-flash',
    openrouter: 'openrouter/auto',
  };
  for (const [provider, want] of Object.entries(valid)) {
    assert.equal(PROVIDER_MODELS[provider], want, `${provider} default is deprecated?`);
  }
});

test('provider model defaults are never the retired model ids', () => {
  const retired = ['gpt-4o', 'claude-3-5-sonnet', 'gemini-1.5-pro'];
  for (const old of retired) {
    assert.ok(!Object.values(PROVIDER_MODELS).includes(old), `still defaulting to ${old}`);
  }
});

test('openrouter is a registered provider wired to OPENROUTER_API_KEY', () => {
  assert.ok((LLM_PROVIDERS as readonly string[]).includes('openrouter'));
  assert.equal(PROVIDER_ENV.openrouter, 'OPENROUTER_API_KEY');
});