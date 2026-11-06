// Rightsizing view: what each Deployment, StatefulSet and DaemonSet requests against what it uses,
// what the requests cost and a reviewed one-click fix. The maths lives in rightsizing-core.js; this
// module draws it and wires the data: live lists, metrics-server samples kept for the session, and
// the 7-day history from Prometheus when the cluster has one.
import { el, button, badge, actions, info, task, get, post, readStore, writeStore, state, hooks, table, page, popupMenu, modal, toast, link } from './kit.js';
import { formatCPU, formatBytes, formatPercent, formatDuration, matchesSelector } from './format.js';
import { meter } from './charts.js';
import { prometheusProvider } from './detail-common.js';
import { reviewBar } from './review.js';
import * as core from './rightsizing-core.js';

const KINDS = [['deployments', 'Deployment'], ['statefulsets', 'StatefulSet'], ['daemonsets', 'DaemonSet']];
const RESOURCE_OF = Object.fromEntries(KINDS.map(([resource, kind]) => [kind, resource]));
const PRICES_KEY = 'rubban.rightsizing.prices';
const VIEW_KEY = 'rubban.rightsizing.view';
const HISTORY_TTL_MS = 10 * 60_000;
const FILTERS = [['all', 'All'], ['over', 'Over-provisioned'], ['under', 'Under-provisioned'], ['none', 'No requests set'], ['ok', 'About right'], ['nodata', 'No usage data']];
const STATUS_RANK = { under: 0, over: 1, none: 2, ok: 3, nodata: 4 };

// ---- Session samples: every metrics-server refresh of the selected cluster is kept --------------
const samples = core.createSampleStore();
export function startRightsizingSampler(usage) {
  usage.onChange(() => { if (state.context) samples.add(state.context, usage.pods); });
}

// ---- Prometheus history, cached per cluster and namespace ---------------------------------------
const historyCache = new Map();
async function loadHistory(context, namespace, force) {
  const key = `${context}|${namespace}`;
  const cached = historyCache.get(key);
  if (!force && cached && Date.now() - cached.at < HISTORY_TTL_MS) return cached.value;
  const detected = await prometheusProvider(context, force);
  let value;
  if (!detected.provider) value = { provider: null, reason: detected.error || 'No Prometheus was found in this cluster.' };
  else {
    try {
      const answer = await post('/api/rightsizing/history', { context, namespace, days: 7 });
      const rows = (answer.containers || []).map(row => ({ ...row, cpu: row.cpu ?? NaN, memory: row.memory ?? NaN }));
      value = { provider: answer.provider, rows, days: answer.days, coverage: answer.coverageSeconds, errors: answer.errors || {}, truncated: answer.truncated };
    } catch (error) { value = { provider: detected.provider, rows: [], errors: { request: error.message } }; }
  }
  historyCache.set(key, { at: Date.now(), value });
  return value;
}

const readPrices = context => core.normalizePrices((readStore(PRICES_KEY, {}) || {})[context]);
function savePrices(context, prices) {
  const all = readStore(PRICES_KEY, {}) || {};
  all[context] = prices;
  writeStore(PRICES_KEY, all);
}
const isScheduled = pod => Boolean(pod.spec?.nodeName) && !['Succeeded', 'Failed'].includes(pod.status?.phase) && !pod.metadata?.deletionTimestamp;
const sourceLabel = u => (!u ? 'no data yet' : u.source === 'prometheus' ? `Prometheus, ${Math.round((u.window || 604800) / 86400)} days` : `metrics-server, ${u.samples} sample${u.samples === 1 ? '' : 's'} this session`);
const cpuBasisLabel = u => (!u ? '' : u.source === 'prometheus' ? 'p95' : u.samples >= 20 ? 'p95' : 'peak');

export function rightsizingPage({ liveList, liveBadge, consumeResync, refreshView }) {
  const signal = state.pageAbort.signal;
  const context = state.context; const namespace = state.namespace;
  const usage = hooks.usage;
  const status = liveBadge();
  const saved = readStore(VIEW_KEY, {}) || {};
  const view = { filter: FILTERS.some(([id]) => id === saved.filter) ? saved.filter : 'all', sortBy: saved.sortBy || 'savings', sortDesc: saved.sortDesc ?? true, search: '' };
  const persistView = () => writeStore(VIEW_KEY, { filter: view.filter, sortBy: view.sortBy, sortDesc: view.sortDesc });
  let prices = readPrices(context);
  let history = null; // Prometheus answer, or { provider: null, reason }
  const expanded = new Set();

  const root = page('Rightsizing', `${namespace === '*' ? 'All namespaces' : namespace} · what workloads request against what they use, what the requests cost, and reviewed fixes.`,
    actions(status, button('↻ Refresh', () => { historyCache.delete(`${context}|${namespace}`); refreshView(); }, 'compact')));

  // Header cards.
  const card = (label, accent) => {
    const value = el('span', { class: 'card-value', text: '—' }); const detail = el('span', { class: 'card-detail', text: 'Loading…' }); const extra = el('div', { class: 'rs-card-extra' });
    return { node: el('div', { class: `card rs-card ${accent}` }, el('span', { class: 'card-label' }, label), value, extra, detail), value, detail, extra };
  };
  const cards = { cpu: card('CPU used of requested', 'rs-accent-info'), memory: card('Memory used of requested', 'rs-accent-teal'), cost: card('Monthly cost of requests', 'rs-accent-magenta'), savings: card('Potential monthly savings', 'rs-accent-good') };
  const sourceNote = el('div', { class: 'rs-source' }, el('span', { class: 'muted', text: 'Looking for usage data…' }));
  const alerts = el('div');

  // Prices: per cluster, in this window's storage.
  const priceInput = (label, key, step) => {
    const input = el('input', { type: 'number', min: '0', step, value: String(prices[key]), class: 'rs-price', 'aria-label': label });
    input.addEventListener('change', () => { const next = core.normalizePrices({ ...prices, [key]: input.value }); input.value = String(next[key]); prices = next; savePrices(context, prices); schedule(); });
    return input;
  };
  const currencyInput = el('input', { type: 'text', value: prices.currency, maxlength: '8', class: 'rs-currency', 'aria-label': 'Currency' });
  currencyInput.addEventListener('change', () => { prices = core.normalizePrices({ ...prices, currency: currencyInput.value }); currencyInput.value = prices.currency; savePrices(context, prices); schedule(); });
  const cpuPrice = priceInput('Price per vCPU-hour', 'cpu', '0.001'); const memoryPrice = priceInput('Price per GiB-hour', 'memory', '0.0001');
  const resetPrices = button('Defaults', () => { prices = { ...core.DEFAULT_PRICES }; cpuPrice.value = String(prices.cpu); memoryPrice.value = String(prices.memory); currencyInput.value = prices.currency; savePrices(context, prices); schedule(); }, 'quiet compact');
  const pricesBar = el('div', { class: 'rs-prices' },
    el('label', { class: 'inline-label' }, 'vCPU-hour', cpuPrice), el('label', { class: 'inline-label' }, 'GiB-hour', memoryPrice), el('label', { class: 'inline-label' }, 'Currency', currencyInput), resetPrices,
    el('span', { class: 'rs-prices-note', text: `Estimate from requests × prices × ${core.HOURS_PER_MONTH} h a month. Saved for ${context}.` }));

  // Filters, search and the workload table.
  const chipNodes = new Map();
  const chips = el('div', { class: 'rs-filters', role: 'group', 'aria-label': 'Filter by classification' }, FILTERS.map(([id, label]) => {
    const chip = el('button', { type: 'button', class: `chip-button rs-chip ${id}${view.filter === id ? ' on' : ''}`, 'aria-pressed': String(view.filter === id) }, label, el('span', { class: 'rs-chip-count' }));
    chip.addEventListener('click', () => { view.filter = id; for (const [key, node] of chipNodes) { node.classList.toggle('on', key === id); node.setAttribute('aria-pressed', String(key === id)); } persistView(); draw(); });
    chipNodes.set(id, chip);
    return chip;
  }));
  const search = el('input', { type: 'search', class: 'table-search', placeholder: 'Filter workloads…', 'aria-label': 'Filter workloads' });
  search.addEventListener('input', () => { view.search = search.value.trim().toLowerCase(); draw(); });
  const count = el('span', { class: 'table-count' });
  const thead = el('thead'); const tbody = el('tbody');
  const tableNode = el('table', { class: 'rs-table' }, thead, tbody);
  const tablePanel = el('section', { class: 'panel table-panel' }, el('div', { class: 'table-toolbar' }, search, el('div', { class: 'actions' }, count)), el('div', { class: 'table-scroll' }, tableNode));

  const namespaceTable = table([], [
    { id: 'namespace', title: 'Namespace', class: 'name', locked: true, render: row => row.namespace, sort: row => row.namespace },
    { id: 'workloads', title: 'Workloads', class: 'num', render: row => String(row.workloads), sort: row => row.workloads },
    { id: 'cpu', title: 'CPU requested', class: 'num', render: row => formatCPU(row.cpu), sort: row => row.cpu },
    { id: 'memory', title: 'Memory requested', class: 'num', render: row => formatBytes(row.memory), sort: row => row.memory },
    { id: 'cost', title: 'Cost / month', class: 'num', render: row => core.formatMoney(row.cost, prices.currency), sort: row => row.cost, sortDesc: true },
    { id: 'savings', title: 'Potential savings / month', class: 'num', render: row => savingsNode(row.savings), sort: row => row.savings, sortDesc: true },
    { id: 'attention', title: 'Needs attention', class: 'num', render: row => String(row.byStatus.over + row.byStatus.under + row.byStatus.none), sort: row => row.byStatus.over + row.byStatus.under + row.byStatus.none, sortDesc: true },
  ], row => { search.value = row.namespace; view.search = row.namespace; draw(); search.focus(); }, { id: 'rightsizing:namespaces', key: row => row.namespace, stamp: row => `${row.cost}|${row.savings}|${row.workloads}|${prices.currency}`, sortBy: 'cost', sortDesc: true, pending: true, placeholder: 'Filter namespaces…', searchText: row => row.namespace, empty: 'No workloads in this scope.' });

  root.append(el('div', { class: 'cards rs-cards' }, Object.values(cards).map(c => c.node)), sourceNote, alerts, pricesBar,
    el('div', { class: 'section-label' }, el('h2', { text: 'Workloads' }), el('span', { text: 'Deployments, StatefulSets and DaemonSets · select a row for each container' })),
    el('div', { class: 'rs-toolbar' }, chips), tablePanel,
    el('div', { class: 'section-label' }, el('h2', { text: 'By namespace' }), el('span', { text: 'Monthly cost of requests and what the recommendations would save' })), namespaceTable);

  // ---- Data --------------------------------------------------------------------------------------
  const data = { deployments: null, statefulsets: null, daemonsets: null, pods: null, nodes: null };
  const errors = new Map();
  let analyses = []; let largest = null; let usedNow = { cpu: 0, memory: 0, measured: false };
  let pending = null;
  function schedule() { if (!pending) pending = setTimeout(recompute, 250); }
  signal.addEventListener('abort', () => clearTimeout(pending), { once: true });

  function usageFor(kind, workload) {
    const ns = workload.metadata.namespace; const name = workload.metadata.name;
    const fromHistory = history?.rows ? core.historyForWorkload(history.rows, ns, kind, name, (history.days || 7) * 86400) : new Map();
    const fromSession = samples.forWorkload(context, ns, kind, name);
    const out = new Map();
    for (const c of workload.spec?.template?.spec?.containers || []) { const value = fromHistory.get(c.name) || fromSession.get(c.name); if (value) out.set(c.name, value); }
    return out;
  }
  function recompute() {
    pending = null;
    if (!data.pods || KINDS.some(([resource]) => !data[resource] && !errors.has(resource))) return;
    largest = core.largestNode(data.nodes || []);
    const podsByNamespace = new Map();
    for (const pod of data.pods) { const ns = pod.metadata?.namespace || ''; if (!podsByNamespace.has(ns)) podsByNamespace.set(ns, []); podsByNamespace.get(ns).push(pod); }
    const list = []; usedNow = { cpu: 0, memory: 0, measured: false };
    for (const [resource, kind] of KINDS) {
      for (const workload of data[resource] || []) {
        const selector = workload.spec?.selector;
        const pods = selector ? (podsByNamespace.get(workload.metadata.namespace) || []).filter(pod => matchesSelector(selector, pod.metadata?.labels || {})) : [];
        const scheduled = pods.filter(isScheduled);
        const replicas = kind === 'DaemonSet' ? workload.status?.desiredNumberScheduled ?? scheduled.length : workload.spec?.replicas ?? 1;
        const analysis = core.analyzeWorkload({ kind, name: workload.metadata.name, namespace: workload.metadata.namespace, containers: workload.spec?.template?.spec?.containers || [], pods: scheduled.length, replicas, usage: usageFor(kind, workload), prices, largestNode: largest });
        let cpu = 0; let memory = 0; let measured = 0;
        for (const pod of scheduled) { const sample = usage.pod(pod); if (sample) { cpu += sample.cpu; memory += sample.memory; measured++; } }
        analysis.live = { cpu, memory, measured, pending: pods.length - scheduled.length };
        analysis.key = `${kind}/${analysis.namespace}/${analysis.name}`;
        analysis.item = workload;
        analysis.text = core.recommendationText(analysis, largest);
        if (measured) { usedNow.cpu += cpu; usedNow.memory += memory; usedNow.measured = true; }
        list.push(analysis);
      }
    }
    analyses = list;
    paint();
  }

  // ---- Drawing -----------------------------------------------------------------------------------
  function savingsNode(value) {
    if (!Number.isFinite(value) || Math.abs(value) < 0.005) return el('span', { class: 'muted', text: '—' });
    return value > 0 ? el('span', { class: 'rs-save', text: core.formatMoney(value, prices.currency) }) : el('span', { class: 'rs-cost-up', title: 'Applying this raises the cost: the workload needs more than it requests', text: `+${core.formatMoney(-value, prices.currency)}` });
  }
  // A compact "requested vs used" bar: the fill is what is used, the mark is the request.
  function requestBar(used, requested, format, { measured = true, name = '' } = {}) {
    const hasUse = measured && Number.isFinite(used);
    const total = Math.max(requested || 0, hasUse ? used : 0);
    const label = (name ? `${name} ` : '') + (requested > 0 ? (hasUse ? `${format(used)} of ${format(requested)}` : `${format(requested)} requested`) : (hasUse ? `${format(used)} · no request` : 'no request'));
    const node = meter({ used: hasUse ? used : NaN, total: total || 1, request: requested > 0 && hasUse && used > requested ? requested : undefined, label, detail: hasUse && requested > 0 ? formatPercent(used, requested) || '0%' : '' });
    node.classList.add('rs-meter');
    const fill = node.querySelector('.meter-fill');
    if (fill && hasUse) fill.dataset.level = requested > 0 ? (used > requested ? 'bad' : used / requested < 0.4 ? 'warn' : 'good') : 'warn';
    return node;
  }
  function setSource() {
    const parts = [];
    const coverage = samples.coverage(context);
    if (history?.provider) {
      const p = history.provider;
      const covered = Number.isFinite(history.coverage) && history.coverage > 0 ? ` · data covers ${formatDuration(history.coverage * 1000)}` : '';
      parts.push(el('span', {}, badge('Prometheus', 'good'), ` ${p.namespace}/${p.service}:${p.port} · p95 CPU and peak memory per container over ${history.days || 7} days${covered}.`));
      const failed = Object.entries(history.errors || {}).filter(([key]) => key !== 'coverage');
      if (failed.length) parts.push(el('span', { class: 'rs-source-warn', text: ` Some history could not be read (${failed.map(([key, message]) => `${key}: ${message}`).join('; ')}); those containers use session samples.` }));
      if (history.truncated) parts.push(el('span', { class: 'rs-source-warn', text: ' Too many containers: the history was cut short.' }));
    }
    if (usage.available === false && !history?.provider) parts.push(el('span', {}, badge('No usage source', 'bad'), ` metrics.k8s.io is unavailable (${usage.message || 'metrics-server is not installed'}) and no Prometheus was found. Without usage, nothing is recommended.`));
    else if (!history?.provider) {
      const span = coverage ? Math.max(0, coverage.until - coverage.since) : 0;
      parts.push(el('span', {}, badge('metrics-server', 'info'), coverage
        ? ` Samples kept while Rubban has this cluster open: ${coverage.refreshes} refresh${coverage.refreshes === 1 ? '' : 'es'} over ${span >= 1000 ? formatDuration(span) : 'less than a minute'}. A short window misses daily peaks, so treat the recommendations as provisional${history ? '' : ' (checking for Prometheus…)'}.`
        : ' Waiting for the first metrics-server sample…'));
      if (history && !history.provider) parts.push(el('span', { class: 'muted', text: ' With Prometheus in the cluster, the 7-day p95 is used instead.' }));
    }
    sourceNote.replaceChildren(...parts);
  }
  function paint() {
    setSource();
    const sum = core.totals(analyses);
    const usedText = (used, req, fmt) => (usedNow.measured ? (req > used ? `${fmt(req - used)} requested but unused right now` : 'Pods use more than they request') : 'Usage not reported by metrics.k8s.io');
    cards.cpu.value.textContent = usedNow.measured && sum.cpu ? formatPercent(usedNow.cpu, sum.cpu) || '0%' : '—';
    cards.cpu.detail.textContent = usedText(usedNow.cpu, sum.cpu, formatCPU);
    cards.cpu.extra.replaceChildren(requestBar(usedNow.cpu, sum.cpu, formatCPU, { measured: usedNow.measured }));
    cards.memory.value.textContent = usedNow.measured && sum.memory ? formatPercent(usedNow.memory, sum.memory) || '0%' : '—';
    cards.memory.detail.textContent = usedText(usedNow.memory, sum.memory, formatBytes);
    cards.memory.extra.replaceChildren(requestBar(usedNow.memory, sum.memory, formatBytes, { measured: usedNow.measured }));
    cards.cost.value.textContent = core.formatMoney(sum.cost, prices.currency);
    cards.cost.detail.textContent = `Estimate from the requests of ${sum.workloads} workload${sum.workloads === 1 ? '' : 's'} at ${core.formatPrice(prices.cpu, prices.currency)} per vCPU-hour and ${core.formatPrice(prices.memory, prices.currency)} per GiB-hour`;
    cards.cost.extra.replaceChildren();
    // Net of both directions: under-provisioned workloads cost more once they request what they use.
    cards.savings.value.textContent = sum.savings >= 0 ? core.formatMoney(sum.savings, prices.currency) : `+${core.formatMoney(-sum.savings, prices.currency)}`;
    cards.savings.node.classList.toggle('rs-net-increase', sum.savings < 0);
    cards.savings.detail.textContent = !sum.applicable ? 'Nothing to change with the usage seen so far'
      : sum.savings < 0 ? `A net increase: requests are too low overall. All ${sum.applicable} recommendations free ${core.formatMoney(sum.freed, prices.currency)} and add ${core.formatMoney(sum.added, prices.currency)}`
        : `If all ${sum.applicable} recommendation${sum.applicable === 1 ? ' is' : 's are'} applied${sum.added > 0.005 ? ` (frees ${core.formatMoney(sum.freed, prices.currency)}, adds ${core.formatMoney(sum.added, prices.currency)} where requests are too low)` : ''}`;
    cards.savings.extra.replaceChildren();
    // The glaring ones: requests no node can satisfy.
    const impossible = analyses.filter(a => a.flags.includes('exceeds-node'));
    alerts.replaceChildren(...impossible.map(a => el('div', { class: 'callout error rs-alert' },
      el('strong', { text: `${a.kind} ${a.namespace}/${a.name}` }), ` ${a.text}.`, a.live.pending ? ` ${a.live.pending} pod${a.live.pending === 1 ? ' is' : 's are'} Pending.` : '',
      ` Its requests would hold ${core.formatMoney(a.desiredCost, prices.currency)} a month once scheduled. `, link('Open', () => hooks.showResource(a.item ? { ...a.item, kind: a.kind } : { kind: a.kind, metadata: { name: a.name, namespace: a.namespace } }, RESOURCE_OF[a.kind])))));
    for (const [id, chip] of chipNodes) chip.querySelector('.rs-chip-count').textContent = String(id === 'all' ? sum.workloads : sum.byStatus[id] || 0);
    namespaceTable.update(core.byNamespace(analyses));
    draw();
  }

  const COLUMNS = [
    { id: 'expand', title: '', class: 'rs-expand-col' },
    { id: 'name', title: 'Workload', class: 'name rs-name-col', sort: a => `${a.namespace}/${a.name}` },
    { id: 'pods', title: 'Pods', class: 'num rs-col-pods', sort: a => a.pods },
    { id: 'usage', title: 'Used / requested', class: 'rs-bar-col', help: 'Sorts by the share of requested CPU in use', sort: a => (a.live.measured && a.requested.cpu ? a.live.cpu / a.requested.cpu : NaN) },
    { id: 'recommendation', title: 'Recommendation', class: 'wrap rs-rec-col' },
    { id: 'cost', title: 'Cost / mo', class: 'num rs-col-cost', sort: a => a.cost, desc: true },
    { id: 'savings', title: 'Savings / mo', class: 'num', sort: a => a.savings, desc: true },
    { id: 'actions', title: '', class: 'rs-actions-col' },
  ];
  function header() {
    thead.replaceChildren(el('tr', {}, COLUMNS.map(column => {
      if (!column.sort) return el('th', { class: column.class || '' }, column.title ? column.title : el('span', { class: 'sr-only', text: column.id === 'expand' ? 'Expand' : 'Actions' }));
      const sorted = view.sortBy === column.id;
      const th = el('th', { class: `sortable${sorted ? ' sorted' : ''} ${column.class || ''}`, 'aria-sort': sorted ? (view.sortDesc ? 'descending' : 'ascending') : 'none' },
        el('button', { type: 'button', class: 'rs-sort', title: column.help || 'Sort by this column' }, column.title, sorted ? el('span', { class: 'sort-arrow', text: view.sortDesc ? ' ▾' : ' ▴' }) : null));
      th.querySelector('button').addEventListener('click', () => {
        if (view.sortBy === column.id) view.sortDesc = !view.sortDesc; else { view.sortBy = column.id; view.sortDesc = Boolean(column.desc); }
        persistView(); header(); draw();
      });
      return th;
    })));
  }
  function visible() {
    let list = analyses;
    if (view.filter !== 'all') list = list.filter(a => a.status === view.filter);
    if (view.search) list = list.filter(a => `${a.kind} ${a.namespace}/${a.name} ${core.STATUSES[a.status].label} ${a.text}`.toLowerCase().includes(view.search));
    const column = COLUMNS.find(c => c.id === view.sortBy) || COLUMNS.find(c => c.id === 'savings');
    const value = a => { try { return column.sort(a); } catch { return NaN; } };
    return [...list].sort((a, b) => {
      const x = value(a); const y = value(b);
      const missX = x === undefined || x === null || Number.isNaN(x); const missY = y === undefined || y === null || Number.isNaN(y);
      if (missX || missY) return missX === missY ? a.key.localeCompare(b.key) : missX ? 1 : -1;
      const result = typeof x === 'number' ? x - y : String(x).localeCompare(String(y));
      return (view.sortDesc ? -result : result) || STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.key.localeCompare(b.key);
    });
  }
  function draw() {
    const focusKey = document.activeElement && tbody.contains(document.activeElement) ? document.activeElement.dataset.focus : '';
    const rows = visible();
    count.textContent = `${rows.length} of ${analyses.length}`;
    if (!rows.length) {
      tbody.replaceChildren(el('tr', {}, el('td', { colspan: COLUMNS.length }, el('div', { class: 'list-note', text: data.pods === null ? 'Loading from your cluster…' : analyses.length ? 'No workloads match this filter.' : 'No Deployments, StatefulSets or DaemonSets in this scope.' }))));
      return;
    }
    const nodes = [];
    for (const a of rows) { nodes.push(rowNode(a)); if (expanded.has(a.key)) nodes.push(detailNode(a)); }
    tbody.replaceChildren(...nodes);
    if (focusKey) tbody.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`)?.focus();
  }
  function toggle(a) { if (expanded.has(a.key)) expanded.delete(a.key); else expanded.add(a.key); draw(); }
  function rowNode(a) {
    const meta = core.STATUSES[a.status];
    // Without scheduled pods the bars show what one desired replica set asks for.
    const shown = a.pods ? a.requested : { cpu: a.perPod.cpu * a.replicas, memory: a.perPod.memory * a.replicas };
    const open = expanded.has(a.key);
    const chevron = el('button', { type: 'button', class: 'icon-button rs-chevron', 'aria-expanded': String(open), 'aria-label': `${open ? 'Hide' : 'Show'} containers of ${a.name}`, 'data-focus': `${a.key}|chevron`, text: open ? '▾' : '▸' });
    chevron.addEventListener('click', event => { event.stopPropagation(); toggle(a); });
    const apply = el('button', { type: 'button', class: 'compact rs-apply', disabled: !a.applicable, title: a.applicable ? 'Review the change (diff and server dry-run) before applying' : a.containers.some(c => c.usage) ? 'Nothing to change' : 'No usage data: nothing is changed without it', 'data-focus': `${a.key}|apply` }, 'Apply…');
    apply.addEventListener('click', event => { event.stopPropagation(); openApply(a); });
    const more = el('button', { type: 'button', class: 'row-menu', 'aria-label': `More actions for ${a.name}`, title: 'Actions', text: '⋮', 'data-focus': `${a.key}|menu` });
    more.addEventListener('click', event => { event.stopPropagation(); popupMenu(more, menuItems(a)); });
    const pending = a.live.pending ? el('span', { class: 'rs-pending', title: 'Pods that are not scheduled hold no resources yet', text: ` +${a.live.pending} pending` }) : null;
    const tr = el('tr', { class: `clickable rs-row${open ? ' open' : ''}`, tabindex: '0', 'data-focus': `${a.key}|row`, 'aria-expanded': String(open) },
      el('td', { class: 'rs-expand-col' }, chevron),
      el('td', { class: 'name rs-name-col', title: `${a.kind} ${a.namespace}/${a.name}` }, el('div', { class: 'rs-name' },
        el('span', { class: 'rs-name-line' }, el('span', { class: 'kind-tag', text: a.kind }), ' ', el('span', { class: 'rs-ns', text: `${a.namespace}/` }), el('span', { class: 'rs-workload', text: a.name })),
        el('span', { class: 'rs-name-line' }, a.flags.includes('exceeds-node') ? badge('Over-requested', 'bad') : badge(meta.label, meta.level), el('span', { class: 'rs-pods-inline', text: ` · ${a.pods} pod${a.pods === 1 ? '' : 's'}` }), pending))),
      el('td', { class: 'num rs-col-pods' }, String(a.pods)),
      el('td', { class: 'rs-bar-col' }, el('div', { class: 'rs-bars' },
        requestBar(a.live.cpu, shown.cpu, formatCPU, { measured: a.live.measured > 0, name: 'CPU' }),
        requestBar(a.live.memory, shown.memory, formatBytes, { measured: a.live.measured > 0, name: 'Mem' }))),
      el('td', { class: 'wrap rs-rec-col', title: a.text }, a.text),
      el('td', { class: 'num rs-col-cost', title: a.pods ? `${formatCPU(a.requested.cpu)} and ${formatBytes(a.requested.memory)} requested by ${a.pods} pod${a.pods === 1 ? '' : 's'}` : 'No scheduled pods' }, a.pods ? core.formatMoney(a.cost, prices.currency) : el('span', { class: 'muted', text: '—' })),
      el('td', { class: 'num' }, savingsNode(a.savings)),
      el('td', { class: 'rs-actions-col' }, el('span', { class: 'rs-row-actions' }, apply, more)));
    tr.addEventListener('click', () => toggle(a));
    tr.addEventListener('keydown', event => { if ((event.key === 'Enter' || event.key === ' ') && event.target === tr) { event.preventDefault(); toggle(a); } });
    tr.addEventListener('contextmenu', event => { event.preventDefault(); popupMenu(more, menuItems(a)); });
    return tr;
  }
  function menuItems(a) {
    return [
      { icon: '⇪', label: 'Apply…', disabled: !a.applicable, action: () => openApply(a) },
      { icon: '⧉', label: 'Copy as kubectl', disabled: !a.applicable, action: () => copy(core.kubectlCommand(a, { context }), 'kubectl command copied.') },
      { icon: '{}', label: 'Copy patch', disabled: !a.applicable, action: () => copy(JSON.stringify(core.strategicPatch(a)), 'Strategic-merge patch copied.') },
      '-',
      { icon: '☰', label: 'Open workload', action: () => hooks.showResource({ ...a.item, kind: a.kind }, RESOURCE_OF[a.kind]) },
    ];
  }
  // Per container: request, limit, what was used (and how it was measured) and the recommendation.
  function detailNode(a) {
    const blocks = a.containers.map(c => {
      const u = c.usage;
      const cell = (text, cls = '') => el('td', { class: `num ${cls}` }, text);
      const changeCell = (now, next, fmt) => (next === undefined || next === now || (!Number.isFinite(now) && !Number.isFinite(next)) ? cell(Number.isFinite(now) ? fmt(now) : '—', 'muted') : cell(fmt(next), 'rs-next'));
      const usedCPU = u ? `${formatCPU(u.cpu)} ${cpuBasisLabel(u)}${u.cpuPeak !== undefined && u.cpuPeak !== u.cpu ? ` · peak ${formatCPU(u.cpuPeak)}` : ''}` : '—';
      const rows = el('table', { class: 'rs-container-table' },
        el('thead', {}, el('tr', {}, el('th', { text: '' }), el('th', { class: 'num', text: 'Request' }), el('th', { class: 'num', text: 'Limit' }), el('th', { class: 'num', text: 'Used' }), el('th', { class: 'num', text: 'New request' }), el('th', { class: 'num', text: 'New limit' }))),
        el('tbody', {},
          el('tr', {}, el('th', { text: 'CPU' }), cell(Number.isFinite(c.request.cpu) ? formatCPU(c.request.cpu) : 'not set'), cell(Number.isFinite(c.limit.cpu) ? formatCPU(c.limit.cpu) : 'none'), cell(usedCPU), changeCell(c.request.cpu, c.next?.request.cpu, formatCPU), changeCell(c.limit.cpu, c.next?.limit.cpu, formatCPU)),
          el('tr', {}, el('th', { text: 'Memory' }), cell(Number.isFinite(c.request.memory) ? formatBytes(c.request.memory) : 'not set'), cell(Number.isFinite(c.limit.memory) ? formatBytes(c.limit.memory) : 'none'), cell(u ? `${formatBytes(u.memory)} peak` : '—'), changeCell(c.request.memory, c.next?.request.memory, formatBytes), changeCell(c.limit.memory, c.next?.limit.memory, formatBytes))));
      const flags = c.flags.map(flag => el('span', { class: `rs-flag ${['oom-risk', 'throttle-risk', 'cpu-under', 'memory-under'].includes(flag) ? 'bad' : ''}`, text: core.FLAG_TEXT[flag] || flag }));
      return el('div', { class: 'rs-container' },
        el('div', { class: 'rs-container-head' }, el('strong', { text: c.name }), badge(core.STATUSES[c.status].label, core.STATUSES[c.status].level), el('span', { class: 'muted', text: `Usage source: ${sourceLabel(u)}` })),
        rows, flags.length ? el('div', { class: 'rs-flags' }, flags) : null);
    });
    const tools = el('div', { class: 'rs-detail-actions' },
      a.applicable ? button('Apply…', () => openApply(a), 'compact primary') : null,
      a.applicable ? button('Copy as kubectl', () => copy(core.kubectlCommand(a, { context }), 'kubectl command copied.'), 'compact') : null,
      button('Open workload', () => hooks.showResource({ ...a.item, kind: a.kind }, RESOURCE_OF[a.kind]), 'quiet compact'),
      el('span', { class: 'muted', text: `CPU request = ${cpuBasisLabel(a.containers.find(c => c.usage)?.usage) || 'p95'} × ${core.CPU_HEADROOM}; memory request = peak × ${core.MEMORY_HEADROOM}; rounded up, never below 10m / 32Mi. Limits are kept unless they sit below the new request.` }));
    return el('tr', { class: 'rs-detail' }, el('td', { colspan: COLUMNS.length }, el('div', { class: 'rs-detail-body' }, blocks, tools)));
  }
  const copy = task(async (text, message) => { await navigator.clipboard.writeText(text); toast(message); });

  // ---- Apply: the strategic-merge change, reviewed like any manifest ------------------------------
  const openApply = task(async a => {
    const resource = RESOURCE_OF[a.kind];
    const live = await get('/api/resource', { context, namespace: a.namespace, resource, name: a.name });
    // The recommendation was computed from the watched object: recompute it from what the API returned now.
    const fresh = core.analyzeWorkload({ kind: a.kind, name: a.name, namespace: a.namespace, containers: live.spec?.template?.spec?.containers || [], pods: a.pods, replicas: a.replicas, usage: new Map(a.containers.filter(c => c.usage).map(c => [c.name, c.usage])), prices, largestNode: largest });
    if (!fresh.applicable) { toast(`${a.name} needs no change any more.`); return; }
    const manifest = core.manifestFor(live, fresh);
    const editor = el('textarea', { class: 'editor rs-manifest', readonly: true, spellcheck: 'false', 'aria-label': 'Manifest that will be applied', value: `${JSON.stringify(manifest, null, 2)}\n` });
    const command = core.kubectlCommand(fresh, { context });
    const patch = JSON.stringify(core.strategicPatch(fresh), null, 2);
    const changes = el('table', { class: 'rs-change-table' },
      el('thead', {}, el('tr', {}, el('th', { text: 'Container' }), el('th', { text: 'Resource' }), el('th', { class: 'num', text: 'Now' }), el('th', { class: 'num', text: 'New' }))),
      el('tbody', {}, fresh.containers.filter(c => c.changed).flatMap(c => [
        ['CPU request', c.request.cpu, c.next.request.cpu, formatCPU], ['CPU limit', c.limit.cpu, c.next.limit.cpu, formatCPU],
        ['Memory request', c.request.memory, c.next.request.memory, formatBytes], ['Memory limit', c.limit.memory, c.next.limit.memory, formatBytes],
      ].filter(([, now, next]) => Number.isFinite(next) && next !== now).map(([label, now, next, fmt]) => el('tr', {}, el('td', { text: c.name }), el('td', { text: label }), el('td', { class: 'num', text: Number.isFinite(now) ? fmt(now) : 'not set' }), el('td', { class: 'num rs-next', text: fmt(next) }))))));
    const session = fresh.containers.filter(c => c.changed && c.usage?.source === 'session');
    const shortest = session.length ? Math.min(...session.map(c => c.usage.until - c.usage.since)) : Infinity;
    const notes = [
      el('div', { class: 'callout info', text: `Changing the pod template rolls out new pods for ${a.kind} ${a.name}. The cost change is an estimate: ${savingsText(fresh.savings)} a month.` }),
      session.length && shortest < 3600_000 ? el('div', { class: 'callout warn', text: `Based on metrics-server samples from ${shortest < 60_000 ? 'less than a minute' : `the last ${formatDuration(shortest)}`} only. Peaks outside that window are not seen; keep Rubban open on this cluster longer, or use Prometheus, for a steadier answer.` }) : null,
      live.metadata?.annotations?.[core.LAST_APPLIED] ? null : el('div', { class: 'callout info', text: 'This object was not created with kubectl apply, so kubectl warns about the missing last-applied annotation and records one that holds only these resources. Nothing else in the object changes.' }),
      fresh.containers.some(c => c.changed && c.flags.includes('qos-change')) ? el('div', { class: 'callout warn', text: `Requests equal limits today, so the pods are Guaranteed QoS. With requests below limits they become Burstable and are evicted earlier under node pressure.` }) : null,
    ];
    const review = reviewBar({ editor, target: { context, namespace: a.namespace }, confirmText: `Change the resources of ${a.kind} ${a.name}. Its pods will be replaced.`, confirmName: a.name, destructive: true });
    modal(`Rightsize ${a.name}`, `${a.kind} in ${a.namespace} on ${context}. The diff and the server-side dry-run below are what kubectl will apply.`, el('div', { class: 'rs-apply-body' },
      changes, notes,
      el('details', { class: 'rs-more' }, el('summary', { text: 'Strategic-merge patch and kubectl command' }),
        el('div', { class: 'rs-code-head' }, el('span', { text: 'Patch (containers merge by name)' }), button('Copy', () => copy(patch, 'Patch copied.'), 'quiet compact')), el('pre', { class: 'output rs-code', text: patch }),
        el('div', { class: 'rs-code-head' }, el('span', { text: 'Equivalent kubectl' }), button('Copy', () => copy(command, 'kubectl command copied.'), 'quiet compact')), el('pre', { class: 'output rs-code', text: command })),
      el('details', { class: 'rs-more' }, el('summary', { text: 'Manifest sent to kubectl apply' }), editor),
      review));
    review.querySelector('.form-actions button')?.click();
  });
  const savingsText = value => (value >= 0 ? `saves ${core.formatMoney(value, prices.currency)}` : `adds ${core.formatMoney(-value, prices.currency)}`);

  // ---- Subscriptions -------------------------------------------------------------------------------
  header();
  draw();
  const resync = consumeResync();
  for (const resource of [...KINDS.map(([r]) => r), 'pods']) {
    liveList({ resource, signal, resync, onStatus: value => status.track(resource, value),
      onData: items => { data[resource] = items; errors.delete(resource); schedule(); },
      onError: error => { errors.set(resource, error); if (resource === 'pods') { tablePanel.replaceWith(info(error.message, 'error')); sourceNote.replaceChildren(info(`Pods cannot be listed, so nothing can be measured: ${error.message}`, 'error')); } else { data[resource] = []; schedule(); toast(`${resource}: ${error.message}`, true); } } });
  }
  // Nodes are cluster-wide; a user who cannot list them just does not get the "fits no node" check.
  liveList({ resource: 'nodes', namespace: '*', signal, onData: items => { data.nodes = items; schedule(); }, onError: () => { data.nodes = []; schedule(); } });
  usage.onChange(schedule, signal);
  loadHistory(context, namespace, false).then(value => { if (signal.aborted) return; history = value; schedule(); setSource(); });
  return root;
}
