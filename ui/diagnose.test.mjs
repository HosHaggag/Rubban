import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosePod, diagnosePods, exitHint } from './diagnose.js';

const NOW = Date.parse('2026-11-06T14:00:00Z');
const pod = (status, spec = {}) => ({ metadata: { name: 'p-1', namespace: 'shop' }, spec: { restartPolicy: 'Always', containers: [{ name: 'app', image: 'registry.example.com/shop/app:1.0', ports: [{ containerPort: 8080, name: 'http' }], resources: { requests: { cpu: '100m', memory: '64Mi' }, limits: { memory: '128Mi' } }, ...spec.container }], ...spec.pod }, status });

test('crash loop names the exit code, the restarts and the next step', () => {
  const [finding] = diagnosePod(pod({ phase: 'Running', containerStatuses: [{ name: 'app', ready: false, restartCount: 5, state: { waiting: { reason: 'CrashLoopBackOff' } }, lastState: { terminated: { exitCode: 1, reason: 'Error', finishedAt: '2026-11-06T13:59:25Z' } } }] }), { now: NOW });
  assert.equal(finding.code, 'crashloop');
  assert.match(finding.text, /exited with code 1 \(Error\) 35 s ago and has restarted 5 times/);
  assert.deepEqual(finding.actions, ['previous-logs', 'events']);
  assert.match(finding.hints[0], /exited with an error/);
});

test('OOMKilled crash loops mention the memory limit', () => {
  const [finding] = diagnosePod(pod({ phase: 'Running', containerStatuses: [{ name: 'app', ready: false, restartCount: 2, state: { waiting: { reason: 'CrashLoopBackOff' } }, lastState: { terminated: { exitCode: 137, reason: 'OOMKilled' } } }] }), { now: NOW });
  assert.equal(finding.code, 'oom');
  assert.match(finding.hints[0], /limit \(128Mi\)/);
});

test('image pull failures explain a missing tag', () => {
  const [finding] = diagnosePod(pod({ phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'True' }], containerStatuses: [{ name: 'app', image: 'registry.example.com/payments/fraud-check:0.8.2', ready: false, restartCount: 0, state: { waiting: { reason: 'ImagePullBackOff', message: 'Back-off pulling image "registry.example.com/payments/fraud-check:0.8.2": ErrImagePull: failed to pull: not found' } } }] }), { now: NOW });
  assert.equal(finding.code, 'image');
  assert.match(finding.hints[0], /tag `0\.8\.2` does not exist in `registry\.example\.com\/payments\/fraud-check`/);
  assert.ok(finding.actions.includes('rollback'));
});

test('image pull: unauthorized and unreachable registries get their own advice', () => {
  const make = message => diagnosePod(pod({ phase: 'Pending', containerStatuses: [{ name: 'app', image: 'r.io/a:1', state: { waiting: { reason: 'ErrImagePull', message } } }] }), { now: NOW })[0].hints[0];
  assert.match(make('pull access denied, unauthorized'), /imagePullSecrets/);
  assert.match(make('dial tcp: lookup r.io: no such host'), /cannot reach the registry/);
});

test('unschedulable pods compare their requests with the largest node', () => {
  const pending = pod({ phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: '0/2 nodes are available: 2 Insufficient cpu.' }] }, { container: { resources: { requests: { cpu: '48' } } } });
  const nodes = [{ status: { allocatable: { cpu: '12', memory: '16Gi' } } }, { status: { allocatable: { cpu: '8', memory: '16Gi' } } }];
  const [finding] = diagnosePod(pending, { nodes, now: NOW });
  assert.equal(finding.code, 'unschedulable');
  assert.match(finding.hints[0], /requests 48 cores.*largest node has only 12 cores/);
});

test('a readiness probe on a port the container does not declare is called out', () => {
  const notReady = pod({ phase: 'Running', containerStatuses: [{ name: 'app', ready: false, restartCount: 0, state: { running: { startedAt: '2026-11-06T13:00:00Z' } } }] }, { container: { readinessProbe: { tcpSocket: { port: 9999 } } } });
  const events = [{ reason: 'Unhealthy', message: 'Readiness probe failed: dial tcp 10.0.0.1:9999: connect: connection refused', lastTimestamp: '2026-11-06T13:59:00Z' }];
  const [finding] = diagnosePod(notReady, { events, now: NOW });
  assert.equal(finding.code, 'not-ready');
  assert.match(finding.text, /Readiness probe failed/);
  assert.match(finding.hints[0], /checks port 9999, but the container declares 8080 \(http\)/);
});

test('missing ConfigMaps are named', () => {
  const [finding] = diagnosePod(pod({ phase: 'Pending', containerStatuses: [{ name: 'app', state: { waiting: { reason: 'CreateContainerConfigError', message: 'configmap "app-config" not found' } } }] }), { now: NOW });
  assert.equal(finding.code, 'config');
  assert.match(finding.hints[0], /Create the configmap `app-config`/);
});

test('healthy pods have no findings', () => {
  assert.deepEqual(diagnosePod(pod({ phase: 'Running', containerStatuses: [{ name: 'app', ready: true, restartCount: 0, state: { running: {} } }] }), { now: NOW }), []);
});

test('workload diagnosis groups pods with the same problem', () => {
  const crash = name => ({ ...pod({ phase: 'Running', containerStatuses: [{ name: 'app', ready: false, restartCount: 3, state: { waiting: { reason: 'CrashLoopBackOff' } }, lastState: { terminated: { exitCode: 1, reason: 'Error' } } }] }), metadata: { name } });
  const groups = diagnosePods([crash('a'), crash('b')], { now: NOW });
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].pods, ['a', 'b']);
});

test('exit hints cover the common codes', () => {
  assert.match(exitHint(127), /not found in the image/);
  assert.match(exitHint(0), /expects it to keep running/);
  assert.match(exitHint(143), /SIGTERM/);
});
