import test from 'node:test';
import assert from 'node:assert/strict';
import { activeCount, createForwardsPoller, statusText, statusLevel } from './forwards.js';

test('only running forwards are counted', () => {
  assert.equal(activeCount([{ status: 'ready' }, { status: 'starting' }, { status: 'error' }, { status: 'stopped' }]), 2);
  assert.equal(activeCount([]), 0);
});

test('the poller reports changes and polls only while forwards exist', async () => {
  const timers = []; const counts = []; let items = [{ status: 'ready' }];
  const poller = createForwardsPoller({ fetchItems: async () => items, onCount: n => counts.push(n), setTimer: fn => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
  await poller.refresh();
  assert.deepEqual(counts, [1]); assert.equal(timers.length, 1);
  await timers[0]();
  assert.deepEqual(counts, [1], 'an unchanged count is not reported again');
  assert.equal(timers.length, 2);
  items = [{ status: 'error' }];
  await timers[1]();
  assert.deepEqual(counts, [1, 0]); assert.equal(timers.length, 3, 'a failing forward is still polled');
  items = [];
  await timers[2]();
  assert.equal(timers.length, 3, 'no forwards, no polling');
  assert.equal(poller.count, 0);
});

test('a failed poll keeps the last count and does not throw', async () => {
  const counts = [];
  const poller = createForwardsPoller({ fetchItems: async () => { throw new Error('down'); }, onCount: n => counts.push(n), setTimer: () => 1, clearTimer: () => {} });
  await poller.refresh();
  assert.deepEqual(counts, []);
});

test('status text', () => {
  assert.equal(statusText({ status: 'ready' }), 'ready');
  assert.equal(statusText({ status: 'ready', restarts: 2 }), 'ready · restarted 2×');
  assert.equal(statusText({ status: 'error', lastError: 'lost connection to pod' }), 'error: lost connection to pod');
  assert.equal(statusText({ status: 'error' }), 'error: the forward stopped');
  assert.equal(statusText({ status: 'starting', restarts: 1 }), 'starting · restarted 1×');
  assert.equal(statusLevel({ status: 'error' }), 'bad');
});
