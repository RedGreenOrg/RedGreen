import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScaffoldPrompt } from './prompts.js';

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
