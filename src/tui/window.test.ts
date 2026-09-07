import test from 'node:test';
import assert from 'node:assert/strict';
import { windowBlocks } from './window.js';

test('content shorter than the viewport: nothing scrolls, slack fills the rest', () => {
  const w = windowBlocks([1, 1, 1], 0, 6);
  assert.equal(w.total, 3);
  assert.equal(w.scrolled, 0);
  assert.equal(w.slack, 3);
  assert.deepEqual(w.slices, [
    { block: 0, from: 0, to: 1 },
    { block: 1, from: 0, to: 1 },
    { block: 2, from: 0, to: 1 },
  ]);
});

test('scroll is clamped to the maximum reachable offset', () => {
  const w = windowBlocks([1, 1, 1, 1, 1], 999, 3);
  assert.equal(w.total, 5);
  assert.equal(w.scrolled, 2);
  assert.equal(w.slack, 0);
  assert.deepEqual(w.slices, [
    { block: 0, from: 0, to: 1 },
    { block: 1, from: 0, to: 1 },
    { block: 2, from: 0, to: 1 },
  ]);
});

test('negative scroll is clamped to zero (live view)', () => {
  const w = windowBlocks([1, 1, 1], -5, 3);
  assert.equal(w.scrolled, 0);
  assert.equal(w.top, 0);
  assert.equal(w.bottom, 3);
});

test('a tall block is clipped on both sides mid-scroll', () => {
  // blocks: 2 lines, 1 line, 4 lines => total 7
  const w = windowBlocks([2, 1, 4], 3, 3);
  // scrolled 3 -> bottom = 7 - 3 = 4, top = 4 - 3 = 1
  assert.equal(w.total, 7);
  assert.equal(w.scrolled, 3);
  assert.equal(w.top, 1);
  assert.equal(w.bottom, 4);
  // block0 (lines 0-1): visible line 1 only -> from max(0, 1-0)=1 to min(2, 4-0)=2
  // block1 (lines 2-3): visible line 2 only -> from max(0, 1-2)=0 to min(1, 4-2)=1
  // block2 (lines 3-7): visible line 3 only -> from max(0, 1-3)=0 to min(4, 4-3)=1
  assert.deepEqual(w.slices, [
    { block: 0, from: 1, to: 2 },
    { block: 1, from: 0, to: 1 },
    { block: 2, from: 0, to: 1 },
  ]);
});

test('last block can be clipped at the top of the window', () => {
  const w = windowBlocks([1, 1, 5], 4, 4);
  // total 7, max scroll 3, so scroll clamps to 3; bottom = 7-3 = 4
  assert.equal(w.scrolled, 3);
  assert.equal(w.top, 0);
  assert.equal(w.bottom, 4);
  // blocks: 1,1,5 -> starts [0,1,2,7]
  // block0 ends 1 <= top 0? no (e=1 > 0), s=0 < bottom 4 -> in view [0,1)
  // block1 [1,2) -> in view
  // block2 [2,7) -> from max(0,0-2)=0 to min(5,4-2)=2 -> [0,2)
  assert.deepEqual(w.slices, [
    { block: 0, from: 0, to: 1 },
    { block: 1, from: 0, to: 1 },
    { block: 2, from: 0, to: 2 },
  ]);
});

test('empty timeline yields no slices and full slack', () => {
  const w = windowBlocks([], 0, 5);
  assert.equal(w.total, 0);
  assert.equal(w.scrolled, 0);
  assert.deepEqual(w.slices, []);
  assert.equal(w.slack, 5);
});

test('window never exceeds the viewport height', () => {
  for (const lens of [[2, 2, 2, 2, 2], [3, 9, 1], [1, 1, 1, 1]]) {
    for (const scroll of [0, 1, 4, 99]) {
      const w = windowBlocks(lens, scroll, 4);
      assert.ok(w.bottom - w.top <= 4, `window too tall for ${lens} @ ${scroll}`);
      assert.equal(w.slack + (w.bottom - w.top), 4);
    }
  }
});