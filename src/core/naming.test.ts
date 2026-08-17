import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleNameFromFeature } from './naming.js';

test('derives module name from natural feature descriptions', () => {
  assert.equal(moduleNameFromFeature('Create a sliding window rate limiter'), 'rateLimiter');
  assert.equal(moduleNameFromFeature('Build a rate limiter middleware for Supabase'), 'rateLimiter');
  assert.equal(moduleNameFromFeature('Implement a worker pool'), 'workerPool');
  assert.equal(moduleNameFromFeature('Sliding window rate limiter'), 'rateLimiter');
});

test('falls back when nothing significant remains', () => {
  assert.equal(moduleNameFromFeature('add support'), 'feature');
});

test('handles punctuation and casing', () => {
  assert.equal(moduleNameFromFeature('Checkout! with cards'), 'checkoutCards');
  assert.equal(moduleNameFromFeature('JSON Config Parser'), 'configParser');
});