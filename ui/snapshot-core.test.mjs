import test from 'node:test';
import assert from 'node:assert/strict';
import { parse as parseYAML } from 'yaml';
import { MASK, createRedactor, redactText, sanitizeObject, toYAML, buildSnapshot, snapshotMarkdown, aiPrompt, splitDetails, snapshotFileName, logTargets, podSpecRefs, podsOf, podStatusText, sortEvents, fenced, cell, redactionTotal, AI_PROMPT_LIMIT } from './snapshot-core.js';

const NOW = Date.parse('2026-11-06T14:00:00Z');

test('redacts tokens, passwords in URLs, bearer headers, AWS keys, private keys and JWTs', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const cases = [
    ['connecting to postgres://app:hunter2@db.shop:5432/orders', 'postgres://app:‹redacted›@db.shop:5432/orders'],
    ['GET /api Authorization: Bearer abcdef0123456789', 'Authorization: Bearer ‹redacted›'],
    ['sent header bearer abcdefgh12345678xyz', 'bearer ‹redacted›'],
    ['key AKIAIOSFODNN7EXAMPLE loaded', 'key ‹redacted› loaded'],
    [`token ${jwt} accepted`, 'token ‹redacted› accepted'],
    ['DB_PASSWORD=s3cr3t-value other=1', 'DB_PASSWORD=‹redacted› other=1'],
    ['{"password": "two words", "user": "bob"}', '{"password": "‹redacted›", "user": "bob"}'],
    ["api_key: 'abc123def'", "api_key: '‹redacted›'"],
    ['GET /callback?code=1&token=abc123xyz&state=2', 'token=‹redacted›&state=2'],
    ['--client-secret=xyz789', '--client-secret=‹redacted›'],
    ['using ghp_0123456789abcdefghijABCDEFGHIJ0123456789', 'using ‹redacted›'],
    ['slack xoxb-1234567890-abcdefghij', 'slack ‹redacted›'],
  ];
  for (const [input, expected] of cases) {
    const { text, count } = redactText(input);
    assert.ok(text.includes(expected), `${input} → ${text}`);
    assert.ok(count >= 1, input);
  }
  const pem = 'before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nIBAAKC\n-----END RSA PRIVATE KEY-----\nafter';
  assert.equal(redactText(pem).text, `before\n${MASK}\nafter`);
  // Cut off by the tail: the rest of the text is masked.
  assert.equal(redactText('x\n-----BEGIN PRIVATE KEY-----\nMIIE').text, `x\n${MASK}`);
});

test('leaves ordinary text, references and placeholders alone', () => {
  for (const input of [
    'secretName: db-credentials',
    'Error: secret "db-creds" not found',
    'Token validation succeeded for user bob',
    'password: ""',
    'DB_PASSWORD=$(DB_PASSWORD_FROM_SECRET)',
    'tokens=512 used',
    'token_ttl=30s',
    'Back-off restarting failed container worker in pod checkout-worker-7d9c',
    'tokenPath: /var/run/secrets/token',
  ]) {
    const { text, count } = redactText(input);
    assert.equal(text, input);
    assert.equal(count, 0, input);
  }
});

test('counts every masked value once', () => {
  const r = createRedactor();
  r.text('password=a1b2c3 and token=zzz999');
  r.text('nothing here');
  r.text(`url https://u:p4ss@h/`);
  assert.equal(r.count, 3);
});

test('sanitizeObject drops managedFields and last-applied, keeps Secret keys only, masks env and args', () => {
  const pod = {
    apiVersion: 'v1', kind: 'Pod',
    metadata: { name: 'api-1', namespace: 'shop', labels: { app: 'api' }, managedFields: [{ manager: 'kubectl' }], annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{"secret":"x"}', note: 'dsn postgres://u:pw@db/x' } },
    spec: { containers: [{ name: 'api', image: 'shop/api:1.0', args: ['--password', 'hunter2', '--port', '8080', '--token=abc12345'], env: [{ name: 'DB_PASSWORD', value: 'hunter2' }, { name: 'LOG_LEVEL', value: 'debug' }, { name: 'API_TOKEN', valueFrom: { secretKeyRef: { name: 'api', key: 'token' } } }, { name: 'DATABASE_URL', value: 'postgres://shop:pw@db:5432/shop' }], volumeMounts: [{ name: 'creds', mountPath: '/etc/creds' }] }], volumes: [{ name: 'creds', secret: { secretName: 'db-credentials' } }] },
  };
  const r = createRedactor();
  const clean = sanitizeObject(pod, r);
  assert.equal(clean.metadata.managedFields, undefined);
  assert.equal(clean.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'], undefined);
  assert.equal(clean.metadata.annotations.note, `dsn postgres://u:${MASK}@db/x`);
  const container = clean.spec.containers[0];
  assert.deepEqual(container.args, ['--password', MASK, '--port', '8080', `--token=${MASK}`]);
  assert.equal(container.env[0].value, MASK);
  assert.equal(container.env[1].value, 'debug');
  assert.deepEqual(container.env[2].valueFrom, { secretKeyRef: { name: 'api', key: 'token' } });
  assert.equal(container.env[3].value, `postgres://shop:${MASK}@db:5432/shop`);
  assert.equal(clean.spec.volumes[0].secret.secretName, 'db-credentials');
  assert.equal(r.count, 5);
  // The input is untouched.
  assert.equal(pod.spec.containers[0].env[0].value, 'hunter2');

  const secret = sanitizeObject({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 's' }, type: 'Opaque', data: { user: 'Ym9i', password: 'aHVudGVyMg==' } });
  assert.deepEqual(secret.data, { user: MASK, password: MASK });
  assert.equal(secret.type, 'Opaque');
});

test('toYAML writes YAML that parses back to the same object', () => {
  const value = {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name: 'web', labels: { 'app.kubernetes.io/name': 'web', version: '1.0' }, annotations: { 'example.com/script': 'line one\nline two\n', empty: '' } },
    spec: { replicas: 2, paused: false, selector: { matchLabels: { app: 'web' } }, template: { spec: { containers: [{ name: 'web', image: 'nginx:1.27', args: ['--flag', 'yes', '3', 'a: b', '#comment', ' padded'], ports: [{ containerPort: 80 }], env: [], resources: {} }], tolerations: [[1, 2], []] } } },
    status: { conditions: [{ type: 'Available', status: 'True', message: 'ok' }], nothing: null, masked: MASK },
  };
  const text = toYAML(value);
  assert.deepEqual(parseYAML(text), value);
  assert.match(text, /^containers:|\n {6}containers:\n {6}- name: web/);
  assert.equal(toYAML({}), '{}\n');
});

const crashingPod = (name, restarts = 7) => ({
  metadata: { name, namespace: 'shop', uid: `uid-${name}`, creationTimestamp: '2026-11-06T12:00:00Z', labels: { app: 'checkout-worker' }, ownerReferences: [{ kind: 'ReplicaSet', name: 'checkout-worker-7d9c', uid: 'uid-rs', controller: true }] },
  spec: { nodeName: 'node-a', restartPolicy: 'Always', containers: [{ name: 'worker', image: 'shop/worker:2.1', env: [{ name: 'QUEUE_PASSWORD', value: 'pa55word' }], envFrom: [{ configMapRef: { name: 'worker-config' } }, { secretRef: { name: 'queue-credentials' } }] }], volumes: [{ name: 'flags', configMap: { name: 'feature-flags', optional: true } }] },
  status: { phase: 'Running', containerStatuses: [{ name: 'worker', image: 'shop/worker:2.1', ready: false, restartCount: restarts, state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 5m0s restarting failed container' } }, lastState: { terminated: { exitCode: 1, reason: 'Error', finishedAt: '2026-11-06T13:58:00Z' } } }] },
});
const deployment = {
  apiVersion: 'apps/v1', kind: 'Deployment',
  metadata: { name: 'checkout-worker', namespace: 'shop', uid: 'uid-deploy', generation: 3, managedFields: [{}] },
  spec: { replicas: 2, selector: { matchLabels: { app: 'checkout-worker' } }, template: { metadata: { labels: { app: 'checkout-worker' } }, spec: { containers: [{ name: 'worker', image: 'shop/worker:2.1' }] } } },
  status: { observedGeneration: 3, replicas: 2, updatedReplicas: 2, readyReplicas: 0, unavailableReplicas: 2 },
};
const replicaSet = { kind: 'ReplicaSet', metadata: { name: 'checkout-worker-7d9c', uid: 'uid-rs', ownerReferences: [{ kind: 'Deployment', name: 'checkout-worker', uid: 'uid-deploy' }] } };
const event = (name, type, reason, message, last, kind = 'Pod', uid = `uid-${name}`) => ({ type, reason, message, count: 3, lastTimestamp: last, involvedObject: { kind, name, uid } });
const node = { metadata: { name: 'node-a' }, spec: {}, status: { allocatable: { cpu: '4', memory: '16Gi' }, conditions: [{ type: 'Ready', status: 'True' }, { type: 'MemoryPressure', status: 'False' }], nodeInfo: { kubeletVersion: 'v1.31.0' } } };

function workloadRaw(extra = {}) {
  const pods = [crashingPod('checkout-worker-7d9c-aaaaa'), crashingPod('checkout-worker-7d9c-bbbbb', 9)];
  return {
    target: { context: 'prod-eu-west-1', namespace: 'shop', resource: 'deployments', name: 'checkout-worker' },
    cluster: { label: 'prod-eu-west-1', env: 'production' }, version: '0.13.1', takenAt: NOW,
    object: deployment, owners: [], intermediates: [replicaSet], pods,
    events: [
      event('checkout-worker-7d9c-aaaaa', 'Normal', 'Pulled', 'Container image "shop/worker:2.1" already present', '2026-11-06T13:59:00Z'),
      event('checkout-worker-7d9c-aaaaa', 'Warning', 'BackOff', 'Back-off restarting failed container worker', '2026-11-06T13:58:30Z'),
      event('checkout-worker-7d9c-7d9c', 'Warning', 'FailedCreate', 'quota exceeded', '2026-11-06T13:00:00Z', 'ReplicaSet', 'uid-rs'),
      event('other', 'Warning', 'BackOff', 'unrelated pod', '2026-11-06T13:59:30Z'),
    ],
    services: [{ metadata: { name: 'checkout' }, spec: { type: 'ClusterIP', selector: { app: 'checkout-worker' }, ports: [{ port: 80, targetPort: 8080, protocol: 'TCP' }] } }, { metadata: { name: 'web' }, spec: { selector: { app: 'web' } } }],
    ingresses: [{ metadata: { name: 'shop' }, spec: { rules: [{ host: 'shop.example.com', http: { paths: [{ backend: { service: { name: 'checkout' } } }] } }] } }],
    configmaps: [{ metadata: { name: 'worker-config' } }],
    secrets: [{ metadata: { name: 'queue-credentials' } }],
    hpas: [],
    nodes: [node],
    problems: [{ severity: 'warning', resource: 'pods', name: 'checkout-worker-7d9c-aaaaa', title: 'Restarting', detail: '7 restarts', since: NOW - 3600_000 }, { severity: 'critical', resource: 'deployments', name: 'checkout-worker', title: 'No ready replicas', detail: '0/2', since: NOW - 600_000 }],
    logs: [
      { pod: 'checkout-worker-7d9c-bbbbb', container: 'worker', previous: true, text: Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\npanic: dial tcp amqp://worker:s3cret@rabbit:5672: connection refused\n' },
      { pod: 'checkout-worker-7d9c-bbbbb', container: 'worker', previous: false, text: '' , unavailable: 'container "worker" in pod is waiting to start' },
    ],
    logPods: { chosen: ['checkout-worker-7d9c-bbbbb'], skipped: 1 },
    notes: [{ step: 'Nodes', message: 'request timed out' }],
    options: { logLines: 100, previous: true, yaml: true },
    ...extra,
  };
}

test('buildSnapshot puts the diagnosis, pods, events, related objects and logs together', () => {
  const model = buildSnapshot(workloadRaw());
  assert.equal(model.title, 'Deployment shop/checkout-worker');
  assert.equal(model.findings[0].code, 'crashloop');
  assert.equal(model.findings[0].pods.length, 2);
  assert.deepEqual(model.pods.map(pod => pod.name), ['checkout-worker-7d9c-bbbbb', 'checkout-worker-7d9c-aaaaa']);
  assert.equal(model.pods[0].status, 'CrashLoopBackOff');
  assert.equal(model.summary.restarts, 16);
  assert.deepEqual(model.events.map(e => e.reason), ['BackOff', 'FailedCreate', 'Pulled']);
  assert.deepEqual(model.related.services.map(s => s.name), ['checkout']);
  assert.deepEqual(model.related.ingresses.map(i => i.hosts), ['shop.example.com']);
  assert.deepEqual(model.related.configmaps, [{ name: 'feature-flags', optional: true, missing: true }, { name: 'worker-config', optional: false, missing: false }]);
  assert.deepEqual(model.related.secrets, [{ name: 'queue-credentials', optional: false, missing: false }]);
  assert.equal(model.nodes[0].pods, 2);
  assert.equal(model.state.label, 'Unavailable');
  assert.equal(model.logs[0].lines.at(-1), `panic: dial tcp amqp://worker:${MASK}@rabbit:5672: connection refused`);
  assert.equal(model.logs[0].crash.exitCode, 1);
  assert.equal(model.redactions.logs, 1);
  assert.equal(model.redactions.yaml, 0);
  assert.doesNotMatch(model.yaml, /managedFields/);
  assert.equal(model.problems[0].severity, 'critical');
});

test('the Markdown report reads top-down and keeps long logs collapsible', () => {
  const model = buildSnapshot(workloadRaw());
  const md = snapshotMarkdown(model);
  const order = ['# Incident snapshot: Deployment shop/checkout-worker', '## What Rubban thinks is wrong', '## Pods (2)', '## Containers', '## Events (warnings first)', '## Logs', '## Related objects', '## Nodes', '## Open problems in namespace shop', '## Deployment YAML', '## About this snapshot'];
  let at = -1;
  for (const heading of order) { const next = md.indexOf(heading); assert.ok(next > at, `${heading} out of order`); at = next; }
  assert.match(md, /- \*\*Cluster:\*\* `prod-eu-west-1` \(production\)/);
  assert.match(md, /- \*\*Status:\*\* Unavailable · 0\/2 ready · 2 pods: 2 CrashLoopBackOff · 16 restarts in total/);
  assert.match(md, /### 1\. Crash loop: the container keeps exiting · 2 pods\n\nContainer worker exited with code 1/);
  assert.match(md, /\n\n\*\*Next step:\*\* The application exited with an error/);
  assert.match(md, /Pods: `checkout-worker-7d9c-aaaaa`, `checkout-worker-7d9c-bbbbb`/);
  assert.match(md, /\| `checkout-worker-7d9c-bbbbb` \| worker \| Waiting: CrashLoopBackOff \| 9 \| Error, exit 1, 2m ago \|/);
  assert.match(md, /`feature-flags` \(missing, optional\)/);
  assert.match(md, /\*\*checkout-worker-7d9c-bbbbb › worker\*\* · previous run, ended Error \(exit 1\) 2m ago · last 41 lines/);
  assert.match(md, /<details><summary>All 41 lines<\/summary>/);
  assert.match(md, /_No logs: container "worker" in pod is waiting to start_/);
  assert.match(md, /Logs of 1 pod shown \(the least healthy first\); 1 more not read/);
  assert.match(md, /- Nodes: request timed out/);
  assert.match(md, /1 value that looked like a secret was replaced with ‹redacted›/);
  assert.doesNotMatch(md, /s3cret|pa55word/);
  assert.doesNotMatch(md, /unrelated pod/);

  const noYaml = snapshotMarkdown(model, { yaml: false });
  assert.doesNotMatch(noYaml, /## Deployment YAML/);
  // The QUEUE_PASSWORD env value lives in the pods, not in the Deployment YAML, so the count is the same.
  assert.equal(redactionTotal(model, { yaml: false }), 1);
});

test('a pod snapshot names the pod status, its owner chain and its secrets by name only', () => {
  const pod = { ...crashingPod('checkout-worker-7d9c-aaaaa'), kind: 'Pod', apiVersion: 'v1' };
  const model = buildSnapshot({ ...workloadRaw(), target: { context: 'prod-eu-west-1', namespace: 'shop', resource: 'pods', name: pod.metadata.name }, object: pod, owners: [replicaSet, { kind: 'Deployment', metadata: { name: 'checkout-worker', uid: 'uid-deploy' } }], intermediates: [], pods: [pod] });
  const md = snapshotMarkdown(model);
  assert.match(md, /- \*\*Status:\*\* CrashLoopBackOff · 0\/1 ready · 7 restarts · node `node-a`/);
  assert.match(md, /- \*\*Owned by:\*\* Deployment `checkout-worker` → ReplicaSet `checkout-worker-7d9c`/);
  assert.match(md, /```yaml[\s\S]*name: QUEUE_PASSWORD\n\s+value: "‹redacted›"/);
  assert.ok(model.redactions.yaml >= 1);
});

test('namespace snapshots list what is in the namespace', () => {
  const healthy = { metadata: { name: 'web-1', namespace: 'shop', uid: 'uid-web' }, spec: { nodeName: 'node-a', containers: [{ name: 'web' }] }, status: { phase: 'Running', containerStatuses: [{ name: 'web', ready: true, restartCount: 0, state: { running: {} } }] } };
  const raw = workloadRaw();
  const model = buildSnapshot({ ...raw, target: { context: 'prod-eu-west-1', namespace: 'shop', resource: 'namespaces', name: 'shop' }, object: { kind: 'Namespace', metadata: { name: 'shop' } }, intermediates: [], pods: [healthy, ...raw.pods] });
  const md = snapshotMarkdown(model);
  assert.match(md, /^# Incident snapshot: Namespace shop/);
  assert.match(md, /3 pods: 2 CrashLoopBackOff, 1 Running/);
  assert.match(md, /unrelated pod/);
  assert.match(md, /## In this namespace/);
  assert.match(md, /- \*\*Services:\*\* `checkout` \(ClusterIP, 80→8080\/TCP\), `web`/);
  assert.doesNotMatch(md, /YAML/);
  // Only unhealthy pods get container rows.
  assert.equal(model.containers.length, 2);
});

test('logTargets reads the worst pods first, with the crashed run before the current one', () => {
  const healthy = { metadata: { name: 'ok' }, spec: { containers: [{ name: 'app' }] }, status: { phase: 'Running', containerStatuses: [{ name: 'app', ready: true, restartCount: 0, state: { running: {} } }] } };
  const { targets, chosen, skipped } = logTargets([healthy, crashingPod('a', 2), crashingPod('b', 5)], { maxPods: 2 });
  assert.deepEqual(chosen, ['b', 'a']);
  assert.equal(skipped, 1);
  // Waiting in CrashLoopBackOff: only the crashed run exists, so the "current" logs are not read twice.
  assert.deepEqual(targets, [{ pod: 'b', container: 'worker', previous: true }, { pod: 'a', container: 'worker', previous: true }]);
  assert.deepEqual(logTargets([crashingPod('a')], { previous: false }).targets, [{ pod: 'a', container: 'worker', previous: false }]);
  // Restarted earlier and running again: both runs.
  const recovered = crashingPod('r');
  recovered.status.containerStatuses[0].state = { running: { startedAt: '2026-11-06T13:59:00Z' } };
  assert.deepEqual(logTargets([recovered]).targets, [{ pod: 'r', container: 'worker', previous: true }, { pod: 'r', container: 'worker', previous: false }]);
  assert.deepEqual(logTargets([healthy, crashingPod('a')], { onlyUnhealthy: true }).chosen, ['a']);
});

test('podSpecRefs and podsOf follow references and ownership', () => {
  const refs = podSpecRefs({ imagePullSecrets: [{ name: 'regcred' }], volumes: [{ projected: { sources: [{ secret: { name: 'tls' } }, { configMap: { name: 'ca' } }] } }], containers: [{ env: [{ valueFrom: { configMapKeyRef: { name: 'cfg', optional: true } } }] }] });
  assert.deepEqual([...refs.secrets.keys()], ['tls', 'regcred']);
  assert.deepEqual([...refs.configmaps], [['ca', false], ['cfg', true]]);
  const pods = [crashingPod('x'), { metadata: { name: 'stray', labels: { app: 'other' } } }];
  assert.deepEqual(podsOf(deployment, 'deployments', pods, [replicaSet]).map(p => p.metadata.name), ['x']);
  assert.deepEqual(podsOf({ metadata: { uid: 'uid-cron' } }, 'cronjobs', pods, [{ metadata: { uid: 'uid-rs', ownerReferences: [{ uid: 'uid-cron' }] } }]).map(p => p.metadata.name), ['x']);
});

test('podStatusText matches what kubectl shows', () => {
  assert.equal(podStatusText(crashingPod('a')), 'CrashLoopBackOff');
  assert.equal(podStatusText({ status: { phase: 'Pending', initContainerStatuses: [{ state: { waiting: { reason: 'ImagePullBackOff' } } }] } }), 'Init:ImagePullBackOff');
  assert.equal(podStatusText({ status: { phase: 'Failed', reason: 'Evicted' } }), 'Evicted');
  assert.equal(podStatusText({ metadata: { deletionTimestamp: 'x' }, status: { phase: 'Running' } }), 'Terminating');
  assert.equal(podStatusText({ status: { phase: 'Running', containerStatuses: [{ ready: false, state: { running: {} } }] } }), 'Running (not ready)');
});

test('events sort warnings first, newest first', () => {
  const sorted = sortEvents([{ type: 'Normal', lastTimestamp: '2026-11-06T13:59:00Z' }, { type: 'Warning', lastTimestamp: '2026-11-06T13:00:00Z' }, { type: 'Warning', lastTimestamp: '2026-11-06T13:30:00Z' }]);
  assert.deepEqual(sorted.map(e => e.lastTimestamp), ['2026-11-06T13:30:00Z', '2026-11-06T13:00:00Z', '2026-11-06T13:59:00Z']);
});

test('fences and table cells cannot be broken by their content', () => {
  assert.equal(fenced('a\n```\nb', 'text'), '~~~~text\na\n```\nb\n~~~~');
  assert.equal(fenced('plain\n\n'), '```\nplain\n```');
  assert.equal(cell('a | b\nc'), 'a \\| b c');
  assert.equal(cell('x'.repeat(10), 5), 'xxxx…');
});

test('the AI prompt carries the instructions and fits the route limit', () => {
  const huge = workloadRaw({ logs: [{ pod: 'checkout-worker-7d9c-bbbbb', container: 'worker', previous: true, text: Array.from({ length: 5000 }, (_, i) => `${i} ${'x'.repeat(120)}`).join('\n') }] });
  const model = buildSnapshot({ ...huge, options: { logLines: 500, previous: true, yaml: true } });
  const { prompt, trimmed, logLines } = aiPrompt(model);
  assert.ok(prompt.length <= AI_PROMPT_LIMIT, String(prompt.length));
  assert.ok(trimmed);
  assert.ok(logLines < 500);
  assert.match(prompt, /Most likely root cause/);
  assert.match(prompt, /## What Rubban thinks is wrong/);
  assert.doesNotMatch(prompt, /<details>/);
  const small = aiPrompt(buildSnapshot(workloadRaw()));
  assert.equal(small.trimmed, false);
  assert.ok(aiPrompt(model, { limit: 3000 }).prompt.length <= 3000);
});

test('splitDetails separates collapsible blocks for the preview', () => {
  const parts = splitDetails('# T\n\ntext\n\n<details><summary>All 41 lines</summary>\n\n```text\nx\n```\n\n</details>\n\n## After');
  assert.deepEqual(parts.map(p => p.type), ['markdown', 'details', 'markdown']);
  assert.equal(parts[1].summary, 'All 41 lines');
  assert.equal(parts[1].text, '```text\nx\n```');
});

test('file names are safe and say what the snapshot is of', () => {
  const model = buildSnapshot(workloadRaw());
  assert.equal(snapshotFileName(model), 'snapshot-prod-eu-west-1-shop-deployment-checkout-worker-20261106-1400.md');
});
