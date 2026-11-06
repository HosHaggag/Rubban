// Live rollout tracker: after a Restart, Scale, Roll back, Pause/Resume or Apply of a Deployment,
// StatefulSet or DaemonSet (or "Watch rollout" from its menu), a card in the bottom-right corner
// follows the rollout and says in plain words whether it is going well, stuck or failing, with Undo,
// the new pods' logs, Pause/Resume and the details one click away. Cards stay across views, tabs and
// clusters; each one watches its own cluster and namespace (not the current tab's) until dismissed.
import { state, hooks, el, button, badge, toast, task, post, confirmAction } from './kit.js';
import { infoFor } from './clusterui.js';
import { clusterIcon } from './cluster-icons.js';
import { workloadSelector, containersOf } from './ops.js';
import { TRACKED, KIND, ACTION_LABELS, COLLAPSE_AFTER_MS, snapshotBefore, progressOf, evaluate, undoPlan, newPodsSelector, barSegments, formatElapsed, trackKey } from './rollouts-core.js';

const RESOURCE_OF = { Deployment: 'deployments', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets' };
const MAX_OPEN = 3; // more cards than this: the older ones fold
const cards = new Map();
let liveList = null;
let stack = null;
let ticker = null;

// `` `code` `` spans for the parts of a sentence written in backticks (diagnose.js style).
const rich = text => String(text || '').split(/(`[^`]+`)/).map(part => (part.startsWith('`') && part.endsWith('`') && part.length > 2 ? el('code', { text: part.slice(1, -1) }) : part));
const normalizeResource = ref => {
  const resource = String(ref.resource || RESOURCE_OF[ref.kind] || '').replace(/\.apps$/, '');
  return TRACKED.has(resource) ? resource : '';
};

export function setupRollouts(deps) {
  liveList = deps.liveList;
  hooks.trackRollout = trackRollout;
}

function ensureStack() {
  if (stack?.isConnected) return stack;
  stack = el('aside', { class: 'rollout-stack', 'aria-label': 'Rollouts in progress' });
  document.body.append(stack);
  // Toasts sit above the cards instead of on top of them.
  new ResizeObserver(() => document.documentElement.style.setProperty('--rollouts-height', `${stack.offsetHeight ? stack.offsetHeight + 8 : 0}px`)).observe(stack);
  return stack;
}

// Start (or restart) following a workload's rollout. `ref` is a selection ({ context, namespace,
// resource, name, item? }) or an applied object ({ kind, … }). Options: action, before.
export function trackRollout(ref, { action = 'watch', before, toRevision } = {}) {
  const resource = normalizeResource(ref);
  if (!resource || !ref?.name || !ref.context || !liveList) return null;
  const target = { context: ref.context, namespace: ref.namespace && ref.namespace !== '*' ? ref.namespace : 'default', resource, name: ref.name };
  const key = trackKey(target);
  let card = cards.get(key);
  const snapshot = before !== undefined ? before : snapshotBefore(resource, ref.item || card?.workload);
  const track = { action, startedAt: Date.now(), before: snapshot, toRevision: Number.isFinite(toRevision) ? toRevision : null };
  if (card) {
    card.track = track; card.autoCollapsed = false; card.collapsed = false; card.manual = false;
    stack.append(card.node); // newest closest to the corner
  } else {
    card = createCard(target, track, key);
    cards.set(key, card);
    ensureStack().append(card.node);
    subscribe(card);
  }
  foldOlder(card);
  update(card);
  if (!ticker) ticker = setInterval(() => cards.forEach(update), 1000);
  return card;
}

function foldOlder(current) {
  const open = [...cards.values()].filter(card => card !== current && !card.collapsed);
  for (const card of open.slice(0, Math.max(0, open.length - (MAX_OPEN - 1)))) { card.collapsed = true; update(card); }
}

function subscribe(card) {
  const { context, namespace, resource, name } = card.target;
  const signal = card.abort.signal;
  const failed = what => error => { card.error = `${what}: ${error.message}`; update(card); };
  liveList({ resource, context, namespace, signal, onError: failed(KIND[resource]), onData: items => {
    card.error = '';
    card.workload = items.find(item => item.metadata?.name === name) || null;
    card.deleted = !card.workload; card.synced.workload = true; update(card);
  } });
  liveList({ resource: 'pods', context, namespace, signal, onError: failed('Pods'), onData: items => { card.pods = items; card.synced.pods = true; update(card); } });
  const owned = resource === 'deployments' ? 'replicasets' : 'controllerrevisions';
  liveList({ resource: owned, context, namespace, signal, onError: failed(owned === 'replicasets' ? 'ReplicaSets' : 'ControllerRevisions'), onData: items => { card[owned] = items; card.synced.owned = true; update(card); } });
}

function dismiss(card) {
  card.abort.abort();
  card.node.remove();
  cards.delete(card.key);
  if (!cards.size) { clearInterval(ticker); ticker = null; }
}

function createCard(target, track, key) {
  const meta = infoFor(target.context);
  const card = { key, target, track, abort: new AbortController(), workload: null, pods: [], replicasets: [], controllerrevisions: [], synced: {}, deleted: false, error: '', collapsed: false, manual: false, autoCollapsed: false };
  const kind = KIND[target.resource];
  const parts = {
    state: el('strong', { class: 'rollout-state', role: 'status', 'aria-live': 'polite' }),
    when: el('span', { class: 'rollout-when' }),
    rev: el('span', { class: 'rollout-rev' }),
    bar: el('div', { class: 'rollout-bar', role: 'img' }),
    counts: el('div', { class: 'rollout-counts' }),
    detail: el('p', { class: 'rollout-detail' }),
    hint: el('p', { class: 'rollout-hint' }),
    undo: button('Undo', task(() => undo(card)), 'compact'),
    logs: button('Logs', () => newPodLogs(card), 'compact'),
    pause: button('Pause', task(() => setPaused(card, !card.workload?.spec?.paused)), 'compact'),
    details: button('Details', task(() => openWorkload(card)), 'compact quiet'),
    toggle: el('button', { type: 'button', class: 'icon-button rollout-toggle', onclick: () => { card.collapsed = !card.collapsed; card.manual = true; update(card); } }),
  };
  const mark = el('span', { class: 'rollout-cluster', style: `color:${meta.color}`, title: `${meta.label} · ${target.context}` }, clusterIcon(meta.icon));
  const title = el('button', { type: 'button', class: 'rollout-title', title: `Open ${kind} ${target.name} (${meta.label} · ${target.namespace})`, onclick: task(() => openWorkload(card)) }, target.name);
  const close = el('button', { type: 'button', class: 'icon-button rollout-close', title: 'Stop watching and dismiss', 'aria-label': `Dismiss the rollout of ${target.name}`, onclick: () => dismiss(card), text: '×' });
  card.node = el('section', { class: 'rollout-card', role: 'group', 'aria-label': `Rollout of ${kind} ${target.name}` },
    el('div', { class: 'rollout-head' }, mark, title, meta.env === 'production' ? badge('production', 'bad') : null, parts.toggle, close),
    el('div', { class: 'rollout-sub', text: `${kind} · ${target.namespace} · ${meta.label}` }),
    el('div', { class: 'rollout-line' }, el('span', { class: 'rollout-dot' }), parts.state, parts.when, el('span', { class: 'spacer' }), parts.rev),
    parts.bar,
    el('div', { class: 'rollout-body' }, parts.counts, parts.detail, parts.hint, el('div', { class: 'rollout-actions' }, parts.undo, parts.logs, target.resource === 'deployments' ? parts.pause : null, parts.details)));
  card.parts = parts;
  return card;
}

function update(card) {
  const { parts, target } = card;
  const now = Date.now();
  const ready = card.synced.workload && card.synced.pods && card.synced.owned;
  card.progress = ready && card.workload ? progressOf(target.resource, card.workload, { replicasets: card.replicasets, controllerrevisions: card.controllerrevisions, pods: card.pods }, card.track.before) : null;
  const result = evaluate(card.track, card.progress, { now, deleted: ready && card.deleted });
  card.track = result.track;
  let current = result.state;
  if (card.error && !card.progress) current = { id: 'error', tone: 'bad', label: 'Cannot watch', detail: card.error };
  card.state = current;
  // A watched workload that was already finished when the card opened has nothing rolling out.
  if (card.track.settled === undefined && !['loading', 'error', 'starting'].includes(current.id)) card.track.settled = current.id === 'complete';
  // A finished rollout folds itself after a while, once, unless the card was opened by hand.
  if (current.id === 'complete' && card.track.completeAt && now - card.track.completeAt >= COLLAPSE_AFTER_MS && !card.autoCollapsed && !card.manual) { card.collapsed = true; card.autoCollapsed = true; }
  const p = card.progress;
  const node = card.node;
  node.className = `rollout-card tone-${current.tone || 'none'} state-${current.id}${card.collapsed ? ' collapsed' : ''}`;
  parts.toggle.textContent = card.collapsed ? '▴' : '▾';
  parts.toggle.title = card.collapsed ? 'Show details' : 'Fold';
  parts.toggle.setAttribute('aria-label', card.collapsed ? `Show the rollout of ${target.name}` : `Fold the rollout of ${target.name}`);
  parts.toggle.setAttribute('aria-expanded', String(!card.collapsed));
  parts.state.textContent = current.id === 'complete' ? `✓ ${current.label}` : current.label;
  const took = current.id === 'complete' && card.track.action === 'watch' && card.track.settled ? 'up to date' : current.id === 'complete' && card.track.completeAt ? `done in ${formatElapsed(Math.max(1000, card.track.completeAt - card.track.startedAt))}` : formatElapsed(now - card.track.startedAt);
  parts.when.textContent = `${ACTION_LABELS[card.track.action] || card.track.action}${card.track.toRevision !== null ? ` to rev ${card.track.toRevision}` : ''} · ${took}`;
  if (card.track.action === 'scale' && Number.isFinite(card.track.before?.replicas) && p) parts.rev.textContent = card.track.before.replicas === p.desired ? `${p.desired} replicas` : `${card.track.before.replicas} → ${p.desired} replicas`;
  else if (p?.newRevision !== null && p?.newRevision !== undefined) parts.rev.textContent = p.fromRevision !== null && p.fromRevision !== p.newRevision ? `rev ${p.fromRevision} → ${p.newRevision}` : `rev ${p.newRevision}`;
  else parts.rev.textContent = '';
  parts.rev.title = p?.revisions?.length ? p.revisions.slice(0, 6).map(r => `rev ${r.revision}${r.image ? ` · ${r.image}` : ''}`).join('\n') : '';
  // Bar: new pods ready / new pods not ready / old pods / terminating.
  const segments = barSegments(p);
  parts.bar.replaceChildren(...segments.map(s => el('span', { class: `rollout-seg ${s.id}${s.id === 'notready' && ['failing', 'deadline'].includes(current.id) ? ' bad' : ''}`, style: `width:${(s.fraction * 100).toFixed(2)}%`, title: `${s.count} ${s.label}` })));
  parts.bar.setAttribute('aria-label', segments.length ? segments.map(s => `${s.count} ${s.label}`).join(', ') : 'No pods yet');
  parts.counts.replaceChildren(...(p ? [
    count('Updated', p.updated, p.desired), count('Ready', p.ready, p.desired), count('Available', p.available, p.desired),
    p.segments.terminating ? el('span', { class: 'rollout-count muted', text: `${p.segments.terminating} terminating` }) : null,
  ].filter(Boolean) : []));
  const finding = current.finding;
  parts.detail.replaceChildren(...(finding ? [el('b', { text: finding.title }), finding.pods?.length > 1 ? ` (${finding.pods.length} pods)` : '', ' — ', ...rich(finding.text)] : rich(current.detail)));
  parts.detail.title = finding ? `${finding.title}: ${finding.text.replace(/`/g, '')}` : '';
  const hint = finding?.hints?.[0] || '';
  parts.hint.replaceChildren(...rich(hint));
  parts.hint.classList.toggle('hidden', !hint);
  const plan = undoPlan(card.track, p);
  parts.undo.textContent = plan ? plan.label : 'Undo';
  parts.undo.disabled = card.busy;
  parts.undo.classList.toggle('hidden', !plan);
  parts.undo.title = plan ? (plan.type === 'rollback' ? `Roll back to revision ${plan.revision} (kubectl rollout undo)` : `Scale back to ${plan.replicas} replicas`) : 'Nothing to undo for this change';
  parts.undo.classList.toggle('primary', Boolean(plan) && ['failing', 'deadline', 'stalled'].includes(current.id));
  parts.logs.disabled = !p?.newPods?.length && !p?.pods?.length;
  parts.logs.title = p?.newHash ? 'Logs of the new revision’s pods' : 'Logs of the workload’s pods';
  const paused = Boolean(card.workload?.spec?.paused);
  parts.pause.textContent = paused ? 'Resume' : 'Pause';
  parts.pause.disabled = !card.workload || card.busy;
  parts.details.disabled = !card.workload;
}

const count = (label, value, desired) => el('span', { class: `rollout-count${value < desired ? ' short' : ''}` }, el('span', { class: 'muted', text: `${label} ` }), el('b', { text: `${value}/${desired}` }));

const guardTarget = card => ({ context: card.target.context, namespace: card.target.namespace, resource: card.target.resource, name: card.target.name });

async function undo(card) {
  const plan = undoPlan(card.track, card.progress);
  if (!plan || card.busy) return;
  const { name, context } = card.target;
  const message = plan.type === 'rollback' ? `Roll back ${name} to revision ${plan.revision}. Pods will be replaced with that revision's template.` : `Scale ${name} back to ${plan.replicas} replica${plan.replicas === 1 ? '' : 's'}.`;
  if (!await confirmAction(message, name, { destructive: true, context })) return;
  const before = snapshotBefore(card.target.resource, card.workload);
  card.busy = true; update(card);
  try {
    if (plan.type === 'rollback') await post('/api/rollout-undo', { ...guardTarget(card), revision: plan.revision });
    else await post('/api/scale', { ...guardTarget(card), replicas: plan.replicas });
  } finally { card.busy = false; }
  toast(plan.type === 'rollback' ? `Rolling ${name} back to revision ${plan.revision}.` : `Scaling ${name} back to ${plan.replicas}.`);
  trackRollout({ ...card.target, item: card.workload }, { action: plan.type === 'rollback' ? 'undo' : 'scale', before, toRevision: plan.type === 'rollback' ? plan.revision : undefined });
  hooks.afterMutation?.();
}

async function setPaused(card, paused) {
  if (card.busy) return;
  card.busy = true; update(card);
  try { await post('/api/patch', { ...guardTarget(card), type: 'merge', patch: { spec: { paused } } }); } finally { card.busy = false; update(card); }
  toast(paused ? 'Rollout paused.' : 'Rollout resumed.');
  hooks.afterMutation?.();
}

function newPodLogs(card) {
  const item = card.workload;
  if (!item) return;
  const base = workloadSelector(item);
  const p = card.progress;
  if (!base) { toast('This workload has no label selector to collect pod logs with.', true); return; }
  const selector = newPodsSelector(card.target.resource, p, base);
  hooks.openLogs?.({ context: card.target.context, namespace: card.target.namespace, selector, title: `${card.target.name}${p?.newRevision !== null && p?.newRevision !== undefined && selector !== base ? ` · rev ${p.newRevision}` : ''}`, containers: containersOf(item) });
}

// Opens the workload's details in its own cluster, switching tab (or opening one) when needed.
async function openWorkload(card) {
  const { context, resource } = card.target;
  if (state.context !== context) {
    const tab = state.tabs.find(item => item.context === context);
    if (tab) await hooks.activateTab?.(tab.id); else await hooks.newClusterTab?.(context);
  }
  const item = card.workload || { kind: KIND[resource], metadata: { name: card.target.name, namespace: card.target.namespace } };
  hooks.showResource?.(item, resource);
}
