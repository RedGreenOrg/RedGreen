import fs from 'node:fs';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadConfig } from '../config/config.js';
import { getConfigDir } from '../utils/paths.js';
import { DEFAULT_SUPABASE_ANON_KEY, DEFAULT_SUPABASE_URL } from './defaults.js';

export const SESSION_FILE = 'session.json';

export function createFileStorage(dir: string): {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
} {
  return {
    getItem: (key) => {
      try {
        const content = fs.readFileSync(path.join(dir, SESSION_FILE), 'utf8');
        const parsed = JSON.parse(content) as Record<string, string>;
        return parsed[key] ?? null;
      } catch {
        return null;
      }
    },
    setItem: (key, value) => {
      fs.mkdirSync(dir, { recursive: true });
      let parsed: Record<string, string> = {};
      try {
        parsed = JSON.parse(fs.readFileSync(path.join(dir, SESSION_FILE), 'utf8')) as Record<
          string,
          string
        >;
      } catch {
        // fresh file
      }
      parsed[key] = value;
      fs.writeFileSync(path.join(dir, SESSION_FILE), JSON.stringify(parsed, null, 2));
    },
    removeItem: (key) => {
      try {
        const file = path.join(dir, SESSION_FILE);
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
        delete parsed[key];
        fs.writeFileSync(file, JSON.stringify(parsed, null, 2));
      } catch {
        // nothing to remove
      }
    },
  };
}

export interface SupabaseEnv {
  url: string;
  anonKey: string;
}

export function resolveSupabaseEnv(): SupabaseEnv | null {
  const { config } = loadConfig();
  const url =
    (process.env.SUPABASE_URL ??
      config?.supabase?.url ??
      process.env.SUPABASE_PUBLIC_URL) ||
    DEFAULT_SUPABASE_URL ||
    null;
  const anonKey =
    (process.env.SUPABASE_ANON_KEY ??
      config?.supabase?.anonKey ??
      process.env.SUPABASE_PUBLISHABLE_KEY) ||
    DEFAULT_SUPABASE_ANON_KEY ||
    null;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

export function hasSupabaseConfig(): boolean {
  return resolveSupabaseEnv() !== null;
}

export function createClientFromConfig(): SupabaseClient | null {
  const env = resolveSupabaseEnv();
  if (!env) return null;
  return createClient(env.url, env.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storage: createFileStorage(getConfigDir()),
    },
  });
}

export function signOutFromConfig(): void {
  try {
    fs.rmSync(path.join(getConfigDir(), SESSION_FILE), { force: true });
  } catch {
    // ignore
  }
}