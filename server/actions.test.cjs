'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBackend } = require('./core.cjs');

// Exercise the actual authenticated backend and live HTTP transport without a user's cluster.
async function fixture(t, { kind = 'storageclasses', items = [], rejectAnnotation = false, evictionStatus = 201 } = {}) {
  const requests = []; const commands = [];
  const group = kind === 'storageclasses' ? 'storage.k8s.io' : 'networking.k8s.io';
  const objectKind = kind === 'storageclasses' ? 'StorageClass' : 'IngressClass';
  const send = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  const api = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    const url = new URL(req.url, 'http://fixture');
    requests.push({ method: req.method, path: url.pathname, body });
    if (url.pathname.endsWith('/eviction')) return send(res, evictionStatus, evictionStatus === 201
      ? { kind: 'Status', status: 'Success' }
      : { kind: 'Status', reason: 'TooManyRequests', message: 'Cannot evict pod as it would violate the disruption budget.' });
    if (url.pathname === '/api') return send(res, 200, { kind: 'APIGroupDiscoveryList', items: [] });
    if (url.pathname === '/apis') return send(res, 200, { kind: 'APIGroupDiscoveryList', items: [{ metadata: { name: group }, versions: [{ version: 'v1', resources: [{ resource: kind, scope: 'Cluster', responseKind: { group, version: 'v1', kind: objectKind }, verbs: ['get', 'list', 'watch'] }] }] }] });
    if (url.pathname === `/apis/${group}/v1/${kind}`) return send(res, 200, { apiVersion: `${group}/v1`, kind: `${objectKind}List`, metadata: { resourceVersion: '1' }, items });
    return send(res, 404, { kind: 'Status', message: 'Test endpoint not found' });
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubban-actions-'));
  const backend = createBackend({ dataDir, kubectlPath: 'fixture-kubectl',
    proxyFactory: () => ({ baseUrl: `http://127.0.0.1:${api.address().port}`, close() {} }),
    runner: async (_command, args) => {
      commands.push(args);
      return rejectAnnotation ? { code: 1, stdout: '', stderr: 'annotation forbidden' } : { code: 0, stdout: `${args[3]} annotated`, stderr: '' };
    },
  });
  const connection = await backend.start();
  t.after(async () => { await backend.close(); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const post = async (route, body) => {
    const response = await fetch(connection.url + route, { method: 'POST', headers: { 'X-Rubban-Token': connection.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ context: 'fixture', ...body }) });
    return { status: response.status, body: await response.json() };
  };
  return { post, requests, commands };
}

test('pod eviction sends policy/v1 to the selected namespace and preserves disruption-budget errors', async t => {
  const f = await fixture(t);
  const response = await f.post('/api/evict', { namespace: 'apps', name: 'debug-shell' });
  assert.equal(response.status, 200);
  assert.match(response.body.output, /debug-shell evicted/);
  assert.deepEqual(f.requests, [{ method: 'POST', path: '/api/v1/namespaces/apps/pods/debug-shell/eviction', body: { apiVersion: 'policy/v1', kind: 'Eviction', metadata: { name: 'debug-shell', namespace: 'apps' } } }]);
  assert.equal(f.commands.length, 0);
  const refused = await fixture(t, { evictionStatus: 429 });
  const error = await refused.post('/api/evict', { namespace: 'apps', name: 'protected' });
  assert.equal(error.status, 429);
  assert.match(error.body.error, /disruption budget/);
});

test('eviction rejects malformed names before reaching the cluster', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/api/evict', { namespace: 'apps', name: '-bad' })).status, 400);
  assert.equal(f.requests.length, 0);
});

test('setting a storage default enables the target before clearing current and legacy defaults', async t => {
  const key = 'storageclass.kubernetes.io/is-default-class';
  const beta = 'storageclass.beta.kubernetes.io/is-default-class';
  const f = await fixture(t, { items: [
    { metadata: { name: 'old', annotations: { [key]: 'true' } } },
    { metadata: { name: 'legacy', annotations: { [beta]: 'true' } } },
    { metadata: { name: 'fast' } },
    { metadata: { name: 'unused' } },
  ] });
  assert.equal((await f.post('/api/default-class', { kind: 'storageclasses', name: 'fast' })).status, 200);
  assert.deepEqual(f.commands, [
    ['--context=fixture', 'annotate', 'storageclasses', 'fast', `${key}=true`, '--overwrite'],
    ['--context=fixture', 'annotate', 'storageclasses', 'old', `${key}=false`, '--overwrite'],
    ['--context=fixture', 'annotate', 'storageclasses', 'legacy', `${key}=false`, '--overwrite', `${beta}-`],
  ]);
});

test('a rejected new default never clears the old default', async t => {
  const key = 'storageclass.kubernetes.io/is-default-class';
  const f = await fixture(t, { rejectAnnotation: true, items: [{ metadata: { name: 'old', annotations: { [key]: 'true' } } }, { metadata: { name: 'fast' } }] });
  const response = await f.post('/api/default-class', { kind: 'storageclasses', name: 'fast' });
  assert.equal(response.status, 502);
  assert.match(response.body.error, /annotation forbidden/);
  assert.equal(f.commands.length, 1);
  assert.equal(f.commands[0][3], 'fast');
});

test('a missing default target makes no writes; an existing sole default is a no-op', async t => {
  const key = 'storageclass.kubernetes.io/is-default-class';
  const f = await fixture(t, { items: [{ metadata: { name: 'fast', annotations: { [key]: 'true' } } }] });
  assert.equal((await f.post('/api/default-class', { kind: 'storageclasses', name: 'missing' })).status, 404);
  const response = await f.post('/api/default-class', { kind: 'storageclasses', name: 'fast' });
  assert.equal(response.status, 200);
  assert.match(response.body.output, /already the default/);
  assert.equal(f.commands.length, 0);
});

test('IngressClass defaults use their own annotation, including the legacy endpoint', async t => {
  const key = 'ingressclass.kubernetes.io/is-default-class';
  for (const route of ['/api/default-class', '/api/ingressclass-default']) {
    const f = await fixture(t, { kind: 'ingressclasses', items: [{ metadata: { name: 'public' } }] });
    assert.equal((await f.post(route, { kind: 'ingressclasses', name: 'public' })).status, 200);
    assert.deepEqual(f.commands, [['--context=fixture', 'annotate', 'ingressclasses', 'public', `${key}=true`, '--overwrite']]);
  }
});
