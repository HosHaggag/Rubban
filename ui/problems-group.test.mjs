import test from 'node:test';
import assert from 'node:assert/strict';
import { groupProblems, workloadOfPod, totalsOf } from './problems-group.js';

const p = (name, title, severity = 'critical', extra = {}) => ({ id: `${name}|${title}`, context: 'prod', resource: 'pods', namespace: 'shop', name, severity, title, ...extra });

test('pod names map to their workload', () => {
  assert.equal(workloadOfPod('checkout-worker-6dcd857f99-4gsfj'), 'checkout-worker');
  assert.equal(workloadOfPod('session-store-2'), 'session-store');
  assert.equal(workloadOfPod('edge-gateway-v99v8'), 'edge-gateway');
  assert.equal(workloadOfPod('plain'), 'plain');
});

test('pods of one workload failing the same way become one row', () => {
  const groups = groupProblems([p('checkout-worker-6dcd857f99-4gsfj', 'CrashLoopBackOff'), p('checkout-worker-6dcd857f99-rjcsq', 'CrashLoopBackOff')]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].owner, 'checkout-worker');
  assert.equal(groups[0].members.length, 2);
});

test('a restart warning is folded into the same pod\'s crash-loop row', () => {
  const groups = groupProblems([p('cw-6dcd857f99-4gsfj', 'CrashLoopBackOff'), p('cw-6dcd857f99-4gsfj', '5 restarts', 'warning'), p('api-6dcd857f99-aaaaa', '3 restarts', 'warning')]);
  assert.deepEqual(groups.map(g => g.title), ['CrashLoopBackOff', '3 restarts']);
});

test('critical first, and totals count every problem', () => {
  const list = [p('a-1', 'Job failed', 'warning', { resource: 'jobs', name: 'a' }), p('b-6dcd857f99-aaaaa', 'ImagePullBackOff')];
  assert.equal(groupProblems(list)[0].severity, 'critical');
  const totals = totalsOf(list);
  assert.equal(totals.critical, 1); assert.equal(totals.warning, 1); assert.equal(totals.clusters.size, 1);
});
