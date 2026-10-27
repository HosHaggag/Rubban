'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const vm = require('node:vm');
const { managementPort, credentialPlan, describeSource } = require('./rabbitmq.cjs');
const { createEmbedProxy, frameHeaders, injectBridge, bridgeScript } = require('./embed-proxy.cjs');

const pod = (containers, labels = {}, volumes = []) => ({ metadata: { name: 'mq-0', labels }, spec: { containers, volumes } });

test('console login waits for a delayed form and verifies authentication', () => {
  let now = 0, submitted = false, handler;
  const timers = [], messages = [];
  const parent = { postMessage: data => messages.push(data.type) };
  const user = { value: '', form: { querySelector: () => ({ click: () => { submitted = true; } }) } };
  const password = { value: '' };
  const document = { querySelector(selector) {
    if (selector.includes('#logout')) return submitted ? {} : null;
    if (now < 3000 || submitted) return null;
    if (selector === 'input[name="username"]') return user;
    if (selector === 'input[name="password"]') return password;
    return null;
  } };
  const window = { parent, addEventListener: (_event, fn) => { handler = fn; } };
  vm.runInNewContext(bridgeScript(['http://127.0.0.1:1']), { window, document, Date: { now: () => now }, setTimeout: fn => timers.push(fn) });
  handler({ source: {}, origin: 'http://127.0.0.1:1', data: { type: 'rubban:login', username: 'wrong' } });
  assert.equal(timers.length, 0);
  handler({ source: parent, origin: 'http://127.0.0.1:1', data: { type: 'rubban:login', username: 'fixture-user', password: 'fixture-password' } });
  for (let step = 0; timers.length && step < 50; step++) { now += 150; timers.shift()(); }
  assert.equal(user.value, 'fixture-user');
  assert.equal(password.value, 'fixture-password');
  assert.equal(submitted, true);
  assert.ok(messages.includes('rubban:authenticated'));
  assert.equal(messages.includes('rubban:login-timeout'), false);
});

test('embedded Secret login endpoint requires its capability and same-origin requests', async t => {
  let reads = 0;
  const proxy = await createEmbedProxy({ targetPort: 1, parentOrigins: ['http://127.0.0.1:4000'], credentials: async () => ({ username: 'fixture', password: `rotation-${++reads}` }) });
  t.after(() => proxy.close());
  const base = `http://127.0.0.1:${proxy.port}`;
  assert.equal((await fetch(`${base}/__rubban/login`)).status, 403);
  const script = await (await fetch(`${base}/__rubban/bridge.js`)).text();
  const token = /const LOGIN_TOKEN = "([a-f0-9]+)"/.exec(script)[1];
  const headers = { 'X-Rubban-Embed-Token': token };
  assert.equal((await fetch(`${base}/__rubban/login`, { headers: { ...headers, Origin: 'http://untrusted.example' } })).status, 403);
  const response = await fetch(`${base}/__rubban/login`, { headers });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).password, 'rotation-1');
  assert.equal((await (await fetch(`${base}/__rubban/login`, { headers })).json()).password, 'rotation-2');
});

test('management ports are found by number or name; TLS only as a fallback', () => {
  assert.deepEqual(managementPort({ spec: { ports: [{ name: 'amqp', port: 5672 }, { name: 'management', port: 15672 }] } }), { port: 15672, name: 'management', scheme: 'http' });
  assert.deepEqual(managementPort({ spec: { ports: [{ name: 'http-stats', port: 8080, targetPort: 'stats' }] } }), { port: 8080, name: 'http-stats', scheme: 'http' });
  assert.deepEqual(managementPort({ spec: { ports: [{ name: 'management-tls', port: 15671 }] } }), { port: 15671, name: 'management-tls', scheme: 'https' });
  assert.equal(managementPort({ spec: { ports: [{ name: 'amqp', port: 5672 }] } }), null);
});

test('initial login sources: operator Secret, env literal / secretKeyRef / _FILE, envFrom and guest', () => {
  const operator = credentialPlan(pod([{ name: 'rabbitmq', image: 'rabbitmq:3.13' }], { 'app.kubernetes.io/part-of': 'rabbitmq', 'app.kubernetes.io/name': 'orders' }));
  assert.equal(operator.kind, 'Cluster Operator');
  assert.deepEqual(operator.password, { type: 'secret', secret: 'orders-default-user', key: 'password' });

  const bitnami = credentialPlan(pod([{ name: 'rabbitmq', image: 'docker.io/bitnami/rabbitmq:3.12', env: [{ name: 'RABBITMQ_USERNAME', value: 'app' }, { name: 'RABBITMQ_PASSWORD', valueFrom: { secretKeyRef: { name: 'mq', key: 'rabbitmq-password' } } }] }]));
  assert.equal(bitnami.kind, 'Bitnami');
  assert.deepEqual(bitnami.username, { type: 'literal', via: 'RABBITMQ_USERNAME' });
  assert.equal(describeSource(bitnami.password), 'Secret mq › rabbitmq-password');
  // Literal values are never part of the plan used for lists.
  assert.equal(JSON.stringify(bitnami).includes('"app"'), false);

  const bitnamiDefaults = credentialPlan(pod([{ name: 'rabbitmq', image: 'bitnami/rabbitmq:4.0', env: [{ name: 'RABBITMQ_PASSWORD', valueFrom: { secretKeyRef: { name: 'mq', key: 'rabbitmq-password' } } }] }]));
  assert.deepEqual(bitnamiDefaults.username, { type: 'default', value: 'user' });

  const fileBased = credentialPlan(pod([{ name: 'rabbitmq', image: 'bitnami/rabbitmq:4.0', env: [{ name: 'RABBITMQ_PASSWORD_FILE', value: '/opt/bitnami/rabbitmq/secrets/rabbitmq-password' }], volumeMounts: [{ name: 'creds', mountPath: '/opt/bitnami/rabbitmq/secrets' }] }], {}, [{ name: 'creds', secret: { secretName: 'mq-files' } }]));
  assert.deepEqual(fileBased.password, { type: 'secret', secret: 'mq-files', key: 'rabbitmq-password', via: 'RABBITMQ_PASSWORD_FILE' });

  const envFrom = credentialPlan(pod([{ name: 'broker', image: 'rabbitmq:4.1-management', envFrom: [{ secretRef: { name: 'broker-env' }, prefix: '' }] }]));
  assert.equal(envFrom.password.type, 'secret-envfrom');
  assert.deepEqual(envFrom.password.alternatives, ['RABBITMQ_DEFAULT_PASS', 'RABBITMQ_PASSWORD']);
  assert.equal(envFrom.password.fallback, 'guest');

  const plain = credentialPlan(pod([{ name: 'broker', image: 'rabbitmq:4.1-management' }]));
  assert.deepEqual([plain.username, plain.password], [{ type: 'default', value: 'guest' }, { type: 'default', value: 'guest' }]);
  assert.equal(describeSource(plain.password), 'RabbitMQ default (guest)');
});

test('embed proxy: frame headers, injected bridge, raw paths and Host checks', async t => {
  assert.deepEqual(frameHeaders({ 'x-frame-options': 'DENY', 'content-security-policy': "script-src 'self'; frame-ancestors 'none'" }, ['http://127.0.0.1:1']),
    { 'content-security-policy': ["script-src 'self'; frame-ancestors http://127.0.0.1:1"] });
  assert.match(injectBridge('<html><head><title>x</title></head><body></body></html>'), /<script src="\/__rubban\/bridge.js"><\/script><\/head>/);
  assert.match(bridgeScript(['http://127.0.0.1:9']), /PARENTS = \["http:\/\/127\.0\.0\.1:9"\]/);

  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization || '' });
    if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html', 'X-Frame-Options': 'SAMEORIGIN' }); res.end('<html><head></head><body>console</body></html>'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await createEmbedProxy({ targetPort: upstream.address().port, parentOrigins: ['http://127.0.0.1:4000'] });
  t.after(async () => { await proxy.close(); upstream.close(); });
  const base = `http://127.0.0.1:${proxy.port}`;

  const page = await fetch(`${base}/`);
  assert.equal(page.headers.get('x-frame-options'), null);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors http:\/\/127\.0\.0\.1:4000$/);
  assert.match(await page.text(), /__rubban\/bridge\.js/);

  const api = await fetch(`${base}/api/queues/%2F/orders`, { headers: { Authorization: 'Basic eDp5' } });
  assert.equal(await api.text(), '[]');
  assert.deepEqual(seen.at(-1), { url: '/api/queues/%2F/orders', auth: 'Basic eDp5' });

  const bridge = await fetch(`${base}/__rubban/bridge.js`);
  assert.match(await bridge.text(), /rubban:login/);

  const rebinding = await new Promise(resolve => http.get({ host: '127.0.0.1', port: proxy.port, path: '/', headers: { Host: `attacker.example:${proxy.port}` } }, res => resolve(res.statusCode)));
  assert.equal(rebinding, 403);
});
