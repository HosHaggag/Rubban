'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { WebSocket } = require('ws');
const { createBackend } = require('./core.cjs');
const { resolveResource } = require('./live.cjs');

// A small in-memory Kubernetes API: aggregated discovery, paginated lists and
// streaming watches with bookmarks/410 errors. It stands in for the per-context
// proxy so the real HTTP/WebSocket transport is exercised without a cluster.
function fakeKubernetes() {
  const store = new Map();
  const watchers = new Set();
  const history = [];
  const requests = [];
  const flags = { goneOnNextWatch: false, forbidden: new Set() };
  let rv = 100;
  const resource = (name, kind, scope = 'Namespaced', verbs = ['get', 'list', 'watch', 'create', 'delete']) =>
    ({ resource: name, responseKind: { group: '', version: 'v1', kind }, scope, singularResource: kind.toLowerCase(), verbs });
  const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const keyOf = object => `${object.kind}/${object.metadata.namespace || ''}/${object.metadata.name}`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fake');
    requests.push(url.pathname + url.search);
    if (url.pathname === '/api') {
      return send(res, 200, { kind: 'APIGroupDiscoveryList', apiVersion: 'apidiscovery.k8s.io/v2', items: [{ metadata: {}, versions: [{ version: 'v1', resources: [
        resource('configmaps', 'ConfigMap'), resource('secrets', 'Secret'), resource('events', 'Event'),
        resource('namespaces', 'Namespace', 'Cluster'), resource('pods', 'Pod'),
      ] }] }] });
    }
    if (url.pathname === '/apis') {
      return send(res, 200, { kind: 'APIGroupDiscoveryList', apiVersion: 'apidiscovery.k8s.io/v2', items: [
        { metadata: { name: 'apps' }, versions: [{ version: 'v1', resources: [{ ...resource('deployments', 'Deployment'), responseKind: { group: 'apps', version: 'v1', kind: 'Deployment' }, shortNames: ['deploy'] }] }] },
        { metadata: { name: 'events.k8s.io' }, versions: [{ version: 'v1', resources: [resource('events', 'Event')] }] },
      ] });
    }
    const match = /^\/api\/v1\/(?:namespaces\/([^/]+)\/)?(configmaps|secrets|events|namespaces)(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match) return send(res, 404, { kind: 'Status', code: 404, message: 'the server could not find the requested resource' });
    const [, namespace, plural, name] = match;
    const kind = { configmaps: 'ConfigMap', secrets: 'Secret', events: 'Event', namespaces: 'Namespace' }[plural];
    if (flags.forbidden.has(plural)) return send(res, 403, { kind: 'Status', code: 403, reason: 'Forbidden', message: `${plural} is forbidden: User "tester" cannot list resource "${plural}"` });
    const matching = [...store.values()].filter(object => object.kind === kind && (!namespace || object.metadata.namespace === namespace))
      .sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
    if (name) {
      const object = matching.find(item => item.metadata.name === name);
      return object ? send(res, 200, object) : send(res, 404, { kind: 'Status', code: 404, message: `${plural} "${name}" not found` });
    }
    if (url.searchParams.get('watch') === '1') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });
      if (flags.goneOnNextWatch) {
        flags.goneOnNextWatch = false;
        res.end(JSON.stringify({ type: 'ERROR', object: { kind: 'Status', code: 410, reason: 'Expired', message: 'too old resource version' } }) + '\n');
        return;
      }
      const watcher = { res, kind, namespace, from: Number(url.searchParams.get('resourceVersion')) };
      watchers.add(watcher);
      // Like the API server, replay events newer than the requested resourceVersion.
      for (const event of history) if (Number(event.object.metadata.resourceVersion) > watcher.from && matches(watcher, event.object)) res.write(JSON.stringify(event) + '\n');
      res.write(JSON.stringify({ type: 'BOOKMARK', object: { kind, apiVersion: 'v1', metadata: { resourceVersion: String(rv) } } }) + '\n');
      req.once('close', () => watchers.delete(watcher));
      return undefined;
    }
    // Lists are paginated two items at a time to exercise continue tokens.
    const start = Number(url.searchParams.get('continue') || 0);
    const page = matching.slice(start, start + 2).map(object => { const { kind: _kind, apiVersion: _apiVersion, ...rest } = object; return rest; });
    const next = start + 2 < matching.length ? String(start + 2) : undefined;
    return send(res, 200, { kind: `${kind}List`, apiVersion: 'v1', metadata: { resourceVersion: String(rv), ...(next ? { continue: next } : {}) }, items: page });
  });
  const matches = (watcher, object) => watcher.kind === object.kind && (!watcher.namespace || watcher.namespace === object.metadata.namespace);
  function put(type, object) {
    rv++;
    const stored = { apiVersion: 'v1', ...object, metadata: { uid: `uid-${object.kind}-${object.metadata.name}`, ...object.metadata, resourceVersion: String(rv), managedFields: [{ manager: 'test' }] } };
    if (type === 'DELETED') store.delete(keyOf(stored)); else store.set(keyOf(stored), stored);
    history.push({ type, object: stored });
    for (const watcher of watchers) if (matches(watcher, stored)) watcher.res.write(JSON.stringify({ type, object: stored }) + '\n');
    return stored;
  }
  function dropWatches() { for (const watcher of watchers) watcher.res.end(); watchers.clear(); }
  return {
    server, store, watchers, requests, flags, put, dropWatches,
    async start() { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; },
    close() { dropWatches(); server.closeAllConnections?.(); return new Promise(resolve => server.close(resolve)); },
  };
}

async function harness(t) {
  const api = fakeKubernetes();
  const baseUrl = await api.start();
  let proxyStarts = 0;
  let proxyClosed = 0;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubban-live-'));
  const backend = createBackend({ dataDir, proxyFactory: () => { proxyStarts++; return { baseUrl, close: () => { proxyClosed++; } }; } });
  const connection = await backend.start();
  t.after(async () => { await backend.close(); await api.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const getJSON = async route => {
    const response = await fetch(connection.url + route, { headers: { 'X-Rubban-Token': connection.token } });
    return { status: response.status, body: await response.json() };
  };
  const watch = query => {
    const url = new URL('/api/watch', connection.url.replace('http', 'ws'));
    for (const [key, value] of Object.entries({ context: 'fake', ...query, token: connection.token })) url.searchParams.set(key, value);
    const socket = new WebSocket(url);
    const messages = [];
    const waiters = [];
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString('utf8'));
      messages.push(message);
      for (const waiter of [...waiters]) if (waiter.test(message, messages)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message); }
    });
    const next = (test, timeout = 4000) => {
      const found = messages.find(message => test(message, messages) && !message.consumed);
      if (found) { found.consumed = true; return Promise.resolve(found); }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for watch message; saw ${JSON.stringify(messages.map(m => m.type))}`)), timeout);
        waiters.push({ test, resolve: message => { clearTimeout(timer); message.consumed = true; resolve(message); } });
      });
    };
    t.after(() => socket.close());
    return { socket, messages, next };
  };
  return { api, backend, connection, getJSON, watch, stats: () => ({ proxyStarts, proxyClosed }) };
}

const configMap = (name, namespace = 'default', data = {}) => ({ kind: 'ConfigMap', metadata: { name, namespace }, data });

test('resolver prefers explicit groups, then core, then API group priority', () => {
  const resources = [
    { name: 'events', kind: 'Event', group: '', version: 'v1', priority: 0, shortNames: ['ev'], singular: 'event', verbs: ['list'] },
    { name: 'deployments', kind: 'Deployment', group: 'apps', version: 'v1', priority: 1, shortNames: ['deploy'], singular: 'deployment', verbs: ['list'] },
    { name: 'events', kind: 'Event', group: 'events.k8s.io', version: 'v1', priority: 5, shortNames: [], singular: 'event', verbs: ['list'] },
  ];
  assert.equal(resolveResource(resources, 'events').group, '');
  assert.equal(resolveResource(resources, 'events.events.k8s.io').group, 'events.k8s.io');
  assert.equal(resolveResource(resources, 'deploy').name, 'deployments');
  assert.equal(resolveResource(resources, 'deployments.v1.apps').group, 'apps');
  assert.equal(resolveResource(resources, 'widgets'), null);
});

test('reads use the shared connection: aggregated discovery, paginated lists, YAML and secret redaction', async t => {
  const { api, getJSON, stats } = await harness(t);
  for (const name of ['a', 'b', 'c', 'd', 'e']) api.put('ADDED', configMap(name));
  api.put('ADDED', { kind: 'Secret', metadata: { name: 'token', namespace: 'default', annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{"data":{"password":"c2VjcmV0"}}' } }, data: { password: 'c2VjcmV0' } });

  const health = await getJSON('/api/health');
  assert.equal(health.body.live, true);
  const discovery = await getJSON('/api/discovery?context=fake');
  assert.equal(discovery.status, 200);
  assert.deepEqual(discovery.body.resources.find(item => item.name === 'deployments').version, 'v1');

  const list = await getJSON('/api/resources?context=fake&namespace=default&resource=configmaps');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.items.map(item => item.metadata.name), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(list.body.items[0].kind, 'ConfigMap');
  assert.equal(list.body.items[0].metadata.managedFields, undefined);
  assert.ok(api.requests.some(request => request.includes('continue=4')), 'pagination continued to the last page');

  const secrets = await getJSON('/api/resources?context=fake&namespace=*&resource=secrets');
  const serialized = JSON.stringify(secrets.body);
  assert.equal(secrets.body.items.length, 1);
  assert.doesNotMatch(serialized, /c2VjcmV0/);
  assert.deepEqual(secrets.body.items[0].dataKeys, ['password']);

  const yaml = await getJSON('/api/yaml?context=fake&namespace=default&resource=configmaps&name=a');
  assert.match(yaml.body.yaml, /^apiVersion: v1\nkind: ConfigMap\nmetadata:\n/);
  assert.match(yaml.body.yaml, /\n {2}name: a\n/);
  assert.doesNotMatch(yaml.body.yaml, /managedFields/);

  const events = await getJSON('/api/events?context=fake&namespace=default');
  assert.equal(events.status, 200);
  assert.ok(api.requests.includes('/api/v1/namespaces/default/events?limit=500'), 'bare "events" resolves to the core API');

  const missing = await getJSON('/api/resources?context=fake&namespace=*&resource=widgets');
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /does not serve the resource type "widgets"/);
  assert.equal(stats().proxyStarts, 1, 'every read reused one connection');
});

test('watch streams a snapshot then coalesced changes, and redacts secrets', async t => {
  const { api, watch } = await harness(t);
  api.put('ADDED', configMap('existing'));
  const stream = watch({ namespace: 'default', resource: 'configmaps' });
  const synced = await stream.next(message => message.type === 'synced');
  assert.equal(synced.count, 1);
  const items = stream.messages.filter(message => message.type === 'items').flatMap(message => message.items);
  assert.equal(items[0].kind, 'ConfigMap');
  assert.equal(items[0].metadata.managedFields, undefined);
  await stream.next(message => message.type === 'status' && message.state === 'live');

  api.put('ADDED', configMap('fresh', 'default', { v: '1' }));
  api.put('MODIFIED', configMap('fresh', 'default', { v: '2' }));
  const added = await stream.next(message => message.type === 'changes');
  assert.deepEqual(added.upserts.map(item => [item.metadata.name, item.data.v]), [['fresh', '2']], 'rapid updates are coalesced');

  api.put('DELETED', configMap('existing'));
  const removed = await stream.next(message => message.type === 'changes' && message.deletes.length);
  assert.deepEqual(removed.deletes, ['uid-ConfigMap-existing']);

  const secrets = watch({ namespace: '*', resource: 'secrets' });
  await secrets.next(message => message.type === 'synced');
  await secrets.next(message => message.type === 'status' && message.state === 'live');
  api.put('ADDED', { kind: 'Secret', metadata: { name: 'db', namespace: 'default' }, data: { password: 'aHVudGVyMg==' }, stringData: { token: 'plain' } });
  const secretChange = await secrets.next(message => message.type === 'changes');
  assert.equal(secretChange.upserts[0].metadata.name, 'db');
  assert.doesNotMatch(JSON.stringify(secrets.messages), /aHVudGVyMg|plain|"data"/);
});

test('watch recovers from 410 Gone with a diff relist and resumes after stream drops', async t => {
  const { api, watch } = await harness(t);
  api.put('ADDED', configMap('one'));
  api.put('ADDED', configMap('two'));
  const stream = watch({ namespace: 'default', resource: 'configmaps' });
  await stream.next(message => message.type === 'synced');
  await stream.next(message => message.type === 'status' && message.state === 'live');

  // Simulate a stream drop during which state changes; the next watch is told its version expired.
  api.flags.goneOnNextWatch = true;
  api.dropWatches();
  api.store.delete('ConfigMap/default/one');
  api.put('ADDED', configMap('three'));
  const diff = await stream.next(message => message.type === 'changes');
  assert.deepEqual(diff.upserts.map(item => item.metadata.name), ['three']);
  assert.deepEqual(diff.deletes, ['uid-ConfigMap-one']);
  assert.equal(stream.messages.filter(message => message.type === 'reset').length, 1, 'recovery does not reset the client');

  // A normal stream end resumes from the last seen resourceVersion.
  await new Promise(resolve => setTimeout(resolve, 50));
  const watchesBefore = api.requests.filter(request => request.includes('watch=1')).length;
  api.dropWatches();
  for (let i = 0; i < 40 && api.requests.filter(request => request.includes('watch=1')).length === watchesBefore; i++) await new Promise(resolve => setTimeout(resolve, 25));
  const lastWatch = api.requests.filter(request => request.includes('watch=1')).at(-1);
  assert.match(lastWatch, /resourceVersion=\d+/);
  assert.match(lastWatch, /allowWatchBookmarks=true/);
  api.put('ADDED', configMap('four'));
  const resumed = await stream.next(message => message.type === 'changes' && message.upserts.some(item => item.metadata.name === 'four'));
  assert.ok(resumed);
});

test('subscribers share one upstream watch; permission errors are reported once', async t => {
  const { api, watch } = await harness(t);
  api.put('ADDED', configMap('shared'));
  const first = watch({ namespace: 'default', resource: 'configmaps' });
  await first.next(message => message.type === 'synced');
  await first.next(message => message.type === 'status' && message.state === 'live');
  const second = watch({ namespace: 'default', resource: 'configmaps' });
  const synced = await second.next(message => message.type === 'synced');
  assert.equal(synced.count, 1);
  assert.equal(api.requests.filter(request => request.startsWith('/api/v1/namespaces/default/configmaps?watch=1')).length, 1);

  api.flags.forbidden.add('secrets');
  const denied = watch({ namespace: '*', resource: 'secrets' });
  const error = await denied.next(message => message.type === 'error');
  assert.equal(error.status, 403);
  assert.match(error.error, /forbidden/);
  await new Promise(resolve => denied.socket.once('close', resolve));

  const unknown = watch({ namespace: '*', resource: 'widgets' });
  assert.equal((await unknown.next(message => message.type === 'error')).status, 404);
});

test('watch endpoint requires the session token and falls back to snapshots without a live connection', async t => {
  const { connection } = await harness(t);
  const rejected = new WebSocket(`${connection.url.replace('http', 'ws')}/api/watch?context=fake&resource=configmaps&token=${'0'.repeat(64)}`);
  const status = await new Promise(resolve => { rejected.once('unexpected-response', (_req, res) => resolve(res.statusCode)); rejected.once('error', () => resolve('error')); });
  assert.equal(status, 401);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubban-snapshot-'));
  const offline = createBackend({ dataDir, runner: async () => ({ stdout: '{"items":[]}', stderr: '', code: 0 }) });
  const started = await offline.start();
  t.after(async () => { await offline.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const socket = new WebSocket(`${started.url.replace('http', 'ws')}/api/watch?context=x&resource=pods&token=${started.token}`);
  const message = await new Promise(resolve => socket.once('message', raw => resolve(JSON.parse(raw.toString()))));
  assert.equal(message.type, 'unavailable');
});

test('closing the backend stops watches and the per-context connection', async t => {
  const { api, backend, watch, stats } = await harness(t);
  const stream = watch({ namespace: 'default', resource: 'configmaps' });
  await stream.next(message => message.type === 'synced');
  await stream.next(message => message.type === 'status' && message.state === 'live');
  for (let i = 0; i < 40 && !api.watchers.size; i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(api.watchers.size, 1);
  await backend.close();
  for (let i = 0; i < 40 && api.watchers.size; i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(api.watchers.size, 0);
  assert.equal(stats().proxyClosed, 1);
});
