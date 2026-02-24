import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTaskCreate, validateTaskUpdate } from '../lib/validation.mjs';

test('validateTaskCreate accepts valid payload', () => {
  const out = validateTaskCreate({ title: 'Build API hardening', owner: 'codi', status: 'assigned', priority: 'p1' });
  assert.equal(out.ok, true);
});

test('validateTaskCreate rejects short title', () => {
  const out = validateTaskCreate({ title: 'x' });
  assert.equal(out.ok, false);
});

test('validateTaskUpdate requires id', () => {
  const out = validateTaskUpdate({ status: 'done' });
  assert.equal(out.ok, false);
});

test('validateTaskUpdate rejects invalid status', () => {
  const out = validateTaskUpdate({ id: 'mcl-123', status: 'bad' });
  assert.equal(out.ok, false);
});
