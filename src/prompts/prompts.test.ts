import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNudgePrompt, buildRefactorApplyPrompt, buildRefactorPrompt, buildScaffoldPrompt } from './prompts.js';

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

test('buildRefactorApplyPrompt demands a complete suite-verified implementation', () => {
  const { system, user } = buildRefactorApplyPrompt({
    feature: 'rate limiter',
    runner: 'vitest',
    moduleName: 'rateLimiter',
    typesPath: 'src/rateLimiter.types.ts',
    implPath: 'src/rateLimiter.ts',
    typesContent: 'export interface RateLimiter { check(key: string): boolean; }',
    implContent: 'export function createRateLimiter() { return {}; }',
    testsContent: "it('limits requests', () => expect(1).toBe(1));",
    suggestion: {
      title: 'extract a prune helper',
      category: 'structure',
      what: 'pull pruning into a helper',
      why: 'it is buried in the hot path',
    },
  });
  assert.match(system, /COMPLETE modified implementation file/);
  assert.match(system, /if you break a single test, the change is rejected/);
  assert.match(system, /public API surface IDENTICAL/);
  assert.match(system, /Never modify the contract/);
  assert.match(user, /REDGREEN:TASK=refactor-apply/);
  assert.ok(user.includes('extract a prune helper'));
  assert.ok(user.includes('export interface RateLimiter'));
});

test('buildNudgePrompt targets the currently failing assertion', () => {
  const { system, user } = buildNudgePrompt({
    feature: 'rate limiter',
    runner: 'vitest',
    moduleName: 'rateLimiter',
    typesPath: 'src/rateLimiter.types.ts',
    implPath: 'src/rateLimiter.ts',
    typesContent: 'export interface RateLimiter { check(key: string): boolean; }',
    implContent: 'export function createRateLimiter() { return {}; }',
    failingAssertions: "1. boundary over max\n   expected true to be false (off by one)",
  });
  assert.match(system, /Nudge Engine/);
  assert.match(system, /CURRENT failing assertion/);
  assert.match(system, /never state the answer/);
  assert.match(user, /REDGREEN:TASK=nudge/);
  assert.ok(user.includes('Currently failing assertion'));
  assert.ok(user.includes('expected true to be false'));
  assert.ok(user.includes('export interface RateLimiter'));
});
