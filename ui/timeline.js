// The change timeline page ("What changed?"): rollouts, config writes, restarts, warnings, scaling, jobs,
// Helm and Argo CD in one chronological view of the tab's cluster and namespace. The entries come from
// timeline-core.js; this module subscribes to the live feeds, polls the two backend routes and draws.
import { state, el, button, badge, get, page, empty, link, actions, loading, readStore, writeStore } from './kit.js';
import { resourceForKind } from './kinds.js';
import { alignRows, foldUnchanged, countDiffering, renderSideBySide } from './diff.js';
import { showRelease } from './helm.js';
import { RANGES, CATEGORIES, buildEntries, correlate, inWindow, countByCategory, histogram, groupEntries, bucketSize, focusWindow, matchesFocus, clock, ago, keyName, MINUTE, HOUR } from './timeline-core.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
// 16px stroke icons in the style of the sidebar's.
const CATEGORY_ICONS = {
  rollouts: 'M8 13.5V4 M4.5 7.5 8 4l3.5 3.5 M3 2.5h10',
  config: 'M2 4h4 M9 4h5 M2 12h7 M12 12h2 M2 8h1 M6 8h8 M9 4a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0z M12 12a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0z M6 8a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0z',
  restarts: 'M13 8a5 5 0 1 1-1.5-3.5 M13 2.5v3h-3',
  warnings: 'M8 2l6.5 11.5h-13z M8 6.5v3 M8 11.6h.01',
  scaling: 'M5 13V3 M2.5 5.5 5 3l2.5 2.5 M11 3v10 M8.5 10.5 11 13l2.5-2.5',
  jobs: 'M2.5 3.5h11v9h-11z M6 6.2v3.6L9.2 8z',
  gitops: 'M5.5 3.5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0z M5.5 12.5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0z M13.5 8a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0z M4 5v6 M4 8h6.5',
  nodes: 'M2.5 2.5h11v4.5h-11z M2.5 9h11v4.5h-11z M5 4.75h.01 M5 11.25h.01 M8 4.75h3 M8 11.25h3',
};
function svgIcon(path) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'tl-svg');
  const node = document.createElementNS(SVG_NS, 'path'); node.setAttribute('d', path); svg.append(node);
  return svg;
}

// Live feeds the timeline reads. The first three must answer before the page draws.
const FEEDS = [
  { resource: 'events', key: 'events', required: true },
  { resource: 'pods', key: 'pods', required: true },
  { resource: 'replicasets', key: 'replicaSets', required: true },
  { resource: 'deployments', key: 'deployments' },
  { resource: 'statefulsets', key: 'statefulSets' },
  { resource: 'daemonsets', key: 'daemonSets' },
  { resource: 'controllerrevisions', key: 'controllerRevisions' },
  { resource: 'jobs', key: 'jobs' },
  { resource: 'cronjobs', key: 'cronJobs' },
  { resource: 'horizontalpodautoscalers', key: 'hpas' },
  { resource: 'nodes', key: 'nodes', cluster: true },
  { resource: 'applications.argoproj.io', key: 'applications', cluster: true, argo: true },
];
// Which data an entry's source comes from, to tell a source's first answer from news.
const SOURCE_KEYS = { replicasets: 'replicaSets', controllerrevisions: 'controllerRevisions', horizontalpodautoscalers: 'hpas', cronjobs: 'cronJobs' };
const CONFIG_POLL_MS = 60_000;
const HELM_POLL_MS = 120_000;
const PAGE_SIZE = 300;
const STORE = 'rubban.timeline';

// View settings survive navigation and restarts; the text filter only navigation.
const saved = readStore(STORE, {});
const view = {
  range: RANGES.some(range => range.id === saved?.range) ? saved.range : '6h',
  hidden: new Set(Array.isArray(saved?.hidden) ? saved.hidden : []),
  relatedOnly: Boolean(saved?.relatedOnly),
  text: '',
};
const saveView = () => writeStore(STORE, { range: view.range, hidden: [...view.hidden], relatedOnly: view.relatedOnly });

// "What changed?" from the Problems page: the next Timeline page drawn takes the focus for its tab.
let pendingFocus = null;
const focusByTab = new Map();
export function focusTimeline(problem) { pendingFocus = { problem: { resource: problem.resource, namespace: problem.namespace, name: problem.name, since: problem.since, title: problem.title, context: problem.context } }; }

const hasArgo = () => Array.isArray(state.crds) && state.crds.some(crd => crd.metadata?.name === 'applications.argoproj.io');
const offsetMs = () => -new Date().getTimezoneOffset() * MINUTE;
const rangeLabel = ms => (ms >= 24 * HOUR ? `${Math.round(ms / (24 * HOUR))} days` : ms >= HOUR ? `${Math.round(ms / HOUR)} hour${ms >= 2 * HOUR ? 's' : ''}` : `${Math.round(ms / MINUTE)} minutes`);

export function timelinePage(tab, { liveList, liveBadge, consumeResync, refreshView, showResource }) {
  const signal = state.pageAbort.signal;
  const context = state.context; const namespace = state.namespace;
  if (pendingFocus && (!pendingFocus.problem.context || pendingFocus.problem.context === context)) { focusByTab.set(tab.id, pendingFocus); pendingFocus = null; }
  let focus = focusByTab.get(tab.id) || null;

  const status = liveBadge();
  const root = page('Timeline', `${namespace === '*' ? 'All namespaces' : namespace} · what changed, newest first: rollouts, config, restarts, warnings, scaling, jobs, Helm, Argo CD and nodes.`, actions(status, button('↻ Refresh', refreshView, 'compact')));
  root.classList.add('timeline-page');

  // ---- Controls -------------------------------------------------------------------------------------
  const rangeChips = RANGES.map(range => {
    const chip = el('button', { type: 'button', class: 'chip-button tl-range', 'data-range': range.id, title: `The last ${rangeLabel(range.ms)}` }, range.label);
    chip.addEventListener('click', () => { view.range = range.id; focus = null; focusByTab.delete(tab.id); saveView(); draw(); });
    return chip;
  });
  const categoryChips = new Map(CATEGORIES.map(category => {
    const count = el('span', { class: 'tl-chip-count', text: '0' });
    const chip = el('button', { type: 'button', class: `chip-button tl-cat cat-${category.id}`, title: `Show or hide ${category.label.toLowerCase()}` }, svgIcon(CATEGORY_ICONS[category.id]), el('span', { text: category.label }), count);
    chip.addEventListener('click', event => {
      // Alt-click (or Ctrl/⌘-click) shows only this category; a second one shows all again.
      if (event.altKey || event.ctrlKey || event.metaKey) {
        const only = CATEGORIES.every(other => other.id === category.id || view.hidden.has(other.id)) && !view.hidden.has(category.id);
        view.hidden = only ? new Set() : new Set(CATEGORIES.map(other => other.id).filter(id => id !== category.id));
      } else if (view.hidden.has(category.id)) view.hidden.delete(category.id); else view.hidden.add(category.id);
      saveView(); draw();
    });
    return [category.id, { chip, count }];
  }));
  const search = el('input', { type: 'search', class: 'tl-search', placeholder: 'Filter by name, image, reason…', 'aria-label': 'Filter the timeline', value: view.text });
  let searchTimer = null;
  search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { view.text = search.value; draw(); }, 150); });
  const relatedToggle = el('input', { type: 'checkbox', checked: view.relatedOnly });
  relatedToggle.addEventListener('change', () => { view.relatedOnly = relatedToggle.checked; saveView(); draw(); });
  const toolbar = el('div', { class: 'tl-toolbar' },
    el('div', { class: 'tl-ranges', role: 'group', 'aria-label': 'Time range' }, rangeChips),
    el('div', { class: 'tl-cats', role: 'group', 'aria-label': 'Categories' }, [...categoryChips.values()].map(item => item.chip)),
    el('div', { class: 'tl-filters' }, search, el('label', { class: 'inline-label', title: 'Only changes that happened shortly before a burst of warnings or restarts on a workload they affect, and those bursts' }, relatedToggle, ' Likely related only')));
  const focusBar = el('div', { class: 'tl-focus-bar hidden', role: 'status' });
  const strip = el('div', { class: 'tl-strip', role: 'group', 'aria-label': 'Changes over time' });
  const axis = el('div', { class: 'tl-axis' });
  const notes = el('div', { class: 'tl-notes' });
  const list = el('div', { class: 'tl-list' }, loading('Reading what changed…'));
  root.append(toolbar, focusBar, el('div', { class: 'tl-strip-wrap' }, strip, axis), notes, list);

  // ---- Data -----------------------------------------------------------------------------------------
  const sources = {}; const synced = new Set(); const errors = new Map(); const warnings = { config: [], helm: [] };
  let all = []; let index = null; const known = new Set(); const delivered = new Set(); const fresh = new Set();
  let recomputeTimer = null;
  const schedule = () => { if (!recomputeTimer) recomputeTimer = setTimeout(() => { recomputeTimer = null; recompute(); }, 250); };
  const ready = () => FEEDS.filter(feed => feed.required).every(feed => synced.has(feed.resource) || errors.has(feed.resource));
  const resync = consumeResync();
  for (const feed of FEEDS) {
    if (feed.argo && !hasArgo()) continue;
    liveList({ resource: feed.resource, namespace: feed.cluster ? '*' : namespace, signal, resync,
      onStatus: value => { if (feed.required) status.track(feed.resource, value); },
      onData: items => { sources[feed.key] = items; synced.add(feed.resource); errors.delete(feed.resource); schedule(); },
      onError: error => { errors.set(feed.resource, error); sources[feed.key] = []; schedule(); } });
  }
  async function poll(route, key, every) {
    if (signal.aborted) return;
    try {
      const answer = await get(route, { context, namespace }, { signal });
      if (key === 'config') { sources.config = answer.items || []; warnings.config = answer.warnings || []; } else { sources.helm = answer.releases || []; warnings.helm = answer.warnings || []; }
      errors.delete(key);
    } catch (error) {
      if (signal.aborted) return;
      errors.set(key, error);
    }
    schedule();
    const timer = setTimeout(() => poll(route, key, every), every);
    signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  }
  poll('/api/timeline/config', 'config', CONFIG_POLL_MS);
  poll('/api/timeline/helm', 'helm', HELM_POLL_MS);

  function recompute() {
    if (signal.aborted || !ready()) { draw(); return; }
    const built = buildEntries(sources, { namespace });
    index = built.index;
    all = correlate(built.entries);
    // Entries that appear while the page is open are marked new; a source's first answer is not news.
    for (const entry of all) {
      if (known.has(entry.id)) continue;
      known.add(entry.id);
      if (delivered.has(SOURCE_KEYS[entry.source] || entry.source)) fresh.add(entry.id);
    }
    for (const key of Object.keys(sources)) delivered.add(key);
    draw();
  }

  // ---- Drawing --------------------------------------------------------------------------------------
  const expanded = new Set();
  let limit = PAGE_SIZE; let shown = []; let windowNow = Date.now(); let activeFocus = null;
  const rowIds = new Map(); let rowSeq = 0;
  const rowId = entry => { if (!rowIds.has(entry.id)) rowIds.set(entry.id, `tl-row-${++rowSeq}`); return rowIds.get(entry.id); };

  function openRef(ref) {
    if (!ref?.name) return;
    if (ref.kind === 'HelmRelease') { showRelease({ name: ref.name, namespace: ref.namespace }); return; }
    showResource({ kind: ref.kind, apiVersion: ref.apiVersion, metadata: { name: ref.name, namespace: ref.namespace } }, resourceForKind(ref.kind, ref.apiVersion || ''));
  }
  const objectCell = entry => el('span', { class: 'tl-object' }, el('span', { class: 'kind-tag', text: entry.ref.kind === 'HorizontalPodAutoscaler' ? 'HPA' : entry.ref.kind }), ' ', link(entry.ref.name, () => openRef(entry.ref), `Open ${entry.ref.kind} ${entry.ref.name}`), namespace === '*' && entry.ref.namespace ? el('small', { class: 'muted', text: ` ${entry.ref.namespace}` }) : null);

  function jumpTo(id) {
    const entry = shown.find(item => item.id === id);
    if (!entry) return;
    const position = shown.indexOf(entry);
    if (position >= limit) { limit = position + PAGE_SIZE; drawList(); }
    const node = document.getElementById(rowId(entry));
    if (!node) return;
    list.querySelectorAll('.tl-target').forEach(item => item.classList.remove('tl-target'));
    node.classList.add('tl-target');
    node.scrollIntoView({ block: 'center' });
    node.focus({ preventScroll: true });
  }

  function detailOf(entry) {
    const parts = [];
    for (const item of entry.related || []) parts.push(el('div', { class: 'tl-why' }, el('span', { class: 'tl-flag related', text: 'likely related' }), ` ${item.text}. `, el('span', { class: 'muted', text: 'Same workload, its ConfigMap or Secret, or its Helm release or Argo CD application, shortly before.' })));
    if (entry.causes?.length) {
      const causes = entry.causes.map(id => all.find(item => item.id === id)).filter(Boolean);
      parts.push(el('div', { class: 'tl-why' }, el('span', { class: 'muted', text: 'Changed shortly before: ' }), causes.flatMap((cause, i) => [i ? ', ' : '', link(cause.title, () => jumpTo(cause.id), 'Show this change')])));
    }
    if (entry.firstShown) parts.push(el('div', { class: 'tl-detail-line muted', text: `First seen ${clock(entry.time, { offsetMs: offsetMs(), seconds: true, day: true })}, last seen ${clock(entry.lastTime, { offsetMs: offsetMs(), seconds: true, day: true })} (${ago(entry.lastTime, windowNow)}), after this window.` }));
    else if (entry.first && entry.first < entry.time - 1000) parts.push(el('div', { class: 'tl-detail-line muted', text: `First seen ${clock(entry.first, { offsetMs: offsetMs(), seconds: true, day: true })} (${ago(entry.first, windowNow)}) · last ${clock(entry.time, { offsetMs: offsetMs(), seconds: true, day: true })}` }));
    for (const line of entry.detail || []) parts.push(el('div', { class: 'tl-detail-line', text: line }));
    if (entry.target && entry.ref && keyName(entry.target) !== entry.ref.name && !entry.target.startsWith('HelmRelease/') && !entry.target.startsWith('Application/')) {
      const [kind, ns, ...rest] = entry.target.split('/');
      parts.push(el('div', { class: 'tl-detail-line muted' }, 'Part of ', el('span', { class: 'kind-tag', text: kind }), ' ', link(rest.join('/'), () => openRef({ kind, namespace: ns, name: rest.join('/') }))));
    }
    if (entry.progress?.length) {
      parts.push(el('div', { class: 'tl-diff-head muted', text: `Rollout progress · ${entry.progress.length} event${entry.progress.length === 1 ? '' : 's'}` }),
        el('ul', { class: 'tl-progress' }, entry.progress.map(item => el('li', {}, el('span', { class: 'tl-progress-time', text: clock(item.time, { offsetMs: offsetMs(), seconds: true }) }), item.text, item.count > 1 ? el('span', { class: 'muted', text: ` ×${item.count}` }) : null))));
    }
    if (entry.diff) {
      const rows = alignRows(entry.diff.before, entry.diff.after);
      parts.push(el('div', { class: 'tl-diff-head muted', text: `Pod template, ${entry.diff.beforeLabel} → ${entry.diff.afterLabel} · ${countDiffering(rows)} changed line${countDiffering(rows) === 1 ? '' : 's'}` }), renderSideBySide(foldUnchanged(rows, 3), { leftHead: el('span', { text: entry.diff.beforeLabel }), rightHead: el('span', { text: entry.diff.afterLabel }) }));
    }
    return el('div', { class: 'tl-detail', id: `${rowId(entry)}-detail` }, parts.length ? parts : el('div', { class: 'muted', text: 'No more detail.' }));
  }

  function entryNodes(entry) {
    const open = expanded.has(entry.id);
    const highlighted = activeFocus && matchesFocus(entry, activeFocus);
    const row = el('div', {
      class: `tl-entry sev-${entry.severity}${entry.related?.length ? ' related' : ''}${highlighted ? ' focused' : ''}${open ? ' open' : ''}`,
      id: rowId(entry), role: 'button', tabindex: '0', 'aria-expanded': String(open), 'aria-controls': `${rowId(entry)}-detail`,
    },
    el('span', { class: 'tl-time', title: entry.firstShown ? `First seen ${new Date(entry.time).toLocaleString()}, last ${new Date(entry.lastTime).toLocaleString()}` : new Date(entry.time).toLocaleString() }, el('span', { text: clock(entry.time, { offsetMs: offsetMs(), seconds: true }) }), el('small', { text: entry.firstShown ? 'first seen' : ago(entry.time, windowNow) })),
    el('span', { class: `tl-icon cat-${entry.category} sev-${entry.severity}`, title: CATEGORIES.find(category => category.id === entry.category)?.label || entry.category }, svgIcon(CATEGORY_ICONS[entry.category] || CATEGORY_ICONS.warnings)),
    el('span', { class: 'tl-body' },
      el('span', { class: 'tl-line' },
        el('span', { class: 'tl-title', text: entry.title }),
        entry.count > 1 ? badge(`×${entry.count}`, entry.severity === 'info' ? '' : 'warn') : null,
        entry.related?.length ? el('span', { class: 'tl-flag related', title: entry.related.map(item => item.text).join('\n') }, 'likely related') : null,
        fresh.has(entry.id) ? el('span', { class: 'tl-flag new', title: 'Appeared while the timeline was open' }, 'new') : null),
      entry.summary ? el('span', { class: 'tl-summary', text: entry.summary, title: entry.summary }) : null),
    objectCell(entry),
    el('span', { class: 'tl-chevron', 'aria-hidden': 'true', text: open ? '▾' : '▸' }));
    const toggle = () => {
      if (expanded.has(entry.id)) expanded.delete(entry.id); else expanded.add(entry.id);
      const [nextRow, nextDetail] = entryNodes(entry);
      if (row.nextElementSibling?.classList.contains('tl-detail')) row.nextElementSibling.remove();
      row.replaceWith(nextRow);
      if (nextDetail) nextRow.after(nextDetail);
      nextRow.focus({ preventScroll: true });
    };
    row.addEventListener('click', event => { if (!event.target.closest('a')) toggle(); });
    row.addEventListener('keydown', event => { if ((event.key === 'Enter' || event.key === ' ') && event.target === row) { event.preventDefault(); toggle(); } });
    return [row, open ? detailOf(entry) : null];
  }

  function drawList() {
    const groups = groupEntries(shown.slice(0, limit), bucketSize(activeWindow.to - activeWindow.from), { offsetMs: offsetMs() });
    const longRange = activeWindow.to - activeWindow.from > 6 * HOUR;
    const nodes = [];
    for (const group of groups) {
      const from = clock(group.start, { offsetMs: offsetMs(), day: longRange }); const to = clock(group.end, { offsetMs: offsetMs() });
      const warningsIn = group.entries.filter(entry => entry.severity !== 'info').length;
      nodes.push(el('div', { class: 'tl-group' }, el('strong', { text: `${from} – ${to}` }), el('span', { class: 'muted', text: `${ago(Math.min(group.end, windowNow), windowNow)} · ${group.entries.length} entr${group.entries.length === 1 ? 'y' : 'ies'}${warningsIn ? ` · ${warningsIn} warning${warningsIn === 1 ? '' : 's'}` : ''}` })));
      for (const entry of group.entries) nodes.push(...entryNodes(entry).filter(Boolean));
    }
    if (shown.length > limit) nodes.push(el('div', { class: 'tl-more' }, button(`Show ${Math.min(PAGE_SIZE, shown.length - limit)} more of ${shown.length - limit}`, () => { limit += PAGE_SIZE; drawList(); }, 'compact')));
    // A redraw (live data, the clock) keeps the keyboard where it was.
    const focusedId = list.contains(document.activeElement) ? document.activeElement.id : '';
    list.replaceChildren(...nodes);
    if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
  }

  let activeWindow = { from: 0, to: 0 };
  function drawStrip() {
    const bins = histogram(shown, { from: activeWindow.from, to: activeWindow.to, bins: 60 });
    const max = Math.max(1, ...bins.map(bin => bin.total));
    strip.replaceChildren(...bins.map(bin => {
      const label = `${clock(bin.start, { offsetMs: offsetMs(), day: activeWindow.to - activeWindow.from > 6 * HOUR })} – ${clock(bin.end, { offsetMs: offsetMs() })}: ${bin.total ? `${bin.total} entr${bin.total === 1 ? 'y' : 'ies'}${bin.warnings ? `, ${bin.warnings} warning${bin.warnings === 1 ? '' : 's'}` : ''}${bin.rollouts ? `, ${bin.rollouts} rollout${bin.rollouts === 1 ? '' : 's'}` : ''}` : 'nothing'}`;
      const node = el('button', { type: 'button', class: `tl-bin${bin.total ? '' : ' empty'}`, title: label, 'aria-label': label, disabled: !bin.total },
        el('span', { class: 'tl-bar' },
          bin.changes ? el('span', { class: 'tl-bar-info', style: `height:${Math.max(8, (bin.changes / max) * 100)}%` }) : null,
          bin.warnings ? el('span', { class: 'tl-bar-warn', style: `height:${Math.max(8, (bin.warnings / max) * 100)}%` }) : null),
        bin.rollouts ? el('span', { class: 'tl-mark', title: 'Rollout' }) : null);
      node.addEventListener('click', () => { const target = shown.find(entry => entry.time >= bin.start && entry.time <= bin.end); if (target) jumpTo(target.id); });
      return node;
    }));
    if (activeFocus) {
      const left = ((activeFocus.start - activeWindow.from) / (activeWindow.to - activeWindow.from)) * 100;
      if (left >= 0 && left <= 100) strip.append(el('span', { class: 'tl-problem-mark', style: `left:${left}%`, title: 'The problem started here' }));
    }
    const long = activeWindow.to - activeWindow.from > 6 * HOUR;
    axis.replaceChildren(el('span', { text: clock(activeWindow.from, { offsetMs: offsetMs(), day: long }) }), el('span', { text: clock((activeWindow.from + activeWindow.to) / 2, { offsetMs: offsetMs(), day: long }) }), el('span', { text: activeFocus ? clock(activeWindow.to, { offsetMs: offsetMs(), day: long }) : 'now' }));
  }

  function drawNotes() {
    const missing = [...errors].map(([resource, error]) => `${resource === 'config' ? 'ConfigMaps and Secrets' : resource === 'helm' ? 'Helm releases' : resource}: ${error.status === 403 || /forbidden/i.test(error.message) ? 'not permitted' : error.message}`);
    const lines = [...missing, ...warnings.config, ...warnings.helm];
    notes.replaceChildren(...(lines.length ? [el('details', { class: 'tl-sources' }, el('summary', { text: `${lines.length} source${lines.length === 1 ? ' is' : 's are'} incomplete` }), el('ul', {}, lines.map(line => el('li', { text: line }))))] : []));
  }

  function drawFocusBar() {
    if (!activeFocus) { focusBar.classList.add('hidden'); focusBar.replaceChildren(); return; }
    const problem = focus.problem;
    focusBar.classList.remove('hidden');
    focusBar.replaceChildren(
      el('span', { class: 'tl-focus-text' }, 'What changed before ', el('strong', { text: problem.name }), problem.title ? ` (${problem.title})` : '', ` started at ${clock(activeFocus.start, { offsetMs: offsetMs() })} — showing ${clock(activeWindow.from, { offsetMs: offsetMs() })} to ${clock(activeWindow.to, { offsetMs: offsetMs() })}. Entries about it are highlighted.`),
      el('span', { class: 'spacer' }),
      button('Open it', () => openRef({ kind: activeFocus.ref.kind, namespace: activeFocus.ref.namespace, name: activeFocus.ref.name }), 'compact quiet'),
      button(`Show the last ${RANGES.find(range => range.id === view.range).label}`, () => { focus = null; focusByTab.delete(tab.id); draw(); }, 'compact'));
  }

  function draw() {
    if (signal.aborted) return;
    windowNow = Date.now();
    for (const chip of rangeChips) { const on = !focus && chip.dataset.range === view.range; chip.classList.toggle('on', on); chip.setAttribute('aria-pressed', String(on)); }
    for (const [id, { chip }] of categoryChips) { const on = !view.hidden.has(id); chip.classList.toggle('on', on); chip.setAttribute('aria-pressed', String(on)); }
    drawNotes();
    if (!ready()) { activeFocus = null; drawFocusBar(); return; }
    const required = FEEDS.filter(feed => feed.required);
    if (required.every(feed => errors.has(feed.resource))) { list.replaceChildren(empty('The timeline could not be read', errors.get('events')?.message || 'The cluster did not answer.', button('Try again', refreshView, 'primary compact'), '⚠')); return; }
    if (focus) {
      activeFocus = focusWindow(focus.problem, all, index, { now: windowNow });
      activeWindow = { from: activeFocus.from, to: activeFocus.to };
    } else {
      activeFocus = null;
      const range = RANGES.find(item => item.id === view.range);
      activeWindow = { from: windowNow - range.ms, to: windowNow };
    }
    drawFocusBar();
    const base = inWindow(all, { from: activeWindow.from, to: activeWindow.to, text: view.text, relatedOnly: view.relatedOnly });
    const counts = countByCategory(base);
    for (const [id, { count }] of categoryChips) count.textContent = String(counts[id] || 0);
    shown = base.filter(entry => !view.hidden.has(entry.category));
    drawStrip();
    if (!shown.length) {
      const filtered = base.length || view.text || view.relatedOnly;
      list.replaceChildren(filtered
        ? empty('Nothing matches these filters', base.length ? `${base.length} entr${base.length === 1 ? 'y is' : 'ies are'} hidden by the category, text or "likely related" filters.` : 'Clear the text filter or the "likely related" toggle to see everything in this range.', undefined, '⌕')
        : empty(activeFocus ? 'Nothing changed in that window' : `Nothing changed in the last ${rangeLabel(activeWindow.to - activeWindow.from)}`, activeFocus ? 'No rollout, config change, scaling, Helm or Argo CD operation in the 30 minutes before this problem. The cause may be outside the cluster, or older: try a longer range.' : 'No rollouts, config changes, restarts or warnings in this range. Try a longer one.', undefined, '✓'));
      return;
    }
    drawList();
  }

  draw();
  // Relative times and the window move with the clock.
  const tick = setInterval(draw, 30_000);
  signal.addEventListener('abort', () => { clearInterval(tick); clearTimeout(recomputeTimer); clearTimeout(searchTimer); }, { once: true });
  return root;
}
