import test from 'node:test';
import assert from 'node:assert/strict';
import { parseImage, shortImage, imageIdentity, workloadCell, helmCell, argoCell, splitChart, classify, buildRows, summarize, filterRows, sortRows, comparePair, fleetColumns, rowKey } from './fleet-core.js';

const deployment = (name, image, { namespace = 'shop', replicas = 2, ready = replicas, updated = replicas, containers, conditions } = {}) => ({
  metadata: { name, namespace },
  spec: { replicas, template: { spec: { containers: containers || [{ name: 'app', image }] } } },
  status: { readyReplicas: ready, updatedReplicas: updated, conditions },
});
const cells = (...list) => ({ cells: list });

test('image references: registries with ports, digests, Docker Hub defaults', () => {
  assert.deepEqual(
    (({ registry, path, name, tag, digest }) => ({ registry, path, name, tag, digest }))(parseImage('registry.example.com/shop/storefront:4.2.1')),
    { registry: 'registry.example.com', path: 'shop/storefront', name: 'storefront', tag: '4.2.1', digest: '' });
  const ported = parseImage('registry.local:5000/team/api:1.0');
  assert.equal(ported.registry, 'registry.local:5000');
  assert.equal(ported.path, 'team/api');
  assert.equal(ported.tag, '1.0');
  const portNoTag = parseImage('registry.local:5000/team/api');
  assert.equal(portNoTag.registry, 'registry.local:5000');
  assert.equal(portNoTag.tag, '', 'the port is not a tag');
  const pinned = parseImage('ghcr.io/org/app:2.1@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
  assert.equal(pinned.tag, '2.1');
  assert.equal(pinned.digest, 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
  const digestOnly = parseImage('registry.local:5000/app@sha256:feedface00000000');
  assert.equal(digestOnly.tag, '');
  assert.equal(digestOnly.registry, 'registry.local:5000');
  assert.equal(parseImage('nginx').canonical, 'library/nginx');
  assert.equal(parseImage('docker.io/library/nginx:1.27').canonical, 'library/nginx');
  assert.equal(parseImage('bitnami/redis:7').registry, '', 'an organisation is not a registry');
  assert.equal(parseImage('localhost/app:dev').registry, 'localhost');
});

test('short image text: tag, short digest, latest, long tags clipped', () => {
  assert.equal(shortImage('registry.example.com/shop/storefront:4.3.0-rc.2'), '4.3.0-rc.2');
  assert.equal(shortImage('nginx'), 'latest');
  assert.equal(shortImage('app@sha256:abcdef1234567890'), '@abcdef1');
  assert.equal(shortImage('app:1.0@sha256:abcdef1234567890'), '1.0@abcdef1');
  assert.equal(shortImage('app:0123456789abcdef0123456789abcdef01234567').length, 24);
});

test('image identity ignores the registry host but not the repository, tag or digest', () => {
  assert.equal(imageIdentity(parseImage('nginx')), imageIdentity(parseImage('docker.io/library/nginx:latest')));
  assert.equal(imageIdentity(parseImage('eu.gcr.io/shop/api:1')), imageIdentity(parseImage('us.gcr.io/shop/api:1')));
  assert.notEqual(imageIdentity(parseImage('shop/api:1')), imageIdentity(parseImage('shop/web:1')));
  assert.notEqual(imageIdentity(parseImage('shop/api:1')), imageIdentity(parseImage('shop/api:1@sha256:aa')));
});

test('workload cells: replicas, health per kind, CronJob images from the job template', () => {
  const healthy = workloadCell('Deployment', deployment('storefront', 'r.io/shop/storefront:4.2.1', { replicas: 5 }));
  assert.equal(healthy.replicas, '5/5');
  assert.equal(healthy.health, 'good');
  assert.equal(healthy.images[0].tag, '4.2.1');
  assert.equal(workloadCell('Deployment', deployment('x', 'a:1', { replicas: 2, ready: 0 })).health, 'bad');
  assert.equal(workloadCell('Deployment', deployment('x', 'a:1', { replicas: 3, ready: 1 })).health, 'warn');
  assert.equal(workloadCell('Deployment', deployment('x', 'a:1', { replicas: 0, ready: 0 })).health, 'idle');
  assert.equal(workloadCell('Deployment', deployment('x', 'a:1', { replicas: 2, ready: 2, updated: 1 })).health, 'warn', 'rolling out');
  assert.equal(workloadCell('Deployment', deployment('x', 'a:1', { conditions: [{ type: 'Progressing', reason: 'ProgressDeadlineExceeded' }] })).health, 'bad');
  assert.equal(workloadCell('Deployment', { metadata: { name: 'x' }, spec: { template: { spec: { containers: [] } } } }).replicas, '0/1', 'replicas default to 1');
  const ds = workloadCell('DaemonSet', { metadata: { name: 'edge', namespace: 'platform' }, spec: { template: { spec: { containers: [{ name: 'gw', image: 'gw:1' }] } } }, status: { desiredNumberScheduled: 3, numberReady: 3, updatedNumberScheduled: 3 } });
  assert.equal(ds.replicas, '3/3'); assert.equal(ds.health, 'good');
  const cron = workloadCell('CronJob', { metadata: { name: 'warm', namespace: 'shop' }, spec: { schedule: '*/5 * * * *', jobTemplate: { spec: { template: { spec: { containers: [{ name: 'job', image: 'base:1' }] } } } } }, status: {} });
  assert.equal(cron.images[0].tag, '1');
  assert.equal(cron.replicas, '*/5 * * * *');
  assert.equal(cron.desired, null);
  assert.equal(workloadCell('CronJob', { metadata: { name: 'w' }, spec: { suspend: true, jobTemplate: {} } }).health, 'idle');
  assert.equal(workloadCell('CronJob', { metadata: { name: 'w' }, spec: { jobTemplate: {} }, status: { lastScheduleTime: '2026-01-02T00:00:00Z', lastSuccessfulTime: '2026-01-01T00:00:00Z' } }).health, 'warn');
  const two = workloadCell('Deployment', deployment('x', '', { containers: [{ name: 'sidecar', image: 'proxy:2' }, { name: 'app', image: 'app:1' }] }));
  assert.equal(two.versionKey, 'app=library/app:1 sidecar=library/proxy:2', 'container order does not matter');
});

test('Helm and Argo CD cells', () => {
  assert.deepEqual(splitChart('shop-search-1.3.0'), { chart: 'shop-search', version: '1.3.0' });
  assert.deepEqual(splitChart('cert-manager-v1.14.2'), { chart: 'cert-manager', version: 'v1.14.2' });
  assert.deepEqual(splitChart('my-chart-2-1.0.0'), { chart: 'my-chart-2', version: '1.0.0' });
  assert.deepEqual(splitChart('app-1.0.0-rc-1'), { chart: 'app', version: '1.0.0-rc-1' });
  assert.deepEqual(splitChart('weird'), { chart: 'weird', version: '' });
  const release = helmCell({ name: 'search', namespace: 'data', chart: 'shop-search-1.3.0', app_version: '2.4.0', revision: 2, status: 'deployed' });
  assert.equal(release.chartVersion, '1.3.0'); assert.equal(release.appVersion, '2.4.0'); assert.equal(release.health, 'good'); assert.equal(release.scaleKey, '2');
  assert.equal(helmCell({ name: 'x', status: 'pending-upgrade' }).health, 'warn');
  assert.equal(helmCell({ name: 'x', status: 'failed' }).health, 'bad');
  const app = argoCell({ metadata: { name: 'payments', namespace: 'argocd' }, spec: { source: { targetRevision: 'main' } }, status: { sync: { status: 'OutOfSync', revision: 'a1b2c3d4e5f6a7b8' }, health: { status: 'Degraded' } } });
  assert.equal(app.shortRevision, 'a1b2c3d'); assert.equal(app.health, 'bad'); assert.equal(app.targetRevision, 'main');
  const synced = argoCell({ metadata: { name: 'payments', namespace: 'argocd' }, status: { sync: { status: 'Synced', revision: 'a1b2c3d4e5f6a7b8' }, health: { status: 'Healthy' } } });
  assert.notEqual(app.versionKey, synced.versionKey, 'out of sync at the same revision is running something else');
});

test('classification: drift beats missing beats scale; the majority is not highlighted', () => {
  const v = (versionKey, scaleKey = '2') => ({ versionKey, scaleKey });
  assert.equal(classify([v('a'), v('a')]).status, 'sync');
  const drift = classify([v('a'), v('b'), v('a')]);
  assert.equal(drift.status, 'drift'); assert.deepEqual(drift.drifted, [1]);
  assert.deepEqual(classify([v('a'), v('b')]).drifted, [0, 1], 'a tie marks every side');
  const missing = classify([v('a'), null, v('a')]);
  assert.equal(missing.status, 'missing'); assert.ok(missing.missing);
  assert.equal(classify([v('a'), null, v('b')]).status, 'drift');
  assert.ok(classify([v('a'), null, v('b')]).missing, 'flags are kept alongside the status');
  const scale = classify([v('a', '5'), v('a', '2')]);
  assert.equal(scale.status, 'scale'); assert.deepEqual(scale.scaled, [0, 1]);
  assert.equal(classify([v('a'), undefined]).status, 'sync', 'an unreadable cluster is neither missing nor different');
  assert.equal(classify([v('a')]).status, 'sync');
});

test('rows join clusters by kind/namespace/name and keep unknown clusters unknown', () => {
  const prod = cells(
    workloadCell('Deployment', deployment('storefront', 'r.io/shop/storefront:4.2.1', { replicas: 5 })),
    workloadCell('Deployment', deployment('fraud-check', 'r.io/payments/fraud-check:0.8.2', { namespace: 'payments', ready: 0 })),
    workloadCell('Deployment', deployment('cart', 'r.io/shop/cart:1.12.0', { replicas: 3 })),
    workloadCell('Deployment', deployment('canary', 'r.io/shop/canary:1')),
    workloadCell('CronJob', { metadata: { name: 'warm', namespace: 'shop' }, spec: { schedule: '@hourly', jobTemplate: { spec: { template: { spec: { containers: [{ name: 'job', image: 'base:1' }] } } } } } }));
  const staging = { cells: [
    workloadCell('Deployment', deployment('storefront', 'r.io/shop/storefront:4.3.0-rc.2', { replicas: 2 })),
    workloadCell('Deployment', deployment('fraud-check', 'r.io/payments/fraud-check:0.8.1', { namespace: 'payments' })),
    workloadCell('Deployment', deployment('cart', 'mirror.io/shop/cart:1.12.0', { replicas: 1 })),
  ], unknown: new Set(['CronJob']) };
  const rows = buildRows(['prod', 'staging'], { prod, staging });
  const find = name => rows.find(row => row.name === name);
  assert.equal(rows.length, 5);
  assert.equal(find('storefront').status, 'drift');
  assert.equal(find('storefront').key, rowKey('Deployment', 'shop', 'storefront'));
  assert.equal(find('fraud-check').status, 'drift');
  assert.equal(find('cart').status, 'scale', 'a registry mirror is the same image');
  assert.equal(find('canary').status, 'missing');
  assert.equal(find('canary').cells[1], null);
  assert.equal(find('warm').cells[1], undefined, 'CronJobs could not be listed in staging');
  assert.equal(find('warm').status, 'sync');
  assert.ok(find('storefront').text.includes('4.3.0-rc.2'));
  const failed = buildRows(['prod', 'staging'], { prod, staging: { cells: [], unknown: true } });
  assert.ok(failed.every(row => row.cells[1] === undefined && row.status === 'sync'));

  const summary = summarize(rows, ['prod', 'staging']);
  assert.deepEqual({ ...summary, pairs: undefined }, { total: 5, sync: 1, drift: 2, missing: 1, scale: 1, pairs: undefined });
  assert.deepEqual(summary.pairs, [{ left: 'prod', right: 'staging', same: 0, drift: 2, scale: 1, onlyLeft: 1, onlyRight: 0 }]);
  assert.equal(summarize(rows, ['prod']).pairs.length, 0);
  assert.equal(summarize(buildRows(['a', 'b', 'c'], { a: prod, b: prod, c: staging }), ['a', 'b', 'c']).pairs.length, 3);

  assert.deepEqual(filterRows(rows, { onlyDiff: true }).map(row => row.name).sort(), ['canary', 'cart', 'fraud-check', 'storefront']);
  assert.deepEqual(filterRows(rows, { namespace: 'payments' }).map(row => row.name), ['fraud-check']);
  assert.deepEqual(filterRows(rows, { kind: 'CronJob' }).map(row => row.name), ['warm']);
  assert.deepEqual(filterRows(rows, { text: 'rc.2' }).map(row => row.name), ['storefront']);
  assert.deepEqual(filterRows(rows, { text: 'SHOP store' }).map(row => row.name), ['storefront']);
  assert.deepEqual(filterRows(rows, { status: 'missing' }).map(row => row.name), ['canary']);

  assert.deepEqual(sortRows(rows).map(row => row.name), ['fraud-check', 'canary', 'cart', 'storefront', 'warm']);
  assert.deepEqual(sortRows(rows, 'drift').map(row => row.name), ['fraud-check', 'storefront', 'canary', 'cart', 'warm']);
});

test('compare pair picks the first two clusters that differ', () => {
  const v = (versionKey, scaleKey = '1') => ({ versionKey, scaleKey });
  assert.deepEqual(comparePair({ cells: [v('a'), v('a'), v('b')] }), [0, 2]);
  assert.deepEqual(comparePair({ cells: [null, v('a'), v('a', '3')] }), [1, 2]);
  assert.deepEqual(comparePair({ cells: [v('a'), v('a')] }), [0, 1]);
  assert.equal(comparePair({ cells: [v('a'), null, undefined] }), null);
});

test('columns: picked clusters, else the open tabs, only contexts that exist', () => {
  assert.deepEqual(fleetColumns(null, ['prod', 'staging', 'prod', ''], ['prod', 'staging', 'dev']), ['prod', 'staging']);
  assert.deepEqual(fleetColumns(['dev', 'gone', 'prod'], ['staging'], ['prod', 'staging', 'dev']), ['dev', 'prod']);
  assert.deepEqual(fleetColumns([], ['staging'], ['staging']), [], 'an explicit empty pick stays empty');
});
