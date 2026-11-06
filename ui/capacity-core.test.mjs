import test from 'node:test';
import assert from 'node:assert/strict';
import { podRequests, podProblem, podKind, pendingReason, nodeFacts, buildModel, tolerates, matchesNode, rejectReason, schedulerMessage, explainPlacement, simulateDrain, pdbAllowance, fragmentation, squarify, tileValues, namespaceColors } from './capacity-core.js';

const GiB = 2 ** 30; const MiB = 2 ** 20;
const CONTROL_TAINT = { key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' };
function node(name, { cpu = '4', memory = '8Gi', pods = '110', labels = {}, taints, unschedulable, ready = true, pressure } = {}) {
  return {
    metadata: { name, labels: { 'kubernetes.io/hostname': name, ...labels } },
    spec: { ...(taints ? { taints } : {}), ...(unschedulable ? { unschedulable: true } : {}) },
    status: { allocatable: { cpu, memory, pods }, conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }, ...(pressure ? [{ type: pressure, status: 'True' }] : [])] },
  };
}
let seq = 0;
function pod(name, { ns = 'shop', node: nodeName = '', cpu = '100m', memory = '128Mi', owner = 'ReplicaSet', labels = {}, phase = 'Running', spec = {}, annotations, status = {} } = {}) {
  return {
    metadata: { name, namespace: ns, uid: `uid-${++seq}`, labels, ...(annotations ? { annotations } : {}), ...(owner ? { ownerReferences: [{ kind: owner, name: `${name}-owner`, controller: true }] } : {}) },
    spec: { ...(nodeName ? { nodeName } : {}), containers: [{ name: 'app', resources: { requests: { ...(cpu ? { cpu } : {}), ...(memory ? { memory } : {}) } } }], ...spec },
    status: { phase, ...status },
  };
}

test('requests add app containers and native sidecars, take the init-container peak and add overhead', () => {
  assert.deepEqual(podRequests(pod('a', { cpu: '250m', memory: '64Mi' })), { cpu: 0.25, memory: 64 * MiB });
  const complex = {
    spec: {
      initContainers: [
        { name: 'migrate', resources: { requests: { cpu: '2', memory: '1Gi' } } },
        { name: 'proxy', restartPolicy: 'Always', resources: { requests: { cpu: '100m', memory: '50Mi' } } },
        { name: 'late-init', resources: { requests: { cpu: '500m' } } },
      ],
      containers: [{ name: 'a', resources: { requests: { cpu: '300m', memory: '200Mi' } } }, { name: 'b', resources: { limits: { cpu: '200m', memory: '100Mi' } } }],
      overhead: { cpu: '10m', memory: '1Mi' },
    },
  };
  const r = podRequests(complex);
  // CPU: max(0.3 + 0.2 + 0.1 sidecar, 2 (migrate, before the sidecar), 0.5 + 0.1) + 0.01 overhead
  assert.ok(Math.abs(r.cpu - 2.01) < 1e-9, String(r.cpu));
  // Memory: max(200 + 100 (limit as request) + 50, 1024) + 1
  assert.equal(r.memory, 1025 * MiB);
  assert.deepEqual(podRequests({ spec: { containers: [{ name: 'x' }] } }), { cpu: 0, memory: 0 });
});

test('pod problems, drain kinds and pending reasons', () => {
  assert.equal(podProblem(pod('ok')), '');
  assert.equal(podProblem(pod('crash', { status: { containerStatuses: [{ ready: false, state: { waiting: { reason: 'CrashLoopBackOff' } } }] } })), 'CrashLoopBackOff');
  assert.equal(podProblem(pod('creating', { phase: 'Pending', node: 'n', status: { containerStatuses: [{ ready: false, state: { waiting: { reason: 'ContainerCreating' } } }] } })), '');
  assert.equal(podProblem(pod('unready', { status: { containerStatuses: [{ ready: false, state: { running: {} } }] } })), 'Not ready');
  assert.equal(podProblem(pod('pending', { phase: 'Pending' })), 'Unschedulable');
  assert.equal(podKind(pod('ds', { owner: 'DaemonSet' })), 'daemonset');
  assert.equal(podKind(pod('static', { owner: 'Node', annotations: { 'kubernetes.io/config.mirror': 'abc' } })), 'mirror');
  assert.equal(podKind(pod('bare', { owner: null })), 'unmanaged');
  assert.equal(podKind(pod('rs')), 'controller');
  assert.match(pendingReason(pod('p', { phase: 'Pending', status: { conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: '0/2 nodes are available: 1 Insufficient cpu.' }] } })), /Insufficient cpu/);
  assert.equal(pendingReason(pod('p', { phase: 'Pending' })), 'Not scheduled yet');
});

test('node facts read roles, zone, instance type, state and allocatable', () => {
  const facts = nodeFacts(node('n1', { cpu: '3500m', memory: '16Gi', labels: { 'node-role.kubernetes.io/worker': '', 'topology.kubernetes.io/zone': 'eu-west-1a', 'node.kubernetes.io/instance-type': 'm6i.xlarge' }, taints: [CONTROL_TAINT], unschedulable: true, pressure: 'MemoryPressure' }));
  assert.deepEqual(facts.roles, ['worker']);
  assert.equal(facts.zone, 'eu-west-1a');
  assert.equal(facts.instanceType, 'm6i.xlarge');
  assert.equal(facts.cordoned, true);
  assert.equal(facts.ready, true);
  assert.deepEqual(facts.pressures, ['MemoryPressure']);
  assert.deepEqual(facts.allocatable, { cpu: 3.5, memory: 16 * GiB, pods: 110 });
  assert.equal(nodeFacts(node('legacy', { labels: { 'failure-domain.beta.kubernetes.io/zone': 'z1', 'beta.kubernetes.io/instance-type': 't3' } })).zone, 'z1');
});

test('the model counts running pods per node, skips finished ones and lists the waiting lane', () => {
  const model = buildModel([node('b'), node('a')], [
    pod('web-1', { node: 'a', cpu: '500m', memory: '1Gi' }), pod('web-2', { node: 'a', cpu: '1', memory: '512Mi' }),
    pod('job-done', { node: 'a', phase: 'Succeeded', cpu: '4' }), pod('job-failed', { node: 'b', phase: 'Failed', cpu: '4' }),
    pod('waiting', { cpu: '8', phase: 'Pending' }), pod('gone', { node: 'removed-node' }),
  ]);
  assert.deepEqual(model.nodes.map(n => n.name), ['a', 'b']);
  const a = model.byName.get('a');
  assert.deepEqual(a.requested, { cpu: 1.5, memory: 1.5 * GiB, pods: 2 });
  assert.equal(a.finished, 1);
  assert.deepEqual(a.pods.map(p => p.name), ['web-2', 'web-1'], 'biggest request first');
  assert.equal(model.byName.get('b').finished, 1);
  assert.deepEqual(model.waiting.map(p => p.name), ['waiting']);
  assert.equal(model.orphans.length, 1);
  assert.deepEqual(model.totals.allocatable, { cpu: 8, memory: 16 * GiB, pods: 220 });
  assert.equal(model.totals.requested.pods, 2);
});

test('tolerations match taints by key, value, operator and effect', () => {
  const taint = { key: 'dedicated', value: 'gpu', effect: 'NoSchedule' };
  assert.ok(tolerates([{ key: 'dedicated', operator: 'Equal', value: 'gpu', effect: 'NoSchedule' }], taint));
  assert.ok(tolerates([{ key: 'dedicated', value: 'gpu' }], taint), 'operator defaults to Equal, empty effect matches all');
  assert.ok(tolerates([{ key: 'dedicated', operator: 'Exists' }], taint));
  assert.ok(tolerates([{ operator: 'Exists' }], taint), 'empty key with Exists tolerates everything');
  assert.ok(!tolerates([{ key: 'dedicated', value: 'cpu' }], taint));
  assert.ok(!tolerates([{ key: 'dedicated', operator: 'Exists', effect: 'NoExecute' }], taint));
  assert.ok(!tolerates([], taint));
  assert.ok(tolerates([{ key: 'node-role.kubernetes.io/control-plane', operator: 'Exists', effect: 'NoSchedule' }], CONTROL_TAINT));
});

test('node selectors and required node affinity', () => {
  const n = nodeFacts(node('n1', { labels: { disk: 'ssd', zone: 'a', cores: '16' } }));
  const affinity = terms => ({ affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: terms } } } });
  assert.ok(matchesNode({ spec: { nodeSelector: { disk: 'ssd' } } }, n));
  assert.ok(!matchesNode({ spec: { nodeSelector: { disk: 'hdd' } } }, n));
  assert.ok(matchesNode({ spec: affinity([{ matchExpressions: [{ key: 'zone', operator: 'In', values: ['a', 'b'] }] }]) }, n));
  assert.ok(!matchesNode({ spec: affinity([{ matchExpressions: [{ key: 'zone', operator: 'NotIn', values: ['a'] }] }]) }, n));
  assert.ok(matchesNode({ spec: affinity([{ matchExpressions: [{ key: 'gpu', operator: 'DoesNotExist' }, { key: 'disk', operator: 'Exists' }] }]) }, n));
  assert.ok(!matchesNode({ spec: affinity([{ matchExpressions: [{ key: 'gpu', operator: 'Exists' }] }]) }, n));
  assert.ok(matchesNode({ spec: affinity([{ matchExpressions: [{ key: 'gpu', operator: 'Exists' }] }, { matchExpressions: [{ key: 'cores', operator: 'Gt', values: ['8'] }] }]) }, n), 'terms are ORed');
  assert.ok(!matchesNode({ spec: affinity([{ matchExpressions: [{ key: 'cores', operator: 'Lt', values: ['8'] }] }]) }, n));
  assert.ok(matchesNode({ spec: affinity([{ matchFields: [{ key: 'metadata.name', operator: 'In', values: ['n1'] }] }]) }, n));
  assert.ok(!matchesNode({ spec: affinity([{ matchFields: [{ key: 'metadata.name', operator: 'In', values: ['n2'] }] }]) }, n));
});

test('reject reasons follow the scheduler: drain, cordon, readiness, affinity, taints, pod count, resources', () => {
  const model = buildModel([node('drained'), node('cordoned', { unschedulable: true }), node('down', { ready: false }), node('ssd', { labels: { disk: 'ssd' } }), node('tainted', { taints: [CONTROL_TAINT] }), node('full', { pods: '1' }), node('small', { cpu: '1', memory: '1Gi' })],
    [pod('existing', { node: 'full', cpu: '0', memory: '0' })]);
  const p = buildModel([node('x')], [pod('big', { node: 'x', cpu: '2', memory: '2Gi', spec: { nodeSelector: { disk: 'hdd' } } })]).byName.get('x').pods[0];
  const pFree = buildModel([node('x')], [pod('big', { node: 'x', cpu: '2', memory: '2Gi' })]).byName.get('x').pods[0];
  const reason = name => rejectReason(name === 'ssd' ? p : pFree, model.byName.get(name), model.byName.get(name).requested, { draining: new Set(['drained']) });
  assert.equal(reason('drained').code, 'draining');
  assert.equal(reason('cordoned').code, 'cordoned');
  assert.equal(reason('down').code, 'notready');
  assert.equal(reason('ssd').code, 'affinity');
  assert.equal(reason('tainted').code, 'taint');
  assert.equal(reason('full').code, 'pods');
  const small = reason('small');
  assert.equal(small.code, 'resources');
  assert.match(small.text, /insufficient cpu \(needs 2 cores, 1 core free\), insufficient memory/);
  // A pod that tolerates the unschedulable taint may still land on a cordoned node.
  const tolerant = { ...pFree, pod: { spec: { tolerations: [{ key: 'node.kubernetes.io/unschedulable', operator: 'Exists' }] } } };
  assert.equal(rejectReason(tolerant, model.byName.get('cordoned'), { cpu: 0, memory: 0, pods: 0 }), null);
  assert.equal(schedulerMessage([{ reason: { code: 'draining' } }, { reason: { code: 'taint', taints: [CONTROL_TAINT] } }, { reason: { code: 'cpu' } }, { reason: { code: 'cpu' } }], 4),
    '0/4 nodes available: 2 insufficient cpu, 1 being drained, 1 untolerated taint {node-role.kubernetes.io/control-plane:NoSchedule}');
});

// The demo clusters: a kind control plane (tainted) and one worker.
function kindCluster() {
  const nodes = [node('prod-control-plane', { cpu: '12', memory: '11Gi', labels: { 'node-role.kubernetes.io/control-plane': '' }, taints: [CONTROL_TAINT] }), node('prod-worker', { cpu: '12', memory: '11Gi' })];
  const pods = [
    pod('coredns-1', { ns: 'kube-system', node: 'prod-control-plane', spec: { tolerations: [{ key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' }] } }),
    pod('etcd-prod-control-plane', { ns: 'kube-system', node: 'prod-control-plane', owner: 'Node', annotations: { 'kubernetes.io/config.mirror': 'x' } }),
    pod('kube-proxy-w', { ns: 'kube-system', node: 'prod-worker', owner: 'DaemonSet', spec: { tolerations: [{ operator: 'Exists' }] } }),
    pod('storefront-1', { node: 'prod-worker', labels: { app: 'storefront' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } }),
    pod('storefront-2', { node: 'prod-worker', labels: { app: 'storefront' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } }),
    pod('payments-api', { ns: 'payments', node: 'prod-worker', cpu: '250m' }),
    pod('cache', { ns: 'data', node: 'prod-worker', spec: { volumes: [{ name: 'tmp', emptyDir: {} }] } }),
    pod('debug', { ns: 'shop', node: 'prod-worker', owner: null }),
    pod('old-job', { ns: 'shop', node: 'prod-worker', phase: 'Failed' }),
  ];
  const pdbs = [{ metadata: { name: 'storefront', namespace: 'shop' }, spec: { minAvailable: 1, selector: { matchLabels: { app: 'storefront' } } }, status: { observedGeneration: 1, disruptionsAllowed: 1, currentHealthy: 2, expectedPods: 2 } }];
  return { nodes, pods, pdbs, model: buildModel(nodes, pods) };
}

test('draining the only worker of a kind cluster: nothing fits, because the control plane is tainted', () => {
  const { pods, pdbs, model } = kindCluster();
  const result = simulateDrain(model, ['prod-worker'], { pdbs, podItems: pods });
  assert.equal(result.verdict.level, 'unsafe');
  assert.equal(result.verdict.headline, 'Not safe to drain prod-worker: none of its 4 pods would have anywhere to go.');
  assert.equal(result.verdict.lines[0], 'The only other node, prod-control-plane, has the taint node-role.kubernetes.io/control-plane:NoSchedule, which none of these pods tolerate.');
  assert.ok(result.verdict.lines.some(line => /Add a worker node first/.test(line)));
  assert.ok(result.verdict.lines.some(line => /would leave them Pending/.test(line)));
  assert.equal(result.placed.length, 0);
  assert.deepEqual(result.unplaced.map(p => p.name).sort(), ['cache', 'payments-api', 'storefront-1', 'storefront-2']);
  assert.equal(result.unplaced[0].message, '0/2 nodes available: 1 being drained, 1 untolerated taint {node-role.kubernetes.io/control-plane:NoSchedule}');
  assert.deepEqual(result.ignored.map(p => p.name), ['kube-proxy-w']);
  assert.deepEqual(result.lost.map(p => p.name), ['debug']);
  assert.equal(result.pdbs.length, 1);
  assert.equal(result.pdbs[0].level, 'blocks');
  assert.match(result.pdbs[0].text, /shop\/storefront allows 1 disruption at a time; the drain evicts 2 of its pods, and none of the replacements would fit/);
  assert.ok(result.verdict.lines.some(line => /1 pod with no controller would be deleted and not come back: shop\/debug/.test(line)));
  assert.ok(result.verdict.lines.some(line => /emptyDir/.test(line)));
});

test('draining the control plane moves its tolerant pods to the worker and reports before and after', () => {
  const { pods, pdbs, model } = kindCluster();
  const result = simulateDrain(model, ['prod-control-plane'], { pdbs, podItems: pods });
  assert.equal(result.verdict.level, 'safe');
  assert.equal(result.verdict.headline, 'Safe to drain prod-control-plane: the one pod that needs a new home fits on prod-worker.');
  assert.deepEqual(result.placed.map(p => [p.name, p.to]), [['coredns-1', 'prod-worker']]);
  assert.deepEqual(result.ignored.map(p => p.name), ['etcd-prod-control-plane']);
  const worker = result.destinations.find(d => d.name === 'prod-worker');
  assert.equal(worker.after.pods, worker.before.pods + 1);
  assert.ok(Math.abs(worker.after.cpu - worker.before.cpu - 0.1) < 1e-9);
});

test('placement spreads pods by least allocation and fills nodes up to their limits', () => {
  const nodes = [node('a', { cpu: '2', memory: '4Gi' }), node('b', { cpu: '2', memory: '4Gi' }), node('c', { cpu: '2', memory: '4Gi' })];
  const pods = [1, 2, 3, 4].map(i => pod(`web-${i}`, { node: 'a', cpu: '400m', memory: '512Mi' }));
  const result = simulateDrain(buildModel(nodes, pods), ['a']);
  assert.equal(result.verdict.level, 'safe');
  assert.equal(result.verdict.headline, 'Safe to drain a: all 4 pods fit on 2 other nodes.');
  const counts = Object.fromEntries(['b', 'c'].map(name => [name, result.placed.filter(p => p.to === name).length]));
  assert.deepEqual(counts, { b: 2, c: 2 });
});

test('some pods do not fit: resources run out and the biggest are placed first', () => {
  const nodes = [node('a', { cpu: '4' }), node('b', { cpu: '2' })];
  const pods = [pod('small-1', { node: 'a', cpu: '500m' }), pod('big', { node: 'a', cpu: '1500m' }), pod('small-2', { node: 'a', cpu: '500m' }), pod('huge', { node: 'a', cpu: '3' })];
  const result = simulateDrain(buildModel(nodes, pods), ['a']);
  assert.equal(result.verdict.level, 'unsafe');
  assert.equal(result.verdict.headline, 'Not safe to drain a: 2 of its 4 pods would not fit on the remaining nodes.');
  assert.deepEqual(result.unplaced.map(p => p.name).sort(), ['huge', 'small-2'].sort());
  assert.ok(result.placed.some(p => p.name === 'big'), 'the bigger pod is placed before the small ones');
  assert.ok(result.verdict.lines.some(line => /^2 pods: 0\/2 nodes available: 1 being drained, 1 insufficient cpu\.$/.test(line)));
});

test('node selectors keep a pod off nodes it does not match; priority goes first', () => {
  const nodes = [node('a'), node('ssd', { cpu: '1', labels: { disk: 'ssd' } }), node('plain', { cpu: '1' })];
  const pods = [
    pod('low', { node: 'a', cpu: '800m', spec: { priority: 0 } }),
    pod('db', { node: 'a', cpu: '800m', spec: { nodeSelector: { disk: 'ssd' }, priority: 1000 } }),
    pod('critical', { node: 'a', cpu: '800m', spec: { priority: 100000 } }),
  ];
  const result = simulateDrain(buildModel(nodes, pods), ['a']);
  assert.deepEqual(Object.fromEntries(result.placed.map(p => [p.name, p.to])), { critical: 'plain', db: 'ssd' });
  assert.deepEqual(result.unplaced.map(p => p.name), ['low']);
});

test('draining every node, and an empty selection', () => {
  const { model } = kindCluster();
  const all = simulateDrain(model, ['prod-worker', 'prod-control-plane']);
  assert.equal(all.verdict.headline, 'Not safe to drain prod-control-plane and prod-worker: no node would be left to run their 5 pods.');
  assert.equal(simulateDrain(model, []).verdict.level, 'none');
});

test('disruption budgets: ok, waits for replacements, blocks with zero allowed', () => {
  const nodes = [node('a'), node('b')];
  const ready = { conditions: [{ type: 'Ready', status: 'True' }] };
  const pods = [pod('api-1', { node: 'a', labels: { app: 'api' }, status: ready }), pod('api-2', { node: 'a', labels: { app: 'api' }, status: ready }), pod('api-3', { node: 'b', labels: { app: 'api' }, status: ready })];
  const budget = spec => ({ metadata: { name: 'api', namespace: 'shop' }, spec: { selector: { matchLabels: { app: 'api' } }, ...spec } });
  const run = spec => simulateDrain(buildModel(nodes, pods), ['a'], { pdbs: [budget(spec)], podItems: pods });
  assert.equal(run({ maxUnavailable: 2 }).pdbs[0].level, 'ok');
  const waits = run({ minAvailable: 2 });
  assert.equal(waits.pdbs[0].level, 'waits');
  assert.equal(waits.verdict.level, 'caution');
  assert.match(waits.verdict.lines.join(' '), /waits for replacements to become Ready/);
  const blocks = run({ maxUnavailable: 0 });
  assert.equal(blocks.pdbs[0].level, 'blocks');
  assert.equal(blocks.verdict.level, 'unsafe');
  assert.match(blocks.verdict.headline, /would stall: a disruption budget blocks it/);
  assert.match(blocks.pdbs[0].text, /allows no disruptions even with all 3 pods healthy/);
  // Budgets that select none of the drained pods are left out.
  assert.equal(simulateDrain(buildModel(nodes, pods), ['b'], { pdbs: [{ metadata: { name: 'x', namespace: 'shop' }, spec: { selector: { matchLabels: { app: 'other' } } } }], podItems: pods }).pdbs.length, 0);
});

test('PDB allowance from the controller status, or computed from percentages', () => {
  const ready = { conditions: [{ type: 'Ready', status: 'True' }] };
  const pods = [1, 2, 3, 4].map(i => pod(`w-${i}`, { node: 'a', labels: { app: 'w' }, status: i === 4 ? {} : ready }));
  const pdb = spec => ({ metadata: { name: 'w', namespace: 'shop' }, spec: { selector: { matchLabels: { app: 'w' } }, ...spec } });
  assert.deepEqual((({ allowed, healthy, expected }) => ({ allowed, healthy, expected }))(pdbAllowance(pdb({ minAvailable: '50%' }), pods)), { allowed: 1, healthy: 3, expected: 4 });
  assert.equal(pdbAllowance(pdb({ maxUnavailable: '25%' }), pods).allowed, 0);
  assert.equal(pdbAllowance(pdb({ minAvailable: 1 }), pods).allowed, 2);
  assert.equal(pdbAllowance({ ...pdb({ minAvailable: 1 }), status: { observedGeneration: 2, disruptionsAllowed: 0, currentHealthy: 1, expectedPods: 4 } }, pods).allowed, 0);
  assert.equal(pdbAllowance(pdb({ selector: { matchExpressions: [{ key: 'app', operator: 'In', values: ['w'] }] }, minAvailable: 0 }), pods).allowed, 3);
});

test('fragmentation: room in total but not in one piece, or simply too little', () => {
  const nodes = [node('a', { cpu: '4' }), node('b', { cpu: '4' }), node('cp', { cpu: '16', taints: [CONTROL_TAINT] })];
  const pods = [pod('x', { node: 'a', cpu: '2' }), pod('y', { node: 'b', cpu: '2' })];
  const split = fragmentation(buildModel(nodes, [...pods, pod('wants-3', { cpu: '3', phase: 'Pending' })]));
  assert.deepEqual(split.largest.cpu, { value: 2, node: 'a' }, 'the tainted node is not counted as free room');
  assert.equal(split.largest.total.cpu, 4);
  assert.match(split.hint, /shop\/wants-3 asks for 3 cores of CPU; the most free on one node it may use is 2 cores \(a\)\. Those nodes have 4 cores free together: the room exists but is split across nodes \(fragmentation\)\./);
  const short = fragmentation(buildModel(nodes, [...pods, pod('wants-48', { cpu: '48', phase: 'Pending' })]));
  assert.match(short.hint, /the cluster is short of CPU, not just fragmented/);
  const nowhere = fragmentation(buildModel(nodes, [...pods, pod('picky', { cpu: '1', phase: 'Pending', spec: { nodeSelector: { gpu: 'yes' } } })]));
  assert.match(nowhere.hint, /no node accepts it at all/);
  assert.equal(fragmentation(buildModel(nodes, pods)).hint, '');
});

test('explaining a waiting pod lists every node and why', () => {
  const nodes = [node('a', { cpu: '1' }), node('cp', { taints: [CONTROL_TAINT] })];
  const model = buildModel(nodes, [pod('big', { cpu: '2', phase: 'Pending' })]);
  const answer = explainPlacement(model.waiting[0], model);
  assert.deepEqual(answer.fits, []);
  assert.equal(answer.message, '0/2 nodes available: 1 insufficient cpu, 1 untolerated taint {node-role.kubernetes.io/control-plane:NoSchedule}');
  assert.match(answer.rejections.find(r => r.node === 'a').reason.text, /needs 2 cores, 1 core free/);
});

test('squarified tiles cover the box with areas proportional to the values', () => {
  const values = [6, 6, 4, 3, 2, 2, 1];
  const rects = squarify(values, 600, 400);
  assert.equal(rects.length, values.length);
  const total = values.reduce((a, b) => a + b, 0);
  for (const rect of rects) {
    assert.ok(Math.abs(rect.w * rect.h - (values[rect.index] / total) * 600 * 400) < 1e-6, `area of ${rect.index}`);
    assert.ok(rect.x >= -1e-9 && rect.y >= -1e-9 && rect.x + rect.w <= 600 + 1e-6 && rect.y + rect.h <= 400 + 1e-6, 'inside the box');
  }
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i]; const b = rects[j];
    const overlap = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    assert.ok(overlap < 1e-6, `tiles ${a.index} and ${b.index} overlap`);
  }
  // The well-known example from the paper keeps every aspect ratio below 3.
  for (const rect of rects) assert.ok(Math.max(rect.w / rect.h, rect.h / rect.w) < 3, `aspect of ${rect.index}`);
  assert.deepEqual(squarify([], 10, 10), []);
  assert.deepEqual(squarify([0, 0], 10, 10), []);
  assert.deepEqual(squarify([5], 10, 4), [{ index: 0, x: 0, y: 0, w: 10, h: 4 }]);
});

test('tile values give pods without requests a visible floor', () => {
  assert.deepEqual(tileValues([{ requests: { cpu: 1, memory: 0 } }, { requests: { cpu: 0, memory: 0 } }], 'cpu'), [1, 0.04]);
  assert.deepEqual(tileValues([{ requests: { cpu: 0, memory: 0 } }], 'memory'), [1]);
});

test('namespace colours are stable and distinct until the palette runs out', () => {
  const first = namespaceColors(['shop', 'payments', 'data', 'logistics'], 10);
  const again = namespaceColors(['logistics', 'data', 'payments', 'shop', 'shop'], 10);
  assert.deepEqual([...first].sort(), [...again].sort());
  assert.equal(new Set(first.values()).size, 4);
  const many = namespaceColors(Array.from({ length: 10 }, (_, i) => `ns-${i}`), 10);
  assert.equal(new Set(many.values()).size, 10);
  const over = namespaceColors(Array.from({ length: 14 }, (_, i) => `ns-${i}`), 10);
  for (const slot of over.values()) assert.ok(slot >= 0 && slot < 10);
  // The busiest namespaces get colours of their own; only small ones share.
  const busy = namespaceColors([...Array(9).fill('shop'), ...Array(8).fill('rollouts'), ...Array.from({ length: 12 }, (_, i) => `tiny-${i}`)], 10);
  const shared = [...busy].filter(([name]) => name !== 'shop' && busy.get(name) === busy.get('shop'));
  assert.deepEqual(shared, []);
  assert.notEqual(busy.get('shop'), busy.get('rollouts'));
  assert.ok(![...busy].some(([name, slot]) => name !== 'rollouts' && slot === busy.get('rollouts')));
});
