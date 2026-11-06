import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, layoutGraph, connectedPath, neighbourhood, matchNodes, summarizeNamespaces, serviceSelects, labelSelectorMatches, podHealth, podSpecRefs, ingressBackends, countCrossings, nodeId, nodeHeight } from './topology-core.js';

const NS = 'shop';
const meta = (name, extra = {}) => ({ name, namespace: NS, uid: `uid-${name}`, ...extra });
const owner = (kind, name) => ({ ownerReferences: [{ kind, name, controller: true, uid: `uid-${name}` }] });
const running = { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ name: 'app', ready: true, state: { running: {} } }] };
const crashing = { phase: 'Running', conditions: [{ type: 'Ready', status: 'False' }], containerStatuses: [{ name: 'app', ready: false, state: { waiting: { reason: 'CrashLoopBackOff' } } }] };
const deployment = (name, labels, spec = {}, status = { readyReplicas: 2 }) => ({ kind: 'Deployment', metadata: meta(name), spec: { replicas: 2, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: { containers: [{ name: 'app' }], ...spec } } }, status });
const rs = (name, deploy) => ({ kind: 'ReplicaSet', metadata: meta(name, owner('Deployment', deploy)) });
const pod = (name, rsName, labels, status = running) => ({ kind: 'Pod', metadata: meta(name, { labels, ...(rsName ? owner('ReplicaSet', rsName) : {}) }), status });
const service = (name, selector) => ({ kind: 'Service', metadata: meta(name), spec: { type: 'ClusterIP', selector, ports: [{ port: 80, protocol: 'TCP' }] } });
const ingress = (name, rules, tls) => ({ kind: 'Ingress', metadata: meta(name), spec: { rules: rules.map(([host, service, path = '/']) => ({ host, http: { paths: [{ path, backend: { service: { name: service, port: { number: 80 } } } }] } })), ...(tls ? { tls } : {}) } });
const configmap = name => ({ kind: 'ConfigMap', metadata: meta(name), data: { a: '1' } });
const secret = (name, type = 'Opaque') => ({ kind: 'Secret', metadata: meta(name), type });

function shop() {
  return {
    ingresses: [ingress('storefront', [['shop.example.com', 'storefront'], ['api.example.com', 'api']])],
    services: [service('storefront', { app: 'storefront' }), service('cart', { app: 'cart' }), service('ghost', { app: 'nothing-has-this' })],
    deployments: [
      deployment('storefront', { app: 'storefront' }, { volumes: [{ name: 'c', configMap: { name: 'storefront-config' } }], containers: [{ name: 'app', envFrom: [{ secretRef: { name: 'storefront-secrets' } }] }] }),
      deployment('cart', { app: 'cart' }, { containers: [{ name: 'app', env: [{ name: 'X', valueFrom: { configMapKeyRef: { name: 'cart-config', key: 'x' } } }, { name: 'Y', valueFrom: { configMapKeyRef: { name: 'optional-config', key: 'y', optional: true } } }] }] }, { readyReplicas: 0 }),
    ],
    replicasets: [rs('storefront-abc', 'storefront'), rs('cart-def', 'cart')],
    pods: [
      pod('storefront-abc-1', 'storefront-abc', { app: 'storefront' }), pod('storefront-abc-2', 'storefront-abc', { app: 'storefront' }),
      pod('cart-def-1', 'cart-def', { app: 'cart' }, crashing), pod('cart-def-2', 'cart-def', { app: 'cart' }, crashing),
    ],
    configmaps: [configmap('storefront-config'), configmap('unused-config'), configmap('kube-root-ca.crt')],
    secrets: [secret('storefront-secrets'), secret('sh.helm.release.v1.x', 'helm.sh/release.v1')],
    persistentvolumeclaims: [{ kind: 'PersistentVolumeClaim', metadata: meta('orphan-data'), status: { phase: 'Pending' }, spec: {} }],
    horizontalpodautoscalers: [{ kind: 'HorizontalPodAutoscaler', metadata: meta('storefront'), spec: { minReplicas: 2, maxReplicas: 10, scaleTargetRef: { kind: 'Deployment', name: 'storefront' } }, status: { currentReplicas: 2 } }],
    poddisruptionbudgets: [{ kind: 'PodDisruptionBudget', metadata: meta('storefront'), spec: { minAvailable: 1, selector: { matchLabels: { app: 'storefront' } } }, status: { disruptionsAllowed: 1, expectedPods: 2 } }],
    statefulsets: [], daemonsets: [], cronjobs: [], jobs: [],
  };
}
const id = (kind, name) => nodeId(kind, NS, name);
const edgeIds = graph => new Set(graph.edges.map(edge => edge.id));
const node = (graph, kind, name) => graph.nodes.find(n => n.id === id(kind, name));

test('selectors: Service maps and LabelSelectors with expressions', () => {
  assert.equal(serviceSelects({ app: 'a' }, { app: 'a', tier: 'web' }), true);
  assert.equal(serviceSelects({ app: 'a', tier: 'db' }, { app: 'a', tier: 'web' }), false);
  assert.equal(serviceSelects({}, { app: 'a' }), false, 'an empty Service selector selects nothing');
  assert.equal(labelSelectorMatches({}, { app: 'a' }), true, 'an empty LabelSelector selects everything');
  assert.equal(labelSelectorMatches(undefined, { app: 'a' }), false);
  const selector = { matchLabels: { app: 'a' }, matchExpressions: [{ key: 'tier', operator: 'In', values: ['web', 'api'] }, { key: 'canary', operator: 'DoesNotExist' }] };
  assert.equal(labelSelectorMatches(selector, { app: 'a', tier: 'api' }), true);
  assert.equal(labelSelectorMatches(selector, { app: 'a', tier: 'db' }), false);
  assert.equal(labelSelectorMatches(selector, { app: 'a', tier: 'web', canary: 'yes' }), false);
  assert.equal(labelSelectorMatches({ matchExpressions: [{ key: 'tier', operator: 'NotIn', values: ['db'] }, { key: 'app', operator: 'Exists' }] }, { app: 'x', tier: 'web' }), true);
});

test('pod health: ready, failing, pending and finished', () => {
  assert.equal(podHealth({ status: running }), 'good');
  assert.equal(podHealth({ status: crashing }), 'bad');
  assert.equal(podHealth({ status: { phase: 'Pending' } }), 'warn');
  assert.equal(podHealth({ status: { phase: 'Succeeded' } }), 'good');
  assert.equal(podHealth({ status: { phase: 'Pending', containerStatuses: [{ state: { waiting: { reason: 'ImagePullBackOff' } } }] } }), 'bad');
  assert.equal(podHealth({ status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'False' }], containerStatuses: [{ ready: false, state: { running: {} } }] } }), 'warn');
});

test('pod spec references: volumes, projected, env, envFrom, image pull secrets', () => {
  const refs = podSpecRefs({
    volumes: [{ configMap: { name: 'a' } }, { secret: { secretName: 'b', optional: true } }, { persistentVolumeClaim: { claimName: 'c' } }, { projected: { sources: [{ configMap: { name: 'd' } }, { secret: { name: 'e' } }] } }],
    initContainers: [{ envFrom: [{ configMapRef: { name: 'f' } }] }],
    containers: [{ env: [{ valueFrom: { secretKeyRef: { name: 'g' } } }, { value: 'plain' }] }],
    imagePullSecrets: [{ name: 'regcred' }],
  });
  assert.deepEqual(refs.map(r => `${r.kind}:${r.name}:${r.how}${r.optional ? ':optional' : ''}`), ['ConfigMap:a:volume', 'Secret:b:volume:optional', 'PersistentVolumeClaim:c:volume', 'ConfigMap:d:volume', 'Secret:e:volume', 'ConfigMap:f:envFrom', 'Secret:g:env', 'Secret:regcred:image pull']);
  assert.deepEqual(ingressBackends({ spec: { defaultBackend: { service: { name: 'fallback', port: { number: 8080 } } }, rules: [{ host: 'a.example', http: { paths: [{ path: '/x', backend: { serviceName: 'legacy', servicePort: 80 } }] } }] } }),
    [{ service: 'fallback', port: 8080, host: '*', path: '' }, { service: 'legacy', port: 80, host: 'a.example', path: '/x' }]);
});

test('edges follow selectors, backends, scale targets, budgets and config references', () => {
  const graph = buildGraph(shop());
  const edges = edgeIds(graph);
  for (const [from, to] of [
    [id('Ingress', 'storefront'), id('Service', 'storefront')],
    [id('Service', 'storefront'), id('Deployment', 'storefront')],
    [id('Service', 'cart'), id('Deployment', 'cart')],
    [id('Deployment', 'storefront'), id('ConfigMap', 'storefront-config')],
    [id('Deployment', 'storefront'), id('Secret', 'storefront-secrets')],
    [id('HorizontalPodAutoscaler', 'storefront'), id('Deployment', 'storefront')],
    [id('PodDisruptionBudget', 'storefront'), id('Deployment', 'storefront')],
  ]) assert.ok(edges.has(`${from}->${to}`), `${from} -> ${to}`);
  assert.ok(!edges.has(`${id('Service', 'storefront')}->${id('Deployment', 'cart')}`), 'selectors do not cross workloads');
  // ReplicaSets fold into their Deployment: pods are dots on the Deployment, no ReplicaSet node.
  assert.equal(graph.nodes.filter(n => n.kind === 'ReplicaSet' || n.kind === 'Pod').length, 0);
  assert.equal(node(graph, 'Deployment', 'storefront').pods.total, 2);
  assert.deepEqual(node(graph, 'Deployment', 'storefront').item.metadata.name, 'storefront');
  assert.equal(node(graph, 'Deployment', 'storefront').layer, 2);
  assert.equal(node(graph, 'Ingress', 'storefront').layer, 0);
});

test('health: failing workloads, Services without ready pods, tinted edges', () => {
  const graph = buildGraph(shop());
  assert.equal(node(graph, 'Deployment', 'storefront').health, 'good');
  assert.equal(node(graph, 'Deployment', 'cart').health, 'bad');
  assert.equal(node(graph, 'Deployment', 'cart').pods.bad, 2);
  assert.equal(node(graph, 'Service', 'cart').health, 'bad', 'no ready pods behind the Service');
  assert.equal(node(graph, 'Service', 'ghost').health, 'bad');
  assert.equal(node(graph, 'Service', 'ghost').status, 'selects no pods');
  assert.equal(node(graph, 'Service', 'storefront').health, 'good');
  assert.equal(graph.edges.find(e => e.id === `${id('Service', 'cart')}->${id('Deployment', 'cart')}`).tone, 'bad');
  assert.equal(graph.edges.find(e => e.id === `${id('Service', 'storefront')}->${id('Deployment', 'storefront')}`).tone, '');
  assert.equal(node(graph, 'PersistentVolumeClaim', 'orphan-data').health, 'warn');
  // One backend of two is missing: the Ingress is degraded, not down.
  assert.equal(node(graph, 'Ingress', 'storefront').health, 'warn');
});

test('references to objects that do not exist become missing nodes and issues', () => {
  const graph = buildGraph(shop());
  const missingService = node(graph, 'Service', 'api');
  assert.ok(missingService?.missing, 'ingress backend api is missing');
  assert.equal(missingService.health, 'missing');
  assert.deepEqual(missingService.referrers, [id('Ingress', 'storefront')]);
  assert.ok(graph.edges.find(e => e.to === missingService.id).missing);
  assert.ok(node(graph, 'ConfigMap', 'cart-config')?.missing, 'env valueFrom a ConfigMap that does not exist');
  assert.equal(node(graph, 'ConfigMap', 'optional-config'), undefined, 'optional references are not bugs');
  const texts = graph.issues.map(issue => issue.text);
  assert.ok(texts.includes('Ingress storefront routes to Service api, which does not exist'), texts.join('\n'));
  assert.ok(texts.includes('Deployment cart uses ConfigMap cart-config, which does not exist'));
  assert.ok(texts.includes('Service ghost selects no pods'));
  // Without the Secret list (not permitted), references to Secrets are drawn but never "missing".
  const data = shop(); delete data.secrets;
  data.deployments[0].spec.template.spec.imagePullSecrets = [{ name: 'regcred' }];
  const partial = buildGraph(data);
  assert.equal(node(partial, 'Secret', 'regcred').missing, false);
  assert.equal(node(partial, 'Secret', 'regcred').unverified, true);
  // An HPA whose target is gone.
  const lost = shop(); lost.horizontalpodautoscalers[0].spec.scaleTargetRef.name = 'gone';
  assert.ok(node(buildGraph(lost), 'Deployment', 'gone').missing);
});

test('unreferenced and system config is hidden unless asked for', () => {
  const graph = buildGraph(shop());
  assert.equal(node(graph, 'ConfigMap', 'unused-config'), undefined);
  assert.equal(node(graph, 'ConfigMap', 'kube-root-ca.crt'), undefined);
  assert.equal(graph.hiddenUnreferenced, 1);
  assert.ok(node(graph, 'PersistentVolumeClaim', 'orphan-data'), 'volume claims always show');
  const all = buildGraph(shop(), { showUnreferenced: true });
  assert.ok(node(all, 'ConfigMap', 'unused-config').unused);
  assert.equal(node(all, 'ConfigMap', 'kube-root-ca.crt'), undefined, 'system config stays hidden');
  assert.equal(node(all, 'Secret', 'sh.helm.release.v1.x'), undefined);
  assert.ok(node(buildGraph(shop(), { include: id('ConfigMap', 'kube-root-ca.crt') }), 'ConfigMap', 'kube-root-ca.crt'), 'include forces one in (drawer map)');
});

test('CronJobs fold their Jobs, StatefulSets link their claim PVCs, bare pods stand alone', () => {
  const data = {
    cronjobs: [{ kind: 'CronJob', metadata: meta('warmer'), spec: { schedule: '*/15 * * * *', jobTemplate: { spec: { template: { metadata: { labels: { app: 'warmer' } }, spec: { containers: [{ name: 'c', envFrom: [{ configMapRef: { name: 'warm' } }] }] } } } } } }],
    jobs: [
      { kind: 'Job', metadata: meta('warmer-1', { ...owner('CronJob', 'warmer'), creationTimestamp: '2026-01-01T00:00:00Z' }), status: { conditions: [{ type: 'Complete', status: 'True' }] } },
      { kind: 'Job', metadata: meta('warmer-2', { ...owner('CronJob', 'warmer'), creationTimestamp: '2026-01-01T00:15:00Z' }), status: { conditions: [{ type: 'Failed', status: 'True' }] } },
      { kind: 'Job', metadata: meta('migrate'), spec: { template: { metadata: { labels: {} }, spec: {} } }, status: { conditions: [{ type: 'Complete', status: 'True' }] } },
    ],
    statefulsets: [{ kind: 'StatefulSet', metadata: meta('db'), spec: { replicas: 1, template: { metadata: { labels: { app: 'db' } }, spec: {} }, volumeClaimTemplates: [{ metadata: { name: 'data' } }] }, status: { readyReplicas: 1 } }],
    persistentvolumeclaims: [{ kind: 'PersistentVolumeClaim', metadata: meta('data-db-0'), status: { phase: 'Bound' }, spec: {} }],
    pods: [pod('debug', null, { run: 'debug' }), { kind: 'Pod', metadata: meta('warmer-2-x', { labels: { app: 'warmer' }, ...owner('Job', 'warmer-2') }), status: { phase: 'Failed' } }],
    configmaps: [{ kind: 'ConfigMap', metadata: meta('warm') }],
    deployments: [], daemonsets: [], replicasets: [], services: [], ingresses: [], secrets: [], horizontalpodautoscalers: [], poddisruptionbudgets: [],
  };
  const graph = buildGraph(data);
  assert.equal(node(graph, 'Job', 'warmer-1'), undefined, 'jobs of a CronJob are folded into it');
  assert.equal(node(graph, 'CronJob', 'warmer').health, 'bad', 'last run failed');
  assert.equal(node(graph, 'CronJob', 'warmer').pods.total, 1);
  assert.ok(node(graph, 'Job', 'migrate'));
  assert.ok(node(graph, 'Pod', 'debug'));
  assert.ok(edgeIds(graph).has(`${id('StatefulSet', 'db')}->${id('PersistentVolumeClaim', 'data-db-0')}`));
  assert.ok(edgeIds(graph).has(`${id('CronJob', 'warmer')}->${id('ConfigMap', 'warm')}`));
});

test('blast radius: a ConfigMap lights every workload, Service and Ingress that depends on it', () => {
  const graph = buildGraph(shop());
  const path = connectedPath(graph, id('ConfigMap', 'storefront-config'));
  for (const expected of [id('Deployment', 'storefront'), id('Service', 'storefront'), id('Ingress', 'storefront'), id('HorizontalPodAutoscaler', 'storefront')]) assert.ok(path.nodes.has(expected), expected);
  assert.ok(!path.nodes.has(id('Secret', 'storefront-secrets')), 'siblings are not upstream or downstream');
  assert.ok(!path.nodes.has(id('Deployment', 'cart')));
  const near = neighbourhood(graph, id('Service', 'storefront'));
  assert.ok(near.nodes.some(n => n.id === id('PodDisruptionBudget', 'storefront')), 'policies on the workload are included');
  assert.ok(!near.nodes.some(n => n.id === id('Service', 'cart')));
  assert.deepEqual([...matchNodes(graph, 'shop.example')], [id('Ingress', 'storefront')]);
});

test('namespace chooser summary counts workloads, pods and the worst health', () => {
  const data = shop();
  data.deployments.push({ ...deployment('worker', { app: 'worker' }), metadata: { name: 'worker', namespace: 'jobs', uid: 'w' } });
  const rows = summarizeNamespaces(data, ['empty', 'kube-system']);
  const shopRow = rows.find(row => row.namespace === NS);
  assert.equal(shopRow.workloads, 2);
  assert.equal(shopRow.pods, 4);
  assert.equal(shopRow.worst, 'bad');
  assert.deepEqual(shopRow.health, { good: 1, warn: 0, bad: 1 });
  assert.equal(rows.find(row => row.namespace === 'empty').workloads, 0);
  assert.equal(rows.at(-1).namespace, 'kube-system', 'system namespaces last');
});

function overlaps(layout) {
  const out = [];
  for (let i = 0; i < layout.nodes.length; i++) for (let j = i + 1; j < layout.nodes.length; j++) {
    const a = layout.nodes[i]; const b = layout.nodes[j];
    if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) out.push(`${a.id} / ${b.id}`);
  }
  return out;
}
function bigNamespace(count) {
  const data = { ingresses: [], services: [], deployments: [], replicasets: [], pods: [], configmaps: [configmap('shared')], secrets: [], persistentvolumeclaims: [], horizontalpodautoscalers: [], poddisruptionbudgets: [], statefulsets: [], daemonsets: [], cronjobs: [], jobs: [] };
  for (let i = 0; i < count; i++) {
    const name = `svc-${i}`;
    data.deployments.push(deployment(name, { app: name }, { volumes: [{ configMap: { name: i % 3 ? 'shared' : `own-${i}` } }] }));
    data.services.push(service(name, { app: name }));
    data.configmaps.push(configmap(`own-${i}`));
    if (i % 4 === 0) data.ingresses.push(ingress(`ing-${i}`, [[`h${i}.example`, name], [`x${i}.example`, `svc-${(i + 5) % count}`]], [{ secretName: `tls-${i}`, hosts: [`h${i}.example`] }]));
    data.pods.push(pod(`${name}-a`, null, { app: name }));
  }
  data.configmaps.push(configmap('lonely'));
  return data;
}
const shuffle = (list, seed) => { const out = [...list]; let s = seed; for (let i = out.length - 1; i > 0; i--) { s = (s * 9301 + 49297) % 233280; const j = Math.floor((s / 233280) * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; } return out; };

test('layout is layered left to right with no overlapping nodes', () => {
  for (const data of [shop(), bigNamespace(24)]) {
    const graph = buildGraph(data, { showUnreferenced: true });
    const layout = layoutGraph(graph);
    assert.deepEqual(overlaps(layout), []);
    for (const n of layout.nodes) {
      assert.equal(n.x, layout.columnX(n.layer));
      assert.equal(n.h, nodeHeight(n));
      assert.ok(Number.isFinite(n.y) && n.y >= 0, `${n.id} y=${n.y}`);
    }
    for (const edge of layout.edges) {
      const from = layout.nodes.find(n => n.id === edge.from); const to = layout.nodes.find(n => n.id === edge.to);
      assert.ok(edge.points.length >= 2);
      assert.equal(edge.points[0][0], from.x + from.w);
      assert.equal(edge.points.at(-1)[0], to.x);
      for (let i = 1; i < edge.points.length; i++) assert.ok(edge.points[i][0] >= edge.points[i - 1][0], 'edges run left to right');
    }
    assert.ok(layout.height >= Math.max(...layout.nodes.map(n => n.y + n.h)));
  }
});

test('layout is deterministic whatever order the lists arrive in', () => {
  const data = bigNamespace(16);
  const first = JSON.stringify(layoutGraph(buildGraph(data)).nodes.map(n => [n.id, n.x, n.y]));
  for (const seed of [1, 7, 42]) {
    const shuffled = Object.fromEntries(Object.entries(data).map(([key, items]) => [key, shuffle(items, seed)]));
    const again = layoutGraph(buildGraph(shuffled));
    assert.equal(JSON.stringify(again.nodes.map(n => [n.id, n.x, n.y])), first);
  }
});

test('crossing reduction untangles a simple crossed pair', () => {
  assert.equal(countCrossings([[0, 1], [1, 0]]), 1);
  assert.equal(countCrossings([[0, 0], [1, 1]]), 0);
  // Two services whose workloads would start in the opposite order.
  const data = { services: [service('a', { app: 'z' }), service('b', { app: 'y' })], deployments: [deployment('y', { app: 'y' }), deployment('z', { app: 'z' })], pods: [], replicasets: [] };
  const layout = layoutGraph(buildGraph(data));
  const y = name => layout.nodes.find(n => n.name === name && n.kind !== 'Service').y;
  const sy = name => layout.nodes.find(n => n.name === name && n.kind === 'Service').y;
  assert.equal(Math.sign(sy('a') - sy('b')), Math.sign(y('z') - y('y')), 'edges do not cross');
  // A lone node next to its neighbour sits level with it.
  const pair = layoutGraph(buildGraph({ services: [service('a', { app: 'a' })], deployments: [deployment('a', { app: 'a' })], pods: [] }));
  const [svc, dep] = [pair.nodes.find(n => n.kind === 'Service'), pair.nodes.find(n => n.kind === 'Deployment')];
  assert.equal(svc.y + svc.h / 2, dep.y + dep.h / 2);
});
