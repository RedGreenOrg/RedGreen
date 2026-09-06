import test from 'node:test';
import assert from 'node:assert/strict';
import { PHASES, currentPhase, initialStatuses, type PhaseId, type PhaseStatus } from './state.js';

const ALL_PENDING: Record<PhaseId, PhaseStatus> = initialStatuses('scaffold');

test('returns the active phase when one is active', () => {
  const statuses: Record<PhaseId, PhaseStatus> = { ...ALL_PENDING, scaffold: 'active' };
  assert.equal(currentPhase(statuses), 'scaffold');
});

test('returns the active phase regardless of later done phases', () => {
  const statuses: Record<PhaseId, PhaseStatus> = { ...ALL_PENDING };
  statuses.scaffold = 'done';
  statuses.red = 'active';
  assert.equal(currentPhase(statuses), 'red');
});

test('falls back to the last started phase when none is active', () => {
  const statuses: Record<PhaseId, PhaseStatus> = { ...ALL_PENDING };
  statuses.scaffold = 'done';
  statuses.red = 'done';
  statuses.green = 'error';
  assert.equal(currentPhase(statuses), 'green');
});

test('falls back to the first phase when nothing has started', () => {
  assert.equal(currentPhase({ ...ALL_PENDING }), 'scaffold');
});

test('every phase id maps to a printable step label', () => {
  for (const p of PHASES) {
    assert.ok(p.label.length > 0, `phase ${p.id} has no label`);
    assert.ok(p.blurb.length > 0, `phase ${p.id} has no blurb`);
  }
});