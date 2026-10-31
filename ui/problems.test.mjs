import test from 'node:test';
import assert from 'node:assert/strict';
import { createProblemStore } from './problems.js';

const MIN = 60_000;
function harness({ argo = false } = {}) {
  let clock = Date.parse('2026-05-01T12:00:00Z');
  const timers = []; const storage = {}; const feeds = []; let changes = 0;
  const liveList = options => feeds.push(options);
  const store = createProblemStore({
    liveList, hasArgo: () => argo, now: () => clock,
    readStore: (key, fallback) => storage[key] ?? fallback, writeStore: (key, value) => { storage[key] = value; },
    setTimer: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; },
    clearTimer: id => { if (timers[id - 1]) timers[id - 1].live = false; },
    onChange: () => { changes++; },
  });
  const flush = () => { for (const timer of [...timers]) if (timer.live && timer.ms === 200) { timer.live = false; timer.fn(); } };
  return { store, feeds, timers, storage, flush, advance: ms => { clock += ms; }, changes: () => changes, feedFor: (context, resource) => feeds.filter(f => f.context === context && f.resource === resource).at(-1) };
}
const crashing = (name, ns = 'shop') => ({ metadata: { name, namespace: ns, creationTimestamp: '2026-05-01T10:00:00Z' }, status: { phase: 'Running', containerStatuses: [{ name: 'app', state: { waiting: { reason: 'CrashLoopBackOff' } } }] } });

test('feeds open only after the first render of a tab on that cluster, for every watched kind, all namespaces', () => {
  const h = harness();
  h.store.sync(['prod']);
  assert.equal(h.feeds.length, 0);
  h.store.contextRendered('prod');
  assert.deepEqual(h.feeds.map(f => f.resource).sort(), ['daemonsets', 'deployments', 'jobs', 'nodes', 'persistentvolumeclaims', 'pods', 'statefulsets']);
  assert.ok(h.feeds.every(f => f.context === 'prod' && f.namespace === '*' && f.signal instanceof AbortSignal));
  h.store.contextRendered('prod');
  assert.equal(h.feeds.length, 7, 'rendering again does not subscribe again');
});

test('Argo CD applications are watched only when the cluster has them', () => {
  const withArgo = harness({ argo: true }); withArgo.store.sync(['prod']); withArgo.store.contextRendered('prod');
  assert.ok(withArgo.feeds.some(f => f.resource === 'applications.argoproj.io'));
  const without = harness(); without.store.sync(['prod']); without.store.contextRendered('prod');
  assert.ok(!without.feeds.some(f => f.resource === 'applications.argoproj.io'));
});

test('data from a feed becomes problems, debounced, and counted per cluster', () => {
  const h = harness();
  h.store.sync(['prod', 'staging']); h.store.contextRendered('prod'); h.store.contextRendered('staging');
  h.feedFor('staging', 'pods').onData([crashing('api')]);
  assert.deepEqual(h.store.all(), [], 'nothing before the debounce fires');
  h.flush();
  const [problem] = h.store.all();
  assert.equal(problem.context, 'staging'); assert.equal(problem.title, 'CrashLoopBackOff');
  assert.deepEqual(h.store.countsFor('staging'), { critical: 1, warning: 0, info: 0 });
  assert.deepEqual(h.store.countsFor('prod'), { critical: 0, warning: 0, info: 0 });
  assert.deepEqual(h.store.totals(), { critical: 1, warning: 0, info: 0 });
});

test('closing the last tab of a cluster removes its problems and aborts its feeds', () => {
  const h = harness();
  h.store.sync(['prod', 'staging']); h.store.contextRendered('staging');
  const signal = h.feedFor('staging', 'pods').signal;
  h.feedFor('staging', 'pods').onData([crashing('api')]); h.flush();
  assert.equal(h.store.all().length, 1);
  h.store.sync(['prod']);
  assert.equal(signal.aborted, true);
  assert.deepEqual(h.store.all(), []);
  assert.deepEqual(h.store.contexts(), []);
});

test('snoozing hides a problem for an hour, then it comes back', () => {
  const h = harness();
  h.store.sync(['prod']); h.store.contextRendered('prod');
  h.feedFor('prod', 'pods').onData([crashing('api'), crashing('web')]); h.flush();
  const [first] = h.store.all();
  h.store.snooze(first.id);
  assert.equal(h.store.all().length, 1);
  assert.equal(h.store.isSnoozed(first.id), true);
  assert.ok(h.storage['rubban.problems.snoozed'][first.id] > 0);
  h.advance(59 * MIN); assert.equal(h.store.all().length, 1);
  h.advance(2 * MIN); assert.equal(h.store.all().length, 2);
});

test('a cluster whose every feed failed is one information problem, flagged when credentials are the cause, and the feeds are retried', () => {
  const h = harness();
  h.store.sync(['prod']); h.store.contextRendered('prod');
  for (const feed of h.feeds) feed.onError(Object.assign(new Error('credentials expired'), { code: 'credentials' }));
  h.flush();
  const [problem] = h.store.all();
  assert.equal(problem.severity, 'info'); assert.equal(problem.title, 'Cluster not reachable'); assert.equal(problem.credentials, true); assert.equal(problem.resource, 'cluster');
  const before = h.feeds.length;
  h.timers.filter(t => t.ms === 30_000 && t.live).slice(1).forEach(t => t.fn()); // the first 30 s timer is the clock tick
  assert.equal(h.feeds.length, before + 7, 'every failed kind is subscribed again');
  h.feedFor('prod', 'pods').onData([]); h.flush();
  assert.deepEqual(h.store.all(), [], 'the row goes as soon as one feed works again');
});

test('one refused feed is not an unreachable cluster, and a refusal is not retried', () => {
  const h = harness();
  h.store.sync(['prod']); h.store.contextRendered('prod');
  const before = h.timers.length;
  h.feedFor('prod', 'nodes').onError(Object.assign(new Error('nodes is forbidden'), { status: 403 }));
  h.flush();
  assert.deepEqual(h.store.all(), []);
  assert.equal(h.timers.filter(t => t.ms === 30_000).length, h.timers.slice(0, before).filter(t => t.ms === 30_000).length, 'no retry for a 403');
  h.feedFor('prod', 'pods').onError(new Error('timeout'));
  h.flush();
  assert.deepEqual(h.store.all(), [], 'two of seven feeds failing is still a reachable cluster');
});

test('the UI is only told when what it shows changed, and Argo is subscribed once', () => {
  const h = harness({ argo: true });
  h.store.sync(['prod']); h.store.contextRendered('prod');
  assert.equal(h.feeds.filter(f => f.resource === 'applications.argoproj.io').length, 1);
  h.store.sync(['prod']); h.store.sync(['prod']);
  assert.equal(h.feeds.filter(f => f.resource === 'applications.argoproj.io').length, 1, 'syncing again does not subscribe again');
  h.feedFor('prod', 'pods').onData([crashing('api')]); h.flush();
  const after = h.changes();
  h.feedFor('prod', 'pods').onData([crashing('api')]); h.flush();
  h.timers.filter(t => t.ms === 30_000 && t.live).forEach(t => t.fn());
  assert.equal(h.changes(), after, 'the same problems are not announced again');
  h.feedFor('prod', 'pods').onData([crashing('api'), crashing('web')]); h.flush();
  assert.equal(h.changes(), after + 1);
});

test('problems that need five minutes of evidence use the time they were first seen', () => {
  const h = harness();
  h.store.sync(['prod']); h.store.contextRendered('prod');
  const sts = { metadata: { name: 'db', namespace: 'shop' }, spec: { replicas: 3 }, status: { readyReplicas: 2 } };
  h.feedFor('prod', 'statefulsets').onData([sts]); h.flush();
  assert.deepEqual(h.store.all(), []);
  h.advance(6 * MIN);
  h.store.sync(['prod']);
  h.timers.filter(t => t.ms === 30_000 && t.live).forEach(t => t.fn());
  assert.equal(h.store.all()[0]?.title, '2/3 available');
  h.feedFor('prod', 'statefulsets').onData([{ ...sts, status: { readyReplicas: 3 } }]); h.flush();
  assert.deepEqual(h.store.all(), []);
  h.advance(10 * MIN);
  h.feedFor('prod', 'statefulsets').onData([sts]); h.flush();
  assert.deepEqual(h.store.all(), [], 'a problem that comes back starts its five minutes again');
});

test('destroy stops everything', () => {
  const h = harness();
  h.store.sync(['prod']); h.store.contextRendered('prod');
  const signal = h.feedFor('prod', 'pods').signal;
  h.store.destroy();
  assert.equal(signal.aborted, true);
  assert.deepEqual(h.store.contexts(), []);
});
