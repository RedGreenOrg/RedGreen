import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { PROVIDER_MODELS, getApiKey } from '../config/config.js';
import type { RedGreenConfig } from '../config/config.js';

export interface ChatTurn {
  system?: string;
  user: string;
}

export type ChatFn = (turn: ChatTurn) => Promise<string>;

const STUB = {
  scaffold: JSON.stringify({
    moduleName: 'rateLimiter',
    summary: 'Sliding window rate limiter',
    typesFile:
      "export interface RateLimiter {\n" +
      "  check(key: string): boolean;\n" +
      "}\n" +
      "export function createRateLimiter(opts: { max: number; windowMs: number }): RateLimiter;",
    implFile:
      "import type { RateLimiter } from './rateLimiter.types';\n" +
      "export function createRateLimiter(opts: { max: number; windowMs: number }): RateLimiter {\n" +
      "  throw new Error('Not implemented');\n" +
      "}",
  }),
  red: JSON.stringify({
    testFile:
      "import { describe, it, expect } from 'vitest';\n" +
      "import { createRateLimiter } from '../src/rateLimiter';\n" +
      "describe('rateLimiter', () => {\n" +
      "  it('allows requests under the limit', () => {\n" +
      "    const rl = createRateLimiter({ max: 2, windowMs: 100 });\n" +
      "    expect(rl.check('a')).toBe(false);\n" +
      "  });\n" +
      "  it('flags requests over the limit', () => {\n" +
      "    const rl = createRateLimiter({ max: 1, windowMs: 100 });\n" +
      "    rl.check('a');\n" +
      "    expect(rl.check('a')).toBe(true);\n" +
      "  });\n" +
      "});",
    hints: {
      small: "The second test ('flags requests over the limit') calls check twice for the same key - look at what state must persist between those calls.",
      medium:
        "Track how many times each key has been seen recently. You need somewhere to store per-key counts, and a way to expire them so old hits stop counting after the window passes.",
      big:
        "createRateLimiter(opts):\n" +
        "  store = new Map(key -> timestamps[])\n" +
        "  check(key):\n" +
        "    now = Date.now()\n" +
        "    arr = store.get(key) ?? []\n" +
        "    arr = arr.filter(t -> now - t < windowMs)\n" +
        "    if arr.length >= max: store.set(key, arr); return true\n" +
        "    arr.push(now); store.set(key, arr); return false",
    },
  }),
  solution: JSON.stringify({
    solutionFile:
      "import type { RateLimiter } from './rateLimiter.types';\n" +
      "export function createRateLimiter(opts: { max: number; windowMs: number }): RateLimiter {\n" +
      "  const hits = new Map<string, number[]>();\n" +
      "  return {\n" +
      "    check(key: string): boolean {\n" +
      "      const now = Date.now();\n" +
      "      const recent = (hits.get(key) ?? []).filter((t) => now - t < opts.windowMs);\n" +
      "      if (recent.length >= opts.max) { hits.set(key, recent); return true; }\n" +
      "      recent.push(now);\n" +
      "      hits.set(key, recent);\n" +
      "      return false;\n" +
      "    },\n" +
      "  };\n" +
      "}",
    explanation:
      "A sliding window with per-key timestamp arrays is the clearest fit: each check prunes expired timestamps and compares the count against max. A Map keeps lookups O(1); memory is bounded by the number of active keys in a window.",
  }),
  attack: JSON.stringify({
    testFile:
      "import { describe, it, expect } from 'vitest';\n" +
      "import { createRateLimiter } from '../src/rateLimiter';\n" +
      "describe('rateLimiter attack', () => {\n" +
      "  it('survives a burst of 50 requests in one window', () => {\n" +
      "    const rl = createRateLimiter({ max: 2, windowMs: 1000 });\n" +
      "    let limited = 0;\n" +
      "    for (let i = 0; i < 50; i++) { if (rl.check('burst')) limited++; }\n" +
      "    expect(limited).toBeGreaterThanOrEqual(48);\n" +
      "  });\n" +
      "});",
  }),
  refactor: JSON.stringify({
    note: "The core check() loop prunes expired timestamps inline - extract that and avoid rebuilding the array on every call.",
    suggestions: [
      {
        title: 'extract a prune helper',
        category: 'structure',
        what: "move the 'arr.filter(t -> now - t < windowMs)' logic out of check() into a private helper",
        why: 'the pruning intent is buried inside the hot path and hard to test in isolation',
      },
      {
        title: 'avoid reallocating the timestamp array every check',
        category: 'performance',
        what: 'prune the array in place (or reuse a writable slot) instead of allocating a fresh array each call',
        why: 'check() runs on every request; needless garbage is on the hot path',
      },
    ],
  }),
};

async function stubChat(turn: ChatTurn): Promise<string> {
  const user = turn.user ?? '';
  if (user.includes('REDGREEN:TASK=scaffold')) return STUB.scaffold;
  if (user.includes('REDGREEN:TASK=solution')) return STUB.solution;
  if (user.includes('REDGREEN:TASK=attack')) return STUB.attack;
  if (user.includes('REDGREEN:TASK=refactor')) return STUB.refactor;
  return STUB.red;
}

function toApiMessages(turn: ChatTurn): Array<{ role: 'system' | 'user'; content: string }> {
  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
  if (turn.system) messages.push({ role: 'system', content: turn.system });
  messages.push({ role: 'user', content: turn.user });
  return messages;
}

async function ollamaChat(config: RedGreenConfig, turn: ChatTurn): Promise<string> {
  const base = (config.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model ?? PROVIDER_MODELS.ollama,
        messages: toApiMessages(turn),
        stream: false,
        options: { temperature: 0.2 },
      }),
    });
    if (!res.ok) {
      throw new Error(`Ollama responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const json = (await res.json()) as { message?: { content?: string } };
    return json.message?.content ?? '';
  } finally {
    clearTimeout(timer);
  }
}

function sdkChat(
  provider: 'openai' | 'anthropic' | 'gemini',
  apiKey: string,
  model: string,
): ChatFn {
  const client =
    provider === 'openai'
      ? createOpenAI({ apiKey })
      : provider === 'anthropic'
        ? createAnthropic({ apiKey })
        : createGoogleGenerativeAI({ apiKey });
  const modelRef = client(model);
  return async (turn) => {
    const { text } = await generateText({
      model: modelRef,
      system: turn.system,
      prompt: turn.user,
      temperature: 0.2,
    });
    return text;
  };
}

export function createChat(config: RedGreenConfig): ChatFn {
  if (config.provider === 'stub') return stubChat;
  if (config.provider === 'ollama') return (turn) => ollamaChat(config, turn);

  const apiKey = getApiKey(config);
  if (!apiKey) {
    throw new Error(
      `No API key for provider "${config.provider}". Set the ${config.provider.toUpperCase()}_API_KEY env var or run: npx redgreen init`,
    );
  }
  return sdkChat(config.provider, apiKey, config.model ?? PROVIDER_MODELS[config.provider]);
}