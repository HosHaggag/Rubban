'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once, EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { WebSocket } = require('ws');
const { createTeamHub } = require('./team-hub.cjs');
const { connectAgent, agentUrl } = require('./agent.cjs');
const { validateQuery, kubectlPlan, runReadQuery } = require('./kube-read.cjs');
const { loadConnection, requestForTool, createMcpBridge, startStdio } = require('./mcp.cjs');

test('Kubernetes runner permits structured reads and never arbitrary command flags', async () => {
  assert.throws(() => validateQuery({ resource: 'secrets' }), /not permitted/);
  assert.throws(() => validateQuery({ resource: 'pods', command: 'exec' }), /Unsupported/);
  assert.throws(() => validateQuery({ resource: 'pods', name: '--raw=/secrets' }), /Invalid/);
  assert.throws(() => validateQuery({ resource: 'logs', name: 'pod' }), /namespace/);
  assert.throws(() => kubectlPlan({ resource: 'pods' }, '--raw=/'), /context/);
  assert.equal(kubectlPlan({ resource: 'pods', namespace: '*' }).query.namespace, undefined);
  assert.ok(!kubectlPlan({ resource: 'pods', name: 'pod-a' }).args.includes('--all-namespaces'));
  assert.deepEqual(kubectlPlan({ resource: 'logs', namespace: 'default', name: 'pod-a' }).args, ['--request-timeout=15s', 'logs', 'pod-a', '--namespace', 'default', '--tail=200', '--limit-bytes=65536', '--timestamps=true']);
  let observed;
  const data = await runReadQuery({ resource: 'pods', namespace: 'default' }, { spawn(executable, args, options) {
    observed = { executable, args, options };
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    process.nextTick(() => { child.stdout.end('{"items":[]}'); child.stderr.end(); child.emit('close', 0); });
    return child;
  } });
  assert.deepEqual(data, { items: [] }); assert.equal(observed.options.shell, false); assert.equal(observed.options.windowsHide, true);
  assert.deepEqual(observed.args, ['--request-timeout=15s', 'get', 'pods', '--namespace', 'default', '-o', 'json']);
});

test('agent requires header credentials and TLS outside loopback', () => {
  assert.throws(() => agentUrl('ws://example.com:4520/agent', 'a'.repeat(36)), /require wss/);
  assert.throws(() => agentUrl('wss://example.com/agent?token=secret', 'a'.repeat(36)), /query/);
  assert.throws(() => agentUrl('wss://user:password@example.com/agent', 'a'.repeat(36)), /credentials/);
  assert.throws(() => createTeamHub({ host: '0.0.0.0' }), /requires TLS/);
});

test('hub authenticates users and agents, restricts assignments, correlates reads and rejects disconnects', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubban-hub-test-'));
  const adminPassword = 'test-admin-password-123'; const viewerPassword = 'test-viewer-password-456';
  const hub = createTeamHub({ host: '127.0.0.1', port: 0, dataDir, adminPassword, queryTimeoutMs: 1000 });
  const address = await hub.start(); const base = `http://127.0.0.1:${address.port}`;
  const sockets = [];
  t.after(async () => { for (const socket of sockets) socket.terminate(); await hub.close(); const absolute = path.resolve(dataDir); assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(absolute).startsWith('rubban-hub-test-')); fs.rmSync(absolute, { recursive: true, force: true }); });
  async function call(endpoint, token, body) { const response = await fetch(base + endpoint, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, body: await response.json() }; }
  assert.equal((await call('/health')).status, 200);
  assert.equal((await call('/api/clusters')).status, 401);
  const login = await call('/api/login', null, { username: 'admin', password: adminPassword }); assert.equal(login.status, 200);
  const adminToken = login.body.token; assert.ok(login.body.expiresAt > Date.now());
  const first = await call('/api/clusters', adminToken, { name: 'Development' }); assert.equal(first.status, 201);
  assert.equal((await call('/api/clusters', adminToken, { name: 'development' })).status, 409);
  const second = await call('/api/clusters', adminToken, { name: 'Production' }); assert.equal(second.status, 201);
  const clusterId = first.body.cluster.id;
  assert.equal((await call('/api/users', adminToken, { username: 'viewer', password: viewerPassword, role: 'viewer', clusterIds: [clusterId] })).status, 201);
  const viewerToken = (await call('/api/login', null, { username: 'viewer', password: viewerPassword })).body.token;
  assert.equal((await call('/api/users', viewerToken, { username: 'bad', password: viewerPassword, role: 'admin', clusterIds: [] })).status, 403);
  assert.deepEqual((await call('/api/clusters', viewerToken)).body.clusters.map(c => c.id), [clusterId]);
  assert.equal((await call(`/api/clusters/${second.body.cluster.id}/query`, viewerToken, { resource: 'pods' })).status, 403);
  assert.equal((await call(`/api/clusters/${clusterId}/query`, viewerToken, { resource: 'pods' })).status, 503);
  let disconnectedStarted;
  const disconnectedReady = new Promise(resolve => { disconnectedStarted = resolve; });
  let runnerCalls = 0;
  const agent = connectAgent({ url: `ws://127.0.0.1:${address.port}/agent`, clusterId, token: first.body.agentToken, runner: async query => { runnerCalls++; if (query.name === 'disconnect-me') { disconnectedStarted(); return new Promise(() => {}); } return { items: [{ metadata: { name: 'example-pod' } }], query }; } });
  sockets.push(agent); await once(agent, 'open');
  assert.equal((await call('/api/clusters', viewerToken)).body.clusters[0].connected, true);
  const query = await call(`/api/clusters/${clusterId}/query`, viewerToken, { resource: 'pods', namespace: 'default' });
  assert.equal(query.status, 200); assert.equal(query.body.data.items[0].metadata.name, 'example-pod');
  assert.equal((await call(`/api/clusters/${clusterId}/query`, viewerToken, { resource: 'secrets' })).status, 400);
  assert.equal((await call(`/api/clusters/${clusterId}/query`, viewerToken, { resource: 'pods', command: 'delete' })).status, 400);
  assert.equal(runnerCalls, 1);
  const oversized = await fetch(base + '/api/clusters', { method: 'POST', headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x'.repeat(17000) }) }); assert.equal(oversized.status, 413); await oversized.text();
  const pending = call(`/api/clusters/${clusterId}/query`, viewerToken, { resource: 'pods', name: 'disconnect-me' }); await disconnectedReady; agent.close(); assert.equal((await pending).status, 503);
  const invalid = new WebSocket(`ws://127.0.0.1:${address.port}/agent?clusterId=${clusterId}`, { headers: { authorization: `Bearer ${'x'.repeat(43)}` } }); sockets.push(invalid);
  const [authError] = await once(invalid, 'error'); assert.match(authError.message, /401/);
  const stored = fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'); const audit = fs.readFileSync(path.join(dataDir, 'audit.ndjson'), 'utf8');
  for (const secret of [adminPassword, viewerPassword, adminToken, viewerToken, first.body.agentToken]) { assert.ok(!stored.includes(secret)); assert.ok(!audit.includes(secret)); }
  assert.ok(audit.includes('cluster_query')); assert.ok(!audit.includes('example-pod'));
});

test('MCP bridge negotiates lifecycle, lists four read tools and uses fixed authenticated GET endpoints', async () => {
  assert.throws(() => loadConnection({ env: { RUBBAN_API_URL: 'http://example.com:4510', RUBBAN_API_TOKEN: 'token' }, argv: [] }), /127\.0\.0\.1/);
  assert.throws(() => loadConnection({ env: { RUBBAN_API_URL: 'http://127.0.0.1:4510/?x=1', RUBBAN_API_TOKEN: 'token' }, argv: [] }), /origin/);
  assert.throws(() => requestForTool('list_resources', { context: 'dev', resource: 'secrets' }), /not permitted/);
  assert.throws(() => requestForTool('list_contexts', { url: 'http://example.com' }), /Unsupported/);
  const requests = []; const token = 'private-local-api-token';
  const bridge = createMcpBridge({ url: 'http://127.0.0.1:4510', token }, { fetch: async (url, options) => { requests.push({ url: String(url), options }); return new Response(JSON.stringify({ items: [] }), { status: 200 }); } });
  const call = (id, method, params) => bridge.handle({ jsonrpc: '2.0', id, method, params });
  assert.equal((await call(1, 'tools/list')).error.code, -32002);
  assert.equal((await call(2, 'initialize', { protocolVersion: '2025-06-18' })).result.protocolVersion, '2025-06-18');
  await bridge.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.deepEqual((await call(3, 'tools/list')).result.tools.map(t => t.name), ['list_contexts', 'list_resources', 'resource_details', 'metrics']);
  assert.equal((await call(4, 'tools/call', { name: 'list_resources', arguments: { context: 'arn:aws:eks:region:account/cluster/dev', resource: 'pods', namespace: 'default' } })).result.isError, undefined);
  assert.equal(requests.length, 1); const url = new URL(requests[0].url); assert.equal(url.pathname, '/api/resources'); assert.equal(url.searchParams.get('context'), 'arn:aws:eks:region:account/cluster/dev');
  assert.equal(requests[0].options.method, 'GET'); assert.equal(requests[0].options.redirect, 'error'); assert.equal(requests[0].options.headers.authorization, `Bearer ${token}`);
  assert.equal((await call(5, 'tools/call', { name: 'resource_details', arguments: { context: 'dev', resource: 'pods', name: '--raw' } })).error.code, -32602); assert.equal(requests.length, 1);
});

test('MCP stdio emits only newline JSON-RPC and reports malformed input without credential output', async () => {
  const input = new PassThrough(); const output = new PassThrough(); let text = '';
  const bridge = createMcpBridge({ url: 'http://127.0.0.1:4510', token: 'not-for-output' }, { fetch: async () => new Response('{"contexts":[]}') });
  const complete = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('stdio responses timed out')), 1000); output.on('data', chunk => { text += chunk; if (text.split('\n').filter(Boolean).length === 4) { clearTimeout(timer); resolve(); } }); });
  startStdio(bridge, input, output);
  input.end('invalid-json\n' + JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_contexts', arguments: {} } }) + '\n');
  await complete; const responses = text.trim().split('\n').map(JSON.parse); assert.equal(responses[0].error.code, -32700); assert.ok(responses.every(r => r.jsonrpc === '2.0')); assert.ok(!text.includes('not-for-output'));
});
