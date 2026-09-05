import { z } from 'zod';
import type { TestRunner } from '../runners/types.js';

export type HintTier = 'small' | 'medium' | 'big';

// Per-runner test-writing guidance injected into the red/attack prompts.
function runnerGuide(runner: TestRunner): { imports: string; syntax: string } {
  switch (runner) {
    case 'vitest':
      return {
        imports: `import { describe, it, expect } from 'vitest';`,
        syntax: 'expect(...).toBe(...) / toEqual / toThrow',
      };
    case 'jest':
      return {
        imports: `import { describe, expect, it } from '@jest/globals';`,
        syntax: 'expect(...).toBe(...) / toEqual / toThrow',
      };
    case 'mocha':
      return {
        imports: `import { describe, it } from 'mocha';\nimport { expect } from 'chai';`,
        syntax: 'expect(...).to.equal(...), expect(() => ...).to.throw()',
      };
    case 'node-test':
      return {
        imports: `import { describe, it } from 'node:test';\nimport assert from 'node:assert/strict';`,
        syntax: 'assert.strictEqual / assert.deepEqual / assert.throws',
      };
  }
}

// Shared tail block appended to every prompt so user-authored project rules
// steer all generation phases (scaffold, red, attack, solution) the same way.
function rulesBlock(rules?: string[]): string {
  if (!rules || rules.length === 0) return '';
  return `\n\nProject rules (MUST follow - they override any default above):\n${rules
    .map((r) => `- ${r}`)
    .join('\n')}`;
}

export interface Hints {
  small: string;
  medium: string;
  big: string;
}

export const HINTS_SCHEMA = z.object({
  small: z.string().min(1),
  medium: z.string().min(1),
  big: z.string().min(1),
});

export const SCAFFOLD_SCHEMA = z.object({
  moduleName: z.string().regex(/^[a-z][a-zA-Z0-9]*$/, 'camelCase identifier'),
  summary: z.string().min(1),
  typesFile: z.string().min(1),
  implFile: z.string().min(1),
});

export interface ScaffoldPromptOpts {
  feature: string;
  runner: TestRunner;
  projectContext?: string;
  customRules?: string[];
  /** Prior features from the project's local memory, most relevant first. */
  pastFeatures?: string[];
  /** Include contract-explaining JSDoc on stub functions (default: true). */
  stubComments?: boolean;
}

export function buildScaffoldPrompt(opts: ScaffoldPromptOpts): {
  system: string;
  user: string;
} {
  const includeStubComments = opts.stubComments !== false;

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
- Respect the project's module system (ESM if "type": "module" in package.json).${includeStubComments ? `
- Add a short JSDoc comment on each stub function explaining WHAT it should do (never HOW).
  Ground the comment in the contract - reference the types and expected behaviour.` : ''}

Respond ONLY with a single fenced JSON block:
{
  "moduleName": "camelCase identifier",
  "summary": "one line",
  "typesFile": "complete .ts file content",
  "implFile": "complete .ts stub file content"
}`;

  const pastBlock =
    opts.pastFeatures && opts.pastFeatures.length > 0
      ? `\n\nPreviously built in this project (match its naming/conventions where sensible):\n${opts.pastFeatures
          .map((f) => `- ${f}`)
          .join('\n')}`
      : '';

  const user = `[REDGREEN:TASK=scaffold]
Feature to build: ${opts.feature}

Detected test runner: ${opts.runner}
${opts.projectContext ? `Project context:\n${opts.projectContext}` : 'Project context: (none detected)'}${pastBlock}${rulesBlock(opts.customRules)}
Generate the type contract and empty implementation stub now.`;
  return { system, user };
}

export const RED_SCHEMA = z.object({
  testFile: z.string().min(1),
  hints: HINTS_SCHEMA.optional(),
});

export interface RedPromptOpts {
  feature: string;
  runner: TestRunner;
  moduleName: string;
  typesPath: string;
  implPath: string;
  typesContent: string;
  implContent: string;
  alreadyPassingNote?: string;
  customRules?: string[];
}

export function buildRedPrompt(opts: RedPromptOpts): { system: string; user: string } {
  // node:test runs via native type stripping, which requires real ".ts"
  // extensions on relative imports; bundler-based resolvers accept them too.
  const importStatement =
    opts.runner === 'node-test' ? `../src/${opts.moduleName}.ts` : `../src/${opts.moduleName}`;
  const guide = runnerGuide(opts.runner);

  const system = `You are the Adversarial Test Driver of RedGreen.
The human developer must experience RED first: write unit tests that FAIL against the current stub,
proving the contract is not yet implemented.

Rules:
- Start the file with:
${guide.imports
  .split('\n')
  .map((l) => `  ${l}`)
  .join('\n')}
- import the module under test with: import ... from '${importStatement}';
- 3-5 focused unit tests covering happy paths AND edge cases of the CONTRACT ONLY.
- Do not test internals not in the public API. Do not modify or assert on the types file.
- Tests MUST fail right now (the stub throws Not implemented). Never import real implementation files.
- Assertion style: ${guide.syntax}.

Also generate three tiers of HINTS to help the developer reach GREEN later. Ground them in the
contract and the tests you just wrote (never put hints inside the testFile itself):
- small: ONE plain-English sentence pointing at WHERE to look (a specific test, assertion, or contract
  detail). Point at the direction, never state the answer or an algorithm.
- medium: a plain-language explanation of the approach/algorithm the developer should reach for,
  in 2-4 sentences. Still no code.
- big: pseudocode for the implementation (short function sketches, not real TypeScript). This tier
  is meant as a last resort, so it may sketch the full logic.

Respond ONLY with a single fenced JSON block:
{
  "testFile": "complete test file content",
  "hints": { "small": "one line", "medium": "plain explanation", "big": "pseudocode" }
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

  user += `${rulesBlock(opts.customRules)}\nGenerate the failing test suite now.`;
  return { system, user };
}

export const ATTACK_SCHEMA = z.object({
  testFile: z.string().min(1),
});

export interface AttackPromptOpts {
  feature: string;
  runner: TestRunner;
  moduleName: string;
  implPath: string;
  implContent: string;
  existingTests: string;
  round: number;
  customRules?: string[];
}

export function buildAttackPrompt(opts: AttackPromptOpts): { system: string; user: string } {
  const importStatement =
    opts.runner === 'node-test' ? `../src/${opts.moduleName}.ts` : `../src/${opts.moduleName}`;
  const guide = runnerGuide(opts.runner);

  const system = `You are the Attack Phase analyzer of RedGreen.
The implementation is GREEN. Now try to BREAK it with devious edge-case tests the developer did not think of.

Attack vectors to consider: race conditions, clock drift / window boundaries, negative or zero window sizes,
massive keys/lengths, repeated identical keys, monotonic timestamp rollback, off-by-one limits, NaN/Infinity,
concurrent interleavings, rapid-clear storms, and adversarial ordering.

Rules:
- Start the file with:
${guide.imports
  .split('\n')
  .map((l) => `  ${l}`)
  .join('\n')}
- import from '${importStatement}'. Assertion style: ${guide.syntax}.
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
${rulesBlock(opts.customRules)}
Attack the implementation now.`;
  return { system, user };
}

export const REFACTOR_SCHEMA = z.object({
  note: z.string().min(1),
  suggestions: z
    .array(
      z.object({
        title: z.string().min(1),
        category: z.enum(['structure', 'performance', 'clarity']),
        what: z.string().min(1),
        why: z.string().min(1),
      }),
    )
    .min(1)
    .max(8),
});

export type RefactorCategory = 'structure' | 'performance' | 'clarity';

export interface RefactorSuggestion {
  title: string;
  category: RefactorCategory;
  what: string;
  why: string;
}

export interface RefactorSuggestions {
  note: string;
  suggestions: RefactorSuggestion[];
}

export interface RefactorPromptOpts {
  feature: string;
  runner: TestRunner;
  moduleName: string;
  typesPath: string;
  implPath: string;
  typesContent: string;
  implContent: string;
  testsContent: string;
  customRules?: string[];
}

export function buildRefactorPrompt(opts: RefactorPromptOpts): { system: string; user: string } {
  const system = `You are the Refactor Coach of RedGreen.
The implementation is GREEN. Your job is to help the human restructure it WITHOUT breaking that.
You never write code - you propose targeted, behavior-preserving refactors the developer can apply.

Rules:
- Every suggestion must keep the passing test suite green - it is the safety net.
- Categories:
  - structure: extract helpers, remove duplication, reorder, split modules, simplify control flow.
  - performance: remove needless allocations/scans, avoid O(n^2) paths, hot-path tweaks.
  - clarity: better names, focused comments, consistent style.
- NEVER propose changing the public contract (types file) or the tests.
- Keep the public API surface identical to the contract.
- 2-6 concrete suggestions, highest impact first. Skip micro-nitpicks.

Respond ONLY with a single fenced JSON block:
{
  "note": "one-paragraph summary of the highest-value refactor",
  "suggestions": [
    {
      "title": "short imperative title",
      "category": "structure | performance | clarity",
      "what": "what to change, concrete and specific to this file",
      "why": "why it is worth it, grounded in this code"
    }
  ]
}`;

  const user = `[REDGREEN:TASK=refactor]
Feature: ${opts.feature}
Test runner: ${opts.runner}
Module: ${opts.moduleName}

Contract (${opts.typesPath}):
${opts.typesContent.slice(0, 8_000)}

Implementation (${opts.implPath}):
${opts.implContent.slice(0, 12_000)}

Passing test suite:
${opts.testsContent.slice(0, 8_000)}
${rulesBlock(opts.customRules)}
Propose behavior-preserving refactors now.`;
  return { system, user };
}

export const SOLUTION_SCHEMA = z.object({
  solutionFile: z.string().min(1),
  explanation: z.string().min(1),
});

export interface SolutionPromptOpts {
  feature: string;
  runner: TestRunner;
  moduleName: string;
  typesPath: string;
  implPath: string;
  typesContent: string;
  implContent: string;
  testsContent: string;
  customRules?: string[];
}

export function buildSolutionPrompt(opts: SolutionPromptOpts): { system: string; user: string } {
  const importStatement = `./${opts.moduleName}.types`;

  const system = `You are the Reference Implementer of RedGreen.
The developer has already reached GREEN on their own - this is a review aid, not a cheat.
Produce a clean reference implementation of the SAME contract for them to compare against.

Rules:
- solutionFile: a complete, idiomatic .ts implementation satisfying the contract. Import the
  contract with: import ... from '${importStatement}'. No tests, no comments beyond essentials.
- explanation: 2-4 plain-language sentences on the key decisions/tradeoffs, so the developer can
  spot where their approach differs. Do not condescend; do not rewrite their file.
- Keep the same public API surface as the contract. Nothing more.

Respond ONLY with a single fenced JSON block:
{
  "solutionFile": "complete .ts implementation file content",
  "explanation": "plain language notes"
}`;

  const user = `[REDGREEN:TASK=solution]
Feature: ${opts.feature}
Test runner: ${opts.runner}
Module: ${opts.moduleName}

Contract (${opts.typesPath}):
${opts.typesContent.slice(0, 8_000)}

Their current implementation (${opts.implPath}):
${opts.implContent.slice(0, 12_000)}

Tests that are now passing:
${opts.testsContent.slice(0, 8_000)}
${rulesBlock(opts.customRules)}
Produce the reference implementation now.`;
  return { system, user };
}