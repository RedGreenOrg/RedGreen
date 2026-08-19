import fs from 'node:fs';
import { z } from 'zod';
import { getConfigPath } from '../utils/paths.js';
import { OPENCODE_THEME_NAMES, type OpenCodeThemeName } from '../tui/opencodeThemes.generated.js';

export const LLM_PROVIDERS = ['openai', 'anthropic', 'gemini', 'ollama', 'stub'] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export const THEME_NAMES: readonly string[] = ['opencode', 'system', ...OPENCODE_THEME_NAMES];
export type ThemeName = 'opencode' | 'system' | OpenCodeThemeName;

export const PROVIDER_MODELS: Record<LlmProvider, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-3-5-sonnet',
  gemini: 'gemini-1.5-pro',
  ollama: 'llama3.1',
  stub: 'stub',
};

export const PROVIDER_ENV: Record<LlmProvider, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  ollama: '',
  stub: '',
};

export function initProviders(): Array<LlmProvider> {
  return LLM_PROVIDERS.filter((p) => p !== 'stub');
}

const configSchema = z.object({
  provider: z.enum(LLM_PROVIDERS),
  model: z.string().optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  theme: z.enum([...THEME_NAMES] as [string, ...string[]]).optional(),
  supabase: z
    .object({
      url: z.string().optional(),
      anonKey: z.string().optional(),
    })
    .optional(),
});

export type RedGreenConfig = z.infer<typeof configSchema>;

const OBFUSC_PREFIX = 'b64:';

// Obfuscation, not encryption: keeps the key non-plaintext on disk.
// Zero-proxy architecture means config never leaves the machine,
// and env vars always take precedence over stored keys.
function obfuscate(value: string): string {
  return OBFUSC_PREFIX + Buffer.from(value, 'utf8').toString('base64');
}

function deobfuscate(value: string): string {
  return value.startsWith(OBFUSC_PREFIX)
    ? Buffer.from(value.slice(OBFUSC_PREFIX.length), 'base64').toString('utf8')
    : value;
}

export function loadConfig(): { path: string; config: RedGreenConfig | null } {
  const p = getConfigPath();
  try {
    if (!fs.existsSync(p)) return { path: p, config: null };
    const parsed = configSchema.safeParse(JSON.parse(fs.readFileSync(p, 'utf8')));
    return { path: p, config: parsed.success ? parsed.data : null };
  } catch {
    return { path: p, config: null };
  }
}

export function saveConfig(config: RedGreenConfig): { path: string } {
  const p = getConfigPath();
  const stored: RedGreenConfig = {
    ...config,
    apiKey: config.apiKey ? obfuscate(config.apiKey) : undefined,
  };
  fs.writeFileSync(p, JSON.stringify(stored, null, 2) + '\n');
  return { path: p };
}

export function getApiKey(config: RedGreenConfig): string | undefined {
  const envVar = PROVIDER_ENV[config.provider];
  if (envVar && process.env[envVar]) return process.env[envVar];
  if (config.apiKey) return deobfuscate(config.apiKey);
  return undefined;
}

// Patches only the theme key, preserving the raw stored config verbatim
// (avoids re-obfuscating an already obfuscated apiKey).
export function updateTheme(theme: ThemeName): void {
  const p = getConfigPath();
  let raw: Record<string, unknown> = {};
  try {
    if (fs.existsSync(p)) raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    raw = {};
  }
  raw.theme = theme;
  fs.writeFileSync(p, JSON.stringify(raw, null, 2) + '\n');
}