import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFocusSync, FOCUS_SYNC_COOLDOWN_MS } from '../src/focus-sync.js';

test('focus sync waits for readiness and applies a two-second automatic cooldown', () => {
  const calls = [];
  let ready = false, time = 1_000, sequence = 0;
  const focus = createFocusSync({
    sync: (...args) => calls.push(args),
    canSync: () => ready,
    now: () => time,
    requestId: () => `request-${++sequence}`,
  });

  assert.equal(focus(), false);
  ready = true;
  assert.equal(focus(), true);
  assert.equal(focus(), false);
  time += FOCUS_SYNC_COOLDOWN_MS - 1;
  assert.equal(focus(), false);
  time += 1;
  assert.equal(focus(), true);
  assert.deepEqual(calls, [['request-1', false], ['request-2', false]]);
});

test('focus sync does not consume cooldown while the app cannot synchronize', () => {
  const calls = [];
  let ready = false, time = 5_000;
  const focus = createFocusSync({ sync: id => calls.push(id), canSync: () => ready, now: () => time, requestId: () => 'request' });
  focus();
  ready = true;
  assert.equal(focus(), true);
  assert.deepEqual(calls, ['request']);
});
