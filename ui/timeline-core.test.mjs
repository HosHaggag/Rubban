import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  MINUTE, HOUR, DAY, CATEGORIES, buildIndex, configRefs, toYaml, cleanTemplate, splitImage, imageChange, envChanges, summarizeTemplateChange,
  rolloutEntries, redactTemplate, podEntries, eventEntries, configEntries, hpaEntries, jobEntries, helmEntries, argoEntries, nodeEntries, buildEntries,
  bursts, correlate, focusWindow, absorbRolloutEvents, matchesFocus, matchesText, inWindow, filterEntries, countByCategory, bucketSize, groupEntries, histogram, clock, ago, kindForResource,
} from './timeline-core.js';

const require = createRequire(import.meta.url);
const YAML = require('yaml');

const T0 = Date.parse('2026-11-06T14:00:00Z');
const at = minutes => new Date(T0 + minutes * MINUTE).toISOString();
const owner = (kind, name) => [{ kind, name, controller: true }];
const container = (name, image, extra = {}) => ({ name, image, ...extra });
const template = (containers, extra = {}) => ({ metadata: { labels: { app: 'storefront', 'pod-template-hash': 'abc' }, ...(extra.metadata || {}) }, spec: { containers, ...(extra.spec || {}) } });
const rs = (name, revision, created, tpl, extra = {}) => ({ kind: 'ReplicaSet', metadata: { name, namespace: 'shop', uid: `uid-${name}`, creationTimestamp: created, ownerReferences: owner('Deployment', 'storefront'), annotations: { 'deployment.kubernetes.io/revision': String(revision), ...(extra.annotations || {}) } }, spec: { template: tpl } });
const deployment = (name, spec = {}, labels = {}) => ({ kind: 'Deployment', metadata: { name, namespace: 'shop', labels }, spec: { template: { spec } }, status: {} });

test('ownership index walks owner references and guesses the owners of objects that are gone', () => {
  const index = buildIndex({
    deployments: [deployment('storefront', { containers: [], volumes: [{ name: 'c', configMap: { name: 'storefront-config' } }] }, { 'app.kubernetes.io/instance': 'web' })],
    replicaSets: [{ metadata: { name: 'storefront-6f456b6bc8', namespace: 'shop', ownerReferences: owner('Deployment', 'storefront') } }],
    pods: [{ metadata: { name: 'storefront-6f456b6bc8-x2x9q', namespace: 'shop', ownerReferences: owner('ReplicaSet', 'storefront-6f456b6bc8') }, spec: { containers: [{ name: 'a', envFrom: [{ secretRef: { name: 'api-keys' } }] }] } }],
    statefulSets: [{ metadata: { name: 'session-store', namespace: 'shop' }, spec: { template: { spec: { containers: [] } } } }],
    cronJobs: [{ metadata: { name: 'cache-warmer', namespace: 'shop' }, spec: { jobTemplate: { spec: { template: { spec: { containers: [{ name: 'w', env: [{ name: 'X', valueFrom: { configMapKeyRef: { name: 'warm', key: 'k' } } }] }] } } } } } }],
  });
  assert.equal(index.ownerOf('Pod', 'shop', 'storefront-6f456b6bc8-x2x9q'), 'Deployment/shop/storefront');
  assert.equal(index.ownerOf('Pod', 'shop', 'storefront-6f456b6bc8-gone1'), 'Deployment/shop/storefront', 'a replaced pod maps through its ReplicaSet name');
  assert.equal(index.ownerOf('Pod', 'shop', 'storefront-5d4c3b2a1-zzzzz'), 'Deployment/shop/storefront', 'a pod of an unknown ReplicaSet maps to the Deployment');
  assert.equal(index.ownerOf('ReplicaSet', 'shop', 'storefront-596d7996bb'), 'Deployment/shop/storefront');
  assert.equal(index.ownerOf('Pod', 'shop', 'session-store-2'), 'StatefulSet/shop/session-store');
  assert.equal(index.ownerOf('Job', 'shop', 'cache-warmer-29899575'), 'CronJob/shop/cache-warmer');
  assert.equal(index.ownerOf('Pod', 'shop', 'lonely'), 'Pod/shop/lonely');
  assert.equal(index.ownerOf('', 'shop', 'x'), null);
  assert.deepEqual(index.users('ConfigMap/shop/storefront-config'), ['Deployment/shop/storefront']);
  assert.deepEqual(index.users('Secret/shop/api-keys'), ['Deployment/shop/storefront'], 'pods add what their spec reads to their workload');
  assert.deepEqual(index.users('ConfigMap/shop/warm'), ['CronJob/shop/cache-warmer']);
  assert.deepEqual(index.managed('shop', 'web'), ['Deployment/shop/storefront']);
  assert.deepEqual(index.managed('data', 'web'), []);
});

test('configRefs finds ConfigMaps and Secrets in volumes, projections, env, envFrom and pull secrets', () => {
  const refs = configRefs({
    volumes: [{ configMap: { name: 'a' } }, { secret: { secretName: 'b' } }, { projected: { sources: [{ configMap: { name: 'c' } }, { secret: { name: 'd' } }] } }],
    initContainers: [{ envFrom: [{ configMapRef: { name: 'e' } }] }],
    containers: [{ env: [{ name: 'X', valueFrom: { secretKeyRef: { name: 'f', key: 'k' } } }, { name: 'Y', value: 'plain' }] }],
    imagePullSecrets: [{ name: 'g' }],
  });
  assert.deepEqual([...refs].sort(), ['ConfigMap/a', 'ConfigMap/c', 'ConfigMap/e', 'Secret/b', 'Secret/d', 'Secret/f', 'Secret/g']);
  assert.equal(configRefs(undefined).size, 0);
});

test('toYaml writes valid YAML with sorted keys and quotes what needs quoting', () => {
  const value = { spec: { containers: [{ name: 'web', image: 'r/web:1.0', args: ['--port', '8080'], env: [{ name: 'A', value: 'yes' }, { name: 'B', value: '' }, { name: 'C', value: 'a: b' }] }], empty: [], none: {}, nested: [[1, 2], []] }, metadata: { labels: { 'app.kubernetes.io/name': 'web' } }, n: 3, t: true, z: null };
  const text = toYaml(value);
  assert.deepEqual(YAML.parse(text), value);
  assert.ok(text.indexOf('metadata:') < text.indexOf('spec:'), 'keys are sorted');
  assert.match(text, /value: "yes"/);
  assert.match(text, /value: ""/);
  assert.equal(toYaml('plain'), 'plain');
  assert.equal(toYaml([]), '[]');
});

test('cleanTemplate drops the hash labels and the empty timestamp, not the rest', () => {
  const cleaned = cleanTemplate({ metadata: { creationTimestamp: null, labels: { 'pod-template-hash': 'x', app: 'a' } }, spec: { containers: [] } });
  assert.deepEqual(cleaned, { metadata: { labels: { app: 'a' } }, spec: { containers: [] } });
  assert.deepEqual(cleanTemplate({ metadata: { labels: { 'controller-revision-hash': 'x' } }, spec: {} }), { spec: {} });
  assert.deepEqual(cleanTemplate(null), {});
});

test('diffs show a fingerprint instead of the literal value of a secret-looking env var', () => {
  const tpl = value => template([container('api', 'api:1', { env: [{ name: 'DB_PASSWORD', value }, { name: 'MODE', value: 'api' }, { name: 'API_KEY', valueFrom: { secretKeyRef: { name: 's', key: 'k' } } }] })]);
  const before = toYaml(redactTemplate(tpl('hunter2'))); const after = toYaml(redactTemplate(tpl('hunter3')));
  assert.ok(!before.includes('hunter') && !after.includes('hunter'));
  assert.match(before, /value: "<redacted [0-9a-f]{4}>"/);
  assert.notEqual(before, after, 'a changed secret still shows as a changed line');
  assert.match(before, /value: api/);
  assert.match(before, /secretKeyRef/);
  const [, rolled] = rolloutEntries({ replicaSets: [rs('s-1', 1, at(0), tpl('hunter2')), rs('s-2', 2, at(1), tpl('hunter3'))] }).sort((a, b) => a.time - b.time);
  assert.ok(!JSON.stringify(rolled).includes('hunter'), 'nothing in the entry carries the value');
});

test('images are summarised by tag when only the tag changes', () => {
  assert.deepEqual(splitImage('registry.example.com:5000/shop/storefront:4.2.1'), { repo: 'registry.example.com:5000/shop/storefront', tag: '4.2.1' });
  assert.deepEqual(splitImage('nginx'), { repo: 'nginx', tag: 'latest' });
  assert.deepEqual(splitImage('nginx@sha256:0123456789abcdef0123'), { repo: 'nginx', tag: '0123456789ab' });
  assert.equal(imageChange('storefront', 'r/shop/storefront:4.2.1', 'r/shop/storefront:4.3.0'), 'storefront 4.2.1 → 4.3.0');
  assert.equal(imageChange('web', 'a/web:1', 'b/web:1'), 'web a/web:1 → b/web:1');
});

test('env changes name what was added, removed and changed and never show secret-looking values', () => {
  const before = [{ name: 'MODE', value: 'storefront' }, { name: 'OLD', value: '1' }, { name: 'API_TOKEN', value: 'abc' }, { name: 'DB', valueFrom: { secretKeyRef: { name: 'db', key: 'url' } } }];
  const after = [{ name: 'MODE', value: 'api' }, { name: 'BUILD', value: '2026.11.05' }, { name: 'API_TOKEN', value: 'def' }, { name: 'DB', valueFrom: { secretKeyRef: { name: 'db2', key: 'url' } } }];
  const changes = envChanges(before, after);
  assert.deepEqual(changes, ['MODE storefront → api', 'BUILD added', 'API_TOKEN changed', 'DB from Secret db/url → from Secret db2/url', 'OLD removed']);
  assert.ok(!changes.join(' ').includes('abc') && !changes.join(' ').includes('def'));
  assert.deepEqual(envChanges(undefined, undefined), []);
});

test('a pod-template change is summarised in a few words', () => {
  const v1 = template([container('storefront', 'r/shop/storefront:4.2.1', { env: [{ name: 'MODE', value: 'storefront' }], resources: { limits: { cpu: '250m', memory: '256Mi' } }, args: ['--a'] })]);
  const v2 = template([container('storefront', 'r/shop/storefront:4.3.0', { env: [{ name: 'MODE', value: 'storefront' }, { name: 'BUILD', value: '1' }], resources: { limits: { cpu: '500m' }, requests: { memory: '128Mi' } }, args: ['--b'] })]);
  assert.deepEqual(summarizeTemplateChange(v1, v2), ['storefront 4.2.1 → 4.3.0', 'env BUILD added', 'memory request 128Mi added, cpu limit 250m → 500m, memory limit 256Mi removed', 'args changed']);
  const restarted = template(v1.spec.containers, { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': '2026-11-06T14:00:00Z' } } });
  assert.deepEqual(summarizeTemplateChange(v1, restarted), ['restarted (rollout restart)']);
  const sidecar = template([...v1.spec.containers, container('proxy', 'envoy:1.30')], { spec: { serviceAccountName: 'web' } });
  assert.deepEqual(summarizeTemplateChange({ ...v1, spec: { ...v1.spec, serviceAccountName: 'default' } }, sidecar), ['container proxy added (envoy:1.30)', 'service account default → web']);
  const two = template([container('a', 'x:1'), container('b', 'y:1', { command: ['run'] })]);
  const twoChanged = template([container('a', 'x:1', { env: [{ name: 'N', value: '1' }] }), container('b', 'y:2', { command: ['go'] })]);
  assert.deepEqual(summarizeTemplateChange(two, twoChanged), ['a: env N added', 'b 1 → 2', 'b: command changed']);
  assert.deepEqual(summarizeTemplateChange(two, template([container('a', 'x:1')])), ['container b removed']);
  assert.deepEqual(summarizeTemplateChange(v1, { ...v1, spec: { ...v1.spec, volumes: [{ name: 'v', emptyDir: {} }] } }), ['volumes changed']);
  assert.deepEqual(summarizeTemplateChange(v1, JSON.parse(JSON.stringify(v1))), []);
  const many = template([container('w', 'i:1', { env: ['A', 'B', 'C', 'D', 'E'].map(name => ({ name, value: '1' })) })]);
  assert.deepEqual(summarizeTemplateChange(template([container('w', 'i:1')]), many), ['env A added, B added, C added, +2 more']);
});

test('rollouts: one entry per revision with the change from the previous one and a YAML diff', () => {
  const v1 = template([container('storefront', 'r/storefront:4.2.1')]);
  const v2 = template([container('storefront', 'r/storefront:4.3.0')]);
  const entries = rolloutEntries({ replicaSets: [rs('storefront-2', 2, at(10), v2), rs('storefront-1', 1, at(0), v1), { metadata: { name: 'orphan', namespace: 'shop' } }] });
  assert.equal(entries.length, 2);
  const [created, rolled] = entries.sort((a, b) => a.time - b.time);
  assert.equal(created.title, 'storefront created');
  assert.match(created.summary, /storefront 4\.2\.1/);
  assert.equal(created.diff, null);
  assert.equal(rolled.title, 'storefront rolled out revision 2');
  assert.equal(rolled.summary, 'storefront 4.2.1 → 4.3.0');
  assert.equal(rolled.time, T0 + 10 * MINUTE);
  assert.equal(rolled.target, 'Deployment/shop/storefront');
  assert.deepEqual(rolled.affects, ['Deployment/shop/storefront']);
  assert.ok(rolled.change);
  assert.match(rolled.diff.before, /4\.2\.1/); assert.match(rolled.diff.after, /4\.3\.0/);
  assert.doesNotMatch(rolled.diff.after, /pod-template-hash/);
  assert.equal(rolled.diff.afterLabel, 'revision 2');
  assert.equal(rolled.healthy, false);
  const healthy = rolloutEntries({ replicaSets: [{ ...rs('storefront-3', 3, at(20), v2), spec: { replicas: 2, template: v2 }, status: { availableReplicas: 2 } }] });
  assert.equal(healthy[0].healthy, true, 'a ReplicaSet with every replica available is a baseline');
});

test('a rollback is dated by the Deployment progressing, not by the old ReplicaSet creation', () => {
  const v1 = template([container('web', 'r/web:1')]); const v2 = template([container('web', 'r/web:2')]);
  const replicaSets = [rs('web-a', 3, at(0), v1, { annotations: { 'deployment.kubernetes.io/revision-history': '1' } }), rs('web-b', 2, at(10), v2)];
  const deployments = [{ metadata: { name: 'storefront', namespace: 'shop' }, status: { conditions: [{ type: 'Progressing', lastUpdateTime: at(40) }] } }];
  const back = rolloutEntries({ replicaSets, deployments }).find(entry => entry.title.includes('rolled back'));
  assert.equal(back.time, T0 + 40 * MINUTE);
  assert.equal(back.summary, 'web 2 → 1');
  assert.match(back.detail[0], /revision 1 before/);
});

test('StatefulSet and DaemonSet rollouts come from ControllerRevisions', () => {
  const cr = (name, revision, created, image) => ({ metadata: { name, namespace: 'shop', creationTimestamp: created, ownerReferences: owner('StatefulSet', 'session-store') }, revision, data: { spec: { template: template([container('redis', image)]) } } });
  const entries = rolloutEntries({ controllerRevisions: [cr('ss-1', 1, at(0), 'redis:7.2'), cr('ss-2', 2, at(5), 'redis:7.4'), { metadata: { name: 'x', ownerReferences: owner('Deployment', 'd') }, revision: 1 }] });
  assert.equal(entries.length, 2);
  const upgrade = entries.find(entry => entry.title.includes('revision 2'));
  assert.equal(upgrade.summary, 'redis 7.2 → 7.4');
  assert.equal(upgrade.ref.kind, 'StatefulSet');
  assert.equal(upgrade.source, 'controllerrevisions');
});

test('pods give restarts with exit codes, OOM kills as critical, and containers stuck waiting', () => {
  const pod = {
    metadata: { name: 'checkout-worker-6dcd857f99-abcde', namespace: 'shop', creationTimestamp: at(0), ownerReferences: owner('ReplicaSet', 'checkout-worker-6dcd857f99') },
    status: {
      startTime: at(0),
      conditions: [{ type: 'ContainersReady', status: 'False', lastTransitionTime: at(1) }],
      containerStatuses: [
        { name: 'worker', restartCount: 7, image: 'w:1', lastState: { terminated: { reason: 'Error', exitCode: 1, startedAt: at(20), finishedAt: at(21) } }, state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 5m0s' } } },
        { name: 'sidecar', restartCount: 1, lastState: { terminated: { reason: 'OOMKilled', exitCode: 137, finishedAt: at(15) } }, state: { running: {} } },
        { name: 'pull', state: { waiting: { reason: 'ImagePullBackOff', message: 'not found' } } },
        { name: 'ok', state: { waiting: { reason: 'ContainerCreating' } } },
      ],
    },
  };
  const index = buildIndex({ replicaSets: [{ metadata: { name: 'checkout-worker-6dcd857f99', namespace: 'shop', ownerReferences: owner('Deployment', 'checkout-worker') } }], pods: [pod] });
  const entries = podEntries([pod], index);
  assert.equal(entries.length, 4);
  const restart = entries.find(entry => entry.id.startsWith('term|') && entry.title.includes('worker'));
  assert.equal(restart.title, 'container worker restarted (Error, exit 1)');
  assert.equal(restart.severity, 'warning');
  assert.equal(restart.time, T0 + 21 * MINUTE);
  assert.equal(restart.first, T0 + 20 * MINUTE);
  assert.equal(restart.target, 'Deployment/shop/checkout-worker');
  assert.match(restart.summary, /7 restarts/);
  assert.equal(entries.find(entry => entry.title.includes('OOMKilled')).severity, 'critical');
  const crash = entries.find(entry => entry.title.endsWith('CrashLoopBackOff'));
  assert.equal(crash.time, T0 + 21 * MINUTE, 'a crash loop is dated by its last exit');
  assert.equal(entries.find(entry => entry.title.endsWith('ImagePullBackOff')).time, T0 + MINUTE, 'otherwise by when the containers stopped being ready');
  const evicted = podEntries([{ metadata: { name: 'e', namespace: 'shop', creationTimestamp: at(3) }, status: { reason: 'Evicted', message: 'low memory' } }]);
  assert.equal(evicted[0].title, 'Pod evicted');
  const completed = podEntries([{ metadata: { name: 'j', namespace: 'shop' }, status: { containerStatuses: [{ name: 'c', lastState: { terminated: { reason: 'Completed', exitCode: 0, finishedAt: at(2) } } }] } }]);
  assert.equal(completed[0].severity, 'info');
});

test('warning events are grouped by object and reason; only a curated set of normal events is kept', () => {
  const ev = (type, reason, kind, name, last, extra = {}) => ({ type, reason, message: extra.message || `${reason} message`, count: extra.count || 1, involvedObject: { kind, name, namespace: kind === 'Node' ? '' : 'shop' }, firstTimestamp: extra.first || last, lastTimestamp: last, metadata: { namespace: 'shop', creationTimestamp: last } });
  const events = [
    ev('Warning', 'BackOff', 'Pod', 'checkout-worker-6dcd857f99-abcde', at(10), { count: 5, first: at(2) }),
    ev('Warning', 'BackOff', 'Pod', 'checkout-worker-6dcd857f99-abcde', at(12), { count: 3, first: at(11), message: 'latest' }),
    ev('Warning', 'FailedScheduling', 'Pod', 'pdf-renderer-1-x', at(4)),
    ev('Normal', 'ScalingReplicaSet', 'Deployment', 'storefront', at(5), { message: 'Scaled up replica set storefront-2 to 2' }),
    ev('Normal', 'Pulled', 'Pod', 'a', at(6), { message: 'Successfully pulled image "x" in 1s' }),
    ev('Normal', 'Pulled', 'Pod', 'a', at(6), { message: 'Container image "x" already present on machine' }),
    ev('Normal', 'Scheduled', 'Pod', 'a', at(6)),
    ev('Normal', 'Started', 'Pod', 'a', at(6)),
    ev('Normal', 'SuccessfulCreate', 'Job', 'cache-warmer-1', at(7)),
    ev('Normal', 'SuccessfulCreate', 'ReplicaSet', 'storefront-2', at(7), { message: 'Created pod: storefront-2-aaaaa' }),
    ev('Normal', 'SuccessfulCreate', 'ReplicaSet', 'storefront-2', at(8), { message: 'Created pod: storefront-2-bbbbb' }),
    ev('Normal', 'NodeNotReady', 'Node', 'worker-1', at(8)),
    ev('Warning', 'CgroupV1', 'Node', 'worker-1', at(1)),
    { type: 'Warning', reason: 'NoTime', involvedObject: { kind: 'Pod', name: 'x' }, metadata: {} },
  ];
  const index = buildIndex({ deployments: [deployment('checkout-worker')] });
  const entries = eventEntries(events, index);
  const backoff = entries.find(entry => entry.title === 'BackOff');
  assert.equal(backoff.count, 8);
  assert.equal(backoff.first, T0 + 2 * MINUTE);
  assert.equal(backoff.time, T0 + 12 * MINUTE);
  assert.equal(backoff.summary, 'latest');
  assert.equal(backoff.category, 'warnings');
  assert.equal(backoff.target, 'Deployment/shop/checkout-worker');
  const scaled = entries.find(entry => entry.summary === 'ScalingReplicaSet');
  assert.equal(scaled.category, 'scaling'); assert.ok(scaled.change); assert.deepEqual(scaled.affects, ['Deployment/shop/storefront']);
  assert.equal(entries.filter(entry => entry.summary === 'Pulled').length, 1, 'only newly pulled images');
  assert.ok(!entries.some(entry => ['Scheduled', 'Started'].includes(entry.summary)));
  assert.equal(entries.find(entry => entry.ref.kind === 'Job').category, 'jobs');
  const created = entries.filter(entry => entry.ref.kind === 'ReplicaSet');
  assert.equal(created.length, 1, 'pods created by one ReplicaSet are one entry');
  assert.equal(created[0].category, 'scaling'); assert.equal(created[0].count, 2); assert.equal(created[0].title, 'Created pod: storefront-2-bbbbb');
  assert.match(created[0].summary, /2 events, the latest shown/);
  const nodeDown = entries.find(entry => entry.summary === 'NodeNotReady');
  assert.equal(nodeDown.category, 'nodes'); assert.equal(nodeDown.severity, 'warning');
  assert.equal(entries.find(entry => entry.title === 'CgroupV1').category, 'nodes');
  assert.ok(!entries.some(entry => entry.title === 'NoTime'));
});

test('config entries: creation and each writer, names only, without the noise', () => {
  const index = buildIndex({ deployments: [deployment('storefront', { containers: [{ name: 'a', envFrom: [{ configMapRef: { name: 'storefront-config' } }] }] })] });
  const entries = configEntries([
    { kind: 'ConfigMap', namespace: 'shop', name: 'storefront-config', created: at(0), writes: [{ time: at(0), manager: 'kubectl-client-side-apply', operation: 'Update' }, { time: at(30), manager: 'kubectl-edit', operation: 'Update' }, { time: at(31), manager: 'kubelet', operation: 'Update', subresource: 'status' }] },
    { kind: 'Secret', namespace: 'shop', name: 'db', created: at(5), writes: [{ time: at(20), manager: 'argocd-controller', operation: 'Apply' }] },
    { kind: 'ConfigMap', namespace: 'shop', name: 'kube-root-ca.crt', created: at(0), writes: [] },
    { kind: 'Secret', namespace: 'shop', name: 'sh.helm.release.v1.web.v1', created: at(0), writes: [] },
  ], index);
  assert.deepEqual(entries.map(entry => entry.title), ['ConfigMap storefront-config created', 'ConfigMap storefront-config updated', 'Secret db created', 'Secret db updated']);
  const edit = entries[1];
  assert.equal(edit.time, T0 + 30 * MINUTE);
  assert.match(edit.summary, /by kubectl-edit \(update\) · Used by storefront/);
  assert.deepEqual(edit.affects, ['Deployment/shop/storefront']);
  assert.match(entries[3].summary, /\(server-side apply\) · Not used by a workload in view/);
  assert.ok(entries[3].detail.some(line => /never read/.test(line)));
});

test('an autoscaler\'s warning events belong to the workload it scales', () => {
  const hpas = [{ metadata: { name: 'storefront-hpa', namespace: 'shop' }, spec: { scaleTargetRef: { kind: 'Deployment', name: 'storefront' } } }];
  const index = buildIndex({ hpas });
  const [entry] = eventEntries([{ type: 'Warning', reason: 'FailedGetResourceMetric', message: '(combined from similar events): no metrics', involvedObject: { kind: 'HorizontalPodAutoscaler', namespace: 'shop', name: 'storefront-hpa' }, lastTimestamp: at(1), metadata: {} }], index);
  assert.equal(entry.target, 'Deployment/shop/storefront');
  assert.equal(entry.summary, 'no metrics', 'the "combined from similar events" prefix is dropped');
});

test('autoscaler, job, cron job and node entries', () => {
  const hpa = hpaEntries([{ metadata: { name: 'storefront', namespace: 'shop' }, spec: { scaleTargetRef: { kind: 'Deployment', name: 'storefront' }, minReplicas: 2, maxReplicas: 10 }, status: { lastScaleTime: at(3), currentReplicas: 2, desiredReplicas: 4 } }, { metadata: { name: 'idle' }, status: {} }]);
  assert.equal(hpa.length, 1);
  assert.equal(hpa[0].title, 'Autoscaler scaled storefront to 4');
  assert.deepEqual(hpa[0].affects, ['Deployment/shop/storefront']);

  const index = buildIndex({ cronJobs: [{ metadata: { name: 'cache-warmer', namespace: 'shop' } }] });
  const jobs = jobEntries({
    jobs: [
      { metadata: { name: 'cache-warmer-29899575', namespace: 'shop', ownerReferences: owner('CronJob', 'cache-warmer') }, status: { startTime: at(0), failed: 2, conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded', message: 'Job has reached the specified backoff limit', lastTransitionTime: at(4) }] } },
      { metadata: { name: 'migrate', namespace: 'shop' }, status: { startTime: at(1), completionTime: at(2), succeeded: 1 } },
    ],
    cronJobs: [{ metadata: { name: 'cache-warmer', namespace: 'shop' }, spec: { schedule: '*/15 * * * *' }, status: { lastScheduleTime: at(0) } }],
  }, index);
  assert.deepEqual(jobs.map(entry => entry.title), ['Job cache-warmer-29899575 started', 'Job cache-warmer-29899575 failed: BackoffLimitExceeded', 'Job migrate started', 'Job migrate completed', 'CronJob cache-warmer scheduled a run']);
  const failed = jobs[1];
  assert.equal(failed.severity, 'warning'); assert.equal(failed.target, 'CronJob/shop/cache-warmer'); assert.equal(failed.first, T0);
  assert.equal(jobs[0].summary, 'Run of cache-warmer');

  const nodes = nodeEntries([{ metadata: { name: 'worker-1', creationTimestamp: at(0) }, status: { nodeInfo: { kubeletVersion: 'v1.31.0' }, conditions: [
    { type: 'Ready', status: 'True', lastTransitionTime: at(1) },
    { type: 'MemoryPressure', status: 'False', lastTransitionTime: at(0) },
    { type: 'DiskPressure', status: 'True', reason: 'KubeletHasDiskPressure', lastTransitionTime: at(50) },
    { type: 'Ready', status: 'False', lastTransitionTime: at(60) },
    { type: 'CustomOk', status: 'False', lastTransitionTime: at(70) },
  ] } }]);
  assert.deepEqual(nodes.map(entry => entry.title), ['Node worker-1 joined', 'DiskPressure on worker-1', 'Node worker-1 became NotReady']);
  assert.equal(nodes[2].severity, 'critical');
});

test('Helm revisions summarise chart and app version changes and are scoped to managed workloads', () => {
  const index = buildIndex({ deployments: [deployment('recommendations-shop-search', {}, { 'app.kubernetes.io/instance': 'recommendations' })] });
  const entries = helmEntries([{ name: 'recommendations', namespace: 'shop', history: [
    { revision: 2, updated: '2026-11-06T17:20:00+03:00', status: 'deployed', chart: 'shop-search-1.4.0', appVersion: '2.5.0', description: 'Upgrade complete' },
    { revision: 1, updated: '2026-11-06T17:00:00+03:00', status: 'superseded', chart: 'shop-search-1.3.0', appVersion: '2.4.0', description: 'Install complete' },
    { revision: 3, updated: '2026-11-06T17:30:00+03:00', status: 'failed', chart: 'shop-search-1.4.0', appVersion: '2.5.0', description: 'Rollback to 1' },
  ] }], index);
  assert.deepEqual(entries.map(entry => entry.title), ['Helm release recommendations installed', 'Helm release recommendations upgraded to revision 2', 'Helm release recommendations rolled back to revision 3 (failed)']);
  assert.equal(entries[1].summary, 'shop-search 1.3.0 → 1.4.0 · app 2.4.0 → 2.5.0 · Upgrade complete');
  assert.equal(entries[1].time, Date.parse('2026-11-06T14:20:00Z'));
  assert.equal(entries[2].severity, 'warning');
  assert.deepEqual(entries[0].affects, ['Deployment/shop/recommendations-shop-search']);
  assert.equal(entries[0].category, 'gitops');
});

test('Argo CD operations, history and health transitions, filtered by app or destination namespace', () => {
  const app = (name, destination, status) => ({ metadata: { name, namespace: 'argocd' }, spec: { destination: { namespace: destination } }, status });
  const apps = [
    app('payments', 'payments', { operationState: { phase: 'Failed', startedAt: at(0), finishedAt: at(1), message: 'image tag 0.8.2 not found', operation: { sync: { revision: 'a1b2c3d4e5f6' } } }, health: { status: 'Degraded', lastTransitionTime: at(2) }, history: [{ id: 1, revision: '0123456789abcdef', deployedAt: at(-30) }] }),
    app('shop', 'shop', { operationState: { phase: 'Succeeded', startedAt: at(5), finishedAt: at(6), syncResult: { revision: '0123456789abcdef0123' } }, history: [{ id: 3, revision: '0123456789abcdef0123', deployedAt: at(6) }] }),
  ];
  const all = argoEntries(apps);
  assert.deepEqual(all.map(entry => entry.title), ['Argo CD sync of payments failed', 'Argo CD deployed payments at 0123456', 'payments became Degraded', 'Argo CD synced shop to 0123456']);
  assert.equal(all[0].severity, 'warning'); assert.equal(all[0].change, false);
  assert.equal(all[2].severity, 'warning');
  assert.equal(all[3].change, true);
  assert.equal(all[0].ref.apiVersion, 'argoproj.io/v1alpha1');
  assert.deepEqual(argoEntries(apps, buildIndex(), 'shop').map(entry => entry.title), ['Argo CD synced shop to 0123456']);
  assert.equal(argoEntries(apps, buildIndex(), 'argocd').length, 4, 'the application namespace is in scope too');
});

// A small incident: a rollout and a ConfigMap edit before a crash loop on checkout-worker, and an
// unrelated rollout of storefront.
function scenario() {
  const v1 = template([container('worker', 'r/worker:1.0')]); const v2 = template([container('worker', 'r/worker:1.1')]);
  const rsOf = (deploy, name, revision, created, tpl) => ({ metadata: { name, namespace: 'shop', uid: name, creationTimestamp: created, ownerReferences: owner('Deployment', deploy), annotations: { 'deployment.kubernetes.io/revision': String(revision) } }, spec: { template: tpl } });
  return {
    deployments: [deployment('checkout-worker', { containers: [{ name: 'worker', envFrom: [{ configMapRef: { name: 'worker-config' } }] }] }), deployment('storefront')],
    replicaSets: [
      rsOf('checkout-worker', 'checkout-worker-aaaaaaaa', 1, at(-300), v1), rsOf('checkout-worker', 'checkout-worker-bbbbbbbb', 2, at(-10), v2),
      rsOf('storefront', 'storefront-cccccccc', 1, at(-300), v1), rsOf('storefront', 'storefront-dddddddd', 2, at(-5), v2),
    ],
    pods: [{ metadata: { name: 'checkout-worker-bbbbbbbb-xxxxx', namespace: 'shop', ownerReferences: owner('ReplicaSet', 'checkout-worker-bbbbbbbb') }, status: { containerStatuses: [{ name: 'worker', restartCount: 4, lastState: { terminated: { reason: 'Error', exitCode: 1, startedAt: at(2), finishedAt: at(3) } }, state: { waiting: { reason: 'CrashLoopBackOff' } } }] } }],
    events: [{ type: 'Warning', reason: 'BackOff', message: 'Back-off restarting failed container', count: 6, involvedObject: { kind: 'Pod', namespace: 'shop', name: 'checkout-worker-bbbbbbbb-xxxxx' }, firstTimestamp: at(0), lastTimestamp: at(4), metadata: {} }],
    config: [{ kind: 'ConfigMap', namespace: 'shop', name: 'worker-config', created: at(-300), writes: [{ time: at(-20), manager: 'kubectl-edit', operation: 'Update' }] }, { kind: 'ConfigMap', namespace: 'shop', name: 'old-config', created: at(-300), writes: [{ time: at(-200), manager: 'kubectl-edit', operation: 'Update' }] }],
  };
}

test('bursts cluster warnings and restarts per workload', () => {
  const { entries } = buildEntries(scenario());
  const found = bursts(entries);
  assert.equal(found.length, 1);
  assert.equal(found[0].target, 'Deployment/shop/checkout-worker');
  assert.equal(found[0].start, T0, 'the burst starts at the first warning');
  const split = bursts([
    { id: 'a', time: 0, category: 'warnings', severity: 'warning', target: 'X', count: 1 },
    { id: 'b', time: 20 * MINUTE, category: 'warnings', severity: 'warning', target: 'X', count: 1 },
    { id: 'c', time: 25 * MINUTE, category: 'warnings', severity: 'info', target: 'X', count: 1 },
  ]);
  assert.equal(split.length, 2, 'a gap longer than BURST_GAP starts a new burst; info entries are not incidents');
});

test('correlation marks changes shortly before a burst on a workload they affect, and only those', () => {
  const { entries } = buildEntries(scenario());
  const correlated = correlate(entries);
  const related = correlated.filter(entry => entry.related?.length);
  assert.deepEqual(related.map(entry => entry.title).sort(), ['ConfigMap worker-config updated', 'checkout-worker rolled out revision 2']);
  const rollout = related.find(entry => entry.category === 'rollouts');
  assert.equal(rollout.related[0].text, '10 min before 8 warnings and restarts on checkout-worker');
  assert.ok(!correlated.find(entry => entry.title === 'storefront rolled out revision 2').related, 'another workload\'s rollout is not related');
  assert.equal(correlated.find(entry => entry.title === 'ConfigMap old-config updated').related, undefined, 'a ConfigMap no workload reads is listed but not related');
  const crash = correlated.find(entry => entry.id.startsWith('event|'));
  assert.equal(crash.causes.length, 2);
  const narrow = correlate(entries, { window: 15 * MINUTE });
  assert.deepEqual(narrow.filter(entry => entry.related).map(entry => entry.category), ['rollouts'], 'the ConfigMap edit 20 min before falls outside a 15 min window');
  assert.equal(correlate([]).length, 0);
  assert.equal(entries.find(entry => entry.title === 'checkout-worker rolled out revision 2').related, undefined, 'the input is not mutated');
});

test('a change after the burst began (beyond the slack) is not its cause', () => {
  const entries = [
    { id: 'w', time: 10 * MINUTE, first: 0, category: 'warnings', severity: 'warning', target: 'D', count: 1 },
    { id: 'late', time: 5 * MINUTE, category: 'rollouts', severity: 'info', change: true, affects: ['D'] },
    { id: 'skew', time: MINUTE, category: 'rollouts', severity: 'info', change: true, affects: ['D'] },
  ];
  assert.deepEqual(correlate(entries).filter(entry => entry.related).map(entry => entry.id), ['skew']);
});

test('"What changed?" focuses on the 30 minutes before the problem started', () => {
  const { entries, index } = buildEntries(scenario());
  const focus = focusWindow({ resource: 'pods', namespace: 'shop', name: 'checkout-worker-bbbbbbbb-xxxxx', since: at(3) }, entries, index, { now: T0 + HOUR });
  assert.equal(focus.target, 'Deployment/shop/checkout-worker');
  assert.equal(focus.start, T0, 'the start of the burst, not the latest crash');
  assert.equal(focus.from, T0 - 30 * MINUTE);
  assert.equal(focus.to, T0 + 5 * MINUTE);
  assert.ok(matchesFocus(entries.find(entry => entry.title === 'checkout-worker rolled out revision 2'), focus));
  assert.ok(matchesFocus(entries.find(entry => entry.title === 'ConfigMap worker-config updated'), focus), 'a ConfigMap the workload reads');
  assert.ok(!matchesFocus(entries.find(entry => entry.title === 'storefront rolled out revision 2'), focus));
  const noSince = focusWindow({ resource: 'deployments', namespace: 'shop', name: 'storefront', since: null }, entries, index, { now: T0 + HOUR });
  assert.equal(noSince.start, T0 + HOUR);
  assert.equal(kindForResource('applications.argoproj.io'), 'Application');
});

test('text, window, category and related filters; category counts ignore the category filter', () => {
  const { entries } = buildEntries(scenario());
  const correlated = correlate(entries);
  assert.ok(matchesText(correlated[0], ''));
  assert.equal(inWindow(correlated, { text: 'worker 1.1' }).length >= 1, true);
  assert.equal(inWindow(correlated, { text: 'nothing-like-this' }).length, 0);
  const windowed = inWindow(correlated, { from: T0 - 15 * MINUTE, to: T0 + 10 * MINUTE });
  assert.ok(windowed.every(entry => entry.time >= T0 - 15 * MINUTE));
  assert.ok(windowed.some(entry => entry.id.startsWith('event|')), 'a grouped event inside the window is in it');
  const early = inWindow(correlated, { from: T0 - 15 * MINUTE, to: T0 + MINUTE }).find(entry => entry.id.startsWith('event|'));
  assert.ok(early.firstShown, 'a grouped event that began in the window but continued after it is shown at its first time');
  assert.equal(early.time, T0); assert.equal(early.lastTime, T0 + 4 * MINUTE);
  assert.ok(!inWindow(correlated, { from: T0 + 5 * MINUTE, to: T0 + 6 * MINUTE }).some(entry => entry.id.startsWith('event|')), 'nor when it began before the window');
  const counts = countByCategory(windowed);
  assert.deepEqual(Object.keys(counts), CATEGORIES.map(category => category.id));
  assert.equal(counts.rollouts, 2);
  assert.equal(filterEntries(correlated, { from: T0 - 15 * MINUTE, to: T0 + 10 * MINUTE, categories: new Set(['rollouts']) }).length, 2);
  assert.ok(inWindow(correlated, { relatedOnly: true }).every(entry => entry.related || entry.causes));
});

test('grouping, bucket sizes and the density strip', () => {
  assert.equal(bucketSize(HOUR), 5 * MINUTE);
  assert.equal(bucketSize(6 * HOUR), 30 * MINUTE);
  assert.equal(bucketSize(DAY), 2 * HOUR);
  assert.equal(bucketSize(7 * DAY), DAY);
  const entries = [0, 1, 6, 12].map(m => ({ id: `e${m}`, time: T0 + m * MINUTE, severity: m === 6 ? 'warning' : 'info', category: m === 1 ? 'rollouts' : 'config', change: true }));
  const groups = groupEntries(entries, 5 * MINUTE);
  assert.deepEqual(groups.map(group => group.entries.map(entry => entry.id)), [['e12'], ['e6'], ['e1', 'e0']]);
  assert.equal(groups[0].start, T0 + 10 * MINUTE);
  const shifted = groupEntries(entries, DAY, { offsetMs: -14 * HOUR });
  assert.equal(shifted.length, 1);
  assert.equal(new Date(shifted[0].start - 14 * HOUR).getUTCHours(), 0, 'day buckets start at local midnight');
  const strip = histogram(entries, { from: T0, to: T0 + 15 * MINUTE, bins: 3 });
  assert.deepEqual(strip.map(bin => [bin.total, bin.warnings, bin.rollouts]), [[2, 0, 1], [1, 1, 0], [1, 0, 0]]);
  assert.equal(histogram(entries, { from: T0 + HOUR, to: T0 + 2 * HOUR, bins: 4 }).reduce((sum, bin) => sum + bin.total, 0), 0);
});

test('clock and relative times', () => {
  assert.equal(clock(T0 + 5 * MINUTE), '14:05');
  assert.equal(clock(T0, { offsetMs: 3 * HOUR, seconds: true }), '17:00:00');
  assert.equal(clock(T0, { day: true }), '6 Nov 14:00');
  assert.equal(ago(T0, T0 + 30_000), 'just now');
  assert.equal(ago(T0, T0 + 12 * MINUTE), '12 min ago');
  assert.equal(ago(T0, T0 + 2 * HOUR + 5 * MINUTE), '2 h 5 min ago');
  assert.equal(ago(T0, T0 + 8 * HOUR), '8 h ago');
  assert.equal(ago(T0, T0 + 3 * DAY), '3 d ago');
});

test('buildEntries tolerates missing sources and keeps ids unique', () => {
  assert.deepEqual(buildEntries().entries, []);
  const { entries } = buildEntries({ ...scenario(), events: [...scenario().events, ...scenario().events] });
  assert.equal(new Set(entries.map(entry => entry.id)).size, entries.length);
  for (let i = 1; i < entries.length; i++) assert.ok(entries[i - 1].time >= entries[i].time, 'newest first');
});

test('the events a rollout makes are folded into its entry', () => {
  const rollout = id => ({ id, time: 0, category: 'rollouts', change: true, target: 'D', severity: 'info' });
  const ev = (id, time, reason, extra = {}) => ({ id, time, source: 'events', reason, severity: 'info', target: 'D', title: `${reason} ${id}`, count: 1, category: 'scaling', ...extra });
  const entries = [
    { ...rollout('r1'), time: 0 }, { ...rollout('r2'), time: 30 * MINUTE },
    ev('a', 2000, 'ScalingReplicaSet'), ev('b', 10 * MINUTE, 'SuccessfulCreate', { first: 30_000 }), ev('c', 30 * MINUTE + 20_000, 'Killing', { category: 'restarts' }),
    ev('scale', 5 * MINUTE, 'ScalingReplicaSet'), ev('late', 20 * MINUTE, 'ScalingReplicaSet'), ev('other', 1000, 'ScalingReplicaSet', { target: 'E' }), ev('warn', 1000, 'Killing', { severity: 'warning' }), ev('pull', 1000, 'Pulled'),
  ];
  const out = absorbRolloutEvents(entries);
  assert.deepEqual(out.map(entry => entry.id).sort(), ['late', 'other', 'pull', 'r1', 'r2', 'scale', 'warn'], 'a scale minutes after the rollout settled is its own change');
  assert.deepEqual(out.find(entry => entry.id === 'r1').progress.map(item => item.text), ['ScalingReplicaSet a', 'SuccessfulCreate b']);
  assert.deepEqual(out.find(entry => entry.id === 'r2').progress.map(item => item.text), ['Killing c']);
});

test('two rollouts in the same second each keep the events that name their ReplicaSet', () => {
  const entries = [
    { id: 'rev2', time: 0, category: 'rollouts', change: true, target: 'D', revisionName: 'web-aaa' },
    { id: 'rev3', time: 1000, category: 'rollouts', change: true, target: 'D', revisionName: 'web-bbb' },
    { id: 'e1', time: 1000, source: 'events', reason: 'ScalingReplicaSet', severity: 'info', target: 'D', title: 'Scaled up replica set web-aaa from 0 to 1' },
    { id: 'e2', time: 1000, source: 'events', reason: 'SuccessfulCreate', severity: 'info', target: 'D', title: 'Created pod: web-bbb-x1', ref: { kind: 'ReplicaSet', name: 'web-bbb' } },
    { id: 'e3', time: 2000, source: 'events', reason: 'Killing', severity: 'info', target: 'D', title: 'Stopping container web', ref: { kind: 'Pod', name: 'web-aaa-x2' } },
    { id: 'e4', time: 2000, source: 'events', reason: 'ScalingReplicaSet', severity: 'info', target: 'D', title: 'Scaled down replica set web-aaa from 1 to 0' },
  ];
  const out = absorbRolloutEvents(entries);
  assert.deepEqual(out.find(entry => entry.id === 'rev2').progress.map(item => item.text), ['Scaled up replica set web-aaa from 0 to 1', 'Stopping container web']);
  assert.deepEqual(out.find(entry => entry.id === 'rev3').progress.map(item => item.text), ['Created pod: web-bbb-x1', 'Scaled down replica set web-aaa from 1 to 0']);
});

test('changes before the last fully available revision are not related to a later burst', () => {
  const entries = [
    { id: 'burst', time: 60 * MINUTE, category: 'warnings', severity: 'warning', target: 'D', count: 3 },
    { id: 'created', time: 40 * MINUTE, category: 'rollouts', change: true, healthy: true, affects: ['D'], target: 'D', severity: 'info' },
    { id: 'config-created', time: 40 * MINUTE - 2000, category: 'config', change: true, affects: ['D'], severity: 'info' },
    { id: 'config-edit', time: 50 * MINUTE, category: 'config', change: true, affects: ['D'], severity: 'info' },
    { id: 'rev2', time: 55 * MINUTE, category: 'rollouts', change: true, healthy: false, affects: ['D'], target: 'D', severity: 'info' },
  ];
  assert.deepEqual(correlate(entries).filter(entry => entry.related).map(entry => entry.id).sort(), ['config-edit', 'rev2']);
  const noBaseline = entries.map(entry => (entry.id === 'created' ? { ...entry, healthy: false } : entry));
  assert.deepEqual(correlate(noBaseline).filter(entry => entry.related).map(entry => entry.id).sort(), ['config-created', 'config-edit', 'created', 'rev2'], 'a workload that never ran healthy keeps its creation as a suspect');
});
