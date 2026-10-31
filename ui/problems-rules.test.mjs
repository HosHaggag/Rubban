import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, counts, bySeverity, GRACE } from './problems-rules.js';

const NOW = Date.parse('2026-05-01T12:00:00Z');
const ago = ms => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const ctx = (extra = {}) => ({ context: 'prod', now: NOW, ...extra });
const pod = (name, status, extra = {}) => ({ metadata: { name, namespace: 'shop', creationTimestamp: ago(60 * MIN), ...(extra.metadata || {}) }, spec: {}, status });
const rules = problems => problems.map(p => `${p.severity}:${p.title}`);

test('waiting reasons that never recover are critical', () => {
  for (const reason of ['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError', 'InvalidImageName']) {
    const [problem] = evaluate('pods', [pod('api', { phase: 'Running', containerStatuses: [{ name: 'app', ready: false, restartCount: 1, state: { waiting: { reason, message: 'back-off 5m' } } }] })], ctx());
    assert.equal(problem.severity, 'critical'); assert.equal(problem.title, reason);
    assert.match(problem.detail, /^app: back-off 5m/);
    assert.equal(problem.id, `prod|pods|shop|api|waiting-${reason}`);
  }
  assert.deepEqual(evaluate('pods', [pod('ok', { phase: 'Running', containerStatuses: [{ name: 'app', ready: true, state: { running: {} } }] })], ctx()), []);
  const creating = pod('new', { phase: 'Pending', containerStatuses: [{ name: 'app', state: { waiting: { reason: 'ContainerCreating' } } }] });
  creating.metadata.creationTimestamp = ago(MIN);
  assert.deepEqual(evaluate('pods', [creating], ctx()), []);
});

test('OOMKilled counts for an hour', () => {
  const killed = finished => pod('worker', { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ name: 'w', ready: true, restartCount: 1, state: { running: {} }, lastState: { terminated: { reason: 'OOMKilled', exitCode: 137, finishedAt: finished } } }] });
  const [problem] = evaluate('pods', [killed(ago(30 * MIN))], ctx());
  assert.equal(problem.severity, 'warning'); assert.equal(problem.title, 'OOMKilled'); assert.equal(problem.since, ago(30 * MIN));
  assert.deepEqual(evaluate('pods', [killed(ago(61 * MIN))], ctx()), []);
});

test('many recent restarts warn, old or few do not', () => {
  const restarts = (count, finished) => pod('cron', { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ name: 'c', ready: true, restartCount: count, state: { running: {} }, lastState: { terminated: { reason: 'Error', exitCode: 1, finishedAt: finished } } }] });
  assert.deepEqual(rules(evaluate('pods', [restarts(5, ago(10 * MIN))], ctx())), ['warning:5 restarts']);
  assert.deepEqual(evaluate('pods', [restarts(4, ago(10 * MIN))], ctx()), []);
  assert.deepEqual(evaluate('pods', [restarts(9, ago(2 * 60 * MIN))], ctx()), []);
});

test('pending pods: unschedulable is critical, other is a warning, both only after five minutes', () => {
  const pending = (age, conditions) => ({ metadata: { name: 'p', namespace: 'shop', creationTimestamp: ago(age) }, status: { phase: 'Pending', conditions } });
  const unschedulable = [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: '0/3 nodes are available: 3 Insufficient cpu.' }];
  const [critical] = evaluate('pods', [pending(GRACE + MIN, unschedulable)], ctx());
  assert.equal(critical.severity, 'critical'); assert.equal(critical.title, 'Unschedulable'); assert.match(critical.detail, /Insufficient cpu/);
  assert.deepEqual(rules(evaluate('pods', [pending(GRACE + MIN, [])], ctx())), ['warning:Pending']);
  assert.deepEqual(evaluate('pods', [pending(GRACE - MIN, unschedulable)], ctx()), []);
});

test('running but not ready for more than five minutes', () => {
  const unready = since => pod('web', { phase: 'Running', conditions: [{ type: 'Ready', status: 'False', lastTransitionTime: since, reason: 'ContainersNotReady' }], containerStatuses: [{ name: 'w', ready: false, restartCount: 0, state: { running: {} } }] });
  assert.deepEqual(rules(evaluate('pods', [unready(ago(6 * MIN))], ctx())), ['warning:Not ready']);
  assert.deepEqual(evaluate('pods', [unready(ago(2 * MIN))], ctx()), []);
});

test('failed pods warn unless a Job owns them, evicted pods are only information', () => {
  assert.deepEqual(rules(evaluate('pods', [pod('x', { phase: 'Failed', reason: 'Error' })], ctx())), ['warning:Failed']);
  assert.deepEqual(evaluate('pods', [pod('j', { phase: 'Failed' }, { metadata: { ownerReferences: [{ kind: 'Job', name: 'j' }] } })], ctx()), []);
  assert.deepEqual(rules(evaluate('pods', [pod('e', { phase: 'Failed', reason: 'Evicted', message: 'The node was low on resource: memory.' })], ctx())), ['info:Evicted']);
  assert.deepEqual(evaluate('pods', [{ ...pod('t', { phase: 'Failed' }), metadata: { name: 't', namespace: 'shop', deletionTimestamp: ago(MIN) } }], ctx()), []);
});

test('workloads with too few available replicas, with the time taken from the Available condition', () => {
  const deployment = (available, since) => ({ metadata: { name: 'api', namespace: 'shop' }, spec: { replicas: 3 }, status: { availableReplicas: available, conditions: [{ type: 'Available', status: 'False', lastTransitionTime: since }] } });
  const [problem] = evaluate('deployments', [deployment(1, ago(10 * MIN))], ctx());
  assert.equal(problem.severity, 'critical'); assert.equal(problem.title, '1/3 available'); assert.equal(problem.since, ago(10 * MIN));
  assert.deepEqual(evaluate('deployments', [deployment(1, ago(MIN))], ctx()), []);
  assert.deepEqual(evaluate('deployments', [deployment(3, ago(10 * MIN))], ctx()), []);
  assert.equal(evaluate('deployments', [{ metadata: { name: 'z' }, spec: { replicas: 0 }, status: {} }], ctx()).length, 0);
});

test('without a timestamp the first time the problem was seen starts the five minutes', () => {
  const sts = { metadata: { name: 'db', namespace: 'shop' }, spec: { replicas: 3 }, status: { readyReplicas: 2 } };
  const seen = {};
  const firstSeen = id => (seen[id] ??= NOW - 2 * MIN);
  assert.deepEqual(evaluate('statefulsets', [sts], ctx({ firstSeen })), []);
  seen['prod|statefulsets|shop|db|unavailable'] = NOW - 6 * MIN;
  assert.deepEqual(rules(evaluate('statefulsets', [sts], ctx({ firstSeen }))), ['critical:2/3 available']);
  const ds = { metadata: { name: 'agent', namespace: 'kube-system' }, status: { desiredNumberScheduled: 4, numberAvailable: 3 } };
  assert.deepEqual(rules(evaluate('daemonsets', [ds], ctx({ firstSeen: () => NOW - 9 * MIN }))), ['critical:3/4 available']);
});

test('a rollout past its progress deadline is critical at once', () => {
  const stuck = { metadata: { name: 'api', namespace: 'shop' }, spec: { replicas: 2 }, status: { availableReplicas: 2, conditions: [{ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded', message: 'ReplicaSet "api-7" has timed out progressing.', lastUpdateTime: ago(MIN) }] } };
  const [problem] = evaluate('deployments', [stuck], ctx());
  assert.equal(problem.severity, 'critical'); assert.equal(problem.title, 'Rollout stuck'); assert.match(problem.detail, /timed out/);
});

test('failed jobs and pending claims', () => {
  const job = { metadata: { name: 'migrate', namespace: 'shop' }, status: { conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded', lastTransitionTime: ago(MIN) }] } };
  assert.deepEqual(rules(evaluate('jobs', [job], ctx())), ['warning:Job failed']);
  assert.deepEqual(evaluate('jobs', [{ metadata: { name: 'ok' }, status: { conditions: [{ type: 'Complete', status: 'True' }] } }], ctx()), []);
  const claim = age => ({ metadata: { name: 'data', namespace: 'shop', creationTimestamp: ago(age) }, status: { phase: 'Pending' } });
  assert.deepEqual(rules(evaluate('persistentvolumeclaims', [claim(10 * MIN)], ctx())), ['warning:Claim pending']);
  assert.deepEqual(evaluate('persistentvolumeclaims', [claim(MIN)], ctx()), []);
  assert.deepEqual(evaluate('persistentvolumeclaims', [{ metadata: { name: 'b' }, status: { phase: 'Bound' } }], ctx()), []);
});

test('nodes: not ready, pressure and cordoned', () => {
  const node = (conditions, spec = {}) => ({ metadata: { name: 'n1' }, spec, status: { conditions } });
  assert.deepEqual(rules(evaluate('nodes', [node([{ type: 'Ready', status: 'False', message: 'kubelet stopped posting' }])], ctx())), ['critical:Node not ready']);
  assert.deepEqual(rules(evaluate('nodes', [node([{ type: 'Ready', status: 'True' }, { type: 'MemoryPressure', status: 'True' }, { type: 'DiskPressure', status: 'False' }, { type: 'PIDPressure', status: 'True' }])], ctx())), ['critical:Memory pressure', 'critical:PID pressure']);
  assert.deepEqual(rules(evaluate('nodes', [node([{ type: 'Ready', status: 'True' }], { unschedulable: true })], ctx())), ['info:Cordoned']);
  assert.deepEqual(evaluate('nodes', [node([{ type: 'Ready', status: 'True' }])], ctx()), []);
  assert.deepEqual(rules(evaluate('nodes', [node([])], ctx())), ['critical:Node not ready']);
});

test('Argo CD applications', () => {
  const app = (sync, health) => ({ metadata: { name: 'shop', namespace: 'argocd' }, status: { sync: { status: sync }, health: { status: health } } });
  assert.deepEqual(rules(evaluate('applications.argoproj.io', [app('OutOfSync', 'Healthy')], ctx())), ['warning:Argo CD: out of sync']);
  assert.deepEqual(rules(evaluate('applications.argoproj.io', [app('Synced', 'Degraded')], ctx())), ['critical:Argo CD: Degraded']);
  assert.deepEqual(rules(evaluate('applications.argoproj.io', [app('Synced', 'Missing')], ctx())), ['critical:Argo CD: Missing']);
  assert.deepEqual(rules(evaluate('applications.argoproj.io', [app('Unknown', 'Unknown')], ctx())), ['info:Argo CD: health unknown', 'info:Argo CD: sync unknown']);
  assert.deepEqual(evaluate('applications.argoproj.io', [app('Synced', 'Healthy')], ctx()), []);
});

test('ids are stable and unknown resources or broken objects are ignored', () => {
  const crash = pod('api', { phase: 'Running', containerStatuses: [{ name: 'a', state: { waiting: { reason: 'CrashLoopBackOff' } } }] });
  const first = evaluate('pods', [crash], ctx())[0].id;
  assert.equal(first, evaluate('pods', [crash], ctx({ now: NOW + 60 * MIN }))[0].id);
  assert.notEqual(first, evaluate('pods', [crash], ctx({ context: 'staging' }))[0].id);
  assert.deepEqual(evaluate('secrets', [crash], ctx()), []);
  assert.deepEqual(evaluate('pods', [null, {}, crash], ctx()).length, 1);
});

test('ordering and counting', () => {
  const list = [{ severity: 'info', name: 'a' }, { severity: 'critical', name: 'z' }, { severity: 'warning', name: 'b' }, { severity: 'critical', name: 'a' }];
  assert.deepEqual(list.sort(bySeverity).map(p => `${p.severity}:${p.name}`), ['critical:a', 'critical:z', 'warning:b', 'info:a']);
  assert.deepEqual(counts(list), { critical: 2, warning: 1, info: 1 });
});
