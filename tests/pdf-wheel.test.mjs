import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accumulatePdfWheel, createPdfWheelState, resetPdfWheel } from '../src/pdf-wheel.js';

test('wheel deltas accumulate and ignore movement below threshold', () => {
  let state = createPdfWheelState();
  let result = accumulatePdfWheel(state, 30, { threshold: 100 });
  assert.equal(result.direction, null);
  result = accumulatePdfWheel(result.state, 69, { threshold: 100 });
  assert.equal(result.direction, null);
  result = accumulatePdfWheel(result.state, 1, { threshold: 100 });
  assert.equal(result.direction, 'next');
  assert.deepEqual(result.state, { accumulated: 0 });
});

test('upward wheel moves to previous page and inversion reverses direction', () => {
  assert.equal(accumulatePdfWheel(createPdfWheelState(), -100).direction, 'previous');
  assert.equal(accumulatePdfWheel(createPdfWheelState(), 100, { inverted: true }).direction, 'previous');
});

test('opposite deltas cancel and reset drops accumulated input', () => {
  let result = accumulatePdfWheel(createPdfWheelState(), 80);
  result = accumulatePdfWheel(result.state, -40);
  assert.equal(result.direction, null);
  assert.equal(result.state.accumulated, 40);
  assert.deepEqual(resetPdfWheel(result.state), { accumulated: 0 });
});
