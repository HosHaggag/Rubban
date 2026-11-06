import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotBefore, revisionsOf, progressOf, failureOf, evaluate, undoPlan, newPodsSelector, barSegments, formatElapsed, trackKey, STALL_MS } from './rollouts-core.js';

const NOW = Date.parse('2026-11-06T14:00:00Z');
const DEPLOY_UID = 'd-1';

const deployment = ({ revision = 4, generation = 7, observed = 7, replicas = 4, status = {}, paused = false, conditions = [] } = {}) => ({
  kind: 'Deployment',
  metadata: { name: 'web', namespace: 'ft', uid: DEPLOY_UID, generation, annotations: { 'deployment.kubernetes.io/revision': String(revision) } },
  spec: { replicas, paused, selector: { matchLabels: { app: 'web' } } },
  status: { observedGeneration: observed, replicas, updatedReplicas: replicas, readyReplicas: replicas, availableReplicas: replicas, conditions, ...status },
});
const replicaSet = (revision, hash, replicas, image = `registry.example.com/shop/base:${revision}`) => ({
  metadata: { name: `web-${hash}`, uid: `rs-${hash}`, labels: { app: 'web', 'pod-template-hash': hash }, annotations: { 'deployment.kubernetes.io/revision': String(revision) }, ownerReferences: [{ uid: DEPLOY_UID, kind: 'Deployment' }] },
  spec: { replicas, template: { spec: { containers: [{ name: 'web', image }] } } },
});
const ready = { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ name: 'web', ready: true, restartCount: 0, state: { running: {} } }] };
const pulling = image => ({ phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'True' }], containerStatuses: [{ name: 'web', image, ready: false, restartCount: 0, state: { waiting: { reason: 'ImagePullBackOff', message: `Back-off pulling image "${image}": ErrImagePull: failed to pull: not found` } } }] });
const pod = (name, hash, status = ready, extra = {}) => ({ metadata: { name, namespace: 'ft', labels: { app: 'web', 'pod-template-hash': hash }, ownerReferences: [{ uid: `rs-${hash}` }], ...extra }, spec: { restartPolicy: 'Always', containers: [{ name: 'web', image: 'registry.example.com/shop/base:404' }] }, status });

test('snapshotBefore keeps what Undo and the settle check need', () => {
  assert.deepEqual(snapshotBefore('deployments', deployment({ revision: 3, generation: 6 })), { generation: 6, revision: 3, updateRevision: null, replicas: 4, paused: false });
  assert.equal(snapshotBefore('statefulsets', { metadata: { generation: 2 }, spec: {}, status: { updateRevision: 'db-abc' } }).updateRevision, 'db-abc');
  assert.equal(snapshotBefore('daemonsets', { metadata: { generation: 1 }, spec: {} }).replicas, null);
  assert.equal(snapshotBefore('deployments', null), null);
});

test('Deployment revisions come from its own ReplicaSets, newest first', () => {
  const foreign = { ...replicaSet(9, 'zzz', 1), metadata: { ...replicaSet(9, 'zzz', 1).metadata, ownerReferences: [{ uid: 'other' }] } };
  const revisions = revisionsOf('deployments', deployment(), { replicasets: [replicaSet(3, 'aaa', 0), replicaSet(4, 'bbb', 4), foreign] });
  assert.deepEqual(revisions.map(r => r.revision), [4, 3]);
  assert.equal(revisions[0].hash, 'bbb');
});

test('a Deployment mid-rollout: new pods ready and not ready, old pods, terminating ones', () => {
  const workload = deployment({ status: { replicas: 6, updatedReplicas: 2, readyReplicas: 4, availableReplicas: 4 } });
  const pods = [pod('n1', 'bbb'), pod('n2', 'bbb', { phase: 'Pending', conditions: [] }), pod('o1', 'aaa'), pod('o2', 'aaa'), pod('o3', 'aaa'), pod('o4', 'aaa', ready, { deletionTimestamp: '2026-11-06T13:59:58Z' }), { metadata: { name: 'stranger', labels: {}, ownerReferences: [{ uid: 'rs-other' }] }, status: ready }];
  const p = progressOf('deployments', workload, { replicasets: [replicaSet(3, 'aaa', 3), replicaSet(4, 'bbb', 2)], pods }, { revision: 3, generation: 6 });
  assert.deepEqual(p.segments, { newReady: 1, newNotReady: 1, old: 3, terminating: 1 });
  assert.equal(p.complete, false);
  assert.equal(p.waiting, '2 of 4 new pods created.');
  assert.equal(p.newRevision, 4);
  assert.equal(p.fromRevision, 3);
  assert.equal(p.newPods.length, 2);
  assert.equal(p.pods.length, 6);
  const bar = barSegments(p);
  assert.deepEqual(bar.map(s => s.id), ['ready', 'notready', 'old', 'terminating']);
  assert.equal(bar[2].fraction, 3 / 6);
});

test('Deployment completion follows kubectl rollout status', () => {
  const sets = { replicasets: [replicaSet(4, 'bbb', 4)], pods: [] };
  assert.equal(progressOf('deployments', deployment({ generation: 8, observed: 7 }), sets).waiting, 'Waiting for the controller to pick up the change.');
  assert.equal(progressOf('deployments', deployment({ status: { replicas: 5 } }), sets).waiting, '1 old pod still running.');
  assert.equal(progressOf('deployments', deployment({ status: { availableReplicas: 2 } }), sets).waiting, '2 of 4 new pods available.');
  assert.equal(progressOf('deployments', deployment(), sets).complete, true);
  const stuck = progressOf('deployments', deployment({ status: { updatedReplicas: 1 }, conditions: [{ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded', message: 'ReplicaSet "web-bbb" has timed out progressing.' }] }), sets);
  assert.match(stuck.deadline, /timed out progressing/);
});

test('StatefulSet: revisions are ControllerRevisions, pods match by controller-revision-hash', () => {
  const sts = { metadata: { name: 'db', uid: 's-1', generation: 3 }, spec: { replicas: 3, updateStrategy: { type: 'RollingUpdate' } }, status: { observedGeneration: 3, replicas: 3, readyReplicas: 3, updatedReplicas: 1, currentRevision: 'db-old', updateRevision: 'db-new' } };
  const crs = [{ metadata: { name: 'db-old', ownerReferences: [{ uid: 's-1' }] }, revision: 1 }, { metadata: { name: 'db-new', ownerReferences: [{ uid: 's-1' }] }, revision: 2 }];
  const stsPod = (name, hash) => ({ metadata: { name, labels: { 'controller-revision-hash': hash }, ownerReferences: [{ uid: 's-1' }] }, status: ready });
  const p = progressOf('statefulsets', sts, { controllerrevisions: crs, pods: [stsPod('db-2', 'db-new'), stsPod('db-1', 'db-old'), stsPod('db-0', 'db-old')] });
  assert.equal(p.newRevision, 2);
  assert.equal(p.fromRevision, 1);
  assert.deepEqual(p.segments, { newReady: 1, newNotReady: 0, old: 2, terminating: 0 });
  assert.equal(p.waiting, '1 of 3 pods on the new revision.');
  assert.equal(p.complete, false);
  const done = progressOf('statefulsets', { ...sts, status: { ...sts.status, updatedReplicas: 3, currentRevision: 'db-new' } }, { controllerrevisions: crs, pods: [] });
  assert.equal(done.complete, true);
  const partitioned = progressOf('statefulsets', { ...sts, spec: { ...sts.spec, updateStrategy: { type: 'RollingUpdate', rollingUpdate: { partition: 2 } } } }, { controllerrevisions: crs, pods: [] });
  assert.equal(partitioned.complete, true, 'only the pods above the partition must update');
  assert.equal(newPodsSelector('statefulsets', p, 'app=db'), 'app=db,controller-revision-hash=db-new');
});

test('DaemonSet: newest ControllerRevision is the new one; its pods carry only the hash', () => {
  const ds = { metadata: { name: 'agent', uid: 'a-1', generation: 2 }, spec: { updateStrategy: { type: 'RollingUpdate' } }, status: { observedGeneration: 2, desiredNumberScheduled: 3, updatedNumberScheduled: 3, numberReady: 2, numberAvailable: 2, currentNumberScheduled: 3 } };
  const crs = [{ metadata: { name: 'agent-5f6d', labels: { 'controller-revision-hash': '5f6d' }, ownerReferences: [{ uid: 'a-1' }] }, revision: 2 }, { metadata: { name: 'agent-11aa', ownerReferences: [{ uid: 'a-1' }] }, revision: 1 }];
  const dsPod = (name, hash, status = ready) => ({ metadata: { name, labels: { 'controller-revision-hash': hash }, ownerReferences: [{ uid: 'a-1' }] }, status });
  const p = progressOf('daemonsets', ds, { controllerrevisions: crs, pods: [dsPod('a', '5f6d'), dsPod('b', '5f6d'), dsPod('c', '5f6d', { phase: 'Running', conditions: [] })] });
  assert.equal(p.newRevision, 2);
  assert.equal(p.desired, 3);
  assert.equal(p.waiting, '2 of 3 pods available.');
  assert.deepEqual(p.segments, { newReady: 2, newNotReady: 1, old: 0, terminating: 0 });
  assert.equal(undoPlan({ action: 'watch' }, p).revision, 1);
  assert.equal(p.fromRevision, null, 'a plain watch with no old pods left names no start revision');
  assert.equal(progressOf('daemonsets', ds, { controllerrevisions: crs, pods: [] }, { generation: 1 }).fromRevision, 1, 'after a restart, the revision before');
});

test('failing new pods name the reason from diagnosePod', () => {
  const workload = deployment({ status: { replicas: 5, updatedReplicas: 2, readyReplicas: 3, availableReplicas: 3 } });
  const pods = [pod('n1', 'bbb', pulling('registry.example.com/shop/base:404')), pod('n2', 'bbb', pulling('registry.example.com/shop/base:404')), pod('o1', 'aaa')];
  const p = progressOf('deployments', workload, { replicasets: [replicaSet(3, 'aaa', 3), replicaSet(4, 'bbb', 2)], pods });
  const finding = failureOf(p, { now: NOW });
  assert.equal(finding.code, 'image');
  assert.equal(finding.pods.length, 2);
  const { state } = evaluate({ action: 'apply', startedAt: NOW - 20000, before: { generation: 6, revision: 3 } }, p, { now: NOW });
  assert.equal(state.id, 'failing');
  assert.equal(state.tone, 'bad');
  assert.match(state.detail, /Image cannot be pulled/);
  assert.match(state.detail, /base:404/);
  // A stale snapshot (taken after the change already landed) never hides the failure.
  assert.equal(evaluate({ action: 'apply', startedAt: NOW - 500, before: { generation: 7 } }, p, { now: NOW }).state.id, 'failing');
  // Old pods failing are not this rollout's failure.
  const oldBroken = progressOf('deployments', workload, { replicasets: [replicaSet(3, 'aaa', 3), replicaSet(4, 'bbb', 2)], pods: [pod('o1', 'aaa', pulling('x:1')), pod('n1', 'bbb')] });
  assert.equal(failureOf(oldBroken, { now: NOW }), null);
});

test('state machine: starting, progressing, stalled, complete and auto-collapse timestamp', () => {
  const sets = { replicasets: [replicaSet(3, 'aaa', 1), replicaSet(4, 'bbb', 4)], pods: [] };
  const before = { generation: 6, revision: 3 };
  // The restart has not reached the Deployment yet: still generation 6 and complete.
  let r = evaluate({ action: 'restart', startedAt: NOW, before }, progressOf('deployments', deployment({ generation: 6, observed: 6, revision: 3 }), sets), { now: NOW + 1000, failure: null });
  assert.equal(r.state.id, 'starting');
  const rolling = progressOf('deployments', deployment({ status: { replicas: 5, updatedReplicas: 2 } }), sets);
  r = evaluate(r.track, rolling, { now: NOW + 2000, failure: null });
  assert.equal(r.state.id, 'progressing');
  assert.equal(r.state.detail, '2 of 4 new pods created.');
  // Nothing moves for a minute.
  r = evaluate(r.track, rolling, { now: NOW + 2000 + STALL_MS, failure: null });
  assert.equal(r.state.id, 'stalled');
  assert.match(r.state.detail, /No progress for 1 min/);
  // Then it finishes.
  r = evaluate(r.track, progressOf('deployments', deployment(), sets), { now: NOW + 70000, failure: null });
  assert.equal(r.state.id, 'complete');
  assert.equal(r.track.completeAt, NOW + 70000);
  assert.equal(r.state.detail, 'All 4 pods run revision 4 and are available.');
  const single = progressOf('deployments', deployment({ replicas: 1 }), sets);
  assert.equal(evaluate({ action: 'watch', startedAt: NOW }, single, { now: NOW, failure: null }).state.detail, 'The only pod runs revision 4 and is available.');
  r = evaluate(r.track, progressOf('deployments', deployment(), sets), { now: NOW + 80000, failure: null });
  assert.equal(r.track.completeAt, NOW + 70000, 'complete time is kept');
});

test('without a snapshot the first seconds are "Starting"; a watch is immediate', () => {
  const p = progressOf('deployments', deployment(), { replicasets: [replicaSet(4, 'bbb', 4)], pods: [] });
  assert.equal(evaluate({ action: 'apply', startedAt: NOW }, p, { now: NOW + 500, failure: null }).state.id, 'starting');
  assert.equal(evaluate({ action: 'apply', startedAt: NOW }, p, { now: NOW + 5000, failure: null }).state.id, 'complete');
  assert.equal(evaluate({ action: 'watch', startedAt: NOW }, p, { now: NOW, failure: null }).state.id, 'complete');
});

test('deadline, paused, deleted and loading states', () => {
  const sets = { replicasets: [replicaSet(4, 'bbb', 4)], pods: [] };
  const stuck = progressOf('deployments', deployment({ status: { updatedReplicas: 1 }, conditions: [{ type: 'Progressing', reason: 'ProgressDeadlineExceeded', message: 'timed out' }] }), sets);
  assert.equal(evaluate({ action: 'watch', startedAt: NOW }, stuck, { now: NOW, failure: null }).state.id, 'deadline');
  const paused = progressOf('deployments', deployment({ paused: true, status: { updatedReplicas: 2 } }), sets);
  const s = evaluate({ action: 'watch', startedAt: NOW }, paused, { now: NOW, failure: null }).state;
  assert.equal(s.id, 'paused');
  assert.match(s.detail, /2 of 4 pods updated/);
  assert.equal(evaluate({ action: 'watch', startedAt: NOW }, null, { now: NOW, deleted: true }).state.id, 'gone');
  assert.equal(evaluate({ action: 'watch', startedAt: NOW }, null, { now: NOW }).state.id, 'loading');
});

test('Undo goes back to the revision the change started from', () => {
  const sets = { replicasets: [replicaSet(2, 'zzz', 0), replicaSet(3, 'aaa', 1), replicaSet(5, 'bbb', 4)], pods: [] };
  const p = progressOf('deployments', deployment({ revision: 5 }), sets);
  assert.deepEqual(undoPlan({ action: 'apply', before: { revision: 2 } }, p), { type: 'rollback', revision: 2, label: 'Undo · back to rev 2' });
  // Without a snapshot (or when that revision is gone): the newest older revision, like kubectl rollout undo.
  assert.equal(undoPlan({ action: 'apply' }, p).revision, 3);
  assert.equal(undoPlan({ action: 'restart', before: { revision: 4 } }, p).revision, 3);
  // Scale undoes to the old replica count; pause/resume and create have nothing to undo.
  assert.deepEqual(undoPlan({ action: 'scale', before: { replicas: 2 } }, p), { type: 'scale', replicas: 2, label: 'Scale back to 2' });
  assert.equal(undoPlan({ action: 'scale', before: { replicas: 4 } }, p), null);
  assert.equal(undoPlan({ action: 'pause' }, p), null);
  assert.equal(undoPlan({ action: 'create' }, p), null);
  assert.equal(undoPlan({ action: 'undo', before: { revision: 4 } }, p), null, 'no undo of an undo');
  const first = progressOf('deployments', deployment({ revision: 1 }), { replicasets: [replicaSet(1, 'one', 4)], pods: [] });
  assert.equal(undoPlan({ action: 'watch' }, first), null);
});

test('helpers: selector for new pods, elapsed time, card key', () => {
  const p = progressOf('deployments', deployment(), { replicasets: [replicaSet(4, 'bbb', 4)], pods: [] });
  assert.equal(newPodsSelector('deployments', p, 'app=web'), 'app=web,pod-template-hash=bbb');
  assert.equal(newPodsSelector('deployments', p, ''), '');
  assert.equal(formatElapsed(9000), '9 s');
  assert.equal(formatElapsed(65000), '1 min 5 s');
  assert.equal(formatElapsed(120000), '2 min');
  assert.equal(formatElapsed(3720000), '1 h 2 min');
  assert.equal(trackKey({ context: 'a', namespace: 'b', resource: 'deployments', name: 'c' }), '["a","b","deployments","c"]');
});
