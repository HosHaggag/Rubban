// Building blocks for resource detail drawers: object metadata, consumption meters, owned pods,
// conditions, tolerations, metrics charts (Prometheus, or session history from metrics-server).
import { state, hooks, el, button, badge, info, loading, mini, get, post, table, dl, link, chips, section, age, dateText, statusOf, liveKey, task } from './kit.js';
import { formatCPU, formatBytes, formatPercent, selectorText } from './format.js';
import { lineChart, meter } from './charts.js';
import { kindColumns, pageContext, resourceForKind, controllerOf } from './kinds.js';
import { rowMenu } from './ops.js';
import { RANGES, stepFor } from './promql.js';

export const muted = text => el('span', { class: 'muted', text });
export function openRef(kind, name, namespace = '', apiVersion = '') {
  if (!kind || !name) return;
  const resource = resourceForKind(kind, apiVersion);
  hooks.showResource({ kind, apiVersion, metadata: { name, namespace } }, resource);
}
export const refLink = (kind, name, namespace = '', apiVersion = '') => (name ? link(name, () => openRef(kind, name, namespace, apiVersion), `Open ${kind} ${name}`) : muted('—'));
export const kindRef = ref => (ref ? el('span', {}, el('span', { class: 'kind-tag', text: ref.kind }), ' ', refLink(ref.kind, ref.name, ref.namespace, ref.apiVersion)) : muted('—'));

export function metaSection(selected) {
  const item = selected.item; const metadata = item.metadata || {};
  const annotations = Object.entries(metadata.annotations || {}).filter(([key]) => key !== 'kubectl.kubernetes.io/last-applied-configuration');
  const owners = (metadata.ownerReferences || []).map(ref => el('div', {}, kindRef({ ...ref, namespace: metadata.namespace }), ref.controller ? muted(' · controller') : ''));
  const annotationList = annotations.length ? el('div', { class: 'annotation-list' }, annotations.map(([key, value]) => {
    const long = String(value).length > 160;
    const valueNode = el('span', { class: 'annotation-value', text: long ? `${String(value).slice(0, 160)}…` : String(value) });
    if (long) valueNode.append(' ', link('more', () => { valueNode.textContent = String(value); }));
    return el('div', { class: 'annotation' }, el('span', { class: 'annotation-key', text: key }), valueNode);
  })) : '';
  return dl([
    ['Created', dateText(metadata.creationTimestamp)],
    ['Name', metadata.name],
    ['Namespace', metadata.namespace ? refLink('Namespace', metadata.namespace) : ''],
    ['UID', metadata.uid ? el('span', { class: 'mono', text: metadata.uid }) : ''],
    ['Resource version', metadata.resourceVersion],
    ['Generation', metadata.generation],
    ['Labels', Object.keys(metadata.labels || {}).length ? chips(metadata.labels) : ''],
    ['Annotations', annotationList],
    ['Finalizers', (metadata.finalizers || []).length ? chips(Object.fromEntries(metadata.finalizers.map(f => [f, '']))) : ''],
    ['Controlled by', owners.length ? owners : ''],
    ['Deletion', metadata.deletionTimestamp ? el('span', { class: 'warn-text', text: `Terminating since ${dateText(metadata.deletionTimestamp)}` }) : ''],
  ]);
}

export function conditionsList(conditions = []) {
  if (!conditions.length) return muted('No conditions reported.');
  return el('div', { class: 'condition-rows' }, conditions.map(condition => {
    // Some condition types are problems when True (MemoryPressure, ScalingLimited, …).
    const negative = /Pressure|Unavailable|Failed|Stalled|ReplicaFailure|ScalingLimited|LowConfidence|NoPodsMatched|Degraded|Terminating/.test(condition.type);
    const good = condition.status === 'True' ? !negative : condition.status === 'False' && negative;
    return el('div', { class: 'condition-row' },
      badge(condition.type, good ? 'good' : condition.status === 'Unknown' ? 'warn' : 'bad'),
      el('span', { class: 'condition-status', text: condition.status }),
      el('div', { class: 'condition-text' }, condition.reason ? el('strong', { text: condition.reason }) : '', condition.message ? el('span', { text: ` ${condition.message}` }) : '',
        el('span', { class: 'muted', text: condition.lastTransitionTime || condition.lastHeartbeatTime ? ` · ${age(condition.lastTransitionTime || condition.lastHeartbeatTime)} ago` : '' })));
  }));
}
export function tolerationsTable(tolerations = []) {
  if (!tolerations.length) return '';
  return simpleTable(tolerations, [['Key', t => t.key || '(any)'], ['Operator', t => t.operator || 'Equal'], ['Value', t => t.value || '—'], ['Effect', t => t.effect || '(all)'], ['Seconds', t => t.tolerationSeconds ?? '—']]);
}
export function simpleTable(rows, columns, { onRow, className = '', emptyText = 'None.' } = {}) {
  if (!rows.length) return muted(emptyText);
  return el('div', { class: `mini-table-wrap ${className}` }, el('table', { class: 'mini-table' },
    el('thead', {}, el('tr', {}, columns.map(([title]) => el('th', { text: title })))),
    el('tbody', {}, rows.map(row => el('tr', { class: onRow ? 'clickable' : '', onclick: onRow ? () => onRow(row) : undefined }, columns.map(([, render, cls]) => { let value; try { value = render(row); } catch { value = '—'; } return el('td', { class: cls || '' }, value ?? '—'); }))))));
}
export function jsonBlock(value, { open = false, title = 'Details' } = {}) {
  if (value === undefined || value === null || (typeof value === 'object' && !Object.keys(value).length)) return '';
  return el('details', { class: 'json-block', ...(open ? { open: '' } : {}) }, el('summary', { text: title }), el('pre', { class: 'output', text: JSON.stringify(value, null, 2) }));
}
export function affinitySummary(affinity) {
  if (!affinity) return '';
  const lines = [];
  const terms = (label, list) => (list || []).forEach(term => lines.push(`${label}: ${[...(term.matchExpressions || []).map(e => `${e.key} ${e.operator}${e.values ? ` (${e.values.join(',')})` : ''}`), ...(term.matchFields || []).map(e => `${e.key} ${e.operator} ${(e.values || []).join(',')}`)].join(' & ')}`));
  terms('Node required', affinity.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms);
  (affinity.nodeAffinity?.preferredDuringSchedulingIgnoredDuringExecution || []).forEach(p => terms(`Node preferred (weight ${p.weight})`, [p.preference]));
  for (const [kind, label] of [['podAffinity', 'Pod affinity'], ['podAntiAffinity', 'Pod anti-affinity']]) {
    for (const term of affinity[kind]?.requiredDuringSchedulingIgnoredDuringExecution || []) lines.push(`${label} required: ${selectorText(term.labelSelector) || 'all'} @ ${term.topologyKey}`);
    for (const p of affinity[kind]?.preferredDuringSchedulingIgnoredDuringExecution || []) lines.push(`${label} preferred (weight ${p.weight}): ${selectorText(p.podAffinityTerm?.labelSelector) || 'all'} @ ${p.podAffinityTerm?.topologyKey}`);
  }
  return el('div', {}, lines.map(line => el('div', { class: 'affinity-line', text: line })), jsonBlock(affinity, { title: 'Raw affinity' }));
}

// Usage meters for a pod, workload, namespace (vs requests/limits) or node (vs allocatable).
export function consumption(summary, { allocatableCPU, allocatableMemory, allocatablePods, pods } = {}) {
  const wrap = el('div', { class: 'consumption' });
  if (!summary) return wrap;
  const metrics = hooks.usage;
  const measured = summary.measured > 0;
  // Limits are a usable scale only when every container declares one.
  const cpuLimit = summary.cpuLimitMissing && !allocatableCPU ? 0 : summary.cpuLimit; const memoryLimit = summary.memoryLimitMissing && !allocatableMemory ? 0 : summary.memoryLimit;
  const cpuTotal = allocatableCPU || cpuLimit || summary.cpuRequest || summary.cpu;
  const memTotal = allocatableMemory || memoryLimit || summary.memoryRequest || summary.memory;
  const detail = (fmt, used, request, limit, missing, total, label) => [measured ? `${fmt(used)} used${total && label ? ` (${formatPercent(used, total)} of ${label})` : ''}` : 'Usage not reported', request ? `requests ${fmt(request)}` : 'no requests', limit ? `limits ${fmt(limit)}${missing ? ' (some containers unlimited)' : ''}` : 'no limits', allocatableCPU || allocatableMemory ? `${label} ${fmt(total)}` : ''].filter(Boolean).join(' · ');
  wrap.append(
    meter({ label: 'CPU', used: measured ? summary.cpu : NaN, total: cpuTotal, request: summary.cpuRequest || undefined, limit: cpuLimit || undefined, detail: detail(formatCPU, summary.cpu, summary.cpuRequest, summary.cpuLimit, summary.cpuLimitMissing, cpuTotal, allocatableCPU ? 'allocatable' : cpuLimit ? 'limits' : 'requests') }),
    meter({ label: 'Memory', used: measured ? summary.memory : NaN, total: memTotal, request: summary.memoryRequest || undefined, limit: memoryLimit || undefined, detail: detail(formatBytes, summary.memory, summary.memoryRequest, summary.memoryLimit, summary.memoryLimitMissing, memTotal, allocatableMemory ? 'allocatable' : memoryLimit ? 'limits' : 'requests') }));
  if (allocatablePods) wrap.append(meter({ label: 'Pods', used: pods ?? summary.pods, total: allocatablePods, detail: `${pods ?? summary.pods} of ${allocatablePods} pods` }));
  if (metrics?.available === false) wrap.append(info(`Live usage unavailable: ${metrics.message || 'metrics-server is not serving metrics.k8s.io'}. Requests and limits come from pod specs.`));
  wrap.append(el('div', { class: 'meter-legend' }, el('span', {}, el('i', { class: 'legend-request' }), 'request'), el('span', {}, el('i', { class: 'legend-limit' }), 'limit')));
  return wrap;
}

// Pods belonging to the selected object, with live consumption, loaded once and re-rendered as usage refreshes.
export function podsSection(selected, query, { filter, title = 'Pods', onSummary, summaryInto, open = true } = {}) {
  const holder = el('div', {}, loading('Loading pods…'));
  const ctx = pageContext(hooks.usage);
  const columns = kindColumns('pods', ctx).filter(c => ['name', 'namespace', 'containers', 'cpu', 'memory', 'restarts', 'node', 'age', 'status'].includes(c.id) && !(c.id === 'namespace' && query.namespace !== '*'));
  const view = table([], columns, item => hooks.showResource(item, 'pods'), { key: liveKey, stamp: item => `${item.metadata?.resourceVersion}|${ctx.version()}`, menu: item => rowMenu('pods', item), empty: 'No pods.', placeholder: 'Filter pods…', pending: true });
  let pods = [];
  const summaryHost = summaryInto || el('div');
  const render = () => { const summary = hooks.usage?.summarize(pods); if (onSummary) summaryHost.replaceChildren(onSummary(summary, pods)); view.update(pods); };
  (async () => {
    try {
      const response = await get('/api/resources', { context: selected.context, resource: 'pods', ...query });
      pods = (response.items || []).filter(filter || (() => true)).sort((a, b) => (statusOf(a)[1] === 'good') - (statusOf(b)[1] === 'good') || a.metadata.name.localeCompare(b.metadata.name));
      ctx.setPods(pods);
      holder.replaceChildren(view); render();
      const abort = new AbortController();
      hooks.usage?.onChange(() => { if (!holder.isConnected) { abort.abort(); return; } render(); }, abort.signal);
    } catch (error) { holder.replaceChildren(info(error.message, 'error')); }
  })();
  const body = el('div', {}, summaryInto ? null : summaryHost, holder);
  body.pods = () => pods;
  return section(title, body, { open });
}

// ---- Metrics tab ------------------------------------------------------------------------------
const providerCache = new Map();
export const resetPrometheusProvider = context => { if (context) providerCache.delete(context); else providerCache.clear(); };
export async function prometheusProvider(context, refresh = false) {
  const cached = providerCache.get(context);
  if (!refresh && cached && Date.now() - cached.at < 120000) return cached.value;
  const result = await get('/api/prometheus/provider', { context, refresh: refresh ? '1' : undefined }).catch(error => ({ provider: null, error: error.message }));
  providerCache.set(context, { at: Date.now(), value: result });
  return result;
}
export const FORMATS = { cpu: v => formatCPU(v), bytes: v => formatBytes(v), rate: v => `${formatBytes(v)}/s`, count: v => (Number.isFinite(v) ? String(Math.round(v)) : '—'), percent: v => `${Math.round(v * 100)}%`, seconds: v => `${(v * 1000).toFixed(0)} ms`, perSecond: v => `${v.toFixed(2)}/s` };
// spec: { queries: () => ({key: promql}), charts: [{ title, format, series: [{ key, name, dashed }], lines?: [{ name, value }] }], session?: () => [{ title, format, series: [{ name, values }] }] }
export function metricsView(selected, spec) {
  const root = el('div', { class: 'metrics-view' });
  const rangeSelect = el('select', { class: 'compact-select', 'aria-label': 'Time range' }, RANGES.map(r => el('option', { value: r.id, text: r.label })));
  const sourceBadge = el('span', { class: 'muted metrics-source', text: 'Detecting Prometheus…' });
  const grid = el('div', { class: 'chart-cards' }, loading('Loading metrics…'));
  const refresh = button('↻', () => load(true), 'quiet compact icon-text');
  refresh.title = 'Reload metrics';
  const containerSelect = spec.containers?.length > 1 ? el('select', { class: 'compact-select', 'aria-label': 'Container' }, el('option', { value: '', text: 'All containers' }), spec.containers.map(name => el('option', { value: name, text: name }))) : null;
  containerSelect?.addEventListener('change', () => load());
  root.append(el('div', { class: 'metrics-toolbar' }, sourceBadge, el('span', { class: 'spacer' }), containerSelect, rangeSelect, refresh), grid);
  let generation = 0;
  async function load(force = false) {
    const id = ++generation;
    grid.replaceChildren(loading('Loading metrics…'));
    let provider = await prometheusProvider(selected.context, force);
    if (id !== generation) return;
    let fallbackReason = '';
    if (provider.provider) {
      const range = RANGES.find(r => r.id === rangeSelect.value) || RANGES[0];
      const end = Math.floor(Date.now() / 1000); const start = end - range.seconds;
      rangeSelect.hidden = false;
      sourceBadge.textContent = `Prometheus · ${provider.provider.namespace}/${provider.provider.service}:${provider.provider.port}${provider.provider.source === 'settings' ? ' (Settings)' : ''}`;
      try {
        const result = await post('/api/prometheus/range', { context: selected.context, queries: spec.queries(containerSelect?.value || ''), start, end, step: stepFor(range.seconds) });
        if (id !== generation) return;
        const charts = spec.charts.map(chart => {
          const series = chart.series.map(s => ({ name: s.name, dashed: s.dashed, values: (result.series[s.key] || [])[0]?.values || [] }));
          for (const line of chart.lines || []) if (Number.isFinite(line.value) && line.value > 0) series.push({ name: line.name, dashed: true, values: [[start, line.value], [end, line.value]] });
          const errors = chart.series.map(s => result.errors[s.key]).filter(Boolean);
          const node = lineChart(series.filter(s => s.values.length || chart.series.length === 1), { format: FORMATS[chart.format] || String, title: chart.title, empty: errors[0] || 'No samples for this series. The exporter that provides it may not be installed.' });
          return node;
        });
        grid.replaceChildren(...charts);
        return;
      } catch (error) {
        if (id !== generation) return;
        // The provider changed (turned off in Settings, or the service went away): use session history.
        if (error.status !== 404) { grid.replaceChildren(info(error.message, 'error')); return; }
        resetPrometheusProvider(selected.context);
        fallbackReason = error.message;
      }
    }
    sourceBadge.textContent = 'Session history · metrics-server';
    rangeSelect.hidden = true;
    const session = spec.session?.(containerSelect?.value || '') || [];
    const usable = session.filter(chart => chart.series.some(s => s.values.length));
    grid.replaceChildren(
      info(`${String(fallbackReason || provider.error || 'Prometheus was not found in this cluster').replace(/\.?$/, '.')} Showing usage sampled from metrics.k8s.io every 15 seconds since this cluster was opened. Configure Prometheus in Settings › Metrics for long-range history.`),
      ...(usable.length ? usable.map(chart => lineChart(chart.series, { format: FORMATS[chart.format] || String, title: chart.title })) : [muted(hooks.usage?.available === false ? `metrics-server is not available: ${hooks.usage.message}` : 'Collecting samples… charts appear after the next refresh.')]));
  }
  rangeSelect.addEventListener('change', () => load());
  load();
  const abort = new AbortController();
  hooks.usage?.onChange(() => { if (!root.isConnected) { abort.abort(); return; } if (sourceBadge.textContent.startsWith('Session')) load(); }, abort.signal);
  return root;
}
export { section, mini, dl, chips, link, badge, table, el, button, info, task, age, dateText, controllerOf };
