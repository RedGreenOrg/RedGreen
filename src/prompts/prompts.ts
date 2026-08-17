import { z } from 'zod';

export const SCAFFOLD_SCHEMA = z.object({
  moduleName: z.string().regex(/^[a-z][a-zA-Z0-9]*$/, 'camelCase identifier'),
  summary: z.string().min(1),
  typesFile: z.string().min(1),
  implFile: z.string().min(1),
});

export interface ScaffoldPromptOpts {
  feature: string;
  runner: 'vitest' | 'jest';
  projectContext?: string;
}

export function buildScaffoldPrompt(opts: ScaffoldPromptOpts): {
  system: string;
  user: string;
} {
  const system = `You are the Socratic Architect of a human-centric TDD pair called RedGreen.
Your job: design the strict TypeScript contract for a feature, then STAY OUT of the implementation.
The human developer crafts all implementation logic themselves - never write real logic in the stub.

Rules:
- moduleName: a short camelCase identifier (e.g. "rateLimiter") inferred from the feature.
- typesFile: pure TypeScript contract - interfaces, type aliases, function signatures. No logic.
- implFile: an empty implementation stub. Import the contract and declare functions that satisfy it,
  but EVERY function body must throw new Error('Not implemented'). No partial logic, no TODOs with hints.
- Use extensionless relative imports between src files (e.g. "./rateLimiter.types").
- Export an organization-level API: keep the public surface small (3-6 functions).
- Respect the project's module system (ESM if "type": "module" in package.json).

Respond ONLY with a single fenced JSON block:
{
  "moduleName": "camelCase identifier",
  "summary": "one line",
  "typesFile": "complete .ts file content",
  "implFile": "complete .ts stub file content"
}`;

  const user = `[REDGREEN:TASK=scaffold]
Feature to build: ${opts.feature}

Detected test runner: ${opts.runner}
${opts.projectContext ? `Project context:\n${opts.projectContext}` : 'Project context: (none detected)'}

Generate the type contract and empty implementation stub now.`;
  return { system, user };
}

export const RED_SCHEMA = z.object({
  testFile: z.string().min(1),
});

export interface RedPromptOpts {
  feature: string;
  runner: 'vitest' | 'jest';
  moduleName: string;
  typesPath: string;
  implPath: string;
  typesContent: string;
  implContent: string;
  alreadyPassingNote?: string;
}

export function buildRedPrompt(opts: RedPromptOpts): { system: string; user: string } {
  const importStatement = `../src/${opts.moduleName}`;
  const testImport =
    opts.runner === 'vitest'
      ? `import { describe, it, expect } from 'vitest';`
      : `import { describe, expect, it } from '@jest/globals';`;

  const system = `You are the Adversarial Test Driver of RedGreen.
The human developer must experience RED first: write unit tests that FAIL against the current stub,
proving the contract is not yet implemented.

Rules:
- ${testImport}
- import the module under test with: import ... from '${importStatement}';
- 3-5 focused unit tests covering happy paths AND edge cases of the CONTRACT ONLY.
- Do not test internals not in the public API. Do not modify or assert on the types file.
- Tests MUST fail right now (the stub throws Not implemented). Never import real implementation files.
- Use the runner's natural syntax: ${opts.runner === 'vitest' ? 'expect(...).toBe(...)' : 'expect(...).toBe(...)'}.

Respond ONLY with a single fenced JSON block:
{
  "testFile": "complete test file content"
}`;

  let user = `[REDGREEN:TASK=red]
Feature: ${opts.feature}
Test runner: ${opts.runner}
Module: ${opts.moduleName}

Contract file (${opts.typesPath}):
${opts.typesContent}

Stub file (${opts.implPath}):
${opts.implContent}`;
  if (opts.alreadyPassingNote) {
    user += `\n\nIMPORTANT: The previous test file did NOT fail against the stub. Make these tests genuinely fail first. ${opts.alreadyPassingNote}`;
  }

  user += `\nGenerate the failing test suite now.`;
  return { system, user };
}

export const ATTACK_SCHEMA = z.object({
  testFile: z.string().min(1),
});

export interface AttackPromptOpts {
  feature: string;
  runner: 'vitest' | 'jest';
  moduleName: string;
  implPath: string;
  implContent: string;
  existingTests: string;
  round: number;
}

export function buildAttackPrompt(opts: AttackPromptOpts): { system: string; user: string } {
  const importStatement = `../src/${opts.moduleName}`;
  const testImport =
    opts.runner === 'vitest'
      ? `import { describe, it, expect } from 'vitest';`
      : `import { describe, expect, it } from '@jest/globals';`;

  const system = `You are the Attack Phase analyzer of RedGreen.
The implementation is GREEN. Now try to BREAK it with devious edge-case tests the developer did not think of.

Attack vectors to consider: race conditions, clock drift / window boundaries, negative or zero window sizes,
massive keys/lengths, repeated identical keys, monotonic timestamp rollback, off-by-one limits, NaN/Infinity,
concurrent interleavings, rapid-clear storms, and adversarial ordering.

Rules:
- ${testImport}
- import from '${importStatement}'.
- Generate 2-3 nasty unit tests targeting real weaknesses in the implementation below.
- These are NEW tests - do not duplicate the existing suite.
- Every test must be executable right now against the provided implementation.

Respond ONLY with a single fenced JSON block:
{
  "testFile": "complete test file content"
}`;

  const user = `[REDGREEN:TASK=attack] attack round ${opts.round}
Feature: ${opts.feature}
Test runner: ${opts.runner}
Module: ${opts.moduleName}

Implementation (${opts.implPath}):
${opts.implContent.slice(0, 12_000)}

Existing tests:
${opts.existingTests.slice(0, 8_000)}

Attack the implementation now.`;
  return { system, user };
}