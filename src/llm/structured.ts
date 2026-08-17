import { z } from 'zod';
import type { ChatFn } from './client.js';

export function extractJsonObject(text: string): unknown | null {
  const fenced = /```(?:json)?[\r\n]+([\s\S]*?)[\r\n]+```/.exec(text.trim());
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // fall through to balanced-brace scan
    }
  }
  const end = text.lastIndexOf('}');
  if (end === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = end; i >= 0; i--) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '}') depth++;
    else if (ch === '{') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(i, end + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export interface StructuredOptions<T> {
  chat: ChatFn;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  attempts?: number;
  debugTag?: string;
}

export async function completeStructured<T>(opts: StructuredOptions<T>): Promise<{
  value: T;
  text: string;
}> {
  const attempts = opts.attempts ?? 3;
  let user = opts.user;
  for (let i = 0; i < attempts; i++) {
    const text = await opts.chat({ system: opts.system, user });
    const json = extractJsonObject(text);
    if (json !== null) {
      const parsed = opts.schema.safeParse(json);
      if (parsed.success) return { value: parsed.data, text };
      user =
        `${opts.user}\n\nYour previous response did not match the required schema. ` +
        `Fix validation errors and respond again with valid JSON only.\nErrors: ${parsed.error.message}`;
      continue;
    }
    user =
      `${opts.user}\n\nYour previous response contained no valid JSON object. ` +
      `Respond again with a single fenced JSON block only.`;
  }
  throw new Error(
    `LLM failed to produce schema-valid output for "${opts.debugTag ?? 'task'}" after ${attempts} attempts`,
  );
}