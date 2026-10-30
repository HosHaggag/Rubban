// Argo CD application management: the Manage view (status cards, filters, bulk actions and an
// errors list) and the Application details (problems, last operation, resources, history) with
// refresh, hard refresh, sync, terminate, auto-sync, rollback and delete.
import { state, hooks, el, button, badge, info, loading, post, table, dl, section, age, dateText, task, toast, modal, confirmAction, page, actions, readStore, writeStore, liveKey, link, popupMenu } from './kit.js';
import { resourceForKind } from './kinds.js';
import { simpleTable, refLink, kindRef, conditionsList, muted } from './detail-common.js';

export const APPS = 'applications.argoproj.io';
const short = value => String(value || '').slice(0, 7);
const shortRepo = url => String(url || '').replace(/^https?:\/\//, '').replace(/\.git$/, '');
export const syncBadge = status => badge(status || 'Unknown', status === 'Synced' ? 'good' : status === 'OutOfSync' ? 'warn' : '');
export const healthBadge = status => badge(status || 'Unknown', status === 'Healthy' ? 'good' : ['Degraded', 'Missing'].includes(status) ? 'bad' : status === 'Progressing' ? 'info' : status === 'Suspended' ? 'warn' : '');
export const operationBadge = phase => (phase ? badge(phase, phase === 'Succeeded' ? 'good' : ['Failed', 'Error'].includes(phase) ? 'bad' : ['Running', 'Terminating'].includes(phase) ? 'info' : '') : muted('—'));
const sourcesOf = app => (app.spec?.sources?.length ? app.spec.sources : [app.spec?.source || {}]);
const destinationText = app => `${app.spec?.destination?.name || app.spec?.destination?.server?.replace(/^https:\/\/kubernetes\.default\.svc$/, 'in-cluster') || '—'} / ${app.spec?.destination?.namespace || '—'}`;
const operationRunning = app => Boolean(app.operation) || ['Running', 'Terminating'].includes(app.status?.operationState?.phase);
const autoSyncText = app => { const a = app.spec?.syncPolicy?.automated; return a ? `On${a.prune ? ' · prune' : ''}${a.selfHeal ? ' · self-heal' : ''}` : 'Off'; };

// Everything that needs attention in one Application: conditions, failed operations and resource problems.
export function appErrors(app) {
  const out = [];
  const status = app.status || {};
  for (const condition of status.conditions || []) out.push({ level: /Warning$/.test(condition.type) ? 'warning' : 'error', source: condition.type, message: condition.message || condition.type, time: condition.lastTransitionTime });
  const op = status.operationState;
  // A SyncError condition usually repeats the failed operation's message; list it once.
  const repeated = message => Boolean(message) && (status.conditions || []).some(condition => String(condition.message || '').includes(message));
  if (op && ['Failed', 'Error'].includes(op.phase) && !repeated(op.message)) out.push({ level: 'error', source: `Sync ${op.phase.toLowerCase()}`, message: op.message || `Operation ${op.phase}`, time: op.finishedAt || op.startedAt });
  if (op && op.phase === 'Running' && op.message && /retry|fail|error/i.test(op.message)) out.push({ level: 'warning', source: 'Sync running', message: op.message, time: op.startedAt });
  for (const result of op?.syncResult?.resources || []) {
    if (result.status === 'SyncFailed' || ['Failed', 'Error'].includes(result.hookPhase)) out.push({ level: 'error', source: `${result.kind}/${result.name}`, message: result.message || result.status, time: op.finishedAt, resource: result });
  }
  for (const resource of status.resources || []) {
    const health = resource.health?.status;
    if (health === 'Degraded') out.push({ level: 'error', source: `${resource.kind}/${resource.name}`, message: resource.health.message || 'Resource is degraded', resource });
    else if (health === 'Missing') out.push({ level: 'warning', source: `${resource.kind}/${resource.name}`, message: resource.health.message || 'Resource is missing from the cluster', resource });
  }
  return out;
}

// ---- Actions -----------------------------------------------------------------------------------
const target = app => ({ context: state.context, namespace: app.metadata.namespace, name: app.metadata.name });
async function call(app, body, message) {
  const result = await post('/api/argocd', { ...target(app), ...body });
  toast(result.output || message);
  hooks.afterMutation?.();
  return result;
}
export const refresh = (app, hard = false) => call(app, { action: hard ? 'hard-refresh' : 'refresh' }, hard ? 'Hard refresh requested.' : 'Refresh requested.');
export async function terminate(app) {
  if (!await confirmAction('Terminate the running sync operation. Resources already applied stay as they are.', app.metadata.name)) return;
  await call(app, { action: 'terminate' }, 'Termination requested.');
}

const OPTION_LABELS = [
  ['prune', 'Prune', 'Delete resources that are no longer defined in Git'],
  ['dryRun', 'Dry run', 'Preview the sync without changing the cluster'],
  ['applyOnly', 'Apply only', 'Skip pre/post-sync hooks'],
  ['force', 'Force', 'Delete and re-create resources that cannot be patched'],
];
const SYNC_OPTION_LABELS = [
  ['skipSchemaValidation', 'Skip schema validation'], ['createNamespace', 'Auto-create namespace'], ['pruneLast', 'Prune last'],
  ['applyOutOfSyncOnly', 'Apply out-of-sync only'], ['respectIgnoreDifferences', 'Respect ignore differences'],
  ['serverSideApply', 'Server-side apply'], ['replace', 'Replace'],
];
const checkbox = (name, label, checked = false, title = '') => el('label', { class: 'check-option', title }, el('input', { type: 'checkbox', name, checked }), el('span', { text: label }));
// Sync dialog for one application (with revision and resource selection) or several (shared options).
export function syncDialog(apps, { preset = {} } = {}) {
  const list = Array.isArray(apps) ? apps : [apps];
  const single = list.length === 1 ? list[0] : null;
  const form = el('form', { class: 'argo-sync-form' });
  const revision = el('input', { name: 'revision', placeholder: single ? `Target revision (${sourcesOf(single)[0]?.targetRevision || 'HEAD'})` : 'Each application’s target revision', disabled: !single, value: preset.revision || '' });
  const options = el('div', { class: 'check-grid' }, OPTION_LABELS.map(([name, label, title]) => checkbox(name, label, Boolean(preset[name]), title)));
  const syncOptions = el('div', { class: 'check-grid' }, SYNC_OPTION_LABELS.map(([name, label]) => checkbox(name, label, Boolean(preset[name]))));
  const propagation = el('select', { name: 'prunePropagationPolicy', class: 'compact-select' }, el('option', { value: '', text: 'Prune propagation: default (foreground)' }), ['foreground', 'background', 'orphan'].map(value => el('option', { value, text: `Prune propagation: ${value}` })));
  const retry = el('div', { class: 'inline-fields' }, checkbox('retry', 'Retry on failure'), el('input', { name: 'retryLimit', type: 'number', min: 1, max: 100, value: 5, class: 'narrow', 'aria-label': 'Retry limit' }), muted('attempts'));
  const resources = single ? (single.status?.resources || []) : [];
  const resourceChecks = resources.map(r => ({ r, box: el('input', { type: 'checkbox', checked: !preset.outOfSyncOnly || r.status === 'OutOfSync' }) }));
  const resourcePanel = single && resources.length ? section(`Resources (${resources.length})`, el('div', {},
    el('div', { class: 'form-actions start' }, button('All', () => resourceChecks.forEach(c => { c.box.checked = true; }), 'quiet compact'), button('None', () => resourceChecks.forEach(c => { c.box.checked = false; }), 'quiet compact'), button('Out of sync', () => resourceChecks.forEach(c => { c.box.checked = c.r.status === 'OutOfSync'; }), 'quiet compact')),
    el('div', { class: 'resource-checks' }, resourceChecks.map(({ r, box }) => el('label', { class: 'check-option' }, box, el('span', { class: 'kind-tag', text: r.kind }), ` ${r.namespace ? `${r.namespace}/` : ''}${r.name} `, r.status === 'OutOfSync' ? badge('OutOfSync', 'warn') : '')))), { open: Boolean(preset.outOfSyncOnly) }) : '';
  const status = el('span', { class: 'form-status' });
  const submit = el('button', { type: 'submit', class: 'primary', text: list.length > 1 ? `Sync ${list.length} applications` : 'Synchronize' });
  form.append(
    single ? el('div', { class: 'field' }, el('label', { text: 'Revision' }), revision) : info(`Applies the same options to ${list.length} applications: ${list.slice(0, 6).map(a => a.metadata.name).join(', ')}${list.length > 6 ? ', …' : ''}.`),
    el('div', { class: 'mini-title', text: 'Sync' }), options,
    el('div', { class: 'mini-title', text: 'Sync options' }), syncOptions, el('div', { class: 'inline-fields' }, propagation), retry,
    resourcePanel, el('div', { class: 'form-actions' }, status, submit));
  form.addEventListener('submit', task(async event => {
    event.preventDefault();
    const data = new FormData(form);
    const opts = Object.fromEntries([...OPTION_LABELS, ...SYNC_OPTION_LABELS].map(([name]) => [name, data.get(name) === 'on']));
    opts.prunePropagationPolicy = data.get('prunePropagationPolicy') || undefined;
    opts.retry = data.get('retry') === 'on'; opts.retryLimit = Number(data.get('retryLimit') || 5);
    if (single && revision.value.trim()) opts.revision = revision.value.trim();
    if (resourceChecks.length) {
      const chosen = resourceChecks.filter(c => c.box.checked).map(({ r }) => ({ group: r.group || '', kind: r.kind, name: r.name, namespace: r.namespace || '' }));
      if (!chosen.length) throw new Error('Select at least one resource to sync.');
      if (chosen.length < resourceChecks.length) opts.resources = chosen;
    }
    const names = list.map(a => a.metadata.name);
    const confirmTarget = single ? single.metadata.name : `${list.length} applications`;
    if (!opts.dryRun && !await confirmAction(`${opts.prune ? 'Sync with prune: resources removed from Git will be deleted. ' : ''}Sync ${single ? 'this application' : `${list.length} applications (${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''})`} to the desired state in Git.`, confirmTarget)) return;
    submit.disabled = true; status.textContent = 'Requesting…';
    let failed = 0;
    for (const app of list) {
      try { await post('/api/argocd', { ...target(app), action: 'sync', options: opts }); }
      catch (error) { failed++; toast(`${app.metadata.name}: ${error.message}`, true); }
    }
    submit.disabled = false;
    status.textContent = failed ? `${list.length - failed} of ${list.length} requested` : 'Sync requested';
    if (!failed) { toast(list.length > 1 ? `Sync requested for ${list.length} applications.` : `${opts.dryRun ? 'Dry-run sync' : 'Sync'} requested for ${list[0].metadata.name}.`); document.querySelector('#action-dialog')?.close(); }
    hooks.afterMutation?.();
  }));
  modal(list.length > 1 ? 'Sync applications' : `Sync ${single.metadata.name}`, single ? `${shortRepo(sourcesOf(single)[0]?.repoURL)} → ${destinationText(single)}` : 'Argo CD applies each application’s desired state from Git.', form);
}
export async function deleteApplications(apps, cascade = 'foreground') {
  const list = Array.isArray(apps) ? apps : [apps];
  if (!await confirmAction(`Delete ${list.length === 1 ? list[0].metadata.name : `${list.length} applications`} from Argo CD${cascade === 'none' ? '' : ' and its managed resources'}.`, list.length === 1 ? list[0].metadata.name : `${list.length} applications`, { destructive: true })) return;
  let failed = 0;
  for (const app of list) {
    try { await post('/api/argocd', { ...target(app), action: 'delete', cascade }); }
    catch (error) { failed++; toast(`${app.metadata.name}: ${error.message}`, true); }
  }
  if (!failed) toast(`Deleted ${list.length === 1 ? list[0].metadata.name : `${list.length} applications`}${cascade === 'none' ? ' (resources kept)' : ''}.`);
  if (list.some(app => state.selected?.name === app.metadata.name)) { state.selected = null; document.querySelector('#drawer')?.classList.add('hidden'); }
  hooks.afterMutation?.();
}
const deleteOptions = apps => [
  { icon: '✕', label: 'Delete', title: 'Cascade (foreground)', danger: true, action: task(() => deleteApplications(apps)) },
  { icon: '✕', label: 'Delete in background', title: 'Cascade (background)', danger: true, action: task(() => deleteApplications(apps, 'background')) },
  { icon: '✕', label: 'Delete without cascade', title: 'Keep managed resources', danger: true, action: task(() => deleteApplications(apps, 'none')) },
];
const deleteOptionsButton = apps => button('Delete options', event => popupMenu(event.currentTarget, deleteOptions(apps)), 'quiet compact');
export function autoSyncDialog(app) {
  const current = app.spec?.syncPolicy?.automated;
  const form = el('form');
  const enabled = checkbox('enabled', 'Automated sync', Boolean(current), 'Sync automatically when Git changes');
  form.append(el('div', { class: 'check-grid' }, enabled, checkbox('prune', 'Prune resources', Boolean(current?.prune), 'Delete resources removed from Git'), checkbox('selfHeal', 'Self heal', Boolean(current?.selfHeal), 'Revert changes made in the cluster'), checkbox('allowEmpty', 'Allow empty', Boolean(current?.allowEmpty), 'Allow syncing to an empty set of resources')),
    el('div', { class: 'form-actions' }, el('button', { type: 'submit', class: 'primary', text: 'Save sync policy' })));
  form.addEventListener('submit', task(async event => {
    event.preventDefault();
    const data = new FormData(form);
    const body = { action: 'auto-sync', enabled: data.get('enabled') === 'on', prune: data.get('prune') === 'on', selfHeal: data.get('selfHeal') === 'on', allowEmpty: data.get('allowEmpty') === 'on' };
    if (!await confirmAction(body.enabled ? 'Turn on automated sync: Argo CD will apply Git changes to the cluster without asking.' : 'Turn off automated sync: changes in Git will wait for a manual sync.', app.metadata.name)) return;
    await call(app, body, 'Sync policy updated.');
    document.querySelector('#action-dialog')?.close();
  }));
  modal(`Sync policy · ${app.metadata.name}`, `Currently ${autoSyncText(app)}.`, form);
}
async function rollback(app, entry) {
  if (app.spec?.syncPolicy?.automated) { toast('Turn off auto-sync before rolling back, or Argo CD will sync forward again.', true); autoSyncDialog(app); return; }
  if (!await confirmAction(`Roll back ${app.metadata.name} to history ${entry.id} (revision ${short(entry.revision || entry.revisions?.[0])}, deployed ${age(entry.deployedAt)} ago).`, app.metadata.name)) return;
  await call(app, { action: 'rollback', id: entry.id }, 'Rollback requested.');
}

export function appMenu(app) {
  const running = operationRunning(app);
  return [
    { icon: '↻', label: 'Refresh', action: task(() => refresh(app)) },
    { icon: '⟲', label: 'Hard refresh', title: 'Also invalidates the manifest cache', action: task(() => refresh(app, true)) },
    { icon: '⟳', label: 'Sync…', action: () => syncDialog(app), disabled: running },
    { icon: '⟳', label: 'Sync out-of-sync resources…', action: () => syncDialog(app, { preset: { outOfSyncOnly: true } }), disabled: running || app.status?.sync?.status !== 'OutOfSync' },
    running ? { icon: '■', label: 'Terminate operation', action: task(() => terminate(app)) } : null,
    { icon: '⚙', label: `Auto-sync: ${autoSyncText(app)}…`, action: () => autoSyncDialog(app) },
    '-',
    { icon: '✎', label: 'Edit', action: () => hooks.showResource(app, APPS, { tab: 'yaml' }) },
    ...deleteOptions(app),
  ];
}

// ---- Application details ------------------------------------------------------------------------
const problemsTable = errors => simpleTable(errors, [
  ['', e => el('span', { class: `issue-dot ${e.level === 'error' ? 'bad' : ''}` })],
  ['Source', e => (e.resource ? kindRef({ kind: e.resource.kind, name: e.resource.name, namespace: e.resource.namespace, apiVersion: e.resource.group ? `${e.resource.group}/${e.resource.version || 'v1'}` : e.resource.version || 'v1' }) : el('strong', { text: e.source }))],
  ['Message', e => el('span', { class: 'argo-message', text: e.message })],
  ['When', e => (e.time ? `${age(e.time)} ago` : '—')],
], { className: 'problems' });
function operationSection(app) {
  const op = app.status?.operationState;
  if (!op) return muted('No operation has run yet.');
  const operation = op.operation || {};
  const results = op.syncResult?.resources || [];
  const started = new Date(op.startedAt).getTime(); const finished = new Date(op.finishedAt).getTime();
  return el('div', {},
    dl([
      ['Phase', operationBadge(op.phase)],
      ['Message', op.message ? el('span', { class: 'argo-message', text: op.message }) : ''],
      ['Initiated by', operation.initiatedBy?.automated ? 'Automated sync policy' : operation.initiatedBy?.username || ''],
      ['Revision', op.syncResult?.revision || operation.sync?.revision || ''],
      ['Started', dateText(op.startedAt)], ['Finished', dateText(op.finishedAt)],
      ['Duration', Number.isFinite(started) && Number.isFinite(finished) ? `${Math.max(0, Math.round((finished - started) / 1000))}s` : ''],
      ['Options', [operation.sync?.prune && 'prune', operation.sync?.dryRun && 'dry run', ...(operation.sync?.syncOptions || [])].filter(Boolean).join(' · ')],
      ['Retries', op.retryCount ? String(op.retryCount) : ''],
    ]),
    results.length ? simpleTable(results, [
      ['Kind', r => r.kind], ['Name', r => r.name], ['Namespace', r => r.namespace || '—'],
      ['Result', r => badge(r.hookPhase || r.status || '—', r.status === 'SyncFailed' || ['Failed', 'Error'].includes(r.hookPhase) ? 'bad' : r.status === 'Synced' || r.hookPhase === 'Succeeded' ? 'good' : '')],
      ['Message', r => el('span', { class: 'argo-message', text: r.message || '' })],
    ]) : '');
}
function resourcesSection(app) {
  const resources = [...(app.status?.resources || [])].sort((a, b) => (a.status === 'OutOfSync' ? 0 : 1) - (b.status === 'OutOfSync' ? 0 : 1) || (['Degraded', 'Missing'].includes(a.health?.status) ? 0 : 1) - (['Degraded', 'Missing'].includes(b.health?.status) ? 0 : 1) || `${a.kind}/${a.name}`.localeCompare(`${b.kind}/${b.name}`));
  if (!resources.length) return muted('Argo CD has not reported any resources yet.');
  const open = r => hooks.showResource({ kind: r.kind, apiVersion: r.group ? `${r.group}/${r.version}` : r.version || 'v1', metadata: { name: r.name, namespace: r.namespace || '' } }, resourceForKind(r.kind, r.group ? `${r.group}/${r.version}` : ''));
  return table(resources, [
    { id: 'kind', title: 'Kind', render: r => el('span', { class: 'kind-tag', text: r.kind }), sort: r => r.kind },
    { id: 'name', title: 'Name', class: 'name', render: r => r.name, sort: r => r.name },
    { id: 'namespace', title: 'Namespace', render: r => r.namespace || '—', sort: r => r.namespace },
    { id: 'sync', title: 'Sync', render: r => syncBadge(r.status), sort: r => r.status },
    { id: 'health', title: 'Health', render: r => (r.health?.status ? healthBadge(r.health.status) : muted('—')), sort: r => r.health?.status },
    { id: 'message', title: 'Message', class: 'wrap', render: r => r.health?.message || (r.requiresPruning ? 'Requires pruning' : '') || '—' },
  ], open, { key: r => `${r.group}/${r.kind}/${r.namespace}/${r.name}`, stamp: r => `${r.status}|${r.health?.status}|${r.health?.message}`, placeholder: 'Filter resources…', searchText: r => `${r.kind} ${r.name} ${r.namespace} ${r.status} ${r.health?.status}`.toLowerCase() });
}
function historySection(app) {
  const history = [...(app.status?.history || [])].reverse();
  if (!history.length) return muted('No deployment history yet.');
  const currentId = history[0]?.id;
  return simpleTable(history, [
    ['ID', h => String(h.id)],
    ['Revision', h => el('span', { class: 'mono', title: h.revision || (h.revisions || []).join(', '), text: short(h.revision || h.revisions?.[0]) })],
    ['Deployed', h => (h.deployedAt ? `${age(h.deployedAt)} ago` : '—')],
    ['By', h => h.initiatedBy?.automated ? 'auto-sync' : h.initiatedBy?.username || '—'],
    ['Source', h => { const s = h.source || h.sources?.[0] || {}; return `${shortRepo(s.repoURL)}${s.path ? ` · ${s.path}` : ''}${s.chart ? ` · ${s.chart}@${s.targetRevision || ''}` : ''}`; }],
    ['', h => (h.id === currentId ? badge('current', 'good') : button('Roll back', task(() => rollback(app, h)), 'quiet compact'))],
  ]);
}
export function argoDetails(selected) {
  const app = selected.item; const spec = app.spec || {}; const status = app.status || {};
  const errors = appErrors(app);
  const running = operationRunning(app);
  const sources = sourcesOf(app);
  const root = el('div', { class: 'argo-details' });
  root.append(el('div', { class: 'argo-status' },
    el('div', {}, el('span', { class: 'muted', text: 'Sync' }), syncBadge(status.sync?.status), el('span', { class: 'mono muted', text: short(status.sync?.revision || status.sync?.revisions?.[0]) })),
    el('div', {}, el('span', { class: 'muted', text: 'Health' }), healthBadge(status.health?.status)),
    el('div', {}, el('span', { class: 'muted', text: 'Last operation' }), operationBadge(status.operationState?.phase), status.operationState?.finishedAt ? el('span', { class: 'muted', text: `${age(status.operationState.finishedAt)} ago` }) : ''),
    el('div', {}, el('span', { class: 'muted', text: 'Auto-sync' }), el('span', { text: autoSyncText(app) }))));
  root.append(el('div', { class: 'detail-actions' },
    button('↻ Refresh', task(() => refresh(app)), 'compact'), button('⟲ Hard refresh', task(() => refresh(app, true)), 'compact'),
    (() => { const b = button('⟳ Sync…', () => syncDialog(app), 'primary compact'); b.disabled = running; return b; })(),
    running ? button('■ Terminate', task(() => terminate(app)), 'compact') : null,
    button('⚙ Auto-sync…', () => autoSyncDialog(app), 'compact'),
    button('✕ Delete', task(() => deleteApplications(app)), 'danger compact'), deleteOptionsButton(app)));
  if (running) root.append(info(`An operation is ${status.operationState?.phase === 'Terminating' ? 'terminating' : 'in progress'}${status.operationState?.message ? `: ${status.operationState.message}` : ''}.`));
  root.append(section(errors.length ? `Problems (${errors.length})` : 'Problems', errors.length ? problemsTable(errors) : el('div', { class: 'callout info', text: 'No errors or warnings reported by Argo CD.' })));
  root.append(section('Last operation', operationSection(app), { open: ['Failed', 'Error', 'Running'].includes(status.operationState?.phase) }));
  root.append(section('Application', dl([
    ['Project', spec.project ? refLink('AppProject', spec.project, app.metadata.namespace, 'argoproj.io/v1alpha1') : 'default'],
    ['Repository', sources.map(s => el('div', { class: 'mono wrap-anywhere', text: s.repoURL || '—' }))],
    [sources.some(s => s.chart) ? 'Chart / path' : 'Path', sources.map(s => el('div', { text: s.chart ? `${s.chart}@${s.targetRevision || ''}` : s.path || '—' }))],
    ['Target revision', sources.map(s => s.targetRevision || 'HEAD').join(', ')],
    ['Destination', destinationText(app)],
    ['Sync options', (spec.syncPolicy?.syncOptions || []).join(' · ')],
    ['Retry', spec.syncPolicy?.retry ? `limit ${spec.syncPolicy.retry.limit ?? '∞'}` : ''],
    ['Reconciled', dateText(status.reconciledAt)],
    ['Images', (status.summary?.images || []).length ? el('div', {}, status.summary.images.map(image => el('div', { class: 'mono wrap-anywhere', text: image }))) : ''],
    ['URLs', (status.summary?.externalURLs || []).length ? el('div', {}, status.summary.externalURLs.map(url => link(url, () => hooks.openExternal?.(url)))) : ''],
  ])));
  root.append(section(`Resources (${(status.resources || []).length})`, resourcesSection(app)));
  root.append(section(`History (${(status.history || []).length})`, historySection(app), { open: false }));
  if ((status.conditions || []).length) root.append(section('Conditions', conditionsList(status.conditions.map(c => ({ type: c.type, status: /Warning$/.test(c.type) ? 'Unknown' : 'False', message: c.message, lastTransitionTime: c.lastTransitionTime }))), { open: false }));
  return root;
}

// ---- Manage view ------------------------------------------------------------------------------
const FILTERS = { sync: ['Synced', 'OutOfSync', 'Unknown'], health: ['Healthy', 'Progressing', 'Degraded', 'Suspended', 'Missing', 'Unknown'] };
export function argoManagerPage({ liveList, liveBadge, consumeResync, refreshView, syncSelected, tickAges }) {
  const signal = state.pageAbort.signal;
  const status = liveBadge();
  const saved = readStore('rubban.argo.filters', {});
  const filters = { sync: saved.sync || '', health: saved.health || '', project: saved.project || '', problems: Boolean(saved.problems) };
  const select = (key, label, values) => { const node = el('select', { class: 'compact-select', 'aria-label': label }, el('option', { value: '', text: `${label}: all` }), values.map(value => el('option', { value, text: value }))); node.value = filters[key]; node.addEventListener('change', () => { filters[key] = node.value; persist(); apply(); }); return node; };
  const persist = () => writeStore('rubban.argo.filters', filters);
  const syncSelect = select('sync', 'Sync', FILTERS.sync); const healthSelect = select('health', 'Health', FILTERS.health);
  const projectSelect = el('select', { class: 'compact-select', 'aria-label': 'Project' });
  projectSelect.addEventListener('change', () => { filters.project = projectSelect.value; persist(); apply(); });
  const problemsToggle = el('label', { class: 'dock-toggle' }, el('input', { type: 'checkbox', checked: filters.problems }), 'With problems only');
  problemsToggle.querySelector('input').addEventListener('change', event => { filters.problems = event.target.checked; persist(); apply(); });
  const root = page('Argo CD · Manage', `${state.namespace === '*' ? 'All namespaces' : `Destination or application namespace ${state.namespace}`} · refresh, sync, roll back and delete applications, and see why they fail.`, actions(status, button('↻ Refresh view', refreshView, 'compact')));
  const cardDefs = [['total', 'Applications'], ['synced', 'Synced'], ['outOfSync', 'Out of sync'], ['healthy', 'Healthy'], ['degraded', 'Degraded / missing'], ['progressing', 'Progressing'], ['problems', 'With problems'], ['running', 'Operations running']];
  const cards = Object.fromEntries(cardDefs.map(([id, label]) => { const value = el('div', { class: 'card-value', text: '—' }); const node = button([el('span', { class: 'card-label', text: label }), value], () => cardFilter(id), 'card argo-card'); node.dataset.card = id; return [id, { node, value }]; }));
  function cardFilter(id) {
    Object.assign(filters, { sync: '', health: '', problems: false });
    if (id === 'synced') filters.sync = 'Synced'; if (id === 'outOfSync') filters.sync = 'OutOfSync';
    if (id === 'healthy') filters.health = 'Healthy'; if (id === 'degraded') filters.health = 'Degraded'; if (id === 'progressing') filters.health = 'Progressing';
    if (id === 'problems') filters.problems = true;
    syncSelect.value = filters.sync; healthSelect.value = filters.health; problemsToggle.querySelector('input').checked = filters.problems;
    persist(); apply();
  }
  const view = table([], [
    { id: 'name', title: 'Application', class: 'name', locked: true, render: app => app.metadata.name, sort: app => app.metadata.name },
    { id: 'namespace', title: 'Namespace', hidden: true, render: app => app.metadata.namespace, sort: app => app.metadata.namespace },
    { id: 'project', title: 'Project', render: app => app.spec?.project || 'default', sort: app => app.spec?.project },
    { id: 'sync', title: 'Sync', render: app => syncBadge(app.status?.sync?.status), sort: app => app.status?.sync?.status },
    { id: 'health', title: 'Health', render: app => healthBadge(app.status?.health?.status), sort: app => ['Degraded', 'Missing', 'Unknown', 'Progressing', 'Suspended', 'Healthy'].indexOf(app.status?.health?.status || 'Unknown') },
    { id: 'operation', title: 'Last operation', render: app => el('span', { class: 'condition-list argo-operation' }, operationBadge(app.status?.operationState?.phase), app.status?.operationState?.finishedAt ? muted(`${age(app.status.operationState.finishedAt)} ago`) : ''), sort: app => -(new Date(app.status?.operationState?.finishedAt || 0).getTime()) },
    { id: 'problems', title: 'Problems', class: 'wrap', render: app => { const errors = appErrors(app); if (!errors.length) return muted('—'); const first = errors.find(e => e.level === 'error') || errors[0]; return el('span', { class: 'argo-problem' }, el('span', { class: `problem-count ${errors.some(e => e.level === 'error') ? 'bad' : 'warn'}`, text: String(errors.length) }), el('span', { class: 'argo-message', text: first.message.length > 140 ? `${first.message.slice(0, 140)}…` : first.message })); }, sort: app => -appErrors(app).length, tooltip: app => appErrors(app).map(e => `${e.source}: ${e.message}`).join('\n') },
    { id: 'revision', title: 'Revision', class: 'mono-cell', render: app => short(app.status?.sync?.revision || app.status?.sync?.revisions?.[0]) || '—' },
    { id: 'autosync', title: 'Auto-sync', render: app => autoSyncText(app), sort: app => (app.spec?.syncPolicy?.automated ? 0 : 1) },
    { id: 'destination', title: 'Destination', render: destinationText, sort: destinationText },
    { id: 'source', title: 'Source', class: 'wrap', hidden: true, render: app => sourcesOf(app).map(s => `${shortRepo(s.repoURL)}${s.path ? ` · ${s.path}` : ''}${s.chart ? ` · ${s.chart}` : ''}`).join(', ') },
  ], app => hooks.showResource(app, APPS), { id: 'argo:manage', key: liveKey, pending: true, menu: appMenu, sortBy: 'problems', placeholder: 'Filter applications…', empty: 'No Argo CD applications match these filters.',
    searchText: app => `${app.metadata.name} ${app.metadata.namespace} ${app.spec?.project} ${app.spec?.destination?.namespace} ${sourcesOf(app).map(s => s.repoURL).join(' ')}`.toLowerCase(),
    bulk: (items, clear) => el('span', { class: 'actions' },
      button(`Refresh ${items.length}`, task(async () => { for (const app of items) await refresh(app).catch(error => toast(`${app.metadata.name}: ${error.message}`, true)); clear(); }), 'compact'),
      button('Hard refresh', task(async () => { for (const app of items) await refresh(app, true).catch(error => toast(`${app.metadata.name}: ${error.message}`, true)); clear(); }), 'compact'),
      button('Sync…', () => syncDialog(items), 'primary compact'),
      button('Delete', task(() => deleteApplications(items)), 'danger compact'), deleteOptionsButton(items)) });
  const errorsView = table([], [
    { id: 'level', title: '', render: row => el('span', { class: `issue-dot ${row.level === 'error' ? 'bad' : ''}` }) },
    { id: 'app', title: 'Application', class: 'name', render: row => row.app.metadata.name, sort: row => row.app.metadata.name },
    { id: 'source', title: 'Source', render: row => row.source, sort: row => row.source },
    { id: 'message', title: 'Message', class: 'wrap', locked: true, render: row => el('span', { class: 'argo-message', text: row.message }), sort: row => row.message },
    { id: 'when', title: 'When', render: row => (row.time ? `${age(row.time)} ago` : '—'), sort: row => -(new Date(row.time || 0).getTime()) },
  ], row => hooks.showResource(row.app, APPS), { id: 'argo:errors', key: row => row.key, stamp: row => `${row.message}|${row.time}`, pending: true, placeholder: 'Filter errors…', empty: 'No Argo CD errors or warnings. Every application is reporting cleanly.', searchText: row => `${row.app.metadata.name} ${row.source} ${row.message}`.toLowerCase() });
  root.append(el('div', { class: 'cards argo-cards' }, Object.values(cards).map(card => card.node)),
    el('div', { class: 'filter-bar' }, syncSelect, healthSelect, projectSelect, problemsToggle),
    view,
    el('div', { class: 'section-label' }, el('h2', { text: 'Errors and warnings' }), el('span', { text: 'Conditions, failed syncs and unhealthy resources across all applications' })), errorsView);
  let apps = [];
  const scoped = list => (state.namespace === '*' ? list : list.filter(app => app.metadata.namespace === state.namespace || app.spec?.destination?.namespace === state.namespace));
  function apply(change) {
    const scope = scoped(apps);
    const count = predicate => scope.filter(predicate).length;
    const counts = {
      total: scope.length, synced: count(a => a.status?.sync?.status === 'Synced'), outOfSync: count(a => a.status?.sync?.status === 'OutOfSync'),
      healthy: count(a => a.status?.health?.status === 'Healthy'), degraded: count(a => ['Degraded', 'Missing'].includes(a.status?.health?.status)),
      progressing: count(a => a.status?.health?.status === 'Progressing'), problems: count(a => appErrors(a).length > 0), running: count(operationRunning),
    };
    for (const [id, card] of Object.entries(cards)) { card.value.textContent = String(counts[id]); card.node.classList.toggle('alert', ['outOfSync', 'degraded', 'problems'].includes(id) && counts[id] > 0); }
    const projects = [...new Set(scope.map(a => a.spec?.project || 'default'))].sort();
    projectSelect.replaceChildren(el('option', { value: '', text: 'Project: all' }), ...projects.map(value => el('option', { value, text: value })));
    projectSelect.value = projects.includes(filters.project) ? filters.project : '';
    const shown = scope.filter(app => (!filters.sync || (app.status?.sync?.status || 'Unknown') === filters.sync)
      && (!filters.health || (filters.health === 'Degraded' ? ['Degraded', 'Missing'].includes(app.status?.health?.status) : (app.status?.health?.status || 'Unknown') === filters.health))
      && (!projectSelect.value || (app.spec?.project || 'default') === projectSelect.value)
      && (!filters.problems || appErrors(app).length > 0));
    view.update(shown, change);
    errorsView.update(scope.flatMap(app => appErrors(app).map((error, index) => ({ ...error, app, key: `${liveKey(app)}:${index}:${error.source}` }))));
  }
  const notice = el('div');
  root.insertBefore(notice, root.querySelector('.argo-cards'));
  // Applications usually live in the argocd namespace; without cluster-wide list rights, fall back to it.
  const subscribe = (namespace, resync) => liveList({ resource: APPS, namespace, signal, resync, onStatus: value => status.track('apps', value),
    onData: (items, change) => { apps = items.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name)); apply(change); syncSelected(change); },
    onError: error => {
      if (error.status === 404 || /doesn't have a resource type|could not find the requested resource/.test(error.message)) view.replaceWith(el('div', { class: 'empty-state' }, el('h2', { text: 'Argo CD is not installed in this cluster' }), el('p', { text: 'Rubban manages Argo CD through its Application resources. Install Argo CD here, or switch to the cluster where Argo CD runs.' })));
      else if (namespace === '*' && (error.status === 403 || /forbidden/i.test(error.message))) { notice.replaceChildren(info('You cannot list Argo CD applications in all namespaces, so this view shows the argocd namespace.')); subscribe('argocd', false); }
      else view.replaceWith(info(error.message, 'error'));
    } });
  subscribe('*', consumeResync());
  tickAges([view, errorsView], signal);
  return root;
}
export { loading };
