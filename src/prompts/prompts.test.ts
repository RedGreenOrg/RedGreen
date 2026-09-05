import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRefactorPrompt, buildScaffoldPrompt } from './prompts.js';

const JSDOC_MARK = /JSDoc comment on each stub function/;

test('buildScaffoldPrompt includes the JSDoc rule by default', () => {
  const { system } = buildScaffoldPrompt({ feature: 'rate limiter', runner: 'vitest' });
  assert.match(system, JSDOC_MARK);
});

test('buildScaffoldPrompt includes the JSDoc rule when stubComments is true', () => {
  const { system } = buildScaffoldPrompt({
    feature: 'rate limiter',
    runner: 'vitest',
    stubComments: true,
  });
  assert.match(system, JSDOC_MARK);
});

test('buildScaffoldPrompt omits the JSDoc rule when stubComments is false', () => {
  const { system } = buildScaffoldPrompt({
    feature: 'rate limiter',
    runner: 'vitest',
    stubComments: false,
  });
  assert.doesNotMatch(system, /JSDoc/);
  // The core stub rules must stay intact either way.
  assert.match(system, /Not implemented/);
});

test('buildRefactorPrompt demands behavior-preserving refactors', () => {
  const { system, user } = buildRefactorPrompt({
    feature: 'rate limiter',
    runner: 'vitest',
    moduleName: 'rateLimiter',
    typesPath: 'src/rateLimiter.types.ts',
    implPath: 'src/rateLimiter.ts',
    typesContent: 'export interface RateLimiter { check(key: string): boolean; }',
    implContent: 'export function createRateLimiter() { return {}; }',
    testsContent: "it('limits requests', () => expect(1).toBe(1));",
  });
  assert.match(system, /behavior-preserving/);
  assert.match(system, /NEVER propose changing the public contract/);
  assert.match(user, /REDGREEN:TASK=refactor/);
  assert.ok(user.includes('export interface RateLimiter'));
});
