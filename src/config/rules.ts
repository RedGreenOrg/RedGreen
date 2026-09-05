import fs from 'node:fs';
import path from 'node:path';

export const RULES_FILE = '.redgreen.json';
export const MAX_RULES = 10;
const MAX_RULE_LEN = 300;

/**
 * Loads per-project generation rules from .redgreen.json in the project root.
 * Missing file -> no rules, no error. Malformed file -> no rules plus an
 * error string for the caller to surface.
 */
export function loadCustomRules(cwd: string = process.cwd()): {
  rules: string[];
  error: string | null;
} {
  const file = path.join(cwd, RULES_FILE);
  if (!fs.existsSync(file)) return { rules: [], error: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { rules: [], error: `${RULES_FILE} is not valid JSON` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { rules: [], error: `${RULES_FILE} must be an object with a "rules" array` };
  }
  const rawRules = (parsed as { rules?: unknown }).rules;
  if (rawRules === undefined) return { rules: [], error: null };
  if (!Array.isArray(rawRules) || rawRules.some((r) => typeof r !== 'string')) {
    return { rules: [], error: `"rules" in ${RULES_FILE} must be an array of strings` };
  }

  const rules = rawRules
    .map((r) => (r as string).trim())
    .filter((r) => r.length > 0)
    .slice(0, MAX_RULES)
    .map((r) => (r.length > MAX_RULE_LEN ? r.slice(0, MAX_RULE_LEN - 1) + '…' : r));
  return { rules, error: null };
}
