// Fleet: what runs where. One matrix with a column per cluster and a row per workload (plus Helm
// releases and Argo CD applications), the image tags and replicas in each cell, and the rows that
// differ between clusters marked. Read-only; a cell opens the object in its cluster, Compare… opens
// the Compare tab. The pure logic (parsing, joining, classification) is in fleet-core.js.
import { $, state, hooks, el, button, info, loading, get, page, actions, empty, readStore, writeStore, task, popupMenu } from './kit.js';
import { infoFor, labelFor, envFor } from './clusterui.js';
import { clusterIcon } from './cluster-icons.js';
import { isExpired, authOf } from './credentials.js';
import { showRelease } from './helm.js';
import { WORKLOAD_KINDS, ARGO_RESOURCE, STATUS_LABEL, workloadCell, helmCell, argoCell, shortImage, buildRows, summarize, filterRows, sortRows, comparePair, fleetColumns } from './fleet-core.js';

const COLUMNS_STORE = 'rubban.fleet.columns';
const VIEW_STORE = 'rubban.fleet.view';
const REFRESH_MS = 30000;
const FRESH_MS = 10000;
const RETRY_FAILED_MS = 120000;
const REQUEST_MS = 25000;
const RESOURCE_OF = { ...Object.fromEntries(WORKLOAD_KINDS.map(entry => [entry.kind, entry.resource])), Application: ARGO_RESOURCE };
const KIND_LABEL = { HelmRelease: 'Helm release', Application: 'Argo CD app' };
const SOFT_LABEL = { workloads: 'scale differs', helm: 'revision differs', argo: 'health differs' };
const SOFT_TITLE = {
  workloads: 'Same images; the replica count (or a CronJob\'s schedule) differs.',
  helm: 'Same chart and app version; the release was upgraded a different number of times, usually with different values.',
  argo: 'Same revision and sync state; the health differs.',
};
const STATUS_TITLE = {
  drift: 'Runs different images (or chart, revision) in these clusters. The cells that differ from the majority are marked.',
  missing: 'Exists in some of these clusters only.',
  sync: 'The same in every cluster that could be read.',
};

// Per-cluster snapshots survive re-renders (switching the tab's cluster re-renders this page), so
// coming back is instant; the view settings are remembered per window.
const snapshots = new Map();
const pending = new Map();
const view = { text: '', namespace: '', kind: '', status: '', onlyDiff: false, sort: 'name', helm: true, argo: true, ...pickView(readStore(VIEW_STORE, {})) };
let scrollMemory = 0;
let topNamespace = '*';
function pickView(saved) {
  const out = {};
  if (saved && typeof saved === 'object') {
    if (saved.sort === 'drift' || saved.sort === 'name') out.sort = saved.sort;
    for (const key of ['onlyDiff', 'helm', 'argo']) if (typeof saved[key] === 'boolean') out[key] = saved[key];
  }
  return out;
}
const saveView = () => writeStore(VIEW_STORE, { sort: view.sort, onlyDiff: view.onlyDiff, helm: view.helm, argo: view.argo });

// Opening a cell moves this tab to the cell's cluster (like a Problems row). When the matrix follows
// the open tabs, that could drop the cluster the tab came from; the clusters shown before such a
// move are kept for as long as this tab stays on the Fleet view.
let retained = { tab: '', contexts: [] };
function fleetColumnsNow() {
  const kept = retained.tab === state.active ? retained.contexts : [];
  return fleetColumns(readStore(COLUMNS_STORE, null), [...kept, ...state.tabs.map(tab => tab.context)], state.contexts.map(context => context.name));
}

// ---- Loading ----------------------------------------------------------------------------------------
const unreachable = /connection refused|dial tcp|no such host|i\/o timeout|timed out|deadline exceeded|unreachable|discovery unavailable|EOF/i;
const shortError = error => (error?.code === 'credentials' ? 'Credentials expired' : error?.status === 403 ? 'No access' : unreachable.test(error?.message || '') ? 'Unreachable' : String(error?.message || 'Unavailable').slice(0, 80));
const reason = error => (error?.code === 'credentials' ? 'Credentials expired' : error?.status === 403 ? 'No access' : error?.message || 'Unavailable');
async function loadContext(context, parent) {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(REQUEST_MS)]);
  const list = (resource, namespace = '*') => get('/api/resources', { context, namespace, resource }, { signal, context }).then(doc => doc.items || []);
  const [kinds, helm, argo] = await Promise.all([
    Promise.allSettled(WORKLOAD_KINDS.map(entry => list(entry.resource))),
    get('/api/helm', { context, namespace: '*' }, { signal, context }).then(result => ({ ok: true, releases: result.releases || [] }), error => ({ ok: false, error })),
    // Like Argo CD › Manage: without access in all namespaces, fall back to the argocd namespace.
    list(ARGO_RESOURCE).catch(error => (error?.status === 403 ? list(ARGO_RESOURCE, 'argocd') : Promise.reject(error))).then(items => ({ ok: true, items }), error => ({ ok: false, error })),
  ]);
  if (parent.aborted) return null;
  const failed = kinds.map((result, index) => (result.status === 'rejected' ? { kind: WORKLOAD_KINDS[index].kind, error: result.reason } : null)).filter(Boolean);
  const whole = failed.length === WORKLOAD_KINDS.length ? failed[0].error : null;
  const cells = kinds.flatMap((result, index) => (result.status === 'fulfilled' ? result.value.map(item => workloadCell(WORKLOAD_KINDS[index].kind, item)) : []));
  const helmMissing = !helm.ok && helm.error?.status === 503 && /helm/i.test(helm.error.message || '');
  return {
    at: Date.now(),
    error: whole ? { message: whole.message || 'Unavailable', code: whole.code || '', status: whole.status || 0 } : null,
    partial: whole ? [] : failed.map(entry => `${entry.kind}s: ${reason(entry.error)}`),
    workloads: { cells, unknown: whole ? true : new Set(failed.map(entry => entry.kind)) },
    helm: helm.ok ? { cells: helm.releases.map(helmCell), unknown: new Set() } : { cells: [], unknown: true, note: helmMissing ? 'Helm CLI not found' : reason(helm.error) },
    // A cluster without Argo CD has nothing to compare, which is not the same as "missing".
    argo: argo.ok ? { cells: argo.items.map(argoCell), unknown: new Set() } : { cells: [], unknown: true, note: argo.error?.status === 404 || /doesn't have a resource type|not found|could not find/i.test(argo.error?.message || '') ? 'No Argo CD' : reason(argo.error) },
  };
}
// One request per cluster at a time; a request started by a page that has since gone (its signal
// aborted) does not count, so the next page starts its own.
function refreshContext(context, signal) {
  const running = pending.get(context);
  if (running && !running.signal.aborted) return running.promise;
  const promise = loadContext(context, signal).then(snapshot => {
    if (snapshot) snapshots.set(context, snapshot);
  }, error => {
    if (!signal.aborted && error?.name !== 'AbortError') snapshots.set(context, { at: Date.now(), error: { message: error?.message || 'Unavailable', code: error?.code || '' }, partial: [], workloads: { cells: [], unknown: true }, helm: { cells: [], unknown: true }, argo: { cells: [], unknown: true } });
  }).finally(() => { if (pending.get(context)?.promise === promise) pending.delete(context); });
  pending.set(context, { promise, signal });
  return promise;
}

// ---- The page ---------------------------------------------------------------------------------------
export function fleetPage() {
  const signal = state.pageAbort.signal;
  if (retained.tab !== state.active) retained = { tab: '', contexts: [] };
  // Choosing a namespace in the top bar narrows the matrix too; the filter below can widen it again.
  if (state.namespace !== topNamespace) { topNamespace = state.namespace; view.namespace = topNamespace === '*' ? '' : topNamespace || ''; }
  const clustersButton = button('Clusters…', () => pickClusters(clustersButton), 'compact');
  const refreshButton = button('↻ Refresh', () => load(true), 'compact');
  const updated = el('span', { class: 'muted fleet-updated' });
  const root = page('Fleet', 'What runs where: image versions and replicas of every workload in the clusters you have open, side by side, with the rows that differ between them marked.', actions(updated, clustersButton, refreshButton));
  const summaryNode = el('div', { class: 'fleet-summary', role: 'group', 'aria-label': 'Summary' });
  const filtersNode = el('div', { class: 'form-actions start fleet-filters' });
  const body = el('div', { class: 'fleet-body' });
  root.append(summaryNode, filtersNode, body);

  const search = el('input', { type: 'search', placeholder: 'Filter by name, namespace or image', 'aria-label': 'Filter rows', value: view.text, class: 'fleet-search' });
  const namespaceSelect = el('select', { class: 'compact-select', 'aria-label': 'Namespace' });
  const kindSelect = el('select', { class: 'compact-select', 'aria-label': 'Kind' }, el('option', { value: '', text: 'All kinds' }), ...WORKLOAD_KINDS.map(entry => el('option', { value: entry.kind, text: entry.kind })), el('option', { value: 'HelmRelease', text: 'Helm releases' }), el('option', { value: 'Application', text: 'Argo CD applications' }));
  kindSelect.value = view.kind;
  const onlyDiff = el('input', { type: 'checkbox', checked: view.onlyDiff });
  const sortSelect = el('select', { class: 'compact-select', 'aria-label': 'Sort' }, el('option', { value: 'name', text: 'Sort by namespace / name' }), el('option', { value: 'drift', text: 'Sort by drift' }));
  sortSelect.value = view.sort;
  const helmBox = el('input', { type: 'checkbox', checked: view.helm });
  const argoBox = el('input', { type: 'checkbox', checked: view.argo });
  filtersNode.append(search, namespaceSelect, kindSelect, sortSelect,
    el('label', { class: 'inline-label', title: 'Hide rows that are the same in every cluster' }, onlyDiff, ' Only drift'),
    el('span', { class: 'fleet-filter-sep' }),
    el('label', { class: 'inline-label' }, helmBox, ' Helm releases'),
    el('label', { class: 'inline-label' }, argoBox, ' Argo CD'));
  search.addEventListener('input', () => { view.text = search.value; draw(); });
  namespaceSelect.addEventListener('change', () => { view.namespace = namespaceSelect.value; draw(); });
  kindSelect.addEventListener('change', () => { view.kind = kindSelect.value; draw(); });
  sortSelect.addEventListener('change', () => { view.sort = sortSelect.value; saveView(); draw(); });
  onlyDiff.addEventListener('change', () => { view.onlyDiff = onlyDiff.checked; saveView(); draw(); });
  helmBox.addEventListener('change', () => { view.helm = helmBox.checked; saveView(); draw(); });
  argoBox.addEventListener('change', () => { view.argo = argoBox.checked; saveView(); draw(); });

  function pickClusters(anchor) {
    const columns = fleetColumnsNow();
    const toggle = (name, on) => {
      const next = columns.filter(item => item !== name);
      if (on) next.push(name);
      columns.splice(0, columns.length, ...next);
      writeStore(COLUMNS_STORE, next);
      draw(); load(false);
    };
    popupMenu(anchor, [
      { heading: 'Clusters in the matrix' },
      ...state.contexts.map(context => ({ checkbox: true, label: `${labelFor(context.name)}${labelFor(context.name) !== context.name ? ` (${context.name})` : ''}`, checked: columns.includes(context.name), onChange: on => toggle(context.name, on) })),
      '-',
      { icon: '↺', label: 'Use the clusters of open tabs', title: 'Forget the picked clusters and follow the tabs again', action: () => { writeStore(COLUMNS_STORE, null); retained = { tab: '', contexts: [] }; draw(); load(false); } },
    ]);
  }

  let drawn = false;
  // force: the Refresh button (everything now) or the 30 s timer, which retries a cluster that
  // could not be read only every two minutes instead of hammering it.
  function load(force, timer = false) {
    const columns = fleetColumnsNow();
    for (const context of columns) {
      const known = snapshots.get(context);
      const age = known ? Date.now() - known.at : Infinity;
      const due = timer && known?.error ? age > RETRY_FAILED_MS : force || age > FRESH_MS;
      if (due) refreshContext(context, signal).then(() => { if (!signal.aborted) draw(); });
    }
    if (force && !timer) draw();
  }

  const NOUN = { workloads: 'workload', helm: 'release', argo: 'application' };
  function columnHead(context, section) {
    const meta = infoFor(context);
    const snapshot = snapshots.get(context);
    const env = envFor(context);
    let line;
    if (pending.has(context) && !snapshot) line = el('span', { class: 'muted', text: 'Loading…' });
    else if (snapshot?.error) {
      const expired = snapshot.error.code === 'credentials' || isExpired(context);
      line = el('span', { class: 'fleet-col-error', title: snapshot.error.message }, expired ? 'Credentials expired' : shortError(snapshot.error),
        expired && hooks.signIn ? button('Sign in again', task(async () => { await hooks.signIn(context); }), 'compact fleet-signin') : null);
    } else if (snapshot && snapshot[section].unknown === true) line = el('span', { class: 'muted', text: snapshot[section].note || 'Unavailable' });
    else if (snapshot) {
      const count = snapshot[section].cells.length;
      const partial = section === 'workloads' ? snapshot.partial : [];
      line = el('span', { class: partial.length ? 'warn-text' : 'muted', title: partial.join('\n') }, `${count} ${NOUN[section]}${count === 1 ? '' : 's'}${partial.length ? ` · ${partial.length} kind${partial.length === 1 ? '' : 's'} unreadable` : ''}${pending.has(context) ? ' · refreshing' : ''}`);
    } else line = el('span', { class: 'muted', text: 'Not loaded' });
    return el('th', { class: 'fleet-col', scope: 'col', title: `${context}${isExpired(context) ? ` — credentials expired${authOf(context).message ? `: ${authOf(context).message}` : ''}` : ''}` },
      el('div', { class: 'fleet-col-head' }, el('span', { class: 'tab-cluster', style: `color:${meta.color}` }, clusterIcon(meta.icon)), el('strong', { text: meta.label })),
      el('div', { class: 'fleet-col-state' }, env ? el('span', { class: `fleet-env ${env === 'production' ? 'bad' : env === 'staging' ? 'warn' : 'info'}`, text: env }) : null, line));
  }

  // Opens the object in its cluster: the tab moves to that cluster, like a Problems row.
  async function openCell(section, row, context) {
    const cell = row.cells[fleetColumnsNow().indexOf(context)];
    if (!cell) return;
    scrollMemory = $('#main').scrollTop;
    if (context !== state.context) {
      retained = { tab: state.active, contexts: fleetColumnsNow() };
      await hooks.selectContext(context, { namespace: '*' });
    }
    if (section === 'helm') showRelease({ ...cell.release, name: cell.name, namespace: cell.namespace });
    else hooks.showResource({ metadata: { name: cell.name, namespace: cell.namespace } }, RESOURCE_OF[cell.kind]);
  }
  function compareRow(row, columns) {
    const pair = comparePair(row);
    if (!pair) return;
    const side = index => ({ context: columns[index], namespace: row.namespace, resource: RESOURCE_OF[row.kind], name: row.name });
    hooks.openCompare(side(pair[0]), side(pair[1]));
  }

  function cellContent(section, cell) {
    if (section === 'helm') {
      return [el('span', { class: 'fleet-tags mono' }, el('span', { text: cell.chartVersion || '—' }), el('span', { class: 'muted', text: ` · app ${cell.appVersion || '—'}` })),
        el('span', { class: 'fleet-reps' }, el('i', { class: `fleet-dot ${cell.health}` }), `rev ${cell.revision}`)];
    }
    if (section === 'argo') {
      return [el('span', { class: 'fleet-tags mono', text: `${cell.shortRevision || cell.targetRevision || '—'} · ${cell.sync}` }),
        el('span', { class: 'fleet-reps' }, el('i', { class: `fleet-dot ${cell.health}` }), cell.healthStatus)];
    }
    const tags = cell.images.length ? cell.images.slice(0, 2).map(image => shortImage(image)) : ['—'];
    return [el('span', { class: 'fleet-tags mono' }, tags.join(' · '), cell.images.length > 2 ? el('span', { class: 'fleet-more', text: ` +${cell.images.length - 2}` }) : null),
      el('span', { class: 'fleet-reps' }, el('i', { class: `fleet-dot ${cell.health}` }), cell.replicas)];
  }
  function cellTitle(section, cell, context) {
    if (section === 'helm') return `${context}\n${cell.chart} ${cell.chartVersion} · app ${cell.appVersion || '—'}\nRevision ${cell.revision} · ${cell.status}`;
    if (section === 'argo') return `${context}\nRevision ${cell.revision || '—'}${cell.targetRevision ? ` (target ${cell.targetRevision})` : ''}\n${cell.sync} · ${cell.healthStatus}`;
    const images = cell.images.map(image => `${cell.images.length > 1 ? `${image.container}: ` : ''}${image.raw}`).join('\n');
    return `${context}\n${images || 'No containers'}\n${cell.desired === null ? `Schedule ${cell.replicas}` : `Ready ${cell.replicas}`}`;
  }

  function matrix(section, title, rows, columns) {
    const head = el('tr', {}, el('th', { class: 'fleet-name-col', scope: 'col', text: section === 'workloads' ? 'Workload' : section === 'helm' ? 'Release' : 'Application' }), ...columns.map(context => columnHead(context, section)), el('th', { class: 'fleet-status-col', scope: 'col', text: 'Status' }), el('th', { class: 'fleet-action-col', scope: 'col' }));
    const lines = rows.map(row => {
      const nameCell = el('td', { class: 'fleet-name' },
        el('div', { class: 'fleet-name-main' }, el('span', { class: 'kind-tag', text: KIND_LABEL[row.kind] || row.kind }), el('strong', { text: row.name })),
        el('div', { class: 'fleet-name-sub muted', text: [row.namespace, section === 'workloads' ? [...new Set(row.cells.filter(Boolean).flatMap(cell => cell.images.map(image => image.name)))].join(', ') : section === 'helm' ? row.cells.find(Boolean)?.chart : ''].filter(Boolean).join(' · ') }));
      const cellsNodes = columns.map((context, index) => {
        const cell = row.cells[index];
        if (cell === undefined) {
          const snapshot = snapshots.get(context);
          const note = !snapshot ? (pending.has(context) ? 'Loading…' : 'Not loaded') : snapshot.error ? shortError(snapshot.error) : section === 'helm' ? snapshot.helm.note : section === 'argo' ? snapshot.argo.note : `${row.kind}s could not be listed`;
          return el('td', { class: 'fleet-cell unknown', title: `${context}: ${note || 'unknown'}` }, el('span', { class: 'muted', text: !snapshot && pending.has(context) ? '…' : section === 'argo' && snapshot?.argo?.note === 'No Argo CD' ? 'n/a' : '?' }));
        }
        if (cell === null) return el('td', { class: 'fleet-cell absent', title: `${context}: not in this cluster` }, el('span', { class: 'fleet-dash', text: '—' }));
        const marks = `${row.drifted.includes(index) ? ' drifted' : ''}${row.scaled.includes(index) && !row.drifted.includes(index) ? ' scaled' : ''}`;
        const node = el('td', { class: `fleet-cell${marks}`, tabindex: '0', role: 'button', 'data-focus': `${section}|${row.key}|${context}`, title: `${cellTitle(section, cell, context)}\nClick to open in ${labelFor(context)}` }, el('div', { class: 'fleet-cell-body' }, cellContent(section, cell)));
        const open = task(() => openCell(section, row, context));
        node.addEventListener('click', open);
        node.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
        return node;
      });
      const label = row.status === 'scale' ? SOFT_LABEL[section] : STATUS_LABEL[row.status];
      const title = row.status === 'scale' ? SOFT_TITLE[section] : STATUS_TITLE[row.status];
      const extra = [row.status !== 'missing' && row.missing ? 'also missing in some clusters' : '', row.status !== 'scale' && row.scale && section === 'workloads' ? 'replicas differ too' : ''].filter(Boolean).join('; ');
      const statusCell = el('td', { class: 'fleet-status' }, el('span', { class: `fleet-pill ${row.status}`, title: `${title}${extra ? ` (${extra})` : ''}`, text: label }), extra ? el('span', { class: 'fleet-extra muted', text: row.missing && row.status !== 'missing' ? '+ missing' : '+ scale' }) : null);
      const pair = section === 'helm' ? null : comparePair(row);
      const actionCell = el('td', { class: 'fleet-action' }, pair ? button('Compare…', event => { event.stopPropagation(); compareRow(row, columns); }, 'quiet compact') : null);
      if (pair) actionCell.firstChild.title = `Compare the YAML in ${labelFor(columns[pair[0]])} and ${labelFor(columns[pair[1]])}`;
      return el('tr', { class: `fleet-row status-${row.status}` }, nameCell, ...cellsNodes, statusCell, actionCell);
    });
    const counts = summarize(rows, columns);
    const differing = counts.total - counts.sync;
    const heading = el('div', { class: 'fleet-section-title' }, el('strong', { text: title }), el('span', { class: 'muted', text: `${counts.total} shown${differing ? ` · ${differing} differ` : ''}` }));
    // Fixed column widths keep the clusters lined up from one section to the next.
    const cols = el('colgroup', {}, el('col', { class: 'fleet-w-name' }), columns.map(() => el('col', { class: 'fleet-w-cluster' })), el('col', { class: 'fleet-w-status' }), el('col', { class: 'fleet-w-action' }));
    return el('section', { class: 'panel fleet-panel' }, el('div', { class: 'panel-heading' }, heading),
      el('div', { class: 'fleet-scroll' }, el('table', { class: 'fleet-table', style: `--fleet-n:${columns.length}` }, cols, el('thead', {}, head), el('tbody', {}, lines))));
  }

  function summaryBar(rows, columns) {
    const counts = summarize(rows, columns);
    const chip = (status, text, count) => {
      const on = view.status === status;
      return el('button', { type: 'button', class: `fleet-count ${status || 'all'}${on ? ' on' : ''}`, 'aria-pressed': String(on), title: status ? `Show only rows that are ${STATUS_LABEL[status]}` : 'Show every row', onclick: () => { view.status = on ? '' : status; draw(); } }, el('strong', { text: String(count) }), ` ${text}`);
    };
    // A pair with a cluster that could not be read has nothing to say; the callout below names it.
    const readable = counts.pairs.filter(pair => !snapshots.get(pair.left)?.error && !snapshots.get(pair.right)?.error);
    const pairs = readable.slice(0, 6).map(pair => el('div', { class: 'fleet-pair' },
      el('span', { class: 'fleet-pair-names' }, el('strong', { text: labelFor(pair.left) }), ' ↔ ', el('strong', { text: labelFor(pair.right) })),
      el('span', { class: 'muted' }, `${pair.same} same · `), el('span', { class: pair.drift ? 'warn-text' : 'muted', text: `${pair.drift} drift` }),
      el('span', { class: 'muted' }, ` · ${pair.scale} scale · ${pair.onlyLeft} only in ${labelFor(pair.left)} · ${pair.onlyRight} only in ${labelFor(pair.right)}`)));
    return [el('div', { class: 'fleet-counts' },
      chip('', `workload${counts.total === 1 ? '' : 's'}`, counts.total), chip('sync', 'in sync', counts.sync), chip('drift', 'drifted', counts.drift), chip('missing', 'missing', counts.missing), chip('scale', 'scale differs', counts.scale)),
    pairs.length ? el('div', { class: 'fleet-pairs' }, pairs, readable.length > pairs.length ? el('div', { class: 'muted', text: `and ${readable.length - pairs.length} more pairs` }) : null) : null].filter(Boolean);
  }

  function draw() {
    const columns = fleetColumnsNow();
    clustersButton.textContent = `Clusters (${columns.length})…`;
    const times = columns.map(context => snapshots.get(context)?.at).filter(Boolean);
    updated.textContent = times.length ? `Updated ${new Date(Math.min(...times)).toLocaleTimeString()} · every 30 s` : '';
    if (!columns.length) {
      summaryNode.replaceChildren(); filtersNode.hidden = true;
      body.replaceChildren(empty('No clusters in the matrix', state.contexts.length ? 'Open clusters in tabs, or pick the clusters to compare with the Clusters… button.' : 'Add a kubeconfig context first; the matrix compares the clusters you have open.', button('Choose clusters…', () => pickClusters(clustersButton), 'primary compact'), '▦'));
      return;
    }
    filtersNode.hidden = false;
    if (!columns.some(context => snapshots.has(context))) { summaryNode.replaceChildren(); body.replaceChildren(loading(`Reading workloads in ${columns.length} cluster${columns.length === 1 ? '' : 's'}…`)); return; }
    const section = key => buildRows(columns, Object.fromEntries(columns.map(context => [context, snapshots.get(context)?.[key] || { cells: [], unknown: true }])));
    const workloads = section('workloads');
    const helm = section('helm');
    const argo = section('argo');
    // Namespaces come from every row, so the choice survives a filter that hides some of them.
    const namespaces = [...new Set([...workloads, ...helm, ...argo].map(row => row.namespace).filter(Boolean))].sort();
    if (view.namespace && !namespaces.includes(view.namespace)) namespaces.push(view.namespace);
    namespaceSelect.replaceChildren(el('option', { value: '', text: 'All namespaces' }), ...namespaces.map(name => el('option', { value: name, text: name })));
    namespaceSelect.value = view.namespace;
    const pick = rows => sortRows(filterRows(rows, view), view.sort);
    const shownWorkloads = pick(workloads);
    summaryNode.replaceChildren(...summaryBar(filterRows(workloads, { ...view, status: '', onlyDiff: false }), columns));
    const parts = [];
    if (columns.length === 1) parts.push(info(`Only ${labelFor(columns[0])} is in the matrix. Open another cluster in a tab, or add one with the Clusters… button, to see what differs.`));
    const unreadable = columns.filter(context => snapshots.get(context)?.error);
    if (unreadable.length) parts.push(info(`${unreadable.map(labelFor).join(', ')} could not be read; ${unreadable.length === 1 ? 'its cells show' : 'their cells show'} ? and ${unreadable.length === 1 ? 'is' : 'are'} left out of the comparison.`, 'error'));
    const wantsWorkloads = !view.kind || WORKLOAD_KINDS.some(entry => entry.kind === view.kind);
    if (wantsWorkloads) parts.push(shownWorkloads.length ? matrix('workloads', 'Workloads', shownWorkloads, columns) : el('section', { class: 'panel fleet-panel' }, empty(workloads.length ? 'No workloads match these filters' : 'No workloads found', workloads.length ? 'Change the text, namespace, kind or status filter to see the others.' : 'Deployments, StatefulSets, DaemonSets and CronJobs appear here once they are read.', undefined, '⌕')));
    const shownHelm = pick(helm);
    if (view.helm && helm.length && (!view.kind || view.kind === 'HelmRelease') && shownHelm.length) parts.push(matrix('helm', 'Helm releases', shownHelm, columns));
    const shownArgo = pick(argo);
    if (view.argo && argo.length && (!view.kind || view.kind === 'Application') && shownArgo.length) parts.push(matrix('argo', 'Argo CD applications', shownArgo, columns));
    if (!wantsWorkloads && parts.every(part => !part.classList?.contains('fleet-panel'))) parts.push(empty('Nothing of this kind matches', 'Change the kind or the other filters.', undefined, '⌕'));
    // A refresh redraws the matrix; keep the keyboard focus on the same cell.
    const focused = body.contains(document.activeElement) ? document.activeElement.dataset?.focus : '';
    body.replaceChildren(...parts);
    if (focused) body.querySelector(`[data-focus="${CSS.escape(focused)}"]`)?.focus();
    if (!drawn) {
      drawn = true;
      if (scrollMemory) { const top = scrollMemory; scrollMemory = 0; requestAnimationFrame(() => { $('#main').scrollTop = top; }); }
    }
  }

  draw();
  load(false);
  const timer = setInterval(() => load(true, true), REFRESH_MS);
  signal.addEventListener('abort', () => clearInterval(timer), { once: true });
  return root;
}
