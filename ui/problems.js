// The problems inbox: one set of live feeds per cluster that has a tab open, judged by problems-rules.js.
// No DOM here; app.js passes liveList in and draws the result.
import { RESOURCES, evaluate, bySeverity, counts } from './problems-rules.js';

const DEBOUNCE_MS = 200;
const TICK_MS = 30_000;
const RETRY_MS = 30_000;
const SNOOZE_MS = 60 * 60_000;
const SNOOZE_KEY = 'rubban.problems.snoozed';

export function createProblemStore({ liveList, hasArgo = () => false, readStore = (key, fallback) => fallback, writeStore = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, onChange = () => {} }) {
  const entries = new Map(); // context -> { abort, raw: Map(resource -> items), seen: Map(id -> ms), errors: Map(resource -> error), subscribed, problems, retry: Map }
  const rendered = new Set();
  let wanted = new Set();
  let debounce = null; let tickTimer = null; let lastSignature = '';

  const snoozed = () => { const map = readStore(SNOOZE_KEY, {}); return map && typeof map === 'object' ? map : {}; };
  const isSnoozed = id => (snoozed()[id] || 0) > now();

  function recompute(context) {
    const entry = entries.get(context);
    if (!entry) return;
    const asked = new Set();
    const at = now();
    const ctx = { context, now: at, firstSeen: id => { asked.add(id); if (!entry.seen.has(id)) entry.seen.set(id, at); return entry.seen.get(id); } };
    const problems = [];
    for (const [resource, items] of entry.raw) problems.push(...evaluate(resource, items, ctx));
    for (const id of [...entry.seen.keys()]) if (!asked.has(id)) entry.seen.delete(id);
    // One feed refused (a namespace-scoped user cannot watch nodes) is not an unreachable cluster: only when
    // every feed failed is the cluster reported.
    if (entry.errors.size && entry.errors.size >= entry.subscribed) {
      const error = [...entry.errors.values()].find(item => item.code === 'credentials') || entry.errors.values().next().value;
      problems.push({ id: `${context}|cluster||${context}|unreachable`, context, resource: 'cluster', namespace: '', name: context, severity: 'info', title: 'Cluster not reachable', detail: error.message, since: null, credentials: error.code === 'credentials' });
    }
    entry.problems = problems;
  }
  // What the UI shows: only a change in it is worth redrawing the tab bar and the page for.
  const signature = () => [...entries].map(([context, entry]) => `${context}:${entry.problems.map(problem => `${problem.id}/${problem.severity}/${problem.title}`).join(',')}`).join(';');
  function recomputeAll() {
    for (const context of entries.keys()) recompute(context);
    const next = signature();
    if (next !== lastSignature) { lastSignature = next; onChange(); }
  }
  function schedule() { if (!debounce) debounce = setTimer(() => { debounce = null; recomputeAll(); }, DEBOUNCE_MS); }

  function subscribe(context, entry, resource) {
    liveList({ resource, context, namespace: '*', signal: entry.abort.signal,
      onData: items => { entry.errors.delete(resource); entry.raw.set(resource, items); schedule(); },
      onError: error => {
        entry.errors.set(resource, { message: error?.message || 'Unknown error', code: error?.code, status: error?.status });
        entry.raw.delete(resource);
        schedule();
        // A refusal will not change by asking again; anything else is retried while the cluster stays open.
        if (error?.status === 403) return;
        entry.retry.set(resource, setTimer(() => { if (entries.get(context) === entry && !entry.abort.signal.aborted) subscribe(context, entry, resource); }, RETRY_MS));
      } });
  }

  function start(context) {
    const entry = { abort: new AbortController(), raw: new Map(), seen: new Map(), errors: new Map(), subscribed: 0, problems: [], retry: new Map(), argo: false };
    entries.set(context, entry);
    for (const resource of RESOURCES) {
      if (resource === 'applications.argoproj.io') { if (!hasArgo(context)) continue; entry.argo = true; }
      entry.subscribed++;
      subscribe(context, entry, resource);
    }
  }
  function stop(context) {
    const entry = entries.get(context);
    if (!entry) return;
    entry.abort.abort();
    for (const timer of entry.retry.values()) clearTimer(timer);
    entries.delete(context);
  }

  const api = {
    // Called whenever tabs change: subscribe for new clusters (once rendered), drop the ones no tab shows.
    sync(contexts) {
      wanted = new Set([...contexts].filter(Boolean));
      let changed = false;
      for (const context of [...entries.keys()]) if (!wanted.has(context)) { stop(context); changed = true; }
      for (const context of wanted) if (rendered.has(context) && !entries.has(context)) { start(context); changed = true; }
      // Argo CD may have been discovered after the feeds started.
      for (const [context, entry] of entries) if (hasArgo(context) && !entry.argo) { entry.argo = true; entry.subscribed++; subscribe(context, entry, 'applications.argoproj.io'); }
      if (changed) { lastSignature = signature(); onChange(); }
      if (entries.size && !tickTimer) tickTimer = setTimer(function tick() { recomputeAll(); tickTimer = entries.size ? setTimer(tick, TICK_MS) : null; }, TICK_MS);
    },
    // The first render of a tab on this cluster has happened: the feeds may open.
    contextRendered(context) { if (context && !rendered.has(context)) { rendered.add(context); api.sync(wanted); } },
    all() { return [...entries.values()].flatMap(entry => entry.problems).filter(problem => !isSnoozed(problem.id)).sort((a, b) => a.context.localeCompare(b.context) || bySeverity(a, b)); },
    countsFor(context) { return counts((entries.get(context)?.problems || []).filter(problem => !isSnoozed(problem.id))); },
    totals() { return counts(api.all()); },
    contexts() { return [...entries.keys()]; },
    snooze(id) {
      const map = snoozed();
      for (const key of Object.keys(map)) if (map[key] <= now()) delete map[key];
      map[id] = now() + SNOOZE_MS;
      writeStore(SNOOZE_KEY, map);
      onChange();
    },
    isSnoozed,
    destroy() { for (const context of [...entries.keys()]) stop(context); clearTimer(debounce); clearTimer(tickTimer); debounce = tickTimer = null; },
  };
  return api;
}
