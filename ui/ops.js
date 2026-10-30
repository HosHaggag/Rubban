// Cluster operations shared by row menus, bulk actions and detail panels.
import { state, hooks, el, button, info, toast, task, get, post, api, targetOf, confirmAction, modal, makeForm, copyButton, download, output, $ } from './kit.js';
import { selectorText } from './format.js';
import { kindOf, isDefaultClass } from './kinds.js';

export const selectionFor = (item, resource) => ({ context: state.context, namespace: item.metadata?.namespace || '', resource, name: item.metadata?.name, item });
const done = message => result => { toast((result?.output || '').split('\n').filter(Boolean).slice(-1)[0] || message); hooks.afterMutation?.(); return result; };
const closeDrawerFor = selected => { if (state.selected?.name === selected.name && state.selected?.resource === selected.resource) { state.selected = null; $('#drawer').classList.add('hidden'); } };

export async function deleteResource(selected) {
  if (!await confirmAction(`Delete ${kindOf(selected.resource) || selected.resource} “${selected.name}” from the cluster. This may interrupt running workloads or remove data.`, selected.name)) return;
  const result = await post('/api/delete', targetOf(selected));
  toast(result.output || 'Resource deleted.');
  closeDrawerFor(selected); hooks.afterMutation?.();
}
export async function deleteMany(resource, items, clear) {
  const target = `${items.length} ${items.length === 1 ? 'resource' : 'resources'}`;
  if (!await confirmAction(`Delete ${target} (${items.slice(0, 5).map(i => i.metadata?.name).join(', ')}${items.length > 5 ? ', …' : ''}). This cannot be undone.`, target)) return;
  let failed = 0;
  for (const item of items) {
    try { await post('/api/delete', targetOf(selectionFor(item, resource))); } catch (error) { failed++; toast(`${item.metadata?.name}: ${error.message}`, true); }
  }
  toast(failed ? `Deleted ${items.length - failed} of ${items.length}.` : `Deleted ${items.length} ${items.length === 1 ? 'resource' : 'resources'}.`, Boolean(failed));
  clear?.(); hooks.afterMutation?.();
}
export function scaleDialog(selected) {
  const current = selected.item.spec?.replicas ?? 1;
  const slider = el('input', { type: 'range', min: 0, max: Math.max(10, current * 2), value: current, 'aria-label': 'Replicas' });
  const form = makeForm([{ name: 'replicas', label: 'Desired replicas', type: 'number', value: current, min: 0, max: 100000, required: true, help: `Currently ${selected.item.status?.readyReplicas ?? selected.item.status?.replicas ?? 0} ready of ${current} desired.` }], 'Scale', values => post('/api/scale', { ...targetOf(selected), replicas: Number(values.replicas) }), { confirm: 'Change the desired number of replicas for this workload.', target: selected.name, after: done('Scaled.') });
  const input = form.querySelector('input[name="replicas"]');
  slider.addEventListener('input', () => { input.value = slider.value; });
  input.addEventListener('input', () => { slider.value = input.value; });
  modal(`Scale ${kindOf(selected.resource) || 'workload'}`, `${selected.name} · ${selected.namespace} · ${selected.context}`, el('div', {}, el('div', { class: 'scale-slider' }, slider), form));
}
export function forwardDialog(selected, preset = {}) {
  const ports = forwardablePorts(selected.item);
  const remote = preset.port || ports[0]?.port || 80;
  const form = makeForm([
    { name: 'remotePort', label: 'Remote port', type: 'number', value: remote, min: 1, max: 65535, required: true, help: ports.length ? `Available: ${ports.map(p => `${p.port}${p.name ? ` (${p.name})` : ''}`).join(', ')}` : '' },
    { name: 'localPort', label: 'Local port', type: 'number', value: preset.localPort || '', min: 0, max: 65535, placeholder: 'Random', help: 'Leave empty to use a random free port on 127.0.0.1.' },
    { name: 'open', label: 'After it starts', options: [{ value: 'open', label: 'Open in browser' }, { value: '', label: 'Do not open' }], value: 'open' },
    { name: 'scheme', label: 'Protocol', options: ['http', 'https'], value: Number(remote) === 443 || /https/.test(ports.find(p => p.port === Number(remote))?.name || '') ? 'https' : 'http' },
  ], 'Start forwarding', async values => {
    const response = await post('/api/forwards', { ...targetOf(selected), localPort: values.localPort ? Number(values.localPort) : 0, remotePort: Number(values.remotePort) });
    toast('Port forwarding started.');
    if (values.open) waitAndOpen(response.id, values.scheme);
    return response;
  });
  modal('Port forward', `${kindOf(selected.resource) || selected.resource} ${selected.name} · ${selected.namespace}`, form);
}
export function forwardablePorts(item) {
  if (item.kind === 'Service' || item.spec?.ports?.[0]?.port) return (item.spec?.ports || []).map(p => ({ port: p.port, name: p.name, protocol: p.protocol }));
  return (item.spec?.containers || []).flatMap(c => (c.ports || []).map(p => ({ port: p.containerPort, name: p.name, protocol: p.protocol, container: c.name })));
}
export function openExternal(url) {
  if (window.rubbanDesktop?.openExternal) window.rubbanDesktop.openExternal(url).catch(error => toast(error.message, true));
  else window.open(url, '_blank', 'noopener');
}
async function waitAndOpen(id, scheme = 'http') {
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const response = await get('/api/forwards', {}, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (!response) continue;
    const { items = [] } = response;
    const forward = items.find(item => item.id === id);
    if (!forward || forward.status === 'error') { toast(forward?.error || 'Port forward stopped before it was ready.', true); return; }
    if (forward.status === 'ready' && forward.localPort) { openExternal(`${scheme}://localhost:${forward.localPort}`); return; }
  }
}
export async function restart(selected) {
  if (!await confirmAction('Restart this workload. New pods will roll out according to its update strategy.', selected.name)) return;
  done('Restart requested.')(await post('/api/restart', targetOf(selected)));
}
export async function evict(selected) {
  if (!await confirmAction('Evict this pod through the Eviction API. Pod disruption budgets are respected; its controller will usually recreate it elsewhere.', selected.name)) return;
  done('Pod evicted.')(await post('/api/evict', targetOf(selected)));
}
export async function cordon(selected, on) {
  if (!await confirmAction(on ? 'Cordon this node. New pods will not be scheduled on it; running pods stay.' : 'Uncordon this node so new pods can be scheduled on it again.', selected.name)) return;
  done(on ? 'Node cordoned.' : 'Node uncordoned.')(await post('/api/node', { context: selected.context, name: selected.name, action: on ? 'cordon' : 'uncordon' }));
}
export function drainDialog(selected) {
  modal('Drain node', `${selected.name} · ${selected.context}`, el('div', {}, info('Draining cordons the node, then evicts its pods (respecting disruption budgets). DaemonSet pods are left in place when ignored.', 'warn'), makeForm([
    { name: 'ignoreDaemonsets', label: 'DaemonSet pods', options: [{ value: 'true', label: 'Ignore (recommended)' }, { value: 'false', label: 'Fail if present' }] },
    { name: 'deleteEmptyDirData', label: 'Pods with emptyDir data', options: [{ value: 'true', label: 'Delete their local data' }, { value: 'false', label: 'Fail if present' }] },
    { name: 'force', label: 'Unmanaged pods', options: [{ value: 'false', label: 'Fail if present' }, { value: 'true', label: 'Force delete them' }] },
    { name: 'gracePeriodSeconds', label: 'Grace period (seconds)', type: 'number', min: -1, max: 3600, placeholder: 'Pod default' },
    { name: 'timeoutSeconds', label: 'Timeout (seconds)', type: 'number', min: 10, max: 3600, value: 300, required: true },
  ], 'Drain node', values => post('/api/node', { context: selected.context, name: selected.name, action: 'drain', ignoreDaemonsets: values.ignoreDaemonsets === 'true', deleteEmptyDirData: values.deleteEmptyDirData === 'true', force: values.force === 'true', gracePeriodSeconds: values.gracePeriodSeconds, timeoutSeconds: Number(values.timeoutSeconds) }), { danger: true, confirm: 'Drain this node and evict its pods.', target: selected.name, after: done('Node drained.') })));
}
export async function cronJobAction(selected, action) {
  const text = { trigger: 'Create a Job from this CronJob now, outside its schedule.', suspend: 'Suspend this CronJob. No new Jobs will be scheduled until it is resumed.', resume: 'Resume this CronJob so it schedules Jobs again.' }[action];
  if (!await confirmAction(text, selected.name)) return;
  done(action === 'trigger' ? 'Job created.' : action === 'suspend' ? 'CronJob suspended.' : 'CronJob resumed.')(await post('/api/cronjob', { ...targetOf(selected), action }));
}
export async function setDefaultClass(selected) {
  if (!await confirmAction(`Make ${selected.name} the cluster default ${selected.resource === 'ingressclasses' ? 'IngressClass' : 'StorageClass'}. Any other default is cleared.`, selected.name)) return;
  done('Default updated.')(await post('/api/default-class', { context: selected.context, kind: selected.resource, name: selected.name }));
}
export async function pauseRollout(selected, paused) {
  if (!await confirmAction(paused ? 'Pause rollouts of this Deployment. Template changes will not roll out until resumed.' : 'Resume rollouts of this Deployment.', selected.name)) return;
  done(paused ? 'Rollout paused.' : 'Rollout resumed.')(await post('/api/patch', { ...targetOf(selected), type: 'merge', patch: { spec: { paused } } }));
}
export async function rollback(selected, revision) {
  if (!await confirmAction(`Roll back ${selected.name} to revision ${revision}. Pods will be replaced with that revision's template.`, selected.name)) return;
  done(`Rolled back to revision ${revision}.`)(await post('/api/rollout-undo', { ...targetOf(selected), revision }));
}
export function kubeconfigDialog(selected) {
  const result = el('div');
  modal('Service account kubeconfig', `${selected.name} · ${selected.namespace}`, el('div', {}, info('Creates a time-limited token with the TokenRequest API. The kubeconfig grants exactly this service account’s permissions; treat it like a password.', 'warn'),
    makeForm([{ name: 'hours', label: 'Token lifetime (hours)', type: 'number', value: 24, min: 1, max: 8760, required: true }], 'Create kubeconfig', async values => {
      const response = await post('/api/serviceaccount-kubeconfig', { context: selected.context, namespace: selected.namespace, name: selected.name, hours: Number(values.hours) });
      result.replaceChildren(output(response.kubeconfig), el('div', { class: 'form-actions' }, copyButton(response.kubeconfig), button('Download', () => download(`${selected.name}-kubeconfig.yaml`, response.kubeconfig, 'application/yaml'), 'compact')));
      return `Token valid for ${response.expiresInHours} hours.`;
    }), result));
}
export function workloadSelector(item) {
  const selector = item.spec?.selector;
  if (!selector) return '';
  return selectorText(selector);
}
export const containersOf = item => (item.spec?.containers || item.spec?.template?.spec?.containers || []).map(c => c.name);
export function logsFor(selected, options = {}) {
  const item = selected.item;
  if (item.kind === 'Pod' || selected.resource === 'pods') {
    // Default to the annotated default container, else the first app container that is not a mesh sidecar.
    const regular = containersOf(item);
    const annotated = item.metadata?.annotations?.['kubectl.kubernetes.io/default-container'];
    const defaultContainer = regular.includes(annotated) ? annotated : regular.find(name => !/^(istio-proxy|linkerd-proxy|vault-agent)/.test(name)) || regular[0];
    return hooks.openLogs({ context: selected.context, namespace: selected.namespace, pod: selected.name, containers: [...regular, ...(item.spec?.initContainers || []).map(c => c.name), ...(item.spec?.ephemeralContainers || []).map(c => c.name)], defaultContainer, ...options });
  }
  const selector = workloadSelector(item);
  if (!selector) { toast('This workload has no label selector to collect pod logs with.', true); return; }
  hooks.openLogs({ context: selected.context, namespace: selected.namespace, selector, title: `${item.kind || selected.resource} ${selected.name}`, containers: containersOf(item), ...options });
}
export const shell = (selected, container) => hooks.openTerminal({ context: selected.context, namespace: selected.namespace, pod: selected.name, container, title: `${selected.name}${container ? ` · ${container}` : ''}` });
export const attach = (selected, container) => hooks.openTerminal({ context: selected.context, namespace: selected.namespace, pod: selected.name, container, attach: true, title: `Attach ${selected.name}${container ? ` · ${container}` : ''}` });
export const nodeShell = selected => hooks.openTerminal({ context: selected.context, node: selected.name, image: state.preferences.nodeShellImage || undefined, title: `Node ${selected.name}` });
export const edit = (item, resource) => hooks.showResource(item, resource, { tab: 'yaml' });

// Context menu for a table row (also shown with right click).
export function rowMenu(resource, item) {
  const selected = selectionFor(item, resource);
  const menu = [];
  const running = item.status?.phase === 'Running';
  if (resource === 'pods') {
    const containers = containersOf(item);
    menu.push({ icon: '≋', label: 'Logs', action: () => logsFor(selected) });
    if (containers.length > 1) for (const name of containers) menu.push({ icon: '›_', label: `Shell · ${name}`, action: () => shell(selected, name), disabled: !running });
    else menu.push({ icon: '›_', label: 'Shell', action: () => shell(selected, containers[0]), disabled: !running });
    menu.push({ icon: '⇢', label: 'Attach', action: () => attach(selected, containers[0]), disabled: !running });
    if (forwardablePorts(item).length) menu.push({ icon: '⇄', label: 'Port forward', action: () => forwardDialog(selected) });
    menu.push({ icon: '⤴', label: 'Evict', action: task(() => evict(selected)) });
  }
  if (['deployments', 'statefulsets', 'replicasets', 'replicationcontrollers'].includes(resource)) menu.push({ icon: '⇕', label: 'Scale', action: () => scaleDialog(selected) });
  if (['deployments', 'statefulsets', 'daemonsets'].includes(resource)) menu.push({ icon: '↻', label: 'Restart', action: task(() => restart(selected)) });
  if (resource === 'deployments') menu.push(item.spec?.paused ? { icon: '⏵', label: 'Resume rollout', action: task(() => pauseRollout(selected, false)) } : { icon: '⏸', label: 'Pause rollout', action: task(() => pauseRollout(selected, true)) });
  if (['deployments', 'statefulsets', 'daemonsets', 'replicasets', 'jobs', 'replicationcontrollers'].includes(resource)) menu.push({ icon: '≋', label: 'Logs', action: () => logsFor(selected) });
  if (resource === 'cronjobs') {
    menu.push({ icon: '▶', label: 'Trigger now', action: task(() => cronJobAction(selected, 'trigger')) });
    menu.push(item.spec?.suspend ? { icon: '⏵', label: 'Resume', action: task(() => cronJobAction(selected, 'resume')) } : { icon: '⏸', label: 'Suspend', action: task(() => cronJobAction(selected, 'suspend')) });
  }
  if (resource === 'nodes') {
    menu.push({ icon: '›_', label: 'Node shell', action: () => nodeShell(selected) });
    menu.push(item.spec?.unschedulable ? { icon: '✓', label: 'Uncordon', action: task(() => cordon(selected, false)) } : { icon: '⊘', label: 'Cordon', action: task(() => cordon(selected, true)) });
    menu.push({ icon: '⇣', label: 'Drain', action: () => drainDialog(selected) });
  }
  if (resource === 'services' && forwardablePorts(item).length) menu.push({ icon: '⇄', label: 'Port forward', action: () => forwardDialog(selected) });
  if (['ingressclasses', 'storageclasses'].includes(resource) && !isDefaultClass(item)) menu.push({ icon: '★', label: 'Set as default', action: task(() => setDefaultClass(selected)) });
  if (resource === 'serviceaccounts') menu.push({ icon: '⚿', label: 'Kubeconfig', action: () => kubeconfigDialog(selected) });
  if (resource === 'customresourcedefinitions') menu.push({ icon: '▤', label: 'Open resources', action: () => hooks.openView('resource', `${item.spec?.names?.plural}.${item.spec?.group}`, item.spec?.names?.kind) });
  if (resource === 'applications.argoproj.io' && hooks.argoMenu) return hooks.argoMenu(item);
  if (resource !== 'events') {
    if (menu.length) menu.push('-');
    menu.push({ icon: '✎', label: 'Edit', action: () => edit(item, resource) });
    menu.push({ icon: '✕', label: 'Delete', danger: true, action: task(() => deleteResource(selected)) });
  }
  return menu;
}
export const bulkActions = resource => (items, clear) => (resource === 'events' ? null : button(`Delete ${items.length}`, task(() => deleteMany(resource, items, clear)), 'danger compact'));
export { api };
