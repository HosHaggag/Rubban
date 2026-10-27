'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const WebSocket = require('ws');
const { createBackend } = require('./core.cjs');

const manifest = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: example\ndata:\n  message: hello\n';
const output = (value, code = 0, stderr = '') => ({ stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr, code });

function makeRunner(handler = () => output({ items: [] })) {
  const calls = [];
  const children = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    return handler(command, args, options);
  };
  runner.spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.killed = false;
    child.killCalls = 0;
    child.kill = () => {
      child.killCalls++;
      if (child.killed) return;
      child.killed = true;
      process.nextTick(() => child.emit('close', null, 'SIGTERM'));
    };
    children.push({ command, args, options, child });
    return child;
  };
  return { runner, calls, children };
}

async function fixture(t, handler, extras) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rubban-core-test-'));
  const mocks = makeRunner(handler);
  const backend = createBackend({ dataDir: path.join(temporary, 'data'), kubectlPath: 'test-kubectl', helmPath: 'test-helm', runner: mocks.runner, extras });
  const endpoint = await backend.start();
  t.after(async () => { await backend.close(); await fs.rm(temporary, { recursive: true, force: true }); });
  const request = async (route, method = 'GET', body, headers = {}) => {
    const response = await fetch(endpoint.url + route, {
      method,
      headers: { 'X-Rubban-Token': endpoint.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, value: await response.json(), headers: response.headers };
  };
  return { backend, endpoint, request, temporary, ...mocks };
}

function rawRequest(port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/health', headers }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, value: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function socketFor(endpoint, pathname, parameters = {}, options = {}) {
  const url = new URL(endpoint.url.replace('http:', 'ws:') + pathname);
  for (const [key, value] of Object.entries({ ...parameters, token: options.token || endpoint.token })) url.searchParams.set(key, value);
  const socket = new WebSocket(url, options.origin ? { origin: options.origin } : {});
  const messages = [];
  socket.on('message', value => messages.push(value.toString('utf8')));
  return { socket, messages, opened: once(socket, 'open') };
}

async function waitFor(predicate, message = 'condition') {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('health starts with no kubeconfig reads or subprocesses; contexts return metadata only', async t => {
  const f = await fixture(t, () => output({
    'current-context': 'development',
    contexts: [{ name: 'development', context: { cluster: 'dev-cluster', user: 'dev-user', namespace: 'apps' } }],
    users: [{ user: { token: 'must-never-be-returned' } }],
  }));
  const health = await f.request('/api/health');
  assert.equal(health.status, 200);
  assert.equal(f.calls.length, 0);
  assert.equal(health.value.tools.kubectl.available, true);
  assert.equal(health.headers.get('access-control-allow-origin'), null);
  const contexts = await f.request('/api/contexts');
  assert.equal(contexts.value.current, 'development');
  assert.deepEqual(contexts.value.contexts, [{ name: 'development', cluster: 'dev-cluster', user: 'dev-user', namespace: 'apps', current: true }]);
  assert.equal(JSON.stringify(contexts.value).includes('must-never-be-returned'), false);
  assert.deepEqual(f.calls[0].args, ['config', 'view', '--output=json']);
  assert.equal(f.calls[0].options.shell, false);
});

test('local API rejects missing tokens, foreign Host and foreign Origin', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/health', 'GET', undefined, { 'X-Rubban-Token': '' })).status, 401);
  assert.equal((await f.request('/api/health', 'GET', undefined, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await f.request('/api/health', 'GET', undefined, { Origin: 'null' })).status, 403);
  assert.equal((await rawRequest(f.endpoint.port, { Host: 'evil.example', 'X-Rubban-Token': f.endpoint.token })).status, 403);
  assert.equal((await rawRequest(f.endpoint.port, { Host: `localhost:${f.endpoint.port}`, Origin: `http://localhost:${f.endpoint.port}`, 'X-Rubban-Token': f.endpoint.token })).status, 200);
  // The MCP bridge sends the session token as a bearer credential.
  assert.equal((await rawRequest(f.endpoint.port, { Host: `127.0.0.1:${f.endpoint.port}`, Authorization: `Bearer ${f.endpoint.token}` })).status, 200);
  assert.equal((await rawRequest(f.endpoint.port, { Host: `127.0.0.1:${f.endpoint.port}`, Authorization: `Bearer ${'0'.repeat(64)}` })).status, 401);
  assert.equal(f.calls.length, 0);
});

test('resource lists use all namespaces only for an empty or wildcard filter', async t => {
  const f = await fixture(t);
  for (const namespace of ['', '*']) {
    const response = await f.request(`/api/resources?context=dev&resource=pods&namespace=${encodeURIComponent(namespace)}`);
    assert.equal(response.status, 200);
    assert.ok(f.calls.at(-1).args.includes('--all-namespaces'));
  }
  assert.equal((await f.request('/api/resources?context=dev&resource=deployments.apps&namespace=apps')).status, 200);
  assert.deepEqual(f.calls.at(-1).args, ['get', 'deployments.apps', '--context=dev', '--namespace=apps', '--output=json']);
  assert.equal((await f.request('/api/resources?resource=pods')).status, 400);
  assert.equal((await f.request('/api/resources?context=dev&resource=pods%2Csecrets')).status, 400);
  assert.equal((await f.request('/api/resource?context=dev&resource=pods&name=hello&namespace=*')).status, 400);
});

test('all-namespace resource and event queries do not enter kubectl plugin dispatch', async t => {
  const f = await fixture(t, (_command, args) => {
    if (args.indexOf('--all-namespaces') < args.indexOf('get')) {
      throw new Error(`flags cannot be placed before plugin name: ${args[0]}`);
    }
    return output({ items: [{ metadata: { name: 'returned-by-get' } }] });
  });
  for (const route of ['/api/resources?resource=pods', '/api/resources?resource=persistentvolumeclaims', '/api/events?']) {
    for (const namespace of ['', '*']) {
      const response = await f.request(`${route}&context=dev&namespace=${encodeURIComponent(namespace)}`);
      assert.equal(response.status, 200, `${route}, namespace=${namespace}`);
      assert.equal(response.value.items[0].metadata.name, 'returned-by-get');
    }
  }
});

test('named object and YAML routes preserve separate command arguments', async t => {
  const f = await fixture(t, (command, args) => output(args.includes('--output=yaml') ? manifest : { metadata: { name: 'example' } }));
  const response = await f.request('/api/yaml?context=team%20cluster&namespace=apps&resource=configmaps&name=example');
  assert.equal(response.value.yaml, manifest);
  assert.deepEqual(f.calls.at(-1).args, ['--context=team cluster', '--namespace=apps', 'get', 'configmaps', 'example', '--output=yaml']);
  assert.equal((await f.request('/api/resource?context=dev&resource=pods&name=--all')).status, 400);
  assert.equal((await f.request('/api/resource?context=dev&resource=pods%2Fstatus&name=x')).status, 400);
});

test('secret lists and object reads omit payloads; values come only from an explicit reveal', async t => {
  const secret = { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'private', annotations: { purpose: 'test', 'kubectl.kubernetes.io/last-applied-configuration': '{"data":{"password":"hidden"}}' } }, data: { password: 'c2VjcmV0' }, stringData: { password: 'secret' }, type: 'Opaque' };
  const f = await fixture(t, (command, args) => output(args.includes('private') ? secret : { kind: 'SecretList', items: [secret] }));
  const list = await f.request('/api/resources?context=dev&resource=secrets');
  assert.equal(list.status, 200);
  assert.equal('data' in list.value.items[0], false);
  assert.equal('stringData' in list.value.items[0], false);
  assert.deepEqual(list.value.items[0].metadata.annotations, { purpose: 'test' });
  assert.equal(JSON.stringify(list.value).includes('c2VjcmV0'), false);
  assert.deepEqual(list.value.items[0].dataKeys, ['password']);
  const selected = await f.request('/api/resource?context=dev&resource=secrets&name=private&namespace=apps');
  assert.equal(selected.status, 200);
  assert.equal('data' in selected.value, false);
  assert.deepEqual(selected.value.dataKeys, ['password']);
  const revealed = await f.request('/api/secret-data?context=dev&name=private&namespace=apps');
  assert.equal(revealed.status, 200);
  assert.deepEqual(revealed.value.data, secret.data);
  assert.deepEqual(f.calls.at(-1).args, ['--context=dev', '--namespace=apps', 'get', 'secret', 'private', '--output=json']);
});

test('mutations require POST, valid resource arguments and selected context', async t => {
  const f = await fixture(t, () => output('updated'));
  assert.equal((await f.request('/api/apply')).status, 404);
  assert.equal((await f.request('/api/delete', 'GET')).status, 404);
  assert.equal((await f.request('/api/delete', 'POST', { context: 'dev', namespace: 'apps', resource: 'pods', name: '--all' })).status, 400);
  assert.equal((await f.request('/api/scale', 'POST', { context: 'dev', resource: 'deployments', name: 'web', replicas: '1;whoami' })).status, 400);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request('/api/scale', 'POST', { context: 'dev', namespace: 'apps', resource: 'deployments', name: 'web', replicas: 0 })).status, 200);
  assert.deepEqual(f.calls.at(-1).args, ['--context=dev', '--namespace=apps', 'scale', 'deployments', 'web', '--replicas=0']);
  assert.equal((await f.request('/api/restart', 'POST', { context: 'dev', namespace: 'apps', resource: 'secrets', name: 'web' })).status, 400);
  assert.equal((await f.request('/api/restart', 'POST', { context: 'dev', namespace: 'apps', resource: 'deployments.apps', name: 'web' })).status, 200);
  assert.ok(f.calls.at(-1).args.includes('deployments.apps/web'));
  assert.equal((await f.request('/api/delete', 'POST', { context: 'dev', namespace: 'apps', resource: 'pods', name: 'web' })).status, 200);
  assert.ok(f.calls.at(-1).args.includes('--wait=false'));
});

test('diff accepts kubectl exit 1 as changed; apply sends validated YAML through stdin', async t => {
  const f = await fixture(t, (command, args) => output(args.includes('diff') ? '- old\n+ new\n' : 'configmap/example configured\n', args.includes('diff') ? 1 : 0));
  const body = { context: 'dev', namespace: 'apps', yaml: manifest };
  const diff = await f.request('/api/diff', 'POST', body);
  assert.equal(diff.status, 200);
  assert.equal(diff.value.changed, true);
  assert.equal(f.calls.at(-1).options.input, manifest);
  assert.deepEqual(f.calls.at(-1).options.allowExitCodes, [0, 1]);
  const apply = await f.request('/api/apply', 'POST', body);
  assert.equal(apply.status, 200);
  assert.ok(f.calls.at(-1).args.includes('--filename=-'));
  assert.equal((await f.request('/api/apply', 'POST', { ...body, yaml: 'kind: [' })).status, 400);
  assert.equal((await f.request('/api/apply', 'POST', { ...body, yaml: 'hello: world' })).status, 400);
  assert.equal(f.calls.length, 2);
});

test('discovery reads preferred public API versions and excludes subresources', async t => {
  const f = await fixture(t, (command, args) => {
    if (args.includes('--raw=/api/v1')) return output({ resources: [{ name: 'pods', kind: 'Pod', namespaced: true, verbs: ['get', 'list'] }, { name: 'pods/exec', kind: 'Pod', namespaced: true, verbs: ['create'] }] });
    if (args.includes('--raw=/apis')) return output({ groups: [{ preferredVersion: { groupVersion: 'apps/v1' } }] });
    if (args.includes('--raw=/apis/apps/v1')) return output({ resources: [{ name: 'deployments', kind: 'Deployment', namespaced: true, verbs: ['get', 'list', 'patch'] }] });
    throw new Error('Unexpected test command');
  });
  const response = await f.request('/api/discovery?context=dev');
  assert.equal(response.status, 200);
  assert.equal(response.value.resources.length, 2);
  assert.ok(response.value.resources.some(resource => resource.name === 'deployments' && resource.group === 'apps'));
  assert.equal(response.value.resources.some(resource => resource.name.includes('/')), false);
});

test('metrics scope pods by namespace and report missing metrics explicitly', async t => {
  const f = await fixture(t, (command, args) => args.some(arg => arg.endsWith('/nodes'))
    ? output('', 1, 'metrics.k8s.io not available') : output({ items: [{ metadata: { name: 'web' } }] }));
  const response = await f.request('/api/metrics?context=dev&namespace=apps');
  assert.equal(response.status, 200);
  assert.deepEqual(response.value.nodes.items, []);
  assert.equal(response.value.pods.items.length, 1);
  assert.match(response.value.warnings[0], /metrics.k8s.io not available/);
  assert.ok(f.calls.some(call => call.args.includes('--raw=/apis/metrics.k8s.io/v1beta1/namespaces/apps/pods')));
});

test('Helm list uses all namespaces and tolerates an empty local repository list', async t => {
  const f = await fixture(t, (command, args) => args[0] === 'repo' ? output('', 1, 'no repositories to show') : output([{ name: 'web' }]));
  const response = await f.request('/api/helm?context=dev&namespace=*');
  assert.equal(response.status, 200);
  assert.deepEqual(response.value.releases, [{ name: 'web' }]);
  assert.deepEqual(response.value.repositories, []);
  assert.ok(f.calls.find(call => call.args[0] === 'list').args.includes('--all-namespaces'));
});

test('Helm chart browser lists repository charts and reports an empty setup without failing', async t => {
  const charts = [{ name: 'bitnami/nginx', version: '18.1.0', app_version: '1.27.1', description: 'NGINX Open Source' }];
  const f = await fixture(t, (command, args) => args[0] === 'search' ? output(charts) : output([{ name: 'bitnami', url: 'https://charts.bitnami.com/bitnami' }]));
  const response = await f.request('/api/helm/charts');
  assert.equal(response.status, 200);
  assert.deepEqual(response.value.charts, charts);
  assert.equal(response.value.repositories[0].name, 'bitnami');
  assert.deepEqual(f.calls.find(call => call.args[0] === 'search').args, ['search', 'repo', '--output=json']);
  assert.equal(f.calls.find(call => call.args[0] === 'search').command, 'test-helm');

  const none = await fixture(t, () => output('', 1, 'Error: no repositories configured'));
  const emptyResponse = await none.request('/api/helm/charts');
  assert.equal(emptyResponse.status, 200);
  assert.deepEqual(emptyResponse.value, { charts: [], repositories: [], warnings: [] });
});

test('Helm mutations validate actions and send values on stdin without invoking a shell', async t => {
  const f = await fixture(t, () => output('release updated'));
  const values = 'replicaCount: 2\n';
  const response = await f.request('/api/helm', 'POST', { action: 'upgrade', context: 'dev', namespace: 'apps', name: 'web', chart: 'stable/web', version: '1.2.3', values });
  assert.equal(response.status, 200);
  assert.deepEqual(f.calls.at(-1).args, ['upgrade', 'web', 'stable/web', '--kube-context=dev', '--namespace=apps', '--version=1.2.3', '--values=-']);
  assert.equal(f.calls.at(-1).options.input, values);
  assert.equal(f.calls.at(-1).options.shell, false);
  assert.equal((await f.request('/api/helm', 'POST', { action: 'plugin', name: 'x' })).status, 400);
  assert.equal((await f.request('/api/helm', 'POST', { action: 'repo-add', repo: 'x', url: 'file:///private/file' })).status, 400);
  assert.equal((await f.request('/api/helm', 'POST', { action: 'repo-add', repo: 'x', url: 'https://user:pass@example.com/' })).status, 400);
  assert.equal((await f.request('/api/helm', 'POST', { action: 'install', context: 'dev', name: 'x', chart: '../private' })).status, 400);
  assert.equal((await f.request('/api/helm', 'POST', { action: 'repo-add', repo: 'public', url: 'https://charts.example.com' })).status, 200);
  assert.deepEqual(f.calls.at(-1).args, ['repo', 'add', 'public', 'https://charts.example.com/']);
});

test('independent preferences are persisted atomically and extras receive shared helpers', async t => {
  let received;
  const f = await fixture(t, undefined, async args => {
    received = args;
    if (args.url.pathname !== '/api/extra') return false;
    args.sendJSON(args.res, 200, { ok: true });
    return true;
  });
  assert.deepEqual((await f.request('/api/preferences')).value, {});
  const settings = { hotbar: ['dev'], prometheusUrls: ['http://127.0.0.1:9090'], theme: 'dark' };
  assert.equal((await f.request('/api/preferences', 'PUT', settings)).status, 200);
  assert.deepEqual((await f.request('/api/preferences')).value, settings);
  assert.equal((await fs.readdir(path.dirname(f.backend.config.preferencesPath))).some(name => name.endsWith('.tmp')), false);
  assert.equal((await f.request('/api/extra')).value.ok, true);
  assert.equal(received.config.readPreferences, f.backend.config.readPreferences);
  assert.equal(typeof received.helpers.validateName, 'function');
  assert.equal(f.calls.length, 0);
});

test('process runner enforces timeout, cancellation and bounded output', async t => {
  const f = await fixture(t, async (command, args, options) => {
    if (command === 'oversize') return output('x'.repeat(100));
    return new Promise((resolve, reject) => {
      if (options.signal.aborted) reject(new Error('already canceled'));
      options.signal.addEventListener('abort', () => reject(new Error('canceled by test')), { once: true });
    });
  });
  await assert.rejects(f.backend.run('oversize', [], { maxBytes: 10 }), /output exceeded/);
  await assert.rejects(f.backend.run('slow', [], { timeoutMs: 20 }), error => error.status === 504);
  const abort = new AbortController();
  const pending = f.backend.run('canceled', [], { signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, error => error.status === 499);
});

test('port forwards bind loopback, detect readiness, prevent duplicate ports and stop on deletion', async t => {
  const f = await fixture(t);
  const body = { context: 'dev', namespace: 'apps', resource: 'services', name: 'web', localPort: 18080, remotePort: 80 };
  const response = await f.request('/api/forwards', 'POST', body);
  assert.equal(response.status, 201);
  assert.equal(response.value.status, 'starting');
  assert.ok(f.children[0].args.includes('--address=127.0.0.1'));
  assert.equal(f.children[0].options.shell, false);
  f.children[0].child.stdout.write('Forwarding from 127.0.0.1:18080 -> 80\n');
  assert.equal((await f.request('/api/forwards')).value.items[0].status, 'ready');
  assert.equal((await f.request('/api/forwards', 'POST', body)).status, 409);
  assert.equal((await f.request(`/api/forwards/${response.value.id}`, 'DELETE')).status, 200);
  assert.equal(f.children[0].child.killed, true);
  assert.deepEqual((await f.request('/api/forwards')).value.items, []);
});

test('logs stream UTF-8 text and close cancels the underlying process', async t => {
  const f = await fixture(t);
  const connection = socketFor(f.endpoint, '/api/logs', { context: 'dev', namespace: 'apps', pod: 'web', container: 'server', tail: '250', previous: 'true' });
  await connection.opened;
  const spawned = f.children[0];
  assert.ok(spawned.args.includes('--tail=250'));
  assert.ok(spawned.args.includes('--container=server'));
  assert.ok(spawned.args.includes('--previous=true'));
  const utf8 = Buffer.from('hello 🌍\n');
  spawned.child.stdout.write(utf8.subarray(0, 8));
  spawned.child.stdout.write(utf8.subarray(8));
  await waitFor(() => connection.messages.join('').includes('🌍'), 'log output');
  assert.equal(connection.messages.join(''), 'hello 🌍\n');
  connection.socket.close();
  await once(connection.socket, 'close');
  await waitFor(() => spawned.child.killed, 'log cancellation');
});

test('websocket handshake rejects a wrong token and a hostile Origin', async t => {
  const f = await fixture(t);
  for (const options of [{ token: 'incorrect' }, { origin: 'https://example.com' }]) {
    const connection = socketFor(f.endpoint, '/api/logs', { context: 'dev', pod: 'web' }, options);
    connection.socket.on('error', () => {});
    await assert.rejects(connection.opened, /Unexpected server response: (401|403)/);
  }
  assert.equal(f.children.length, 0);
});

test('terminal reports its pipe fallback, accepts input and never requests a remote TTY without PTY', async t => {
  const f = await fixture(t);
  const connection = socketFor(f.endpoint, '/api/terminal', { context: 'dev', namespace: 'apps', pod: 'web', container: 'server' });
  await connection.opened;
  await waitFor(() => connection.messages.length > 0, 'terminal status');
  assert.equal(JSON.parse(connection.messages[0]).mode, 'pipes');
  const spawned = f.children[0];
  assert.equal(spawned.args.includes('--tty=true'), false);
  assert.ok(spawned.args.includes('--stdin=true'));
  assert.deepEqual(spawned.args.slice(-4), ['--', '/bin/sh', '-c', 'if [ -x /bin/bash ]; then exec /bin/bash; else exec /bin/sh; fi']);
  let input = '';
  spawned.child.stdin.on('data', data => { input += data; });
  connection.socket.send(JSON.stringify({ type: 'input', data: 'echo test\n' }));
  await waitFor(() => input === 'echo test\n', 'terminal input');
  connection.socket.send(JSON.stringify({ type: 'resize', cols: 0, rows: 30 }));
  await waitFor(() => connection.messages.some(message => JSON.parse(message).type === 'error'), 'resize validation');
  connection.socket.close();
  await once(connection.socket, 'close');
  await waitFor(() => spawned.child.killed, 'terminal cancellation');
});

test('native PTY integration forwards input/resize and kills the PTY on disconnect', async t => {
  const f = await fixture(t);
  const terminal = { writes: [], sizes: [], killed: false, write(value) { this.writes.push(value); }, resize(cols, rows) { this.sizes.push([cols, rows]); }, kill() { this.killed = true; }, onData(callback) { this.data = callback; }, onExit(callback) { this.exit = callback; } };
  let ptyArgs;
  f.runner.pty = { spawn(command, args, options) { ptyArgs = { command, args, options }; return terminal; } };
  const connection = socketFor(f.endpoint, '/api/terminal', { context: 'dev', namespace: 'apps', pod: 'web' });
  await connection.opened;
  await waitFor(() => connection.messages.length > 0, 'PTY status');
  assert.equal(JSON.parse(connection.messages[0]).mode, 'pty');
  assert.ok(ptyArgs.args.includes('--tty=true'));
  connection.socket.send(JSON.stringify({ type: 'input', data: 'ls\n' }));
  connection.socket.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
  await waitFor(() => terminal.writes.length && terminal.sizes.length, 'PTY input');
  assert.deepEqual(terminal.writes, ['ls\n']);
  assert.deepEqual(terminal.sizes, [[120, 40]]);
  terminal.data('output\n');
  await waitFor(() => connection.messages.some(message => JSON.parse(message).type === 'data'), 'PTY output');
  connection.socket.close();
  await once(connection.socket, 'close');
  await waitFor(() => terminal.killed, 'PTY cancellation');
  assert.equal(f.children.length, 0);
});

test('backend shutdown aborts in-flight runs and stops active log streams and forwards', async t => {
  const f = await fixture(t, (command, args, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })));
  const pending = f.backend.run('pending', []);
  const pendingRejection = assert.rejects(pending, error => error.status === 499);
  const connection = socketFor(f.endpoint, '/api/logs', { context: 'dev', namespace: 'apps', pod: 'web' });
  await connection.opened;
  await f.request('/api/forwards', 'POST', { context: 'dev', namespace: 'apps', resource: 'pods', name: 'web', localPort: 18081, remotePort: 80 });
  await f.backend.close();
  await pendingRejection;
  assert.equal(f.children.every(entry => entry.child.killed), true);
});

test('resource actions build exact kubectl and helm arguments', async t => {
  const f = await fixture(t, () => output('done'));
  const post = (route, body) => f.request(route, 'POST', body);
  assert.equal((await post('/api/node', { context: 'dev', name: 'node-a', action: 'drain', timeoutSeconds: 120, ignoreDaemonsets: true, deleteEmptyDirData: false, force: false, gracePeriodSeconds: '30' })).status, 200);
  assert.deepEqual(f.calls.at(-1).args, ['--context=dev', 'drain', 'node-a', '--timeout=120s', '--ignore-daemonsets=true', '--delete-emptydir-data=false', '--force=false', '--grace-period=30']);
  assert.equal((await post('/api/node', { context: 'dev', name: 'node-a', action: 'reboot' })).status, 400);
  assert.equal((await post('/api/cronjob', { context: 'dev', namespace: 'apps', name: 'backup', action: 'suspend' })).status, 200);
  assert.deepEqual(f.calls.at(-1).args, ['--context=dev', '--namespace=apps', 'patch', 'cronjob', 'backup', '--type=merge', '--patch={"spec":{"suspend":true}}']);
  await post('/api/cronjob', { context: 'dev', namespace: 'apps', name: 'backup', action: 'trigger' });
  assert.match(f.calls.at(-1).args.join(' '), /^--context=dev --namespace=apps create job backup-manual-[0-9a-f]{6} --from=cronjob\/backup$/);
  await post('/api/rollout-undo', { context: 'dev', namespace: 'apps', resource: 'deployments', name: 'web', revision: 3 });
  assert.deepEqual(f.calls.at(-1).args, ['--context=dev', '--namespace=apps', 'rollout', 'undo', 'deployments/web', '--to-revision=3']);
  assert.equal((await post('/api/rollout-undo', { context: 'dev', namespace: 'apps', resource: 'pods', name: 'web', revision: 3 })).status, 400);
  await post('/api/patch', { context: 'dev', namespace: 'apps', resource: 'configmaps', name: 'cfg', type: 'merge', patch: { data: { a: 'b', old: null } } });
  assert.deepEqual(f.calls.at(-1).args, ['--context=dev', '--namespace=apps', 'patch', 'configmaps', 'cfg', '--type=merge', '--patch={"data":{"a":"b","old":null}}']);
  assert.equal((await post('/api/patch', { context: 'dev', namespace: 'apps', resource: 'configmaps', name: 'cfg', patch: 'x' })).status, 400);
  await post('/api/helm', { action: 'repo-remove', repo: 'bitnami' });
  assert.deepEqual(f.calls.at(-1).args, ['repo', 'remove', 'bitnami']);
  // RBAC names may contain ':' (system:controller:…); flags never pass as names.
  assert.notEqual((await f.request('/api/resource?context=dev&resource=clusterroles&name=system:controller:job-controller')).status, 400);
  assert.equal((await f.request('/api/resource?context=dev&resource=clusterroles&name=:bad')).status, 400);
  // Eviction and default classes need the live connection, which test runners do not provide.
  assert.equal((await post('/api/evict', { context: 'dev', namespace: 'apps', name: 'web-1' })).status, 503);
  assert.equal((await post('/api/default-class', { context: 'dev', kind: 'nodes', name: 'x' })).status, 400);
});

test('port forwards can let kubectl choose the local port', async t => {
  const f = await fixture(t, () => output(''));
  const created = await f.request('/api/forwards', 'POST', { context: 'dev', namespace: 'apps', resource: 'services', name: 'web', remotePort: 80 });
  assert.equal(created.status, 201);
  const spawned = f.children.at(-1);
  assert.deepEqual(spawned.args.slice(-3), ['services/web', ':80', '--address=127.0.0.1']);
  spawned.child.stdout.write('Forwarding from 127.0.0.1:43123 -> 80\n');
  await new Promise(resolve => setTimeout(resolve, 20));
  const list = await f.request('/api/forwards');
  assert.equal(list.value.items[0].localPort, 43123);
  assert.equal(list.value.items[0].status, 'ready');
});

test('negative sentinels are accepted where the range allows them', async t => {
  const f = await fixture(t, () => output('done'));
  assert.equal((await f.request('/api/node', 'POST', { context: 'dev', name: 'node-a', action: 'drain', timeoutSeconds: 60, gracePeriodSeconds: '-1' })).status, 200);
  assert.ok(f.calls.at(-1).args.includes('--grace-period=-1'));
  assert.equal((await f.request('/api/node', 'POST', { context: 'dev', name: 'node-a', action: 'drain', timeoutSeconds: 60, gracePeriodSeconds: '-2' })).status, 400);
  const connection = socketFor(f.endpoint, '/api/logs', { context: 'dev', namespace: 'apps', pod: 'web', tail: '-1' });
  await connection.opened;
  await waitFor(() => f.children.length > 0, 'log process');
  assert.ok(f.children.at(-1).args.includes('--tail=-1'));
  connection.socket.close();
});

test('Argo CD actions write refresh annotations, operations, sync policy and delete finalizers', async t => {
  const app = {
    apiVersion: 'argoproj.io/v1alpha1', kind: 'Application',
    metadata: { name: 'web', namespace: 'argocd', resourceVersion: '42', finalizers: ['resources-finalizer.argocd.argoproj.io/background', 'example.com/keep'] },
    spec: { project: 'default', source: { repoURL: 'https://git.example/apps.git', path: 'web' } },
    status: { history: [{ id: 3, revision: 'abc123', source: { repoURL: 'https://git.example/apps.git', path: 'web' } }], operationState: { phase: 'Succeeded' } },
  };
  let current = app;
  const f = await fixture(t, (command, args) => (args.includes('get') ? output(current) : output('done')));
  const post = body => f.request('/api/argocd', 'POST', { context: 'dev', namespace: 'argocd', name: 'web', ...body });
  const base = ['--context=dev', '--namespace=argocd'];
  const patchOf = call => JSON.parse(call.args.find(arg => arg.startsWith('--patch=')).slice('--patch='.length));

  assert.equal((await post({ action: 'hard-refresh' })).status, 200);
  assert.deepEqual(f.calls.at(-1).args, [...base, 'annotate', 'applications.argoproj.io', 'web', 'argocd.argoproj.io/refresh=hard', '--overwrite']);
  await post({ action: 'refresh' });
  assert.equal(f.calls.at(-1).args.at(-2), 'argocd.argoproj.io/refresh=normal');

  assert.equal((await post({ action: 'sync', options: { prune: true, serverSideApply: true, prunePropagationPolicy: 'background', revision: 'v1.2.3', retry: true, retryLimit: 3, resources: [{ group: 'apps', kind: 'Deployment', name: 'web', namespace: 'apps' }] } })).status, 200);
  assert.deepEqual(f.calls.at(-1).args.slice(0, 6), [...base, 'patch', 'applications.argoproj.io', 'web', '--type=merge']);
  assert.deepEqual(patchOf(f.calls.at(-1)), { metadata: { resourceVersion: '42' }, operation: {
    initiatedBy: { username: 'rubban' },
    sync: { prune: true, dryRun: false, syncStrategy: { hook: { force: false } }, syncOptions: ['ServerSideApply=true', 'PrunePropagationPolicy=background'], revision: 'v1.2.3', resources: [{ group: 'apps', kind: 'Deployment', name: 'web', namespace: 'apps' }] },
    retry: { limit: 3, backoff: { duration: '5s', factor: 2, maxDuration: '3m' } } } });
  await post({ action: 'sync', options: { applyOnly: true, force: true, dryRun: true } });
  assert.deepEqual(patchOf(f.calls.at(-1)).operation.sync, { prune: false, dryRun: true, syncStrategy: { apply: { force: true } } });
  for (const options of [{ revision: '--upload-pack=x' }, { revision: 'a b' }, { prunePropagationPolicy: 'now' }, { resources: [{ kind: 'Deployment', name: '-x' }] }, { resources: 'all' }]) {
    assert.equal((await post({ action: 'sync', options })).status, 400, JSON.stringify(options));
  }

  await post({ action: 'rollback', id: 3, prune: true });
  assert.deepEqual(patchOf(f.calls.at(-1)).operation.sync, { prune: true, dryRun: false, syncStrategy: { hook: {} }, revision: 'abc123', source: { repoURL: 'https://git.example/apps.git', path: 'web' } });
  assert.equal((await post({ action: 'rollback', id: 9 })).status, 404);

  await post({ action: 'auto-sync', enabled: true, prune: true, selfHeal: false });
  assert.deepEqual(patchOf(f.calls.at(-1)), { spec: { syncPolicy: { automated: { prune: true, selfHeal: false } } } });
  await post({ action: 'auto-sync', enabled: false });
  assert.deepEqual(patchOf(f.calls.at(-1)), { spec: { syncPolicy: { automated: null } } });

  // Busy and policy guards
  current = { ...app, operation: { sync: {} } };
  assert.equal((await post({ action: 'sync', options: {} })).status, 409);
  current = { ...app, spec: { ...app.spec, syncPolicy: { automated: { prune: true } } } };
  assert.equal((await post({ action: 'rollback', id: 3 })).status, 409);
  assert.equal((await post({ action: 'terminate' })).status, 409);
  current = { ...app, status: { operationState: { phase: 'Running' } } };
  await post({ action: 'terminate' });
  assert.deepEqual(patchOf(f.calls.at(-1)), { metadata: { resourceVersion: '42' }, status: { operationState: { phase: 'Terminating' } } });

  // Delete: the finalizer decides cascading; other finalizers are kept.
  current = app;
  for (const [cascade, finalizers] of [['foreground', ['example.com/keep', 'resources-finalizer.argocd.argoproj.io']], ['background', ['example.com/keep', 'resources-finalizer.argocd.argoproj.io/background']], ['none', ['example.com/keep']]]) {
    assert.equal((await post({ action: 'delete', cascade })).status, 200);
    assert.deepEqual(patchOf(f.calls.at(-2)), { metadata: { resourceVersion: '42', finalizers } });
    assert.deepEqual(f.calls.at(-1).args, [...base, 'delete', 'applications.argoproj.io', 'web', '--wait=false']);
  }
  assert.equal((await post({ action: 'delete', cascade: 'orphan' })).status, 400);
  assert.equal((await post({ action: 'restart' })).status, 400);
  assert.equal((await f.request('/api/argocd', 'POST', { context: 'dev', namespace: 'argocd', name: '-web', action: 'refresh' })).status, 400);
});

test('nodes metrics-server left out are read from the kubelet summary, failures explained and cached', async t => {
  let kubeletUp = true;
  const f = await fixture(t, (command, args) => {
    const raw = (args.find(arg => arg.startsWith('--raw=')) || '').slice('--raw='.length);
    if (raw === '/apis/metrics.k8s.io/v1beta1/nodes') return output({ items: [{ metadata: { name: 'n1' }, usage: { cpu: '500m', memory: '1Gi' } }] });
    if (raw === '/apis/metrics.k8s.io/v1beta1/pods') return output({ items: [{ metadata: { name: 'a', namespace: 'x' }, containers: [{ name: 'c', usage: { cpu: '1m', memory: '1Mi' } }] }] });
    if (args.includes('nodes') && args.includes('--output=name')) return output('node/n1\nnode/n2\n');
    if (raw.startsWith('/api/v1/nodes/n2/proxy/stats/summary')) {
      if (!kubeletUp) return output('', 1, 'Error from server (Forbidden): nodes "n2" is forbidden: cannot get resource "nodes/proxy"');
      return output({ node: { cpu: { time: 't', usageNanoCores: 2500000000 }, memory: { time: 't', workingSetBytes: 1073741824 } },
        pods: [{ podRef: { name: 'a', namespace: 'x' }, containers: [{ name: 'c', cpu: { usageNanoCores: 5 }, memory: { workingSetBytes: 5 } }] },
          { podRef: { name: 'b', namespace: 'x' }, containers: [{ name: 'c', cpu: { usageNanoCores: 300000000 }, memory: { workingSetBytes: 2048 } }] }] });
    }
    return output({ items: [] });
  });
  const metrics = (await f.request('/api/metrics?context=dev&namespace=*')).value;
  assert.deepEqual(metrics.nodes.items.map(item => [item.metadata.name, item.usage, item.source]), [['n1', { cpu: '500m', memory: '1Gi' }, undefined], ['n2', { cpu: '2500000000n', memory: '1073741824' }, 'kubelet']]);
  // Pods already reported by metrics-server are kept; only missing ones are added.
  assert.deepEqual(metrics.pods.items.map(item => [item.metadata.name, item.source]), [['a', undefined], ['b', 'kubelet']]);
  assert.ok(f.calls.some(call => call.args.includes('--raw=/api/v1/nodes/n2/proxy/stats/summary?only_cpu_and_memory=true')));

  kubeletUp = false;
  const failedFresh = await fixture(t, (command, args) => {
    const raw = (args.find(arg => arg.startsWith('--raw=')) || '').slice('--raw='.length);
    if (raw === '/apis/metrics.k8s.io/v1beta1/nodes') return output({ items: [] });
    if (args.includes('nodes') && args.includes('--output=name')) return output('node/n2\n');
    if (raw.startsWith('/api/v1/nodes/n2/proxy')) return output('', 1, 'Error from server (Forbidden): cannot get resource "nodes/proxy"');
    return output({ items: [] });
  });
  const failed = (await failedFresh.request('/api/metrics?context=dev&namespace=*')).value;
  assert.match(failed.missingNodes.n2, /^metrics-server has no sample for this node, and its kubelet could not be read: .*nodes\/proxy/);
  await failedFresh.request('/api/metrics?context=dev&namespace=*');
  assert.equal(failedFresh.calls.filter(call => call.args.some(arg => arg.startsWith('--raw=/api/v1/nodes/n2/proxy'))).length, 1, 'a failing kubelet is retried after a minute, not on every refresh');
});

test('RabbitMQ discovery lists consoles without credential values; credentials come on request', async t => {
  const services = { items: [
    { metadata: { name: 'orders', namespace: 'mq' }, spec: { selector: { app: 'orders' }, ports: [{ name: 'amqp', port: 5672 }, { name: 'management', port: 15672 }] } },
    { metadata: { name: 'orders-headless', namespace: 'mq' }, spec: { clusterIP: 'None', selector: { app: 'orders' }, ports: [{ name: 'http-stats', port: 15672 }] } },
    { metadata: { name: 'web', namespace: 'mq' }, spec: { selector: { app: 'web' }, ports: [{ name: 'management', port: 15672 }] } },
  ] };
  const mqPod = { metadata: { name: 'orders-0', namespace: 'mq', labels: { app: 'orders' } }, spec: { containers: [{ name: 'rabbitmq', image: 'rabbitmq:3.13-management', env: [{ name: 'RABBITMQ_DEFAULT_USER', value: 'ops' }, { name: 'RABBITMQ_DEFAULT_PASS', valueFrom: { secretKeyRef: { name: 'orders-login', key: 'pass' } } }] }] }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } };
  const webPod = { metadata: { name: 'web-0', namespace: 'mq', labels: { app: 'web' } }, spec: { containers: [{ name: 'nginx', image: 'nginx:1.27' }] }, status: { phase: 'Running' } };
  const f = await fixture(t, (command, args) => {
    if (args[0] === 'get' && args[1] === 'services') return output(services);
    if (args[0] === 'get' && args[1] === 'pods') return output({ items: args.includes('--selector=app=web') ? [webPod] : [mqPod] });
    if (args.includes('secret') && args.includes('orders-login')) return output({ data: { pass: Buffer.from('s3cret/+').toString('base64') } });
    return output({ items: [] });
  });
  const list = await f.request('/api/rabbitmq?context=dev&namespace=*');
  assert.equal(list.status, 200);
  assert.deepEqual(list.value.items.map(item => [item.id, item.port, item.kind, item.login.password]), [['mq/orders', 15672, 'RabbitMQ image', 'Secret orders-login › pass']]);
  assert.equal(JSON.stringify(list.value).includes('ops'), false);
  assert.equal(JSON.stringify(list.value).includes('s3cret'), false);
  const creds = await f.request('/api/rabbitmq/credentials', 'POST', { context: 'dev', namespace: 'mq', service: 'orders' });
  assert.deepEqual([creds.value.username, creds.value.password], ['ops', 's3cret/+']);
  assert.equal((await f.request('/api/rabbitmq/credentials', 'POST', { context: 'dev', namespace: 'mq', service: 'web' })).status, 404);
  assert.equal((await f.request('/api/rabbitmq/credentials', 'POST', { context: 'dev', namespace: 'mq', service: '-x' })).status, 400);
});
