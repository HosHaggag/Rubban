'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
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
