// Per-kind table columns for every resource view, including human-readable CPU and memory
// consumption for pods, nodes, namespaces and workloads, plus custom-resource printer columns.
import { el, badge, age, statusOf, liveKey, liveStamp, state, link, hooks } from './kit.js';
import { parseQuantity, parseCPU, parseMemory, formatCPU, formatBytes, formatPercent, podResources, matchesSelector, selectorText, formatDuration, nextCronRun, jsonPath } from './format.js';
export { jsonPath };
import { indexPods } from './usage.js';

// ---- Kind ↔ resource mapping ------------------------------------------------------------------
const CORE_KINDS = {
  Pod: 'pods', Deployment: 'deployments', DaemonSet: 'daemonsets', StatefulSet: 'statefulsets', ReplicaSet: 'replicasets', ReplicationController: 'replicationcontrollers',
  Job: 'jobs', CronJob: 'cronjobs', Node: 'nodes', Namespace: 'namespaces', Service: 'services', Endpoints: 'endpoints', EndpointSlice: 'endpointslices', Ingress: 'ingresses',
  IngressClass: 'ingressclasses', NetworkPolicy: 'networkpolicies', ConfigMap: 'configmaps', Secret: 'secrets', ResourceQuota: 'resourcequotas', LimitRange: 'limitranges',
  HorizontalPodAutoscaler: 'horizontalpodautoscalers', PodDisruptionBudget: 'poddisruptionbudgets', PriorityClass: 'priorityclasses', RuntimeClass: 'runtimeclasses', Lease: 'leases',
  MutatingWebhookConfiguration: 'mutatingwebhookconfigurations', ValidatingWebhookConfiguration: 'validatingwebhookconfigurations', PersistentVolumeClaim: 'persistentvolumeclaims',
  PersistentVolume: 'persistentvolumes', StorageClass: 'storageclasses', ServiceAccount: 'serviceaccounts', Role: 'roles', ClusterRole: 'clusterroles', RoleBinding: 'rolebindings',
  ClusterRoleBinding: 'clusterrolebindings', CustomResourceDefinition: 'customresourcedefinitions', Event: 'events', ControllerRevision: 'controllerrevisions',
  VerticalPodAutoscaler: 'verticalpodautoscalers.autoscaling.k8s.io',
};
export function resourceForKind(kind, apiVersion = '') {
  const group = apiVersion.includes('/') ? apiVersion.split('/')[0] : '';
  const builtin = !group || ['apps', 'batch', 'autoscaling', 'policy', 'networking.k8s.io', 'rbac.authorization.k8s.io', 'storage.k8s.io', 'apiextensions.k8s.io', 'admissionregistration.k8s.io', 'scheduling.k8s.io', 'node.k8s.io', 'coordination.k8s.io', 'discovery.k8s.io', 'events.k8s.io'].includes(group);
  if (builtin && CORE_KINDS[kind]) return CORE_KINDS[kind];
  const found = state.discovery.find(resource => resource.kind === kind && (!group || resource.group === group));
  if (found) return found.group ? `${found.name}.${found.group}` : found.name;
  if (CORE_KINDS[kind]) return CORE_KINDS[kind];
  return `${kind.toLowerCase()}s${group ? `.${group}` : ''}`;
}
export const kindOf = resource => Object.entries(CORE_KINDS).find(([, value]) => value === resource)?.[0] || '';
export const controllerOf = item => (item.metadata?.ownerReferences || []).find(ref => ref.controller) || (item.metadata?.ownerReferences || [])[0] || null;

// ---- Page context: pods and live usage shared by the columns of one view ---------------------
const NEEDS_PODS = new Set(['deployments', 'daemonsets', 'statefulsets', 'replicasets', 'replicationcontrollers', 'jobs', 'nodes', 'namespaces', 'persistentvolumeclaims', 'services', 'poddisruptionbudgets']);
const USES_USAGE = new Set(['pods', 'deployments', 'daemonsets', 'statefulsets', 'replicasets', 'replicationcontrollers', 'jobs', 'nodes', 'namespaces']);
export const needsPods = resource => NEEDS_PODS.has(resource);
export const usesUsage = resource => USES_USAGE.has(resource);
// Nodes and namespaces always aggregate pods cluster-wide.
export const podScopeFor = resource => (['nodes', 'namespaces', 'persistentvolumes'].includes(resource) ? '*' : null);

export function pageContext(usage) {
  let index = indexPods([]); let podVersion = 0; let memo = new Map(); let memoVersion = '';
  const ctx = {
    usage,
    podsReady: false,
    // null means the pod list is unavailable (for example RBAC), which renders as '—' rather than 0.
    setPods(list) { index = indexPods(list || []); podVersion++; ctx.podsReady = Array.isArray(list); },
    get index() { return index; },
    version: () => `${usage?.version ?? 0}.${podVersion}`,
    podsFor(item) {
      const kind = item.kind;
      if (kind === 'Namespace') return index.inNamespace(item.metadata?.name);
      if (kind === 'Node') return index.forWorkload(item);
      if (kind === 'PersistentVolumeClaim') return index.inNamespace(item.metadata?.namespace).filter(pod => (pod.spec?.volumes || []).some(volume => volume.persistentVolumeClaim?.claimName === item.metadata?.name));
      if (kind === 'Service') return item.spec?.selector && Object.keys(item.spec.selector).length ? index.inNamespace(item.metadata?.namespace).filter(pod => matchesSelector(item.spec.selector, pod.metadata?.labels || {})) : [];
      if (kind === 'PodDisruptionBudget') return item.spec?.selector ? index.inNamespace(item.metadata?.namespace).filter(pod => matchesSelector(item.spec.selector, pod.metadata?.labels || {})) : [];
      return index.forWorkload(item);
    },
    summary(item) {
      const version = ctx.version();
      if (version !== memoVersion) { memo = new Map(); memoVersion = version; }
      const key = `${liveKey(item)}:${liveStamp(item)}`;
      if (!memo.has(key)) memo.set(key, usage ? usage.summarize(ctx.podsFor(item)) : null);
      return memo.get(key);
    },
  };
  return ctx;
}

// ---- Cell renderers ---------------------------------------------------------------------------
const muted = text => el('span', { class: 'muted', text });
// Related objects in a row (namespace, owner, node) are links that open that object, like Lens.
const openRef = (kind, name, namespace = '', apiVersion = '') => hooks.showResource?.({ kind, apiVersion, metadata: { name, namespace } }, resourceForKind(kind, apiVersion));
export const refCell = (kind, name, namespace = '', apiVersion = '') => (name ? link(name, () => openRef(kind, name, namespace, apiVersion), `Open ${kind} ${name}`) : muted('—'));
const levelOf = fraction => (fraction >= 0.9 ? 'bad' : fraction >= 0.75 ? 'warn' : 'good');
export function usageCell(kind, used, { base, baseLabel } = {}) {
  if (!Number.isFinite(used)) return muted('—');
  const text = kind === 'cpu' ? formatCPU(used) : formatBytes(used);
  const cell = el('div', { class: 'usage-cell' }, el('span', { class: 'usage-value', text }));
  if (Number.isFinite(base) && base > 0) {
    const fraction = used / base;
    cell.append(el('span', { class: 'usage-bar', title: `${formatPercent(used, base)} of ${baseLabel || 'capacity'}` }, el('span', { class: 'usage-fill', 'data-level': levelOf(fraction), style: `width:${Math.min(100, fraction * 100).toFixed(1)}%` })));
  }
  return cell;
}
function usageTooltip(kind, used, { request, limit, capacity, capacityLabel = 'allocatable' } = {}) {
  const fmt = kind === 'cpu' ? formatCPU : formatBytes;
  const parts = [`Usage ${Number.isFinite(used) ? fmt(used) : 'not reported'}`];
  if (request) parts.push(`Requests ${fmt(request)}${Number.isFinite(used) ? ` (${formatPercent(used, request)} used)` : ''}`);
  if (limit) parts.push(`Limits ${fmt(limit)}${Number.isFinite(used) ? ` (${formatPercent(used, limit)} used)` : ''}`);
  if (capacity) parts.push(`${capacityLabel[0].toUpperCase()}${capacityLabel.slice(1)} ${fmt(capacity)}`);
  return parts.join(' · ');
}
const usageMissing = ctx => (ctx.usage?.available === false ? `Metrics unavailable: ${ctx.usage.message || 'metrics.k8s.io is not serving data'}` : '');
function joinLimited(values, max = 3) { const list = values.filter(Boolean); return list.length > max ? `${list.slice(0, max).join(', ')} +${list.length - max}` : list.join(', '); }
const conditionTrue = (item, type) => (item.status?.conditions || []).some(c => c.type === type && c.status === 'True');
const creation = item => new Date(item.metadata?.creationTimestamp).getTime() || 0;
const ageColumn = { id: 'age', title: 'Age', render: item => age(item.metadata?.creationTimestamp), sort: item => -creation(item), tooltip: item => item.metadata?.creationTimestamp ? new Date(item.metadata.creationTimestamp).toLocaleString() : '' };
const nameColumn = { id: 'name', title: 'Name', class: 'name', locked: true, render: item => item.metadata?.name || '—', sort: item => item.metadata?.name };
const namespaceColumn = { id: 'namespace', title: 'Namespace', render: item => (item.metadata?.namespace ? refCell('Namespace', item.metadata.namespace) : 'Cluster scoped'), sort: item => item.metadata?.namespace };
const statusColumn = { id: 'status', title: 'Status', render: item => badge(...statusOf(item)), sort: item => statusOf(item)[0] };
const labelsColumn = { id: 'labels', title: 'Labels', class: 'wrap', hidden: true, render: item => joinLimited(Object.entries(item.metadata?.labels || {}).map(([k, v]) => `${k}=${v}`), 2) || '—' };
const controlledByColumn = { id: 'controlledBy', title: 'Controlled by', render: item => { const owner = controllerOf(item); return owner ? el('span', {}, el('span', { class: 'kind-tag', text: owner.kind }), ' ', refCell(owner.kind, owner.name, item.metadata?.namespace, owner.apiVersion)) : muted('—'); }, sort: item => { const owner = controllerOf(item); return owner ? `${owner.kind}/${owner.name}` : ''; } };
const imagesOf = item => [...new Set((item.spec?.template?.spec?.containers || item.spec?.jobTemplate?.spec?.template?.spec?.containers || item.spec?.containers || []).map(c => c.image))];
const imagesColumn = { id: 'images', title: 'Images', class: 'wrap mono-cell', hidden: true, render: item => joinLimited(imagesOf(item), 2) || '—', sort: item => imagesOf(item)[0] };
const num = (value, empty = '—') => (value === undefined || value === null || value === '' ? empty : String(value));
function conditionBadges(item, types) {
  const node = el('span', { class: 'condition-list' });
  for (const condition of item.status?.conditions || []) {
    if (types && !types.includes(condition.type)) continue;
    if (condition.status !== 'True' && !['Ready', 'Available'].includes(condition.type)) continue;
    const bad = ['ReplicaFailure', 'Failed', 'Stalled'].includes(condition.type) || condition.status !== 'True';
    node.append(badge(condition.status === 'True' ? condition.type : `Not ${condition.type.toLowerCase()}`, bad ? 'bad' : condition.type === 'Progressing' ? 'info' : 'good'));
  }
  return node.childElementCount ? node : muted('—');
}

// Usage columns for an aggregate of pods (workloads, namespaces).
function aggregateUsageColumns(ctx) {
  return [
    { id: 'cpu', title: 'CPU', class: 'usage', sortDesc: true,
      render: item => { const s = ctx.summary(item); if (!s || !s.measured) return muted(ctx.podsReady && s?.pods === 0 ? '0' : '—'); const byLimit = s.cpuLimit && !s.cpuLimitMissing; return usageCell('cpu', s.cpu, { base: byLimit ? s.cpuLimit : s.cpuRequest, baseLabel: byLimit ? 'limits' : 'requests' }); },
      sort: item => ctx.summary(item)?.measured ? ctx.summary(item).cpu : NaN,
      tooltip: item => { const s = ctx.summary(item); return usageMissing(ctx) || (s ? `${usageTooltip('cpu', s.measured ? s.cpu : NaN, { request: s.cpuRequest, limit: s.cpuLimit })}${s.cpuLimitMissing ? ' (some containers have no CPU limit)' : ''} · ${s.pods} pod${s.pods === 1 ? '' : 's'}` : ''); } },
    { id: 'memory', title: 'Memory', class: 'usage', sortDesc: true,
      render: item => { const s = ctx.summary(item); if (!s || !s.measured) return muted(ctx.podsReady && s?.pods === 0 ? '0' : '—'); const byLimit = s.memoryLimit && !s.memoryLimitMissing; return usageCell('memory', s.memory, { base: byLimit ? s.memoryLimit : s.memoryRequest, baseLabel: byLimit ? 'limits' : 'requests' }); },
      sort: item => ctx.summary(item)?.measured ? ctx.summary(item).memory : NaN,
      tooltip: item => { const s = ctx.summary(item); return usageMissing(ctx) || (s ? `${usageTooltip('memory', s.measured ? s.memory : NaN, { request: s.memoryRequest, limit: s.memoryLimit })}${s.memoryLimitMissing ? ' (some containers have no memory limit)' : ''}` : ''); } },
    { id: 'cpuRequests', title: 'CPU requests', class: 'num', hidden: true, render: item => { const s = ctx.summary(item); return s?.cpuRequest ? formatCPU(s.cpuRequest) : '—'; }, sort: item => ctx.summary(item)?.cpuRequest },
    { id: 'memoryRequests', title: 'Memory requests', class: 'num', hidden: true, render: item => { const s = ctx.summary(item); return s?.memoryRequest ? formatBytes(s.memoryRequest) : '—'; }, sort: item => ctx.summary(item)?.memoryRequest },
  ];
}

// ---- Pods -------------------------------------------------------------------------------------
export const podRestarts = item => (item.status?.containerStatuses || []).reduce((sum, c) => sum + (c.restartCount || 0), 0);
export const podReady = item => { const statuses = item.status?.containerStatuses || []; return `${statuses.filter(c => c.ready).length}/${item.spec?.containers?.length || statuses.length || 0}`; };
export function containerState(status) {
  if (!status) return ['pending', 'Pending'];
  if (status.state?.running) return status.ready === false ? ['warn', 'Running, not ready'] : ['good', 'Running'];
  if (status.state?.waiting) return [/BackOff|Err|Invalid/.test(status.state.waiting.reason || '') ? 'bad' : 'warn', status.state.waiting.reason || 'Waiting'];
  if (status.state?.terminated) return [status.state.terminated.exitCode === 0 ? 'done' : 'bad', `${status.state.terminated.reason || 'Terminated'} (exit ${status.state.terminated.exitCode})`];
  return ['pending', 'Unknown'];
}
function containerSquares(item) {
  const statuses = new Map([...(item.status?.initContainerStatuses || []), ...(item.status?.containerStatuses || [])].map(s => [s.name, s]));
  const node = el('span', { class: 'container-squares' });
  for (const [list, init] of [[item.spec?.initContainers || [], true], [item.spec?.containers || [], false]]) {
    for (const container of list) {
      const [level, text] = containerState(statuses.get(container.name));
      node.append(el('span', { class: `square ${level}${init ? ' init' : ''}`, title: `${init ? 'Init container ' : ''}${container.name}: ${text}` }));
    }
  }
  return node;
}
function podColumns(ctx) {
  const usage = item => ctx.usage?.pod(item);
  return [nameColumn, namespaceColumn,
    { id: 'containers', title: 'Containers', render: containerSquares, sort: item => (item.spec?.containers || []).length },
    { id: 'cpu', title: 'CPU', class: 'usage', sortDesc: true,
      render: item => { const u = usage(item); const r = podResources(item); return u ? usageCell('cpu', u.cpu, { base: r.cpuLimitMissing ? r.cpuRequest : r.cpuLimit, baseLabel: r.cpuLimitMissing ? 'requests' : 'limits' }) : muted('—'); },
      sort: item => usage(item)?.cpu ?? NaN,
      tooltip: item => { const r = podResources(item); return usageMissing(ctx) || usageTooltip('cpu', usage(item)?.cpu ?? NaN, { request: r.cpuRequest, limit: r.cpuLimitMissing ? 0 : r.cpuLimit }); } },
    { id: 'memory', title: 'Memory', class: 'usage', sortDesc: true,
      render: item => { const u = usage(item); const r = podResources(item); return u ? usageCell('memory', u.memory, { base: r.memoryLimitMissing ? r.memoryRequest : r.memoryLimit, baseLabel: r.memoryLimitMissing ? 'requests' : 'limits' }) : muted('—'); },
      sort: item => usage(item)?.memory ?? NaN,
      tooltip: item => { const r = podResources(item); return usageMissing(ctx) || usageTooltip('memory', usage(item)?.memory ?? NaN, { request: r.memoryRequest, limit: r.memoryLimitMissing ? 0 : r.memoryLimit }); } },
    { id: 'ready', title: 'Ready', render: podReady, sort: item => (item.status?.containerStatuses || []).filter(c => c.ready).length },
    { id: 'restarts', title: 'Restarts', class: 'num', sortDesc: true, render: item => { const count = podRestarts(item); return count > 5 ? el('span', { class: 'hot-number', text: String(count) }) : String(count); }, sort: podRestarts,
      tooltip: item => { const last = (item.status?.containerStatuses || []).map(c => c.lastState?.terminated).filter(Boolean).sort((a, b) => new Date(b.finishedAt) - new Date(a.finishedAt))[0]; return last ? `Last restart: ${last.reason || 'terminated'} (exit ${last.exitCode}) ${age(last.finishedAt)} ago` : ''; } },
    { id: 'node', title: 'Node', render: item => (item.spec?.nodeName ? refCell('Node', item.spec.nodeName) : '—'), sort: item => item.spec?.nodeName },
    { id: 'qos', title: 'QoS', render: item => item.status?.qosClass || '—', sort: item => item.status?.qosClass },
    { id: 'ip', title: 'IP', class: 'mono-cell', hidden: true, render: item => item.status?.podIP || '—', sort: item => item.status?.podIP },
    labelsColumn, ageColumn,
    { id: 'status', title: 'Status', render: item => badge(...statusOf(item)), sort: item => statusOf(item)[0] }];
}

// ---- Workloads --------------------------------------------------------------------------------
const desiredOf = item => item.spec?.replicas ?? 1;
function replicaColumns(kind) {
  if (kind === 'DaemonSet') return [{ id: 'pods', title: 'Pods', render: item => `${item.status?.numberReady || 0}/${item.status?.desiredNumberScheduled || 0}`, sort: item => item.status?.desiredNumberScheduled || 0 }];
  return [{ id: 'pods', title: 'Pods', render: item => { const ready = item.status?.readyReplicas || 0; const desired = desiredOf(item); const text = `${ready}/${desired}`; return ready < desired ? el('span', { class: 'warn-text', text }) : text; }, sort: item => desiredOf(item) }];
}
const deploymentColumns = ctx => [nameColumn, namespaceColumn, ...replicaColumns('Deployment'),
  { id: 'replicas', title: 'Replicas', class: 'num', render: item => num(item.spec?.replicas, '1'), sort: desiredOf },
  ...aggregateUsageColumns(ctx), imagesColumn, ageColumn,
  { id: 'conditions', title: 'Conditions', render: item => conditionBadges(item, ['Available', 'Progressing', 'ReplicaFailure']) }];
const daemonSetColumns = ctx => [nameColumn, namespaceColumn, ...replicaColumns('DaemonSet'),
  { id: 'nodeSelector', title: 'Node selector', class: 'wrap', render: item => joinLimited(Object.entries(item.spec?.template?.spec?.nodeSelector || {}).map(([k, v]) => `${k}=${v}`), 2) || '—' },
  ...aggregateUsageColumns(ctx), imagesColumn, ageColumn];
const statefulSetColumns = ctx => [nameColumn, namespaceColumn, ...replicaColumns('StatefulSet'),
  { id: 'replicas', title: 'Replicas', class: 'num', render: item => num(item.spec?.replicas, '1'), sort: desiredOf },
  ...aggregateUsageColumns(ctx), imagesColumn, ageColumn];
const replicaSetColumns = ctx => [nameColumn, namespaceColumn,
  { id: 'desired', title: 'Desired', class: 'num', render: item => num(item.spec?.replicas, '0'), sort: item => item.spec?.replicas || 0 },
  { id: 'current', title: 'Current', class: 'num', render: item => num(item.status?.replicas, '0'), sort: item => item.status?.replicas || 0 },
  { id: 'ready', title: 'Ready', class: 'num', render: item => num(item.status?.readyReplicas, '0'), sort: item => item.status?.readyReplicas || 0 },
  controlledByColumn, ...aggregateUsageColumns(ctx), imagesColumn, ageColumn];
const replicationControllerColumns = ctx => [nameColumn, namespaceColumn,
  { id: 'replicas', title: 'Replicas', render: item => `${item.status?.readyReplicas || 0}/${item.spec?.replicas ?? 0}`, sort: item => item.spec?.replicas || 0 },
  { id: 'selector', title: 'Selector', class: 'wrap', render: item => selectorText(item.spec?.selector) || '—' },
  ...aggregateUsageColumns(ctx), ageColumn];
const jobDuration = item => { const start = new Date(item.status?.startTime).getTime(); if (!start) return NaN; const end = new Date(item.status?.completionTime).getTime() || Date.now(); return end - start; };
const jobColumns = ctx => [nameColumn, namespaceColumn,
  { id: 'completions', title: 'Completions', render: item => `${item.status?.succeeded || 0}/${item.spec?.completions ?? 1}`, sort: item => item.status?.succeeded || 0 },
  { id: 'duration', title: 'Duration', render: item => { const ms = jobDuration(item); return Number.isFinite(ms) ? formatDuration(ms) : '—'; }, sort: jobDuration },
  controlledByColumn, ...aggregateUsageColumns(ctx), ageColumn,
  { id: 'status', title: 'Status', render: item => conditionTrue(item, 'Complete') ? badge('Complete', 'good') : conditionTrue(item, 'Failed') ? badge('Failed', 'bad') : item.spec?.suspend ? badge('Suspended', 'warn') : item.status?.active ? badge('Running', 'info') : badge('Pending', 'warn'), sort: item => conditionTrue(item, 'Complete') ? 2 : conditionTrue(item, 'Failed') ? 0 : 1 }];
export function cronNext(item) {
  if (item.spec?.suspend) return null;
  const tz = item.spec?.timeZone;
  let offset = null;
  if (tz) { try { const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value || ''; const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(parts); offset = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : 0; } catch { offset = null; } }
  return nextCronRun(item.spec?.schedule, new Date(), { timeZoneOffsetMinutes: offset });
}
const cronJobColumns = () => [nameColumn, namespaceColumn,
  { id: 'schedule', title: 'Schedule', class: 'mono-cell', render: item => item.spec?.schedule || '—', sort: item => item.spec?.schedule },
  { id: 'timezone', title: 'Time zone', hidden: true, render: item => item.spec?.timeZone || 'Controller local', sort: item => item.spec?.timeZone },
  { id: 'next', title: 'Next run', render: item => { if (item.spec?.suspend) return muted('Suspended'); const next = cronNext(item); return next ? `in ${formatDuration(next.getTime() - Date.now())}` : '—'; }, sort: item => cronNext(item)?.getTime() ?? NaN, tooltip: item => cronNext(item)?.toLocaleString() || '' },
  { id: 'suspend', title: 'Suspend', render: item => item.spec?.suspend ? badge('True', 'warn') : 'False', sort: item => (item.spec?.suspend ? 1 : 0) },
  { id: 'active', title: 'Active', class: 'num', render: item => String((item.status?.active || []).length), sort: item => (item.status?.active || []).length },
  { id: 'lastSchedule', title: 'Last schedule', render: item => item.status?.lastScheduleTime ? `${age(item.status.lastScheduleTime)} ago` : '—', sort: item => -(new Date(item.status?.lastScheduleTime).getTime() || 0) },
  { id: 'lastSuccess', title: 'Last success', hidden: true, render: item => item.status?.lastSuccessfulTime ? `${age(item.status.lastSuccessfulTime)} ago` : '—', sort: item => -(new Date(item.status?.lastSuccessfulTime).getTime() || 0) },
  imagesColumn, ageColumn];

// ---- Nodes ------------------------------------------------------------------------------------
export const nodeRoles = item => { const roles = Object.keys(item.metadata?.labels || {}).filter(key => key.startsWith('node-role.kubernetes.io/')).map(key => key.slice('node-role.kubernetes.io/'.length) || 'node'); const legacy = item.metadata?.labels?.['kubernetes.io/role']; if (legacy && !roles.includes(legacy)) roles.push(legacy); return roles; };
export const isControlPlane = item => nodeRoles(item).some(role => ['control-plane', 'master'].includes(role));
export function nodeCondition(item) {
  if (!item.status?.conditions) return ['Unknown', 'warn'];
  const ready = item.status.conditions.find(c => c.type === 'Ready');
  const pressures = item.status.conditions.filter(c => c.type !== 'Ready' && c.status === 'True').map(c => c.type);
  const parts = [ready?.status === 'True' ? 'Ready' : ready?.status === 'Unknown' ? 'Unknown' : 'NotReady'];
  if (item.spec?.unschedulable) parts.push('SchedulingDisabled');
  parts.push(...pressures);
  return [parts.join(', '), ready?.status !== 'True' ? 'bad' : parts.length > 1 ? 'warn' : 'good'];
}
const allocatable = (item, key) => (key === 'cpu' ? parseCPU : parseQuantity)(item.status?.allocatable?.[key]);
const nodeAddress = (item, type) => (item.status?.addresses || []).find(a => a.type === type)?.address;
function nodeColumns(ctx) {
  const usage = item => ctx.usage?.node(item.metadata?.name);
  // A node metrics-server did not report shows why, instead of a bare dash.
  const noUsage = item => { const reason = ctx.usage?.nodeMissing?.(item.metadata?.name); return reason ? el('span', { class: 'muted no-usage', text: 'no data', title: reason }) : muted('—'); };
  const sourceNote = item => (usage(item)?.source === 'kubelet' ? ' · Read from the kubelet: metrics-server has no sample for this node' : '');
  const nodeTooltip = (kind, item) => { const s = ctx.summary(item); const u = usage(item); if (!u && ctx.usage?.nodeMissing?.(item.metadata?.name)) return ctx.usage.nodeMissing(item.metadata.name); return usageMissing(ctx) || `${usageTooltip(kind, u?.[kind] ?? NaN, { request: s?.[`${kind}Request`], limit: s?.[`${kind}Limit`], capacity: allocatable(item, kind) })}${sourceNote(item)}`; };
  return [nameColumn,
    { id: 'cpu', title: 'CPU', class: 'usage wide', sortDesc: true, render: item => { const u = usage(item); return u ? usageCell('cpu', u.cpu, { base: allocatable(item, 'cpu'), baseLabel: 'allocatable' }) : noUsage(item); }, sort: item => { const u = usage(item); return u ? u.cpu / (allocatable(item, 'cpu') || 1) : NaN; },
      tooltip: item => nodeTooltip('cpu', item) },
    { id: 'memory', title: 'Memory', class: 'usage wide', sortDesc: true, render: item => { const u = usage(item); return u ? usageCell('memory', u.memory, { base: allocatable(item, 'memory'), baseLabel: 'allocatable' }) : noUsage(item); }, sort: item => { const u = usage(item); return u ? u.memory / (allocatable(item, 'memory') || 1) : NaN; },
      tooltip: item => nodeTooltip('memory', item) },
    { id: 'pods', title: 'Pods', class: 'num', render: item => { if (!ctx.podsReady) return '—'; const running = ctx.podsFor(item).filter(p => !['Succeeded', 'Failed'].includes(p.status?.phase)).length; return `${running}/${item.status?.allocatable?.pods || '—'}`; }, sort: item => ctx.podsFor(item).length },
    { id: 'cpuRequests', title: 'CPU requests', class: 'num', hidden: true, render: item => { const s = ctx.summary(item); const total = allocatable(item, 'cpu'); return s && ctx.podsReady ? `${formatCPU(s.cpuRequest)} (${formatPercent(s.cpuRequest, total) || '—'})` : '—'; }, sort: item => (ctx.summary(item)?.cpuRequest || 0) / (allocatable(item, 'cpu') || 1) },
    { id: 'memoryRequests', title: 'Memory requests', class: 'num', hidden: true, render: item => { const s = ctx.summary(item); const total = allocatable(item, 'memory'); return s && ctx.podsReady ? `${formatBytes(s.memoryRequest)} (${formatPercent(s.memoryRequest, total) || '—'})` : '—'; }, sort: item => (ctx.summary(item)?.memoryRequest || 0) / (allocatable(item, 'memory') || 1) },
    { id: 'taints', title: 'Taints', class: 'num', render: item => String((item.spec?.taints || []).length), sort: item => (item.spec?.taints || []).length, tooltip: item => (item.spec?.taints || []).map(t => `${t.key}${t.value ? `=${t.value}` : ''}:${t.effect}`).join('\n') },
    { id: 'roles', title: 'Roles', render: item => nodeRoles(item).join(', ') || '—', sort: item => nodeRoles(item).join(',') },
    { id: 'version', title: 'Version', class: 'mono-cell', render: item => item.status?.nodeInfo?.kubeletVersion || '—', sort: item => item.status?.nodeInfo?.kubeletVersion },
    { id: 'internalIP', title: 'Internal IP', class: 'mono-cell', hidden: true, render: item => nodeAddress(item, 'InternalIP') || '—', sort: item => nodeAddress(item, 'InternalIP') },
    { id: 'os', title: 'OS / arch', hidden: true, render: item => `${item.status?.nodeInfo?.osImage || '—'} · ${item.status?.nodeInfo?.architecture || ''}` },
    { id: 'runtime', title: 'Runtime', hidden: true, render: item => item.status?.nodeInfo?.containerRuntimeVersion || '—' },
    labelsColumn, ageColumn,
    { id: 'conditions', title: 'Conditions', render: item => badge(...nodeCondition(item)), sort: item => nodeCondition(item)[0] }];
}

// ---- Namespaces -------------------------------------------------------------------------------
const namespaceColumns = ctx => [nameColumn,
  { id: 'labels', title: 'Labels', class: 'wrap', render: item => joinLimited(Object.entries(item.metadata?.labels || {}).filter(([k]) => k !== 'kubernetes.io/metadata.name').map(([k, v]) => `${k}=${v}`), 2) || '—' },
  { id: 'pods', title: 'Pods', class: 'num', render: item => (ctx.podsReady ? String(ctx.podsFor(item).length) : '—'), sort: item => ctx.podsFor(item).length },
  ...aggregateUsageColumns(ctx), ageColumn,
  { id: 'status', title: 'Status', render: item => badge(item.status?.phase || 'Active', item.status?.phase === 'Terminating' ? 'warn' : 'good'), sort: item => item.status?.phase }];

// ---- Config -----------------------------------------------------------------------------------
const configMapColumns = () => [nameColumn, namespaceColumn,
  { id: 'keys', title: 'Keys', class: 'wrap', render: item => joinLimited([...Object.keys(item.data || {}), ...Object.keys(item.binaryData || {})], 4) || '—', sort: item => Object.keys(item.data || {}).length },
  labelsColumn, ageColumn];
const secretColumns = () => [nameColumn, namespaceColumn,
  { id: 'labels', title: 'Labels', class: 'wrap', render: item => joinLimited(Object.entries(item.metadata?.labels || {}).map(([k, v]) => `${k}=${v}`), 2) || '—' },
  { id: 'keys', title: 'Keys', class: 'wrap', render: item => joinLimited(item.dataKeys || [], 4) || '—', sort: item => (item.dataKeys || []).length },
  { id: 'type', title: 'Type', render: item => item.type || 'Opaque', sort: item => item.type },
  ageColumn];
function quotaUsage(item) {
  const hard = item.status?.hard || item.spec?.hard || {}; const used = item.status?.used || {};
  return Object.keys(hard).map(key => { const h = parseQuantity(hard[key]); const u = parseQuantity(used[key] ?? 0); return { key, hard: hard[key], used: used[key] ?? '0', fraction: h > 0 ? u / h : 0 }; }).sort((a, b) => b.fraction - a.fraction);
}
export { quotaUsage };
const quotaColumns = () => [nameColumn, namespaceColumn,
  { id: 'usage', title: 'Highest usage', render: item => { const top = quotaUsage(item)[0]; return top ? el('div', { class: 'usage-cell' }, el('span', { class: 'usage-value', text: `${top.key} ${top.used}/${top.hard}` }), el('span', { class: 'usage-bar' }, el('span', { class: 'usage-fill', 'data-level': levelOf(top.fraction), style: `width:${Math.min(100, top.fraction * 100)}%` }))) : '—'; }, sort: item => quotaUsage(item)[0]?.fraction ?? NaN, tooltip: item => quotaUsage(item).map(q => `${q.key}: ${q.used} / ${q.hard}`).join('\n') },
  { id: 'resources', title: 'Resources', class: 'num', render: item => String(quotaUsage(item).length) },
  ageColumn];
const limitRangeColumns = () => [nameColumn, namespaceColumn,
  { id: 'types', title: 'Types', render: item => (item.spec?.limits || []).map(l => l.type).join(', ') || '—' }, ageColumn];
function hpaMetric(metric, current) {
  const type = metric.type;
  const spec = metric[type.charAt(0).toLowerCase() + type.slice(1)] || {};
  const name = spec.name || spec.metric?.name || spec.resource?.name || type;
  const target = spec.target || {};
  const currentSpec = current?.[type.charAt(0).toLowerCase() + type.slice(1)]?.current || {};
  const targetText = target.averageUtilization !== undefined ? `${target.averageUtilization}%` : target.averageValue || target.value || '—';
  const currentText = currentSpec.averageUtilization !== undefined ? `${currentSpec.averageUtilization}%` : currentSpec.averageValue || currentSpec.value || 'unknown';
  return { name, type, target: targetText, current: currentText };
}
const metricKey = metric => { const type = metric?.type || ''; const body = metric?.[type.charAt(0).toLowerCase() + type.slice(1)] || {}; return `${type}:${body.name || body.metric?.name || ''}`; };
export function hpaMetrics(item) {
  const specs = item.spec?.metrics || (item.spec?.targetCPUUtilizationPercentage !== undefined ? [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: item.spec.targetCPUUtilizationPercentage } } }] : []);
  const currents = item.status?.currentMetrics || (item.status?.currentCPUUtilizationPercentage !== undefined ? [{ type: 'Resource', resource: { name: 'cpu', current: { averageUtilization: item.status.currentCPUUtilizationPercentage } } }] : []);
  return specs.map((metric, index) => hpaMetric(metric, currents.find(current => metricKey(current) === metricKey(metric)) || currents[index]));
}
const hpaColumns = () => [nameColumn, namespaceColumn,
  { id: 'metrics', title: 'Metrics', class: 'wrap', render: item => joinLimited(hpaMetrics(item).map(m => `${m.name}: ${m.current} / ${m.target}`), 2) || '—' },
  { id: 'min', title: 'Min pods', class: 'num', render: item => num(item.spec?.minReplicas, '1'), sort: item => item.spec?.minReplicas ?? 1 },
  { id: 'max', title: 'Max pods', class: 'num', render: item => num(item.spec?.maxReplicas), sort: item => item.spec?.maxReplicas },
  { id: 'replicas', title: 'Replicas', class: 'num', render: item => num(item.status?.currentReplicas, '0'), sort: item => item.status?.currentReplicas || 0 },
  { id: 'target', title: 'Target', render: item => `${item.spec?.scaleTargetRef?.kind || ''}/${item.spec?.scaleTargetRef?.name || ''}` },
  ageColumn,
  { id: 'status', title: 'Status', render: item => conditionBadges(item, ['AbleToScale', 'ScalingActive', 'ScalingLimited']) }];
const vpaRecommendation = (item, key) => (item.status?.recommendation?.containerRecommendations || []).reduce((sum, c) => sum + ((key === 'cpu' ? parseCPU : parseMemory)(c.target?.[key]) || 0), 0);
const vpaColumns = () => [nameColumn, namespaceColumn,
  { id: 'mode', title: 'Mode', render: item => item.spec?.updatePolicy?.updateMode || 'Auto' },
  { id: 'target', title: 'Target', render: item => `${item.spec?.targetRef?.kind || ''}/${item.spec?.targetRef?.name || ''}` },
  { id: 'cpu', title: 'CPU target', class: 'num', render: item => { const v = vpaRecommendation(item, 'cpu'); return v ? formatCPU(v) : '—'; }, sort: item => vpaRecommendation(item, 'cpu') },
  { id: 'memory', title: 'Memory target', class: 'num', render: item => { const v = vpaRecommendation(item, 'memory'); return v ? formatBytes(v) : '—'; }, sort: item => vpaRecommendation(item, 'memory') },
  ageColumn, { id: 'status', title: 'Status', render: item => conditionBadges(item, ['RecommendationProvided', 'LowConfidence', 'NoPodsMatched', 'FetchingHistory']) }];
const pdbColumns = () => [nameColumn, namespaceColumn,
  { id: 'minAvailable', title: 'Min available', class: 'num', render: item => num(item.spec?.minAvailable, 'N/A') },
  { id: 'maxUnavailable', title: 'Max unavailable', class: 'num', render: item => num(item.spec?.maxUnavailable, 'N/A') },
  { id: 'currentHealthy', title: 'Current healthy', class: 'num', render: item => num(item.status?.currentHealthy, '0'), sort: item => item.status?.currentHealthy || 0 },
  { id: 'desiredHealthy', title: 'Desired healthy', class: 'num', render: item => num(item.status?.desiredHealthy, '0'), sort: item => item.status?.desiredHealthy || 0 },
  { id: 'allowed', title: 'Allowed disruptions', class: 'num', render: item => { const n = item.status?.disruptionsAllowed ?? 0; return n === 0 ? el('span', { class: 'warn-text', text: '0' }) : String(n); }, sort: item => item.status?.disruptionsAllowed || 0 },
  ageColumn];
const priorityClassColumns = () => [nameColumn,
  { id: 'value', title: 'Value', class: 'num', render: item => num(item.value), sort: item => item.value },
  { id: 'globalDefault', title: 'Global default', render: item => (item.globalDefault ? badge('True', 'info') : 'False'), sort: item => (item.globalDefault ? 1 : 0) },
  { id: 'preemption', title: 'Preemption', render: item => item.preemptionPolicy || 'PreemptLowerPriority' }, ageColumn];
const runtimeClassColumns = () => [nameColumn, { id: 'handler', title: 'Handler', render: item => item.handler || '—', sort: item => item.handler }, ageColumn];
const leaseColumns = () => [nameColumn, namespaceColumn,
  { id: 'holder', title: 'Holder', class: 'wrap', render: item => item.spec?.holderIdentity || '—', sort: item => item.spec?.holderIdentity },
  { id: 'renewed', title: 'Renewed', render: item => item.spec?.renewTime ? `${age(item.spec.renewTime)} ago` : '—', sort: item => -(new Date(item.spec?.renewTime).getTime() || 0) },
  ageColumn];
const webhookColumns = () => [nameColumn,
  { id: 'webhooks', title: 'Webhooks', class: 'num', render: item => String((item.webhooks || []).length), sort: item => (item.webhooks || []).length },
  { id: 'failurePolicy', title: 'Failure policies', render: item => [...new Set((item.webhooks || []).map(w => w.failurePolicy || 'Fail'))].join(', ') || '—' },
  ageColumn];
const admissionPolicyColumns = () => [nameColumn,
  { id: 'failurePolicy', title: 'Failure policy', render: item => item.spec?.failurePolicy || 'Fail' },
  { id: 'validations', title: 'Validations', class: 'num', render: item => String((item.spec?.validations || []).length) }, ageColumn];
const admissionBindingColumns = () => [nameColumn,
  { id: 'policy', title: 'Policy', render: item => item.spec?.policyName || '—', sort: item => item.spec?.policyName },
  { id: 'actions', title: 'Actions', render: item => (item.spec?.validationActions || []).join(', ') || '—' }, ageColumn];

// ---- Network ----------------------------------------------------------------------------------
export const servicePorts = item => (item.spec?.ports || []).map(p => `${p.port}${p.nodePort ? `:${p.nodePort}` : ''}${p.targetPort !== undefined && String(p.targetPort) !== String(p.port) ? `→${p.targetPort}` : ''}/${p.protocol || 'TCP'}`);
export const externalIPs = item => [...(item.status?.loadBalancer?.ingress || []).map(i => i.ip || i.hostname), ...(item.spec?.externalIPs || []), ...(item.spec?.type === 'ExternalName' ? [item.spec.externalName] : [])].filter(Boolean);
const serviceColumns = () => [nameColumn, namespaceColumn,
  { id: 'type', title: 'Type', render: item => item.spec?.type || 'ClusterIP', sort: item => item.spec?.type },
  { id: 'clusterIP', title: 'Cluster IP', class: 'mono-cell', render: item => item.spec?.clusterIP || '—', sort: item => item.spec?.clusterIP },
  { id: 'ports', title: 'Ports', class: 'wrap mono-cell', render: item => joinLimited(servicePorts(item), 3) || '—' },
  { id: 'externalIP', title: 'External IP', class: 'mono-cell', render: item => joinLimited(externalIPs(item), 2) || (item.spec?.type === 'LoadBalancer' ? el('span', { class: 'warn-text', text: 'Pending' }) : '—') },
  { id: 'selector', title: 'Selector', class: 'wrap', render: item => joinLimited(Object.entries(item.spec?.selector || {}).map(([k, v]) => `${k}=${v}`), 2) || '—' },
  ageColumn,
  { id: 'status', title: 'Status', render: item => (item.spec?.type === 'LoadBalancer' && !externalIPs(item).length ? badge('Pending', 'warn') : badge('Active', 'good')) }];
const endpointAddresses = item => (item.subsets || []).flatMap(subset => (subset.addresses || []).flatMap(address => (subset.ports || [{ port: '' }]).map(port => `${address.ip}${port.port ? `:${port.port}` : ''}`)));
const endpointsColumns = () => [nameColumn, namespaceColumn,
  { id: 'endpoints', title: 'Endpoints', class: 'wrap mono-cell', render: item => joinLimited(endpointAddresses(item), 3) || el('span', { class: 'warn-text', text: 'None ready' }), sort: item => endpointAddresses(item).length },
  { id: 'notReady', title: 'Not ready', class: 'num', render: item => String((item.subsets || []).reduce((sum, s) => sum + (s.notReadyAddresses || []).length, 0)) },
  ageColumn];
const endpointSliceColumns = () => [nameColumn, namespaceColumn,
  { id: 'addressType', title: 'Address type', render: item => item.addressType || '—' },
  { id: 'ports', title: 'Ports', class: 'mono-cell', render: item => (item.ports || []).map(p => `${p.port}/${p.protocol || 'TCP'}`).join(', ') || '—' },
  { id: 'endpoints', title: 'Endpoints', class: 'wrap mono-cell', render: item => joinLimited((item.endpoints || []).flatMap(e => e.addresses || []), 3) || '—', sort: item => (item.endpoints || []).length },
  { id: 'ready', title: 'Ready', class: 'num', render: item => `${(item.endpoints || []).filter(e => e.conditions?.ready !== false).length}/${(item.endpoints || []).length}` },
  { id: 'service', title: 'Service', render: item => item.metadata?.labels?.['kubernetes.io/service-name'] || '—' },
  ageColumn];
export const ingressRules = item => (item.spec?.rules || []).flatMap(rule => (rule.http?.paths || [{ path: '' }]).map(path => {
  const backend = path.backend?.service ? `${path.backend.service.name}:${path.backend.service.port?.number ?? path.backend.service.port?.name ?? ''}` : path.backend?.serviceName ? `${path.backend.serviceName}:${path.backend.servicePort}` : path.backend?.resource ? `${path.backend.resource.kind}/${path.backend.resource.name}` : '';
  return { host: rule.host || '*', path: path.path || '/', pathType: path.pathType || '', backend, tls: (item.spec?.tls || []).some(t => (t.hosts || []).includes(rule.host)) };
}));
const ingressColumns = () => [nameColumn, namespaceColumn,
  { id: 'class', title: 'Class', render: item => item.spec?.ingressClassName || item.metadata?.annotations?.['kubernetes.io/ingress.class'] || '—', sort: item => item.spec?.ingressClassName },
  { id: 'loadBalancers', title: 'Load balancers', class: 'mono-cell', render: item => joinLimited((item.status?.loadBalancer?.ingress || []).map(i => i.ip || i.hostname), 2) || '—' },
  { id: 'rules', title: 'Rules', class: 'wrap', render: item => joinLimited(ingressRules(item).map(r => `${r.tls ? 'https' : 'http'}://${r.host}${r.path} → ${r.backend}`), 2) || '—' },
  ageColumn];
const isDefaultClass = item => item.metadata?.annotations?.['ingressclass.kubernetes.io/is-default-class'] === 'true' || item.metadata?.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true' || item.metadata?.annotations?.['storageclass.beta.kubernetes.io/is-default-class'] === 'true';
export { isDefaultClass };
const ingressClassColumns = () => [nameColumn,
  { id: 'controller', title: 'Controller', class: 'wrap', render: item => item.spec?.controller || '—', sort: item => item.spec?.controller },
  { id: 'apiGroup', title: 'API group', render: item => item.spec?.parameters?.apiGroup || '—' },
  { id: 'scope', title: 'Scope', render: item => item.spec?.parameters?.scope || '—' },
  { id: 'kind', title: 'Kind', render: item => item.spec?.parameters?.kind || '—' },
  { id: 'default', title: 'Default', render: item => (isDefaultClass(item) ? badge('Default', 'info') : '—'), sort: item => (isDefaultClass(item) ? 0 : 1) },
  ageColumn];
const networkPolicyColumns = () => [nameColumn, namespaceColumn,
  { id: 'podSelector', title: 'Pod selector', class: 'wrap', render: item => selectorText(item.spec?.podSelector) || 'All pods' },
  { id: 'types', title: 'Policy types', render: item => (item.spec?.policyTypes || ['Ingress']).join(', ') },
  ageColumn];
const gatewayColumns = () => [nameColumn, namespaceColumn,
  { id: 'class', title: 'Class', render: item => item.spec?.gatewayClassName || '—' },
  { id: 'addresses', title: 'Addresses', class: 'mono-cell', render: item => joinLimited((item.status?.addresses || []).map(a => a.value), 2) || '—' },
  { id: 'listeners', title: 'Listeners', class: 'wrap', render: item => joinLimited((item.spec?.listeners || []).map(l => `${l.name} ${l.protocol}/${l.port}${l.hostname ? ` ${l.hostname}` : ''}`), 2) || '—' },
  ageColumn, { id: 'status', title: 'Status', render: item => conditionBadges(item, ['Programmed', 'Accepted']) }];
const gatewayClassColumns = () => [nameColumn,
  { id: 'controller', title: 'Controller', class: 'wrap', render: item => item.spec?.controllerName || '—' },
  ageColumn, { id: 'status', title: 'Status', render: item => conditionBadges(item, ['Accepted']) }];
const routeColumns = () => [nameColumn, namespaceColumn,
  { id: 'hostnames', title: 'Hostnames', class: 'wrap', render: item => joinLimited(item.spec?.hostnames || [], 2) || '*' },
  { id: 'parents', title: 'Parents', class: 'wrap', render: item => joinLimited((item.spec?.parentRefs || []).map(p => `${p.namespace ? `${p.namespace}/` : ''}${p.name}${p.sectionName ? `:${p.sectionName}` : ''}`), 2) || '—' },
  { id: 'backends', title: 'Backends', class: 'wrap', render: item => joinLimited([...new Set((item.spec?.rules || []).flatMap(r => (r.backendRefs || []).map(b => `${b.name}${b.port ? `:${b.port}` : ''}`)))], 3) || '—' },
  ageColumn];

// ---- Storage ----------------------------------------------------------------------------------
const pvcSize = item => item.status?.capacity?.storage || item.spec?.resources?.requests?.storage;
const pvcColumns = ctx => [nameColumn, namespaceColumn,
  { id: 'storageClass', title: 'Storage class', render: item => item.spec?.storageClassName || '—', sort: item => item.spec?.storageClassName },
  { id: 'size', title: 'Size', class: 'num', render: item => { const bytes = parseMemory(pvcSize(item)); return Number.isFinite(bytes) ? formatBytes(bytes) : pvcSize(item) || '—'; }, sort: item => parseMemory(pvcSize(item)), tooltip: item => pvcSize(item) || '' },
  { id: 'pods', title: 'Pods', class: 'wrap', render: item => (ctx.podsReady ? joinLimited(ctx.podsFor(item).map(p => p.metadata.name), 2) || '—' : '—'), sort: item => ctx.podsFor(item).length },
  { id: 'volume', title: 'Volume', class: 'wrap', hidden: true, render: item => item.spec?.volumeName || '—' },
  { id: 'accessModes', title: 'Access modes', hidden: true, render: item => (item.spec?.accessModes || []).join(', ') || '—' },
  ageColumn, statusColumn];
const pvColumns = () => [nameColumn,
  { id: 'storageClass', title: 'Storage class', render: item => item.spec?.storageClassName || '—', sort: item => item.spec?.storageClassName },
  { id: 'capacity', title: 'Capacity', class: 'num', render: item => { const bytes = parseMemory(item.spec?.capacity?.storage); return Number.isFinite(bytes) ? formatBytes(bytes) : '—'; }, sort: item => parseMemory(item.spec?.capacity?.storage) },
  { id: 'claim', title: 'Claim', class: 'wrap', render: item => (item.spec?.claimRef ? `${item.spec.claimRef.namespace}/${item.spec.claimRef.name}` : '—'), sort: item => item.spec?.claimRef?.name },
  { id: 'reclaim', title: 'Reclaim policy', render: item => item.spec?.persistentVolumeReclaimPolicy || 'Retain' },
  { id: 'accessModes', title: 'Access modes', hidden: true, render: item => (item.spec?.accessModes || []).join(', ') || '—' },
  ageColumn, statusColumn];
const storageClassColumns = () => [nameColumn,
  { id: 'provisioner', title: 'Provisioner', class: 'wrap', render: item => item.provisioner || '—', sort: item => item.provisioner },
  { id: 'reclaim', title: 'Reclaim policy', render: item => item.reclaimPolicy || 'Delete' },
  { id: 'binding', title: 'Binding mode', render: item => item.volumeBindingMode || 'Immediate' },
  { id: 'expansion', title: 'Expansion', render: item => (item.allowVolumeExpansion ? 'Allowed' : '—') },
  { id: 'default', title: 'Default', render: item => (isDefaultClass(item) ? badge('Default', 'info') : '—'), sort: item => (isDefaultClass(item) ? 0 : 1) },
  ageColumn];

// ---- Access control ---------------------------------------------------------------------------
const subjectsText = item => (item.subjects || []).map(s => `${s.kind === 'ServiceAccount' ? 'sa' : s.kind.toLowerCase()}:${s.namespace ? `${s.namespace}/` : ''}${s.name}`);
const serviceAccountColumns = () => [nameColumn, namespaceColumn,
  { id: 'secrets', title: 'Secrets', class: 'num', render: item => String((item.secrets || []).length) },
  { id: 'pullSecrets', title: 'Image pull secrets', render: item => (item.imagePullSecrets || []).map(s => s.name).join(', ') || '—' }, ageColumn];
const roleColumns = scoped => () => [nameColumn, ...(scoped ? [namespaceColumn] : []),
  { id: 'rules', title: 'Rules', class: 'num', render: item => String((item.rules || []).length), sort: item => (item.rules || []).length },
  ...(scoped ? [] : [{ id: 'aggregated', title: 'Aggregated', render: item => (item.aggregationRule ? badge('Yes', 'info') : '—') }]),
  ageColumn];
const bindingColumns = scoped => () => [nameColumn, ...(scoped ? [namespaceColumn] : []),
  { id: 'role', title: 'Role', render: item => `${item.roleRef?.kind || ''}/${item.roleRef?.name || ''}`, sort: item => item.roleRef?.name },
  { id: 'subjects', title: 'Bindings', class: 'wrap', render: item => joinLimited(subjectsText(item), 3) || '—', sort: item => (item.subjects || []).length },
  ageColumn];

// ---- CRDs, events, custom resources -----------------------------------------------------------
export const crdStorageVersion = item => (item.spec?.versions || []).find(v => v.storage) || (item.spec?.versions || [])[0] || { name: item.spec?.version };
const crdColumns = () => [{ id: 'resource', title: 'Resource', class: 'name', locked: true, render: item => item.spec?.names?.kind || item.metadata?.name, sort: item => item.spec?.names?.kind },
  { id: 'group', title: 'Group', render: item => item.spec?.group || '—', sort: item => item.spec?.group },
  { id: 'version', title: 'Version', render: item => crdStorageVersion(item)?.name || '—' },
  { id: 'scope', title: 'Scope', render: item => item.spec?.scope || '—', sort: item => item.spec?.scope },
  { id: 'name', title: 'Name', class: 'mono-cell', hidden: true, render: item => item.metadata?.name },
  ageColumn];
export const eventTime = event => new Date(event.lastTimestamp || event.eventTime || event.series?.lastObservedTime || event.metadata?.creationTimestamp).getTime() || 0;
const firstSeen = event => new Date(event.firstTimestamp || event.eventTime || event.metadata?.creationTimestamp).getTime() || 0;
export const involved = event => event.involvedObject || event.regarding || {};
export function eventColumns() {
  return [
    { id: 'type', title: 'Type', render: item => badge(item.type || 'Normal', item.type === 'Warning' ? 'warn' : 'good'), sort: item => item.type },
    { id: 'message', title: 'Message', class: 'wrap', locked: true, render: item => item.message || item.note || '—', sort: item => item.message || item.note },
    { id: 'reason', title: 'Reason', class: 'name', render: item => item.reason || '—', sort: item => item.reason },
    { id: 'namespace', title: 'Namespace', render: item => item.metadata?.namespace || involved(item).namespace || '—', sort: item => item.metadata?.namespace },
    { id: 'object', title: 'Involved object', class: 'wrap', render: item => el('span', {}, el('span', { class: 'kind-tag', text: involved(item).kind || '' }), ' ', involved(item).name || ''), sort: item => `${involved(item).kind}/${involved(item).name}` },
    { id: 'source', title: 'Source', hidden: true, render: item => [item.source?.component || item.reportingController || item.reportingComponent, item.source?.host].filter(Boolean).join(' ') || '—' },
    { id: 'count', title: 'Count', class: 'num', render: item => String(item.count || item.series?.count || 1), sort: item => item.count || item.series?.count || 1 },
    { id: 'age', title: 'Age', hidden: true, render: item => age(firstSeen(item) ? new Date(firstSeen(item)).toISOString() : ''), sort: item => -firstSeen(item) },
    { id: 'lastSeen', title: 'Last seen', render: item => age(eventTime(item) ? new Date(eventTime(item)).toISOString() : ''), sort: item => -eventTime(item) },
  ];
}

function printerColumns(crd) {
  if (!crd) return [];
  const version = (crd.spec?.versions || []).find(v => v.storage) || (crd.spec?.versions || []).find(v => v.served) || {};
  const columns = version.additionalPrinterColumns || crd.spec?.additionalPrinterColumns || [];
  return columns.filter(c => !/^\.metadata\.(name|namespace|creationTimestamp)$/.test(c.jsonPath || c.JSONPath || '')).map(column => {
    const path = column.jsonPath || column.JSONPath;
    const valueOf = item => jsonPath(item, path);
    const type = column.type;
    return {
      id: `printer:${column.name}`, title: column.name, hidden: (column.priority || 0) > 0, help: column.description || '',
      class: type === 'integer' || type === 'number' ? 'num' : 'wrap',
      render: item => { const values = valueOf(item); if (!values.length) return '—'; if (type === 'date') return age(values[0]); return values.map(v => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(', '); },
      sort: item => { const v = valueOf(item)[0]; if (v === undefined) return null; if (type === 'date') return -(new Date(v).getTime() || 0); if (type === 'integer' || type === 'number') return Number(v); return String(v); },
    };
  });
}
function customColumns(resource) {
  const crd = (state.crds || []).find(item => `${item.spec?.names?.plural}.${item.spec?.group}` === resource);
  const namespaced = crd ? crd.spec?.scope === 'Namespaced' : true;
  const extra = printerColumns(crd);
  const hasStatus = !extra.some(column => /status|ready|health|sync/i.test(column.title));
  return [nameColumn, ...(namespaced ? [namespaceColumn] : []), ...extra, ageColumn, ...(hasStatus ? [statusColumn] : [])];
}

// Flux toolkit objects share a Ready condition and suspend flag.
const fluxColumns = () => [nameColumn, namespaceColumn,
  { id: 'ready', title: 'Ready', render: item => { const ready = (item.status?.conditions || []).find(c => c.type === 'Ready'); return ready ? badge(ready.status === 'True' ? 'Ready' : ready.reason || 'Not ready', ready.status === 'True' ? 'good' : ready.status === 'Unknown' ? 'info' : 'bad') : badge('Unknown'); }, sort: item => (item.status?.conditions || []).find(c => c.type === 'Ready')?.status },
  { id: 'message', title: 'Status', class: 'wrap', render: item => (item.status?.conditions || []).find(c => c.type === 'Ready')?.message || '—' },
  { id: 'suspended', title: 'Suspended', render: item => (item.spec?.suspend ? badge('True', 'warn') : 'False') },
  { id: 'revision', title: 'Revision', class: 'mono-cell', hidden: true, render: item => String(item.status?.lastAppliedRevision || item.status?.artifact?.revision || '—').slice(0, 24) },
  ageColumn];

const genericColumns = () => [nameColumn, namespaceColumn, statusColumn,
  { id: 'detail', title: 'Ready / detail', render: item => { if (item.status?.containerStatuses) return `${item.status.containerStatuses.filter(c => c.ready).length}/${item.spec?.containers?.length || 0} containers`; if (item.spec?.replicas !== undefined) return `${item.status?.readyReplicas || 0}/${item.spec.replicas} replicas`; if (item.spec?.type) return item.spec.type; if (item.type) return item.type; return item.kind || '—'; } },
  ageColumn];

const BUILDERS = {
  pods: podColumns, deployments: deploymentColumns, daemonsets: daemonSetColumns, statefulsets: statefulSetColumns, replicasets: replicaSetColumns,
  replicationcontrollers: replicationControllerColumns, jobs: jobColumns, cronjobs: cronJobColumns, nodes: nodeColumns, namespaces: namespaceColumns,
  configmaps: configMapColumns, secrets: secretColumns, resourcequotas: quotaColumns, limitranges: limitRangeColumns, horizontalpodautoscalers: hpaColumns,
  'verticalpodautoscalers.autoscaling.k8s.io': vpaColumns, poddisruptionbudgets: pdbColumns, priorityclasses: priorityClassColumns, runtimeclasses: runtimeClassColumns,
  leases: leaseColumns, mutatingwebhookconfigurations: webhookColumns, validatingwebhookconfigurations: webhookColumns,
  'validatingadmissionpolicies.admissionregistration.k8s.io': admissionPolicyColumns, 'validatingadmissionpolicybindings.admissionregistration.k8s.io': admissionBindingColumns,
  'mutatingadmissionpolicies.admissionregistration.k8s.io': admissionPolicyColumns, 'mutatingadmissionpolicybindings.admissionregistration.k8s.io': admissionBindingColumns,
  services: serviceColumns, endpoints: endpointsColumns, endpointslices: endpointSliceColumns, ingresses: ingressColumns, ingressclasses: ingressClassColumns,
  networkpolicies: networkPolicyColumns, persistentvolumeclaims: pvcColumns, persistentvolumes: pvColumns, storageclasses: storageClassColumns,
  serviceaccounts: serviceAccountColumns, clusterroles: roleColumns(false), roles: roleColumns(true), clusterrolebindings: bindingColumns(false), rolebindings: bindingColumns(true),
  customresourcedefinitions: crdColumns, events: eventColumns,
  'gateways.gateway.networking.k8s.io': gatewayColumns, 'gatewayclasses.gateway.networking.k8s.io': gatewayClassColumns,
  'httproutes.gateway.networking.k8s.io': routeColumns, 'grpcroutes.gateway.networking.k8s.io': routeColumns, 'tlsroutes.gateway.networking.k8s.io': routeColumns,
};
// Argo CD columns stay in app.js (they predate this module); everything else is built here.
export function kindColumns(resource, ctx, fallback) {
  if (BUILDERS[resource]) return BUILDERS[resource](ctx);
  if (/\.(toolkit\.fluxcd\.io)$/.test(resource)) return fluxColumns();
  if (fallback) return fallback;
  if (resource.includes('.')) return customColumns(resource);
  return genericColumns();
}
export const searchTextFor = resource => (resource === 'events'
  ? item => `${item.reason} ${item.message || item.note} ${involved(item).kind} ${involved(item).name} ${item.metadata?.namespace}`.toLowerCase()
  : item => `${item.metadata?.name || ''} ${item.metadata?.namespace || ''} ${Object.entries(item.metadata?.labels || {}).map(([k, v]) => `${k}=${v}`).join(' ')} ${item.spec?.nodeName || ''} ${item.status?.podIP || ''}`.toLowerCase());
