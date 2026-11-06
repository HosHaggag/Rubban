import test from 'node:test';
import assert from 'node:assert/strict';
import { createMiner, parseLine, tokenize, maskToken, parseTime, summarize, spikeOf, seriesOf, streamNow, templateParts, templateText, normalizeLevel } from './logpatterns.js';

const T0 = Date.UTC(2026, 10, 6, 14, 0, 0);
const iso = ms => new Date(ms).toISOString();
// A small deterministic generator, so the synthetic logs are the same on every run.
function rng(seed = 7) { let x = seed; return () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; }; }
const hex8 = random => Math.floor(random() * 0xffffffff).toString(16).padStart(8, '0');

// The demo's shop/storefront: five pods of health checks, the odd 503, slow upstream warnings.
const STOREFRONT = ['storefront-6f456b6bc8-5c978', 'storefront-6f456b6bc8-x9k2p', 'storefront-6f456b6bc8-q7rtw', 'storefront-6f456b6bc8-mm2fd', 'storefront-6f456b6bc8-b8zcl'];
function storefrontLine(random, at, i) {
  const pod = STOREFRONT[i % STOREFRONT.length];
  const r = random();
  const ms = Math.floor(random() * 90) + 1;
  const body = r < 0.01 ? `INFO  demo GET /healthz 503 ${ms}ms trace=${hex8(random)}`
    : r < 0.02 ? `WARN  demo GET /healthz took ${300 + Math.floor(random() * 900)}ms (slow upstream: postgres)`
      : `INFO  demo GET /healthz 200 ${ms}ms trace=${hex8(random)}`;
  return `[${pod}/storefront] ${iso(at)} ${body}\n`;
}

test('parseLine strips the pod prefix, timestamps and the level', () => {
  const line = parseLine('[storefront-6f456b6bc8-5c978/storefront] 2026-11-06T14:29:17.482123456Z 2026-11-06T14:29:17.482Z INFO  demo GET /healthz 200 13ms trace=6a5f4e8e\n');
  assert.equal(line.pod, 'storefront-6f456b6bc8-5c978');
  assert.equal(line.container, 'storefront');
  assert.equal(line.ts, Date.UTC(2026, 10, 6, 14, 29, 17, 482));
  assert.equal(line.level, 'info');
  assert.equal(line.message, 'demo GET /healthz 200 13ms trace=6a5f4e8e');
  assert.equal(parseLine('2026-11-06T14:26:52.165Z ERROR demo dial tcp 10.96.41.7:5672: connect: connection refused').level, 'error');
  assert.equal(parseLine('[WARN] disk almost full').level, 'warn');
  assert.equal(parseLine('ERROR: boom').message, 'boom');
  assert.equal(parseLine('2026-11-06 14:29:17,482 - app.db - WARNING - pool exhausted').message, 'pool exhausted');
  assert.equal(parseLine('2026/11/06 14:29:17 listening on :8080').ts, Date.UTC(2026, 10, 6, 14, 29, 17));
  assert.deepEqual(parseLine('Info about nothing'), { pod: '', container: '', ts: NaN, level: '', message: 'Info about nothing' });
  const klog = parseLine('E1106 14:29:17.482123    1 controller.go:123] sync failed');
  assert.equal(klog.level, 'error'); assert.equal(klog.message, 'sync failed');
});

test('JSON and logfmt lines are unwrapped to level, time and message', () => {
  const json = parseLine('{"level":"error","ts":1793975357.5,"msg":"upstream failed","status":503,"trace":"abc"}');
  assert.equal(json.level, 'error'); assert.equal(json.ts, 1793975357500); assert.equal(json.message, 'upstream failed status=503');
  assert.equal(parseLine('{"severity":"WARNING","message":"slow","time":"2026-11-06T14:00:00Z"}').ts, T0);
  assert.equal(parseLine('{"level":50,"msg":"pino error"}').level, 'error');
  assert.equal(parseLine('{"not":"a log"').message, '{"not":"a log"');
  const logfmt = parseLine('time=2026-11-06T14:00:00Z level=warn msg="cache miss" key=user:42');
  assert.deepEqual([logfmt.level, logfmt.ts, logfmt.message], ['warn', T0, 'cache miss key=user:42']);
  assert.equal(normalizeLevel('Critical'), 'error'); assert.equal(normalizeLevel(''), '');
  assert.equal(parseTime('2026-11-06T16:00:00+02:00'), T0);
  assert.ok(Number.isNaN(parseTime('yesterday-ish')));
});

test('variables are masked: numbers, durations, ids, addresses, pod names, quotes; status codes stay', () => {
  assert.equal(maskToken('13ms'), '<*>');
  assert.equal(maskToken('1h2m3s'), '<*>');
  assert.equal(maskToken('trace=6a5f4e8e'), 'trace=<*>');
  assert.equal(maskToken('trace=fbcadeef'), 'trace=<*>');
  assert.equal(maskToken('10.96.41.7:5672:'), '<*>:');
  assert.equal(maskToken('/api/orders/550e8400-e29b-41d4-a716-446655440000/items/7'), '/api/orders/<*>/items/<*>');
  assert.equal(maskToken('storefront-6f456b6bc8-5c978'), 'storefront-<*>');
  assert.equal(maskToken('session-store-0'), 'session-store-<*>');
  assert.equal(maskToken('512MiB'), '<*>');
  assert.equal(maskToken('v1'), 'v1');
  assert.equal(maskToken('http2'), 'http2');
  assert.equal(maskToken('sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'), 'sha256:<*>');
  assert.equal(tokenize('user "alice smith" not found').tokens.join(' '), 'user "<*>" not found');
  const http = tokenize('GET /healthz 503 13ms trace=6a5f4e8e');
  assert.equal(http.tokens.join(' '), 'GET /healthz 503 <*> trace=<*>');
  assert.equal(http.pinned, '1:/healthz 2:503 ');
  assert.equal(tokenize('"GET /a HTTP/1.1" 404 12').pinned, '1:/a 3:404 ');
  assert.equal(tokenize('GET /api/orders/123?x=1 200').pinned, '1:/api/orders 2:200 ');
  assert.equal(tokenize('GET /123/x 200').pinned, '2:200 ', 'no route when the first segment is an id');
  assert.equal(tokenize('retrying 503 times').pinned, '');
});

test('the demo storefront and checkout-worker fold into their templates', () => {
  const miner = createMiner(); const random = rng(1);
  let at = T0;
  for (let i = 0; i < 5000; i++) { at += 200; miner.add(storefrontLine(random, at, i), at); }
  for (let i = 0; i < 6; i++) {
    for (const pod of ['checkout-worker-6dcd857f99-4gsfj', 'checkout-worker-6dcd857f99-rjcsq']) {
      miner.add(`[${pod}/worker] ${iso(at)} INFO  demo starting worker (version 1.0.0)\n`, at);
      miner.add(`[${pod}/worker] ${iso(at)} INFO  demo connecting to amqp://rabbitmq.shop.svc:5672\n`, at);
      miner.add(`[${pod}/worker] ${iso(at + 3000)} ERROR demo dial tcp 10.96.41.${7 + i}:5672: connect: connection refused\n`, at);
    }
  }
  const { rows } = summarize(miner, { now: at + 3000 });
  const templates = Object.fromEntries(rows.map(row => [row.template, row]));
  assert.deepEqual(Object.keys(templates).sort(), [
    'demo GET /healthz 200 <*> trace=<*>',
    'demo GET /healthz 503 <*> trace=<*>',
    'demo GET /healthz took <*> (slow upstream: postgres)',
    'demo connecting to amqp://rabbitmq.shop.svc:<*>',
    'demo dial tcp <*>: connect: connection refused',
    'demo starting worker (version <*>)',
  ].sort());
  assert.equal(rows[0].template, 'demo GET /healthz 200 <*> trace=<*>');
  assert.equal(rows[0].pods.length, 5);
  assert.equal(templates['demo dial tcp <*>: connect: connection refused'].level, 'error');
  assert.equal(templates['demo dial tcp <*>: connect: connection refused'].count, 12);
  assert.equal(templates['demo GET /healthz took <*> (slow upstream: postgres)'].level, 'warn');
  assert.equal(rows.reduce((sum, row) => sum + row.count, 0), miner.total);
  // Sort orders.
  assert.equal(summarize(miner, { now: at, sort: 'severity' }).rows[0].level, 'error');
  assert.equal(summarize(miner, { now: at, sort: 'newest' }).rows[0].firstSeen, Math.max(...rows.map(row => row.firstSeen)));
});

test('match finds the pattern of a line without counting it', () => {
  const miner = createMiner();
  const a = miner.add('INFO GET /healthz 200 13ms trace=6a5f4e8e', T0);
  miner.add('INFO GET /healthz 200 8ms trace=1b2c3d4e', T0);
  const b = miner.add('ERROR dial tcp 10.0.0.1:5672: connect: connection refused', T0);
  assert.equal(miner.match('INFO GET /healthz 200 99ms trace=ffff0000'), a.id);
  assert.equal(miner.match('ERROR dial tcp 10.0.0.9:5672: connect: connection refused'), b.id);
  assert.equal(miner.match('INFO GET /healthz 503 99ms trace=ffff0000'), 0);
  assert.equal(miner.match('something else entirely'), 0);
  assert.equal(miner.total, 3);
  assert.equal(templateText(a), 'GET /healthz 200 <*> trace=<*>');
});

test('request paths: routes never fold together, ids and slugs under one route do', () => {
  const miner = createMiner();
  const health = miner.add('INFO GET /healthz 200 5ms trace=6a5f4e8e', T0);
  const orders = miner.add('INFO GET /api/orders/12345 200 33ms trace=7f79140f', T0);
  miner.add('INFO GET /api/orders/67890 200 12ms trace=1cfd274a', T0);
  assert.notEqual(health.id, orders.id);
  assert.equal(templateText(orders), 'GET /api/orders/<*> 200 <*> trace=<*>');
  miner.add('INFO GET /products/blue-shirt 200 4ms', T0);
  const products = miner.add('INFO GET /products/red-hat 200 9ms', T0);
  assert.equal(templateText(products), 'GET /products/<*> 200 <*>');
  assert.equal(miner.match('INFO GET /products/green-socks 200 1ms'), products.id);
  assert.equal(miner.match('INFO GET /api/users/1 200 1ms trace=abcdef12'), 0);
  assert.equal(miner.size, 3);
});

test('different words in the same place generalise to <*>, key=value keeps its key', () => {
  const miner = createMiner();
  miner.add('user alice logged in from web session=a1', T0);
  const cluster = miner.add('user bob logged in from web session=b2', T0);
  assert.equal(templateText(cluster), 'user <*> logged in from web session=<*>');
  miner.add('job alpha mode=fast', T0);
  assert.equal(templateText(miner.add('job alpha mode=slow', T0)), 'job alpha mode=<*>');
  assert.equal(miner.size, 2);
});

test('new patterns: only after the warm-up, only for a few minutes', () => {
  const miner = createMiner();
  for (let s = 0; s < 600; s += 5) miner.add(`${iso(T0 + s * 1000)} INFO tick ${s}`, T0);
  miner.add(`${iso(T0 + 10000)} INFO early bird`, T0);
  miner.add(`${iso(T0 + 590000)} ERROR fresh failure 1`, T0);
  const rows = Object.fromEntries(summarize(miner, { now: T0 + 600000 }).rows.map(row => [row.template, row]));
  assert.equal(rows['tick <*>'].isNew, false);
  assert.equal(rows['early bird'].isNew, false, 'first seen inside the warm-up');
  assert.equal(rows['fresh failure <*>'].isNew, true);
  assert.equal(summarize(miner, { now: T0 + 600000 + 6 * 60000 }).rows.find(row => row.template === 'fresh failure <*>').isNew, false);
});

test('spikes: far above the pattern\'s own baseline, with a minimum count, never during warm-up', () => {
  const miner = createMiner();
  let at = T0;
  // Ten minutes of a steady 2 lines a minute, then 42 in the last minute.
  for (; at < T0 + 600000; at += 30000) miner.add(`${iso(at)} ERROR dial tcp 10.0.0.${at % 7}:5672: connect: connection refused`, at);
  for (; at < T0 + 600000 + 30000; at += 30000) miner.add(`${iso(at)} INFO steady state`, at);
  const steady = miner.patterns().find(cluster => templateText(cluster).startsWith('dial'));
  assert.equal(spikeOf(steady, miner, at), null);
  for (let i = 0; i < 42; i++) miner.add(`${iso(at + i * 1000)} ERROR dial tcp 10.0.0.${i % 7}:5672: connect: connection refused`, at);
  const now = at + 42000;
  const spike = spikeOf(steady, miner, now);
  assert.ok(spike, 'spike detected');
  assert.ok(spike.count >= 42 && spike.baseline < 4, JSON.stringify(spike));
  const summary = summarize(miner, { now });
  assert.equal(summary.spikes[0].id, steady.id);
  // A steady high rate is not a spike.
  const busy = createMiner();
  for (let t = T0; t < T0 + 900000; t += 1000) busy.add(`${iso(t)} INFO GET /healthz 200 ${t % 50}ms`, t);
  assert.equal(summarize(busy, { now: T0 + 900000 }).spikes.length, 0);
  // A stream that starts mid-window (a tail of 500 lines) does not count that window as quiet.
  const tail = createMiner();
  for (let t = T0 + 55000; t < T0 + 130000; t += 5000) tail.add(`${iso(t)} INFO POST /api/cart/1/items 201 ${t % 9}ms`, t);
  for (let t = T0 + 130000; t <= T0 + 189000; t += 3000) tail.add(`${iso(t)} INFO POST /api/cart/1/items 201 ${t % 9}ms`, t);
  assert.equal(summarize(tail, { now: T0 + 189000 }).spikes.length, 0);
  // A burst at the very start of a stream is not a spike: no baseline yet.
  const fresh = createMiner();
  for (let i = 0; i < 100; i++) fresh.add(`${iso(T0 + i * 100)} ERROR boom ${i}`, T0);
  assert.equal(summarize(fresh, { now: T0 + 10000 }).spikes.length, 0);
});

test('lines without timestamps use the arrival time; streamNow follows the wall clock for recent logs', () => {
  const miner = createMiner();
  miner.add('no time here', T0 + 5000);
  assert.equal(miner.start, T0 + 5000);
  assert.equal(streamNow(miner, T0 + 60000), T0 + 60000);
  assert.equal(streamNow(miner, T0 + 86400000), T0 + 5000, 'old logs keep their own clock');
  const series = seriesOf(miner.patterns()[0], miner, T0 + 60000, 30);
  assert.equal(series.values.length, 30);
  assert.equal(series.values.reduce((a, b) => a + b, 0), 1);
});

test('memory is bounded: patterns are capped and histograms are fixed rings', () => {
  const miner = createMiner({ maxPatterns: 50 });
  // Words made of letters only (no digits to mask), different in every position: every line is its own pattern.
  const word = n => { let out = 'q'; for (let v = n; v > 0; v = Math.floor(v / 26)) out += String.fromCharCode(103 + (v % 20)); return out; };
  for (let i = 0; i < 2000; i++) miner.add(`${iso(T0 + i * 1000)} INFO ${word(i * 3)} ${word(i * 3 + 1)} ${word(i * 3 + 2)}`, T0);
  assert.ok(miner.size <= 50, `${miner.size} patterns`);
  assert.ok(miner.evicted > 0);
  for (const cluster of miner.patterns()) assert.equal(cluster.hist.length, 360);
  const long = createMiner();
  const cluster = long.add(`INFO ${'a'.repeat(10000)}`, T0);
  assert.ok(cluster.example.length <= 501);
  // Old lines past the ring are counted but not drawn; the ring never grows.
  const ring = createMiner();
  for (let h = 0; h < 5; h++) ring.add(`${iso(T0 + h * 3600000)} INFO hourly`, T0);
  assert.equal(ring.patterns()[0].count, 5);
  assert.equal(ring.patterns()[0].hist.reduce((a, b) => a + b, 0), 1);
});

test('templateParts marks the masked parts', () => {
  assert.deepEqual(templateParts('dial tcp <*>: connect'), [{ text: 'dial tcp ', masked: false }, { text: '<*>', masked: true }, { text: ': connect', masked: false }]);
  assert.deepEqual(templateParts('<*>'), [{ text: '<*>', masked: true }]);
});

test('100k synthetic lines cluster in well under a second', () => {
  const random = rng(42); const lines = []; let at = T0;
  const extra = [
    () => `ERROR demo dial tcp 10.96.${Math.floor(random() * 255)}.${Math.floor(random() * 255)}:5672: connect: connection refused`,
    () => `INFO  demo order ${Math.floor(random() * 1e6)} placed by user ${hex8(random)}-${hex8(random).slice(0, 4)} in ${Math.floor(random() * 900)}ms`,
    () => `{"level":"warn","msg":"cache miss","key":"product:${Math.floor(random() * 1e5)}","ts":${(at / 1000).toFixed(3)}}`,
    () => `DEBUG demo GET /api/products/${Math.floor(random() * 1e4)} 200 ${Math.floor(random() * 40)}ms`,
  ];
  for (let i = 0; i < 100000; i++) {
    at += 10;
    lines.push(random() < 0.8 ? storefrontLine(random, at, i) : `[catalog-5d8f9c7b6a-k2j4h/catalog] ${iso(at)} ${extra[i % extra.length]()}\n`);
  }
  // CPU time of this process, best of two runs: other work on the machine does not count against it.
  let miner; let summary; let best = Infinity; let wall = Infinity;
  for (let run = 0; run < 2; run++) {
    const cpu = process.cpuUsage(); const started = performance.now();
    miner = createMiner();
    for (const line of lines) miner.add(line, at);
    summary = summarize(miner, { now: at });
    const used = process.cpuUsage(cpu);
    best = Math.min(best, (used.user + used.system) / 1000); wall = Math.min(wall, performance.now() - started);
  }
  console.log(`# 100k lines: ${best.toFixed(0)} ms CPU (${wall.toFixed(0)} ms wall), ${miner.size} patterns`);
  assert.ok(best < 1000, `took ${best.toFixed(0)} ms of CPU`);
  const templates = summary.rows.map(row => row.template);
  for (const expected of ['demo GET /healthz 200 <*> trace=<*>', 'demo GET /healthz 503 <*> trace=<*>', 'demo GET /healthz took <*> (slow upstream: postgres)', 'demo dial tcp <*>: connect: connection refused', 'demo order <*> placed by user <*> in <*>', 'cache miss', 'demo GET /api/products/<*> 200 <*>']) assert.ok(templates.includes(expected), `missing ${expected}: ${templates.join(' | ')}`);
  assert.equal(miner.size, 7);
  assert.equal(summary.rows.reduce((sum, row) => sum + row.count, 0), 100000);
});
