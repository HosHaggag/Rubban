import test from 'node:test';
import assert from 'node:assert/strict';
import {
  roundCPU, roundMemory, cpuQuantity, memoryQuantity, percentile, normalizePrices, monthlyCost, formatMoney, formatPrice, podMatchesWorkload,
  createSampleStore, historyForWorkload, containerResources, recommendContainer, analyzeWorkload, recommendationText,
  strategicPatch, manifestFor, kubectlCommand, totals, byNamespace, largestNode, DEFAULT_PRICES, LAST_APPLIED, CPU_FLOOR, MEMORY_FLOOR,
} from './rightsizing-core.js';

const Mi = 2 ** 20; const Gi = 2 ** 30;
const container = (name, requests = {}, limits = {}) => ({ name, image: 'x', resources: { ...(Object.keys(requests).length ? { requests } : {}), ...(Object.keys(limits).length ? { limits } : {}) } });
const usageOf = (cpu, memory, extra = {}) => ({ cpu, memory, source: 'session', samples: 40, ...extra });

test('CPU rounds up to 10m, 50m and 100m steps with a floor', () => {
  assert.equal(roundCPU(0.0144), 0.02);
  assert.equal(roundCPU(0.1), 0.1);
  assert.equal(roundCPU(0.101), 0.15);
  assert.equal(roundCPU(0.96), 1);
  assert.equal(roundCPU(1.01), 1.1);
  assert.equal(roundCPU(0.001), CPU_FLOOR);
  assert.equal(roundCPU(0), CPU_FLOOR);
  assert.equal(roundCPU(NaN), CPU_FLOOR);
});

test('memory rounds up to 16Mi below 256Mi and 64Mi above, never below the floor', () => {
  assert.equal(roundMemory(20 * Mi), MEMORY_FLOOR);
  assert.equal(roundMemory(33 * Mi), 48 * Mi);
  assert.equal(roundMemory(256 * Mi), 256 * Mi);
  assert.equal(roundMemory(257 * Mi), 320 * Mi);
  assert.equal(roundMemory(0), MEMORY_FLOOR);
});

test('quantities are written the way people write them', () => {
  assert.equal(cpuQuantity(0.05), '50m');
  assert.equal(cpuQuantity(1), '1');
  assert.equal(cpuQuantity(1.5), '1500m');
  assert.equal(memoryQuantity(64 * Mi), '64Mi');
  assert.equal(memoryQuantity(2 * Gi), '2Gi');
  assert.equal(memoryQuantity(1.5 * Gi), '1536Mi');
});

test('percentile uses the nearest rank and ignores non-numbers', () => {
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(percentile([5, 1, NaN, 3], 50), 3);
  assert.ok(Number.isNaN(percentile([], 95)));
});

test('prices fall back to defaults when storage holds nonsense', () => {
  assert.deepEqual(normalizePrices(null), { ...DEFAULT_PRICES });
  assert.deepEqual(normalizePrices({ cpu: '0.05', memory: -1, currency: ' EUR ' }), { cpu: 0.05, memory: DEFAULT_PRICES.memory, currency: 'EUR' });
  assert.equal(normalizePrices({ cpu: 'abc' }).cpu, DEFAULT_PRICES.cpu);
});

test('monthly cost is cores and GiB times the hourly prices over 730 hours', () => {
  const cost = monthlyCost(2, 4 * Gi, { cpu: 0.031, memory: 0.004 });
  assert.ok(Math.abs(cost - (2 * 0.031 + 4 * 0.004) * 730) < 1e-9);
  assert.equal(monthlyCost(NaN, undefined, DEFAULT_PRICES), 0);
});

test('money is formatted with ISO codes or a free-form symbol', () => {
  assert.equal(formatMoney(12.5, 'USD'), '$12.50');
  assert.equal(formatMoney(1234.4, 'USD'), '$1,234');
  assert.equal(formatMoney(3, '€'), '€3.00');
  assert.equal(formatMoney(-3, 'kr'), '-kr 3.00');
  assert.equal(formatMoney(NaN), '—');
});

test('prices are shown with the precision they were entered with', () => {
  assert.equal(formatPrice(0.031, 'USD'), '$0.031');
  assert.equal(formatPrice(0.0045, 'EUR'), '€0.0045');
  assert.equal(formatPrice(2, 'USD'), '$2.00');
  assert.equal(formatPrice(0.004, '£'), '£0.004');
});

test('pods are matched to their controller by name', () => {
  assert.ok(podMatchesWorkload('Deployment', 'api', 'api-7d9f8b6c4-abcde'));
  assert.ok(!podMatchesWorkload('Deployment', 'api', 'api-v2-7d9f8b6c4-abcde'));
  assert.ok(!podMatchesWorkload('Deployment', 'api', 'api-0'));
  assert.ok(podMatchesWorkload('StatefulSet', 'db', 'db-12'));
  assert.ok(!podMatchesWorkload('StatefulSet', 'db', 'db-x'));
  assert.ok(podMatchesWorkload('DaemonSet', 'edge.gw', 'edge.gw-x7k2p'));
  assert.ok(!podMatchesWorkload('DaemonSet', 'edge.gw', 'edgeXgw-x7k2p'));
});

test('the session store keeps each scrape once and pools a workload\'s pods', () => {
  const store = createSampleStore();
  const snap = (stamp, a, b) => new Map([
    ['shop/cart-5f6d7c8b9-aaaaa', { timestamp: stamp, containers: new Map([['app', { cpu: a, memory: 40 * Mi }]]) }],
    ['shop/cart-5f6d7c8b9-bbbbb', { timestamp: stamp, containers: new Map([['app', { cpu: b, memory: 60 * Mi }]]) }],
    ['shop/cartography-0', { timestamp: stamp, containers: new Map([['app', { cpu: 9, memory: 9 * Gi }]]) }],
  ]);
  assert.equal(store.add('prod', snap('t1', 0.01, 0.02), 1000), 3);
  assert.equal(store.add('prod', snap('t1', 0.01, 0.02), 2000), 0, 'the same metrics-server sample is not counted twice');
  store.add('prod', snap('t2', 0.03, 0.012), 16000);
  const stats = store.forWorkload('prod', 'shop', 'Deployment', 'cart').get('app');
  assert.equal(stats.samples, 4);
  assert.equal(stats.cpu, 0.03, 'few samples: the peak stands in for the p95');
  assert.equal(stats.memory, 60 * Mi);
  assert.equal(stats.source, 'session');
  assert.equal(stats.since, 1000);
  assert.equal(store.forWorkload('stage', 'shop', 'Deployment', 'cart').size, 0, 'clusters are separate');
  assert.deepEqual(store.coverage('prod'), { since: 1000, until: 16000, pods: 3, refreshes: 2 });
});

test('the session store uses the p95 once there are enough samples and forgets old pods', () => {
  const store = createSampleStore({ maxAgeMs: 60_000 });
  for (let i = 1; i <= 100; i++) store.add('c', new Map([['ns/web-0', { timestamp: `t${i}`, containers: new Map([['app', { cpu: i / 1000, memory: i * Mi }]]) }]]), i * 100);
  const stats = store.forWorkload('c', 'ns', 'StatefulSet', 'web').get('app');
  assert.equal(stats.cpu, 0.095);
  assert.equal(stats.cpuPeak, 0.1);
  store.add('c', new Map([['ns/other-0', { timestamp: 'x', containers: new Map() }]]), 10_000 + 60_001);
  assert.equal(store.forWorkload('c', 'ns', 'StatefulSet', 'web').size, 0);
});

test('Prometheus rows fold into the busiest pod per container', () => {
  const rows = [
    { namespace: 'shop', pod: 'cart-5f6d7c8b9-aaaaa', container: 'app', cpu: 0.01, memory: 50 * Mi },
    { namespace: 'shop', pod: 'cart-6a7b8c9d-ccccc', container: 'app', cpu: 0.03, memory: 40 * Mi },
    { namespace: 'shop', pod: 'cart-6a7b8c9d-ccccc', container: 'proxy', cpu: 0.002, memory: null },
    { namespace: 'other', pod: 'cart-6a7b8c9d-ddddd', container: 'app', cpu: 5, memory: 5 * Gi },
  ];
  const history = historyForWorkload(rows, 'shop', 'Deployment', 'cart', 604800);
  assert.deepEqual(history.get('app'), { cpu: 0.03, memory: 50 * Mi, pods: 2, source: 'prometheus', window: 604800 });
  assert.equal(history.has('proxy'), false, 'a container without both numbers has no data');
});

test('a missing request defaults to the limit', () => {
  const spec = containerResources(container('a', {}, { cpu: '200m', memory: '128Mi' }));
  assert.equal(spec.request.cpu, 0.2);
  assert.equal(spec.request.memory, 128 * Mi);
  assert.ok(Number.isNaN(containerResources(container('b')).request.cpu));
});

test('an idle container with generous requests is over-provisioned', () => {
  const rec = recommendContainer(containerResources(container('app', { cpu: '120m', memory: '128Mi' }, { cpu: '250m', memory: '256Mi' })), usageOf(0.012, 20 * Mi));
  assert.equal(rec.status, 'over');
  assert.deepEqual(rec.next.request, { cpu: 0.02, memory: 32 * Mi });
  assert.deepEqual(rec.next.limit, { cpu: 0.25, memory: 256 * Mi }, 'limits above the new request are kept');
  assert.ok(rec.flags.includes('cpu-over') && rec.flags.includes('memory-over'));
});

test('a request in the band is left alone', () => {
  const rec = recommendContainer(containerResources(container('app', { cpu: '50m', memory: '64Mi' })), usageOf(0.03, 45 * Mi));
  assert.equal(rec.status, 'ok');
  assert.equal(rec.changed, false);
  assert.equal(rec.next, null);
});

test('only the resource that is off changes', () => {
  const rec = recommendContainer(containerResources(container('app', { cpu: '500m', memory: '64Mi' })), usageOf(0.05, 50 * Mi));
  assert.equal(rec.status, 'over');
  assert.equal(rec.next.request.cpu, 0.06);
  assert.equal(rec.next.request.memory, 64 * Mi);
});

test('usage above the request is under-provisioned and the limit follows the request up', () => {
  const rec = recommendContainer(containerResources(container('app', { cpu: '50m', memory: '64Mi' }, { cpu: '100m', memory: '128Mi' })), usageOf(0.2, 100 * Mi));
  assert.equal(rec.status, 'under');
  assert.equal(rec.next.request.cpu, 0.25);
  assert.equal(rec.next.limit.cpu >= rec.next.request.cpu, true);
  assert.ok(rec.flags.includes('throttle-risk'));
  assert.equal(rec.next.limit.cpu, 0.3, 'throttled: the limit gets room above the peak');
});

test('memory pressed against its limit is an OOM risk and gets room', () => {
  const rec = recommendContainer(containerResources(container('app', { memory: '128Mi', cpu: '50m' }, { memory: '128Mi' })), usageOf(0.03, 120 * Mi));
  assert.equal(rec.status, 'under');
  assert.ok(rec.flags.includes('oom-risk'));
  assert.equal(rec.next.request.memory, 144 * Mi);
  assert.equal(rec.next.limit.memory, 160 * Mi);
});

test('lowering the request of a Guaranteed container is called out', () => {
  const rec = recommendContainer(containerResources(container('app', { cpu: '100m', memory: '50Mi' }, { cpu: '100m', memory: '50Mi' })), usageOf(0.001, 20 * Mi));
  assert.equal(rec.status, 'over');
  assert.ok(rec.flags.includes('qos-change'));
  const kept = recommendContainer(containerResources(container('app', { cpu: '100m', memory: '50Mi' }, { cpu: '100m', memory: '50Mi' })), usageOf(0.07, 40 * Mi));
  assert.equal(kept.changed, false);
  assert.ok(!kept.flags.includes('qos-change'));
});

test('no requests: classified, and set from usage when there is some', () => {
  const none = recommendContainer(containerResources(container('app')), null);
  assert.equal(none.status, 'none');
  assert.equal(none.changed, false);
  const measured = recommendContainer(containerResources(container('app')), usageOf(0.004, 10 * Mi));
  assert.equal(measured.status, 'none');
  assert.deepEqual(measured.next.request, { cpu: CPU_FLOOR, memory: MEMORY_FLOOR });
});

test('a container without usage data is never changed', () => {
  const rec = recommendContainer(containerResources(container('app', { cpu: '2', memory: '4Gi' })), { cpu: NaN, memory: 10, source: 'prometheus' });
  assert.equal(rec.status, 'nodata');
  assert.equal(rec.changed, false);
});

const deployment = (containers, extra = {}) => ({ kind: 'Deployment', name: 'cart', namespace: 'shop', containers, pods: 3, replicas: 3, prices: DEFAULT_PRICES, ...extra });

test('a workload costs its requests times its scheduled pods and saves the difference', () => {
  const a = analyzeWorkload(deployment([container('app', { cpu: '120m', memory: '128Mi' })], { usage: new Map([['app', usageOf(0.012, 20 * Mi)]]) }));
  assert.equal(a.status, 'over');
  assert.ok(Math.abs(a.cost - monthlyCost(0.36, 384 * Mi, DEFAULT_PRICES)) < 1e-9);
  assert.ok(Math.abs(a.newCost - monthlyCost(0.06, 96 * Mi, DEFAULT_PRICES)) < 1e-9);
  assert.ok(a.savings > 0 && Math.abs(a.savings - (a.cost - a.newCost)) < 1e-9);
  assert.equal(a.applicable, true);
  assert.deepEqual(a.sources, ['session']);
  assert.equal(recommendationText(a), 'CPU 120m → 20m, memory 128Mi → 32Mi');
});

test('a workload asking for more than any node offers is flagged and left alone without data', () => {
  const node = largestNode([{ status: { allocatable: { cpu: '8', memory: '16Gi' } } }, { spec: { unschedulable: true }, status: { allocatable: { cpu: '64', memory: '256Gi' } } }]);
  assert.deepEqual(node, { cpu: 8, memory: 16 * Gi });
  const a = analyzeWorkload({ ...deployment([container('renderer', { cpu: '48', memory: '64Mi' }, { cpu: '48', memory: '128Mi' })]), pods: 0, replicas: 1, largestNode: node });
  assert.equal(a.status, 'over');
  assert.deepEqual(a.flags, ['exceeds-node']);
  assert.equal(a.applicable, false);
  assert.equal(a.cost, 0, 'pods that cannot be scheduled hold nothing yet');
  assert.ok(a.desiredCost > 1000);
  assert.equal(recommendationText(a, node), 'Cannot be scheduled: asks for 48 CPU per pod, the largest node offers 8');
});

test('a multi-container workload takes the worst status and names its containers', () => {
  const a = analyzeWorkload(deployment([container('app', { cpu: '500m', memory: '64Mi' }), container('proxy', { cpu: '10m', memory: '32Mi' })], { usage: new Map([['app', usageOf(0.05, 50 * Mi)], ['proxy', usageOf(0.05, 20 * Mi)]]) }));
  assert.equal(a.status, 'under');
  assert.equal(recommendationText(a), 'app: CPU 500m → 60m · proxy: CPU 10m → 60m');
  assert.equal(analyzeWorkload(deployment([container('app', { cpu: '50m', memory: '64Mi' })])).status, 'nodata');
  assert.equal(recommendationText(analyzeWorkload(deployment([container('app', { cpu: '50m', memory: '64Mi' })]))), 'No usage data yet');
  assert.equal(recommendationText(analyzeWorkload(deployment([container('app', { cpu: '50m', memory: '64Mi' })], { usage: new Map([['app', usageOf(0.04, 50 * Mi)]]) }))), 'Keep as is');
});

test('the patch, the manifest and the kubectl command carry only what changes', () => {
  const a = analyzeWorkload(deployment([container('app', { cpu: '500m', memory: '64Mi' }, { cpu: '1', memory: '128Mi' }), container('proxy', { cpu: '10m', memory: '32Mi' })], { usage: new Map([['app', usageOf(0.05, 50 * Mi)], ['proxy', usageOf(0.005, 20 * Mi)]]) }));
  assert.deepEqual(strategicPatch(a), { spec: { template: { spec: { containers: [{ name: 'app', resources: { requests: { cpu: '60m' } } }] } } } });
  assert.equal(kubectlCommand(a, { context: 'prod eu' }), "kubectl --context='prod eu' --namespace=shop set resources deployment/cart --containers=app --requests=cpu=60m");
  const live = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'cart', namespace: 'shop', uid: 'u', resourceVersion: '9' }, spec: { replicas: 3, template: { spec: { containers: [{ name: 'app', image: 'x' }] } } } };
  assert.deepEqual(manifestFor(live, a), { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'cart', namespace: 'shop' }, spec: { template: { spec: { containers: [{ name: 'app', resources: { requests: { cpu: '60m' } } }] } } } });
});

test('the manifest starts from the last-applied configuration so apply removes nothing', () => {
  const applied = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'cart', namespace: 'shop', labels: { app: 'cart' } }, spec: { replicas: 3, selector: { matchLabels: { app: 'cart' } }, template: { metadata: { labels: { app: 'cart' } }, spec: { containers: [{ name: 'app', image: 'cart:1', resources: { requests: { cpu: '500m', memory: '64Mi', 'ephemeral-storage': '1Gi' }, limits: { memory: '128Mi' } } }] } } } };
  const live = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'cart', namespace: 'shop', annotations: { [LAST_APPLIED]: JSON.stringify(applied) } } };
  const a = analyzeWorkload(deployment([container('app', { cpu: '500m', memory: '64Mi' }, { memory: '128Mi' })], { usage: new Map([['app', usageOf(0.05, 50 * Mi)]]) }));
  const manifest = manifestFor(live, a);
  const expected = JSON.parse(JSON.stringify(applied));
  expected.spec.template.spec.containers[0].resources.requests.cpu = '60m';
  assert.deepEqual(manifest, expected);
  assert.equal(applied.spec.template.spec.containers[0].resources.requests.cpu, '500m', 'the input is not mutated');
  // A broken or foreign annotation falls back to the bare object.
  live.metadata.annotations[LAST_APPLIED] = '{nope';
  assert.deepEqual(Object.keys(manifestFor(live, a).spec), ['template']);
});

test('totals and namespace groups add up', () => {
  const usage = new Map([['app', usageOf(0.012, 20 * Mi)]]);
  const list = [
    analyzeWorkload(deployment([container('app', { cpu: '120m', memory: '128Mi' })], { usage })),
    analyzeWorkload({ ...deployment([container('app', { cpu: '50m', memory: '64Mi' })], { usage: new Map([['app', usageOf(0.2, 50 * Mi)]]) }), name: 'orders', namespace: 'pay' }),
    analyzeWorkload({ ...deployment([container('app')]), name: 'bare', namespace: 'pay' }),
  ];
  const sum = totals(list);
  assert.equal(sum.workloads, 3);
  assert.deepEqual(sum.byStatus, { over: 1, under: 1, none: 1, ok: 0, nodata: 0 });
  assert.equal(sum.applicable, 2);
  assert.ok(Math.abs(sum.savings - (list[0].savings + list[1].savings)) < 1e-9);
  assert.ok(sum.added > 0 && sum.freed > 0);
  const groups = byNamespace(list);
  assert.deepEqual(groups.map(g => [g.namespace, g.workloads]), [['shop', 1], ['pay', 2]]);
});
