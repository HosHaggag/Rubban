'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createExtras, validateServiceURL, queryArgs, jsonFetch } = require('./extras.cjs');
function harness(extraOptions = {}) {
  const extras = createExtras(extraOptions); const calls = []; let sent;
  return {
    calls,
    invoke: async (route, { method = 'GET', body, prefs = {}, run } = {}) => {
      sent = undefined;
      const handled = await extras({ req: { method }, res: {}, url: new URL(route, 'http://127.0.0.1:1234'), body,
        readJSON: async () => body || {}, sendJSON: (_res, status, data) => { sent = { status, data }; },
        run: run || (async (command, args, opts) => { calls.push({ command, args, opts }); return { stdout: '{"items":[]}', stderr: '', code: 0 }; }),
        config: { kubectlPath: 'kubectl-test.exe', dataDir: '.', readPreferences: async () => prefs } });
      return { handled, ...sent };
    },
  };
}

test('Codex assistant accepts non-Git installs while retaining read-only sandbox and stdin prompts', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rubban-ai-test-'));
  const previousPath = process.env.PATH;
  fs.writeFileSync(path.join(directory, process.platform === 'win32' ? 'codex.exe' : 'codex'), 'fixture executable; runner is mocked');
  process.env.PATH = directory;
  t.after(() => { process.env.PATH = previousPath; fs.rmSync(directory, { recursive: true, force: true }); });
  const h = harness();
  const prompt = 'hello --dangerously-bypass-approvals-and-sandbox';
  const result = await h.invoke('/api/ai', { method: 'POST', body: { command: 'codex', prompt }, run: async (command, args, opts) => {
    h.calls.push({ command, args, opts }); return { stdout: 'Hello from the fixture', stderr: '', code: 0 };
  } });
  assert.equal(result.data.output, 'Hello from the fixture');
  const call = h.calls[0];
  assert.ok(call.args.includes('--skip-git-repo-check'));
  assert.equal(call.args[call.args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(call.args.at(-1), '-');
  assert.equal(call.args.includes(prompt), false);
  assert.ok(call.opts.input.endsWith(prompt + '\n'));
  assert.equal(call.opts.timeoutMs, 180000);
});
test('integration availability retains individual failures rather than inventing empty success', async () => {
  const h = harness();
  const result = await h.invoke('/api/integrations?context=test&namespace=apps', { run: async (_command, args) => {
    if (args[1].startsWith('applications')) throw new Error('Argo controller not installed');
    return { stdout: '{"items":[{"metadata":{"name":"observed"}}]}' };
  } });
  assert.equal(result.data.groups.length, 6);
  assert.equal(result.data.groups.find(g => g.id === 'argo-applications').available, false);
  assert.equal(result.data.groups[0].items[0].metadata.name, 'observed');
});
test('GitOps operations use fixed kubectl operations and exact literal targets', async () => {
  const h = harness();
  await h.invoke('/api/gitops', { method: 'POST', body: { context: 'dev', namespace: 'apps', kind: 'kustomizations.kustomize.toolkit.fluxcd.io', name: 'website', action: 'suspend' } });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].args[0], 'patch');
  assert.deepEqual(JSON.parse(h.calls[0].args.at(-1)), { spec: { suspend: true } });
  await assert.rejects(h.invoke('/api/gitops', { method: 'POST', body: { context: 'dev', namespace: 'apps', kind: 'pods', name: 'website', action: 'delete' } }), /Unsupported/);
});
test('unconfigured costs are explicitly unavailable and make no remote request', async () => {
  const h = harness({ fetchJSON: async () => { throw new Error('Unexpected remote request'); } });
  const result = await h.invoke('/api/cost');
  assert.equal(result.data.available, false); assert.match(result.data.reason, /Configure/);
});
test('cost queries only use the saved endpoint and supported windows', async () => {
  let requested;
  const h = harness({ fetchJSON: async u => { requested = new URL(u); return { data: [] }; } });
  const result = await h.invoke('/api/cost?period=7d&url=http://attacker.invalid', { prefs: { opencostUrl: 'http://127.0.0.1:9003' } });
  assert.equal(result.data.available, true); assert.equal(requested.hostname, '127.0.0.1');
  assert.equal(requested.pathname, '/allocation'); assert.equal(requested.searchParams.get('window'), '7d');
  await assert.rejects(h.invoke('/api/cost?period=forever', { prefs: { opencostUrl: 'http://127.0.0.1:9003' } }), /Unsupported/);
});
test('remote plaintext collaboration login is rejected before credentials leave device', async () => {
  let touched = false;
  const h = harness({ fetchJSON: async () => { touched = true; return {}; } });
  await assert.rejects(h.invoke('/api/team/login', { method: 'POST', body: { url: 'http://remote.invalid', username: 'user', password: 'never-send' } }), /HTTPS/);
  assert.equal(touched, false);
});
test('team sessions do not disclose session token through configuration endpoint', async () => {
  const h = harness({ fetchJSON: async (url) => new URL(url).pathname === '/api/login' ? { token: 'test-session-token' } : { clusters: [{ id: 'dev', name: 'Development', connected: true }] } });
  const result = await h.invoke('/api/team/login', { method: 'POST', body: { url: 'https://hub.example', username: 'admin', password: 'test-value' } });
  assert.equal(result.data.clusters[0].name, 'Development');
  const config = await h.invoke('/api/team'); assert.equal(config.data.configured, true);
  assert.equal(JSON.stringify(config.data).includes('test-session-token'), false);
});
test('service URLs reject embedded passwords and non-web schemes', () => {
  assert.throws(() => validateServiceURL('http://user:password@host/'));
  assert.throws(() => validateServiceURL('file:///C:/secret'));
  assert.equal(validateServiceURL('https://metrics.example').hostname, 'metrics.example');
});
test('query target validation rejects namespace argument injection', () => {
  assert.throws(() => queryArgs('dev', '--server=example'));
  assert.throws(() => queryArgs('dev\n--server=x', 'apps'));
  assert.deepEqual(queryArgs('dev', '*'), ['--context', 'dev', '--all-namespaces']);
});
test('remote JSON response limit cancels streaming before buffering unbounded data', async () => {
  const original = global.fetch; let pulls = 0, cancelled = false;
  global.fetch = async () => new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(256 * 1024)); if (pulls === 1000) controller.close(); },
    cancel() { cancelled = true; },
  }));
  try {
    await assert.rejects(jsonFetch('http://127.0.0.1:1234'), /exceeds 12 MiB/);
    assert.ok(pulls < 55); assert.equal(cancelled, true);
  } finally { global.fetch = original; }
});
