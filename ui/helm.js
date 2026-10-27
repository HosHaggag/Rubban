// Helm: chart browser with README, versions and default values; release details with values,
// notes, managed resources and revision history; install, upgrade, rollback and uninstall.
import { state, hooks, $, el, button, badge, info, loading, get, post, table, dl, section, toast, task, confirmAction, modal, makeForm, output, copyButton, age, clusterQuery, empty } from './kit.js';
import { renderMarkdown } from './markdown.js';
import { resourceForKind } from './kinds.js';

const statusBadge = status => badge(status || 'unknown', status === 'deployed' ? 'good' : /failed/.test(status || '') ? 'bad' : 'warn');
const helmTime = value => { if (!value) return ''; const date = new Date(String(value).replace(/ \+0000 UTC$/, 'Z').replace(' ', 'T')); return Number.isFinite(date.getTime()) ? date : null; };
const ago = value => { const date = helmTime(value); return date ? `${age(date.toISOString())} ago` : String(value || '—'); };

function openDrawer(kind, name) {
  state.selected = { helm: true, name }; $('#drawer').classList.remove('hidden');
  $('#drawer-kind').textContent = kind; $('#drawer-name').textContent = name;
  $('#drawer-back').classList.add('hidden');
  $('#drawer-content').replaceChildren(loading());
}

// ---- Charts --------------------------------------------------------------------------------------
export function showChart(chart) {
  openDrawer('Helm chart', chart.name);
  const versionSelect = el('select', { class: 'compact-select', 'aria-label': 'Chart version' }, el('option', { value: chart.version || '', text: chart.version || 'latest' }));
  const body = el('div', {}, loading('Loading chart…'));
  const header = el('div', { class: 'detail-actions' }, versionSelect, button('Install…', () => installDialog(chart.name, versionSelect.value, cache.get(versionSelect.value)?.values), 'primary compact'));
  $('#drawer-content').replaceChildren(header, body);
  const cache = new Map();
  async function load(version) {
    body.replaceChildren(loading('Loading chart…'));
    try {
      const data = cache.get(version) || await get('/api/helm/chart', { chart: chart.name, version: version || undefined });
      cache.set(version, data);
      if (state.selected?.name !== chart.name) return;
      if (data.versions?.length && versionSelect.options.length <= 1) {
        versionSelect.replaceChildren(...data.versions.map(v => el('option', { value: v.version, text: `${v.version}${v.appVersion ? ` · app ${v.appVersion}` : ''}` })));
        versionSelect.value = data.version;
      }
      const current = (data.versions || []).find(v => v.version === data.version) || {};
      body.replaceChildren(
        ...(data.warnings || []).map(warning => info(warning, 'warn')),
        dl([['Chart', chart.name], ['Version', data.version], ['App version', current.appVersion || chart.app_version], ['Description', current.description || chart.description], ['Versions available', String((data.versions || []).length)]]),
        section('README', data.readme ? renderMarkdown(data.readme) : el('p', { class: 'muted', text: 'This chart has no README.' })),
        section('Default values', el('div', {}, el('div', { class: 'form-actions start' }, copyButton(data.values || '')), el('pre', { class: 'output code', text: data.values || '# No default values' })), { open: false }),
      );
    } catch (error) { body.replaceChildren(info(error.message, 'error')); }
  }
  versionSelect.addEventListener('change', () => load(versionSelect.value));
  load(chart.version || '');
}
export function installDialog(chartRef, version = '', values = '') {
  if (!state.context) { toast('Select a cluster before installing a chart.', true); return; }
  modal('Install chart', `${chartRef}${version ? ` ${version}` : ''} → ${state.context}`, makeForm([
    { name: 'name', label: 'Release name', value: chartRef.split('/').pop().slice(0, 40), required: true },
    { name: 'namespace', label: 'Namespace', value: state.namespace === '*' ? 'default' : state.namespace, required: true },
    { name: 'chart', label: 'Chart', value: chartRef, required: true },
    { name: 'version', label: 'Version', value: version, placeholder: 'Latest' },
    { name: 'values', label: 'Values (YAML)', type: 'textarea', full: true, rows: 16, editor: true, value: values || '', placeholder: '# Override chart values here' },
  ], 'Install', async form => { const result = await post('/api/helm', { ...clusterQuery(), ...form, action: 'install' }); toast('Chart installed.'); hooks.afterMutation?.(); return result; }, { confirm: 'Install this chart into the cluster. It will create the resources defined by its templates.' }));
}

// ---- Releases ------------------------------------------------------------------------------------
export function showRelease(release) {
  openDrawer(`Helm release · ${release.namespace}`, release.name);
  const content = $('#drawer-content');
  const tabs = el('div', { class: 'detail-tabs' });
  const body = el('div', { class: 'drawer-body' }, loading('Loading release…'));
  const actionsBar = el('div', { class: 'detail-actions' },
    button('Upgrade…', () => upgradeDialog(release, data?.values), 'primary compact'),
    button('Rollback…', () => rollbackDialog(release, data?.history), 'compact'),
    button('Uninstall', task(() => uninstall(release)), 'danger compact'));
  content.replaceChildren(actionsBar, tabs, body);
  let data = null; let active = 'overview';
  const tabDefs = [['overview', 'Overview'], ['values', 'Values'], ['resources', 'Resources'], ['history', 'History'], ['notes', 'Notes']];
  const showTab = id => {
    active = id;
    for (const node of tabs.children) node.classList.toggle('active', node.dataset.tab === id);
    if (!data) return;
    if (id === 'overview') body.replaceChildren(dl([
      ['Chart', release.chart], ['App version', release.app_version || release.appVersion], ['Status', statusBadge(release.status)], ['Revision', String(release.revision)],
      ['Namespace', release.namespace], ['Updated', ago(release.updated)], ['Resources', `${data.resources.length} objects`],
      ['Description', (data.history || []).at(-1)?.description],
    ]), data.notes ? section('Notes', el('pre', { class: 'output', text: data.notes }), { open: false }) : '');
    if (id === 'values') {
      const user = el('pre', { class: 'output code', text: data.values || '# No user-supplied values' });
      const all = el('pre', { class: 'output code hidden', text: data.allValues || '' });
      const toggle = el('label', { class: 'dock-toggle' }, el('input', { type: 'checkbox' }), 'Include chart defaults');
      toggle.querySelector('input').addEventListener('change', event => { all.classList.toggle('hidden', !event.target.checked); user.classList.toggle('hidden', event.target.checked); });
      body.replaceChildren(el('div', { class: 'form-actions start' }, toggle, copyButton(() => (all.classList.contains('hidden') ? data.values : data.allValues)), button('Edit and upgrade…', () => upgradeDialog(release, data.values), 'compact')), user, all);
    }
    if (id === 'resources') {
      const resources = [...data.resources].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
      body.replaceChildren(table(resources, [
        { id: 'kind', title: 'Kind', render: r => r.kind, sort: r => r.kind }, { id: 'name', title: 'Name', class: 'name', render: r => r.name, sort: r => r.name },
        { id: 'namespace', title: 'Namespace', render: r => r.namespace || release.namespace, sort: r => r.namespace }, { id: 'api', title: 'API version', render: r => r.apiVersion },
      ], r => hooks.showResource({ kind: r.kind, apiVersion: r.apiVersion, metadata: { name: r.name, namespace: r.namespace || (isClusterScoped(r.kind) ? '' : release.namespace) } }, resourceForKind(r.kind, r.apiVersion)), { searchText: r => `${r.kind} ${r.name}`, placeholder: 'Filter resources…', empty: 'The release manifest has no resources.' }));
    }
    if (id === 'history') {
      const history = [...(data.history || [])].reverse();
      body.replaceChildren(table(history, [
        { id: 'revision', title: 'Revision', class: 'num', render: h => String(h.revision), sort: h => h.revision },
        { id: 'updated', title: 'Updated', render: h => ago(h.updated) }, { id: 'status', title: 'Status', render: h => statusBadge(h.status) },
        { id: 'chart', title: 'Chart', render: h => h.chart }, { id: 'app', title: 'App version', render: h => h.app_version || '—' },
        { id: 'description', title: 'Description', class: 'wrap', render: h => h.description || '—' },
        { id: 'actions', title: '', render: h => (Number(h.revision) !== Number(release.revision) ? button('Roll back', task(async event => { event.stopPropagation(); await rollback(release, h.revision); }), 'quiet compact') : badge('current', 'good')) },
      ], null, { searchText: h => `${h.revision} ${h.status} ${h.description}`, placeholder: 'Filter revisions…' }));
    }
    if (id === 'notes') body.replaceChildren(data.notes ? el('pre', { class: 'output', text: data.notes }) : el('p', { class: 'muted', text: 'This release has no notes.' }));
  };
  for (const [id, title] of tabDefs) { const node = button(title, () => showTab(id), `quiet compact${id === 'overview' ? ' active' : ''}`); node.dataset.tab = id; tabs.append(node); }
  get('/api/helm/release', { context: state.context, namespace: release.namespace, name: release.name }).then(result => { data = result; if (state.selected?.name === release.name) showTab(active); }).catch(error => body.replaceChildren(info(error.message, 'error')));
}
const CLUSTER_KINDS = new Set(['Namespace', 'ClusterRole', 'ClusterRoleBinding', 'CustomResourceDefinition', 'StorageClass', 'PersistentVolume', 'IngressClass', 'PriorityClass', 'MutatingWebhookConfiguration', 'ValidatingWebhookConfiguration', 'APIService', 'Node', 'RuntimeClass', 'ValidatingAdmissionPolicy', 'ValidatingAdmissionPolicyBinding']);
const isClusterScoped = kind => CLUSTER_KINDS.has(kind);
export function upgradeDialog(release, values = '') {
  const chartName = String(release.chart || '').replace(/-v?\d+\.\d+.*$/, '');
  modal('Upgrade release', `${release.name} · ${release.namespace} · currently ${release.chart}`, makeForm([
    { name: 'name', label: 'Release', value: release.name, required: true },
    { name: 'namespace', label: 'Namespace', value: release.namespace, required: true },
    { name: 'chart', label: 'Chart reference', value: release.chartRef || '', placeholder: `repository/${chartName}`, required: true, help: 'Helm needs the repository-qualified chart (for example bitnami/nginx) or an OCI reference.' },
    { name: 'version', label: 'Version', value: '', placeholder: 'Latest' },
    { name: 'values', label: 'Values (YAML)', type: 'textarea', full: true, rows: 16, editor: true, value: values || '', help: 'These values replace the release’s user-supplied values.' },
  ], 'Upgrade', async form => { const result = await post('/api/helm', { ...clusterQuery(), ...form, action: 'upgrade' }); toast('Release upgraded.'); hooks.render?.(); return result; }, { confirm: 'Upgrade this release. Its resources will be updated to the new chart version and values.', target: release.name }));
  // Suggest the repository chart with the same name from the local Helm repositories.
  const input = document.querySelector('#action-dialog input[name="chart"]');
  if (input && !input.value) get('/api/helm/charts').then(data => { const match = (data.charts || []).find(chart => chart.name.split('/').pop() === chartName); if (match && !input.value) { input.value = match.name; const version = document.querySelector('#action-dialog input[name="version"]'); if (version) version.placeholder = `Latest (${match.version})`; } }).catch(() => {});
  if (!values) get('/api/helm/release', { context: state.context, namespace: release.namespace, name: release.name }).then(data => { const area = document.querySelector('#action-dialog textarea[name="values"]'); if (area && !area.value) area.value = data.values || ''; }).catch(() => {});
}
export function rollbackDialog(release, history = []) {
  const options = [...(history || [])].reverse().filter(h => Number(h.revision) !== Number(release.revision)).map(h => ({ value: String(h.revision), label: `${h.revision} · ${h.chart} · ${h.status} · ${ago(h.updated)}` }));
  modal('Roll back release', `${release.name} · ${release.namespace}`, makeForm([
    options.length ? { name: 'revision', label: 'Revision', options } : { name: 'revision', label: 'Revision', type: 'number', min: 1, required: true },
  ], 'Roll back', async form => { const result = await post('/api/helm', { ...clusterQuery(), namespace: release.namespace, name: release.name, revision: Number(form.revision), action: 'rollback' }); toast('Release rolled back.'); hooks.render?.(); return result; }, { confirm: 'Roll back this release to the chosen revision.', target: release.name }));
}
async function rollback(release, revision) {
  if (!await confirmAction(`Roll back ${release.name} to revision ${revision}.`, release.name)) return;
  const result = await post('/api/helm', { ...clusterQuery(), namespace: release.namespace, name: release.name, revision, action: 'rollback' });
  toast(result.output || 'Release rolled back.'); hooks.render?.();
}
export async function uninstall(release) {
  if (!await confirmAction('Uninstall this Helm release and delete its managed Kubernetes resources.', release.name)) return;
  const result = await post('/api/helm', { ...clusterQuery(), action: 'uninstall', namespace: release.namespace, name: release.name });
  toast(result.output || 'Release uninstalled.'); $('#drawer').classList.add('hidden'); state.selected = null; hooks.render?.();
}
export const releaseMenu = release => [
  { icon: '⇪', label: 'Upgrade', action: () => upgradeDialog(release) },
  { icon: '↶', label: 'Rollback', action: () => rollbackDialog(release) },
  '-', { icon: '✕', label: 'Uninstall', danger: true, action: task(() => uninstall(release)) },
];
export function repositoriesPanel(repositories, refresh) {
  return table(repositories || [], [
    { id: 'name', title: 'Name', class: 'name', render: r => r.name, sort: r => r.name }, { id: 'url', title: 'URL', class: 'wrap', render: r => r.url, sort: r => r.url },
  ], null, { searchText: r => `${r.name} ${r.url}`, empty: 'No Helm repositories configured.', menu: r => [
    { icon: '↻', label: 'Update index', action: task(async () => { const result = await post('/api/helm', { ...clusterQuery(), action: 'repo-update', repo: r.name }); toast(result.output || 'Repository updated.'); refresh(); }) },
    { icon: '✕', label: 'Remove', danger: true, action: task(async () => { if (!await confirmAction(`Remove the Helm repository ${r.name} from your local Helm configuration.`, r.name)) return; const result = await post('/api/helm', { ...clusterQuery(), action: 'repo-remove', repo: r.name }); toast(result.output || 'Repository removed.'); refresh(); }) },
  ] });
}
export { empty };
