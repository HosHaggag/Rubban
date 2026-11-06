import test from 'node:test';
import assert from 'node:assert/strict';
import { healthTone, healthFacets, workloadState } from './health.js';

const deploy = (desired, ready, extra = {}) => ({ spec: { replicas: desired }, status: { readyReplicas: ready, updatedReplicas: desired, ...extra }, metadata: { generation: 2 } });

test('workload state in words', () => {
  assert.equal(workloadState('deployments', deploy(3, 3)).label, 'Healthy');
  assert.equal(workloadState('deployments', deploy(2, 0)).label, 'Unavailable');
  assert.equal(workloadState('deployments', deploy(3, 2)).label, 'Degraded');
  assert.equal(workloadState('deployments', deploy(0, 0)).label, 'Scaled to zero');
  assert.equal(workloadState('deployments', deploy(2, 0, { conditions: [{ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded' }] })).label, 'Rollout stuck');
  assert.equal(workloadState('daemonsets', { status: { desiredNumberScheduled: 2, numberReady: 2, updatedNumberScheduled: 2 }, metadata: {} }).tone, 'good');
});

test('pod tones', () => {
  assert.equal(healthTone('pods', { status: { phase: 'Running', containerStatuses: [{ ready: true, state: { running: {} } }] } }), 'good');
  assert.equal(healthTone('pods', { status: { phase: 'Running', containerStatuses: [{ ready: false, state: { waiting: { reason: 'CrashLoopBackOff' } } }] } }), 'bad');
  assert.equal(healthTone('pods', { status: { phase: 'Pending' } }), 'warn');
  assert.equal(healthTone('pods', { status: { phase: 'Running', containerStatuses: [{ ready: false, state: { running: {} } }] } }), 'warn');
});

test('old replica sets at zero are not problems; facets only where health is known', () => {
  assert.equal(healthTone('replicasets', { spec: { replicas: 0 }, status: {} }), '');
  assert.equal(healthFacets('configmaps'), null);
  assert.deepEqual(healthFacets('pods').map(f => f.id), ['good', 'warn', 'bad']);
  assert.equal(healthTone('events', { type: 'Warning' }), 'warn');
});
