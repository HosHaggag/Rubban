// Per-kind detail panels for the resource drawer: overview sections, metrics tab specs and
// action buttons. Data comes straight from the Kubernetes objects and the live usage engine.
import { state, hooks, el, button, badge, info, loading, get, post, table, dl, link, chips, section, age, dateText, statusOf, liveKey, task, toast, confirmAction, makeForm, modal, copyButton, targetOf } from './kit.js';
import { parseQuantity, parseCPU, parseMemory, formatCPU, formatBytes, formatPercent, podResources, selectorText, formatDuration, certificateSummary } from './format.js';
import { meter } from './charts.js';
import { containerState, nodeRoles, nodeCondition, hpaMetrics, quotaUsage, ingressRules, externalIPs, isDefaultClass, crdStorageVersion, cronNext, controllerOf, involved, kindColumns, pageContext, jsonPath } from './kinds.js';
import { rowMenu, forwardDialog, logsFor, shell, rollback, setDefaultClass, kubeconfigDialog, openExternal } from './ops.js';
import { muted, refLink, kindRef, metaSection, conditionsList, tolerationsTable, simpleTable, jsonBlock, affinitySummary, consumption, podsSection, metricsView } from './detail-common.js';
import { podQueries, namespaceQueries, nodeQueries, pvcQueries, ingressQueries, podPattern } from './promql.js';

const levelBadge = { good: 'good', warn: 'warn', bad: 'bad', done: '', pending: 'warn' };
const cpuText = value => formatCPU(parseCPU(value));
const memText = value => { const bytes = parseMemory(value); return Number.isFinite(bytes) ? formatBytes(bytes) : String(value ?? '—'); };
const quantityText = (key, value) => (value === undefined ? '—' : key === 'cpu' || key.endsWith('.cpu') ? cpuText(value) : /memory|storage|hugepages/.test(key) ? memText(value) : String(value));
const yesNo = value => (value ? 'Yes' : 'No');
const workloadKinds = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'ReplicationController', 'Job']);

// ---- Action buttons for the drawer (mirrors the row menu) -------------------------------------
export function detailActions(selected) {
  const items = rowMenu(selected.resource, selected.item).filter(item => item !== '-' && !item.heading);
  return el('div', { class: 'detail-actions' }, items.map(item => {
    const node = button([el('span', { class: 'btn-icon', text: item.icon || '' }), item.label], () => item.action(), `compact${item.danger ? ' danger' : ''}`);
    node.disabled = Boolean(item.disabled);
    return node;
  }));
}

// ---- Pods ---------------------------------------------------------------------------------------
function probeText(probe) {
  if (!probe) return '';
  const parts = [];
  if (probe.httpGet) parts.push(`http-get ${(probe.httpGet.scheme || 'HTTP').toLowerCase()}://${probe.httpGet.host || ''}:${probe.httpGet.port}${probe.httpGet.path || ''}`);
  if (probe.tcpSocket) parts.push(`tcp-socket :${probe.tcpSocket.port}`);
  if (probe.exec) parts.push(`exec [${(probe.exec.command || []).join(' ')}]`);
  if (probe.grpc) parts.push(`grpc :${probe.grpc.port}${probe.grpc.service ? ` ${probe.grpc.service}` : ''}`);
  parts.push(`delay=${probe.initialDelaySeconds || 0}s`, `timeout=${probe.timeoutSeconds || 1}s`, `period=${probe.periodSeconds || 10}s`, `#success=${probe.successThreshold || 1}`, `#failure=${probe.failureThreshold || 3}`);
  return el('span', { class: 'mono probe', text: parts.join(' ') });
}
// Short-lived, in-memory only; failures are not cached and saves invalidate the entry.
const secretCache = new Map();
const forgetSecret = (context, namespace, name) => secretCache.delete(`${context}/${namespace}/${name}`);
async function secretData(context, namespace, name) {
  const key = `${context}/${namespace}/${name}`;
  if (!secretCache.has(key)) {
    const request = get('/api/secret-data', { context, namespace, name }, { signal: AbortSignal.timeout(30000) });
    secretCache.set(key, request);
    request.then(() => setTimeout(() => { if (secretCache.get(key) === request) secretCache.delete(key); }, 30000), () => { if (secretCache.get(key) === request) secretCache.delete(key); });
  }
  return secretCache.get(key);
}
const decode = value => { try { const bytes = Uint8Array.from(atob(value || ''), c => c.charCodeAt(0)); return new TextDecoder('utf-8', { fatal: false }).decode(bytes); } catch { return ''; } };
const encode = text => { const bytes = new TextEncoder().encode(text); let binary = ''; bytes.forEach(b => { binary += String.fromCharCode(b); }); return btoa(binary); };
function revealCell(label, load) {
  const cell = el('span', { class: 'env-ref' }, el('span', { class: 'muted', text: label }), ' ');
  const reveal = button('Show', task(async event => { event.stopPropagation(); reveal.disabled = true; try { const value = await load(); cell.replaceChildren(el('span', { class: 'mono env-value', text: value }), ' ', copyButton(value)); } finally { reveal.disabled = false; } }), 'quiet compact');
  cell.append(reveal);
  return cell;
}
function envRows(selected, container) {
  const rows = [];
  for (const env of container.env || []) {
    let value;
    if (env.value !== undefined) value = el('span', { class: 'mono env-value', text: env.value });
    else if (env.valueFrom?.secretKeyRef) { const ref = env.valueFrom.secretKeyRef; value = revealCell(`secret ${ref.name} · ${ref.key}`, async () => { const data = await secretData(selected.context, selected.namespace, ref.name); if (!(ref.key in data.data)) throw new Error(`Key ${ref.key} not found in secret ${ref.name}`); return decode(data.data[ref.key]); }); }
    else if (env.valueFrom?.configMapKeyRef) { const ref = env.valueFrom.configMapKeyRef; value = revealCell(`configmap ${ref.name} · ${ref.key}`, async () => { const cm = await get('/api/resource', { context: selected.context, namespace: selected.namespace, resource: 'configmaps', name: ref.name }); return cm.data?.[ref.key] ?? '(key not found)'; }); }
    else if (env.valueFrom?.fieldRef) value = el('span', { class: 'muted', text: `fieldRef(${env.valueFrom.fieldRef.fieldPath})` });
    else if (env.valueFrom?.resourceFieldRef) value = el('span', { class: 'muted', text: `resourceFieldRef(${env.valueFrom.resourceFieldRef.resource}${env.valueFrom.resourceFieldRef.containerName ? `, ${env.valueFrom.resourceFieldRef.containerName}` : ''})` });
    else value = muted('—');
    rows.push({ name: env.name, value });
  }
  for (const from of container.envFrom || []) {
    const ref = from.configMapRef || from.secretRef;
    const kind = from.configMapRef ? 'ConfigMap' : 'Secret';
    rows.push({ name: `${from.prefix || ''}*`, value: el('span', {}, `All keys from ${kind} `, refLink(kind, ref?.name, selected.namespace), from.prefix ? muted(` (prefix ${from.prefix})`) : '') });
  }
  return rows;
}
function containerCard(selected, container, status, { init = false, ephemeral = false } = {}) {
  const pod = selected.item;
  const [level, stateText] = containerState(status);
  const running = Boolean(status?.state?.running);
  const usage = hooks.usage?.pod(pod)?.containers.get(container.name);
  const requests = container.resources?.requests || {}; const limits = container.resources?.limits || {};
  const head = el('div', { class: 'container-head' },
    el('span', { class: `square ${level}` }), el('strong', { text: container.name }),
    init ? badge('init', 'info') : null, ephemeral ? badge('ephemeral', 'info') : null,
    badge(stateText, levelBadge[level]), status?.ready ? badge('Ready', 'good') : null,
    el('span', { class: 'spacer' }),
    button('Logs', () => logsFor(selected, { container: container.name }), 'quiet compact'),
    !init ? button('Shell', () => shell(selected, container.name), 'quiet compact') : null,
    status?.lastState?.terminated ? button('Previous logs', () => logsFor(selected, { container: container.name, previous: true }), 'quiet compact') : null);
  const stateDetail = status?.state?.running ? `Running since ${dateText(status.state.running.startedAt)}` : status?.state?.waiting ? `${status.state.waiting.reason || 'Waiting'}${status.state.waiting.message ? `: ${status.state.waiting.message}` : ''}` : status?.state?.terminated ? `${status.state.terminated.reason || 'Terminated'} · exit ${status.state.terminated.exitCode}${status.state.terminated.signal ? ` · signal ${status.state.terminated.signal}` : ''} · finished ${age(status.state.terminated.finishedAt)} ago${status.state.terminated.message ? ` · ${status.state.terminated.message}` : ''}` : '';
  const last = status?.lastState?.terminated;
  const ports = (container.ports || []).map(port => el('div', { class: 'port-row' }, el('span', { class: 'mono', text: `${port.name ? `${port.name}: ` : ''}${port.containerPort}/${port.protocol || 'TCP'}${port.hostPort ? ` (host ${port.hostPort})` : ''}` }), running ? button('Forward…', () => forwardDialog(selected, { port: port.containerPort }), 'quiet compact') : null));
  const env = envRows(selected, container);
  const mounts = container.volumeMounts || [];
  const usageNode = usage || requests.cpu || limits.cpu || requests.memory || limits.memory ? el('div', { class: 'consumption compact' },
    meter({ label: 'CPU', used: usage ? usage.cpu : NaN, total: parseCPU(limits.cpu) || parseCPU(requests.cpu) || usage?.cpu, request: parseCPU(requests.cpu) || undefined, limit: parseCPU(limits.cpu) || undefined, detail: `${usage ? formatCPU(usage.cpu) : 'not reported'} · request ${requests.cpu ? cpuText(requests.cpu) : '—'} · limit ${limits.cpu ? cpuText(limits.cpu) : '—'}` }),
    meter({ label: 'Memory', used: usage ? usage.memory : NaN, total: parseMemory(limits.memory) || parseMemory(requests.memory) || usage?.memory, request: parseMemory(requests.memory) || undefined, limit: parseMemory(limits.memory) || undefined, detail: `${usage ? formatBytes(usage.memory) : 'not reported'} · request ${requests.memory ? memText(requests.memory) : '—'} · limit ${limits.memory ? memText(limits.memory) : '—'}` })) : '';
  const extraResources = Object.keys({ ...requests, ...limits }).filter(key => !['cpu', 'memory'].includes(key));
  return el('div', { class: 'container-card' }, head, usageNode, dl([
    ['Status', stateDetail],
    ['Last state', last ? `${last.reason || 'Terminated'} · exit ${last.exitCode} · ${age(last.finishedAt)} ago${last.message ? ` · ${last.message}` : ''}` : ''],
    ['Restarts', status?.restartCount ? String(status.restartCount) : ''],
    ['Image', el('span', { class: 'mono wrap-anywhere', text: container.image || '—' })],
    ['Image ID', status?.imageID ? el('span', { class: 'mono wrap-anywhere muted', text: status.imageID }) : ''],
    ['Pull policy', container.imagePullPolicy],
    ['Ports', ports.length ? ports : ''],
    ['Other resources', extraResources.length ? extraResources.map(key => `${key}: ${requests[key] ?? '—'} / ${limits[key] ?? '—'}`).join(' · ') : ''],
    ['Liveness', probeText(container.livenessProbe)], ['Readiness', probeText(container.readinessProbe)], ['Startup', probeText(container.startupProbe)],
    ['Command', container.command ? el('span', { class: 'mono wrap-anywhere', text: container.command.join(' ') }) : ''],
    ['Arguments', container.args ? el('span', { class: 'mono wrap-anywhere', text: container.args.join(' ') }) : ''],
    ['Working dir', container.workingDir],
    ['Restart policy', container.restartPolicy],
    ['Security', container.securityContext ? Object.entries(container.securityContext).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ') : ''],
  ]),
  env.length ? section(`Environment (${env.length})`, simpleTable(env, [['Name', row => el('span', { class: 'mono', text: row.name })], ['Value', row => row.value]]), { open: env.length <= 12 }) : '',
  mounts.length ? section(`Mounts (${mounts.length})`, simpleTable(mounts, [['Volume', m => m.name], ['Path', m => el('span', { class: 'mono', text: m.mountPath })], ['Sub path', m => m.subPath || m.subPathExpr || '—'], ['Mode', m => (m.readOnly ? 'read-only' : 'read-write')]]), { open: mounts.length <= 6 }) : '');
}
function volumeDetail(selected, volume) {
  const type = Object.keys(volume).find(key => key !== 'name') || 'unknown';
  const spec = volume[type] || {};
  const ns = selected.namespace;
  let detail;
  switch (type) {
    case 'configMap': detail = el('span', {}, 'ConfigMap ', refLink('ConfigMap', spec.name, ns), spec.items ? muted(` · ${spec.items.length} items`) : ''); break;
    case 'secret': detail = el('span', {}, 'Secret ', refLink('Secret', spec.secretName, ns), spec.items ? muted(` · ${spec.items.length} items`) : ''); break;
    case 'persistentVolumeClaim': detail = el('span', {}, 'Claim ', refLink('PersistentVolumeClaim', spec.claimName, ns), spec.readOnly ? muted(' · read-only') : ''); break;
    case 'emptyDir': detail = `emptyDir${spec.medium ? ` · ${spec.medium}` : ''}${spec.sizeLimit ? ` · limit ${memText(spec.sizeLimit)}` : ''}`; break;
    case 'hostPath': detail = el('span', { class: 'mono', text: `${spec.path}${spec.type ? ` (${spec.type})` : ''}` }); break;
    case 'projected': detail = el('div', {}, (spec.sources || []).map(source => { const [kind] = Object.keys(source); const s = source[kind]; if (kind === 'configMap') return el('div', {}, 'ConfigMap ', refLink('ConfigMap', s.name, ns)); if (kind === 'secret') return el('div', {}, 'Secret ', refLink('Secret', s.name, ns)); if (kind === 'serviceAccountToken') return el('div', { text: `Service account token · ${s.audience || 'default audience'} · ${s.expirationSeconds || 3600}s` }); return el('div', { text: kind }); })); break;
    case 'downwardAPI': detail = `Downward API · ${(spec.items || []).map(i => i.path).join(', ')}`; break;
    case 'csi': detail = `CSI ${spec.driver}${spec.volumeAttributes ? ` · ${Object.entries(spec.volumeAttributes).map(([k, v]) => `${k}=${v}`).join(', ')}` : ''}`; break;
    case 'nfs': detail = el('span', { class: 'mono', text: `${spec.server}:${spec.path}` }); break;
    case 'ephemeral': detail = `Ephemeral claim · ${spec.volumeClaimTemplate?.spec?.storageClassName || 'default class'} · ${spec.volumeClaimTemplate?.spec?.resources?.requests?.storage || ''}`; break;
    default: detail = el('span', { class: 'mono', text: JSON.stringify(spec).slice(0, 200) });
  }
  return { name: volume.name, type, detail };
}
function podSummary(pod) { return hooks.usage ? hooks.usage.summarize([pod]) : null; }
function podOverview(selected) {
  const pod = selected.item; const spec = pod.spec || {}; const status = pod.status || {};
  const statuses = new Map([...(status.initContainerStatuses || []), ...(status.containerStatuses || []), ...(status.ephemeralContainerStatuses || [])].map(s => [s.name, s]));
  const secrets = new Set([...(spec.imagePullSecrets || []).map(s => s.name), ...(spec.volumes || []).filter(v => v.secret).map(v => v.secret.secretName), ...(spec.containers || []).flatMap(c => [...(c.env || []).map(e => e.valueFrom?.secretKeyRef?.name), ...(c.envFrom || []).map(e => e.secretRef?.name)])].filter(Boolean));
  const usageHost = el('div', {}, consumption(podSummary(pod)));
  const volumes = (spec.volumes || []).map(v => volumeDetail(selected, v));
  return [
    section('Consumption', usageHost),
    section('Pod', dl([
      ['Status', badge(...statusOf(pod))],
      ['Controlled by', controllerOf(pod) ? kindRef({ ...controllerOf(pod), namespace: selected.namespace }) : ''],
      ['Node', spec.nodeName ? refLink('Node', spec.nodeName) : el('span', { class: 'warn-text', text: 'Not scheduled' })],
      ['Pod IP', status.podIP ? el('span', { class: 'mono', text: (status.podIPs || [{ ip: status.podIP }]).map(p => p.ip).join(', ') }) : ''],
      ['Host IP', status.hostIP ? el('span', { class: 'mono', text: status.hostIP }) : ''],
      ['Service account', spec.serviceAccountName ? refLink('ServiceAccount', spec.serviceAccountName, selected.namespace) : ''],
      ['Priority class', spec.priorityClassName ? el('span', {}, refLink('PriorityClass', spec.priorityClassName), spec.priority !== undefined ? muted(` (${spec.priority})`) : '') : spec.priority ? String(spec.priority) : ''],
      ['QoS class', status.qosClass],
      ['Restart policy', spec.restartPolicy], ['DNS policy', spec.dnsPolicy], ['Scheduler', spec.schedulerName !== 'default-scheduler' ? spec.schedulerName : ''],
      ['Runtime class', spec.runtimeClassName ? refLink('RuntimeClass', spec.runtimeClassName) : ''],
      ['Host namespaces', [spec.hostNetwork && 'network', spec.hostPID && 'PID', spec.hostIPC && 'IPC'].filter(Boolean).join(', ')],
      ['Termination grace', spec.terminationGracePeriodSeconds !== undefined ? `${spec.terminationGracePeriodSeconds}s` : ''],
      ['Started', dateText(status.startTime)],
      ['Reason', status.reason ? `${status.reason}${status.message ? `: ${status.message}` : ''}` : ''],
      ['Node selector', Object.keys(spec.nodeSelector || {}).length ? chips(spec.nodeSelector) : ''],
      ['Readiness gates', (spec.readinessGates || []).map(g => g.conditionType).join(', ')],
      ['Secrets', secrets.size ? el('div', { class: 'link-list' }, [...secrets].map(name => refLink('Secret', name, selected.namespace))) : ''],
    ])),
    section('Conditions', conditionsList(status.conditions)),
    spec.tolerations?.length ? section(`Tolerations (${spec.tolerations.length})`, tolerationsTable(spec.tolerations), { open: false }) : '',
    spec.affinity ? section('Affinity', affinitySummary(spec.affinity), { open: false }) : '',
    spec.topologySpreadConstraints?.length ? section('Topology spread', simpleTable(spec.topologySpreadConstraints, [['Topology key', t => t.topologyKey], ['Max skew', t => t.maxSkew], ['When unsatisfiable', t => t.whenUnsatisfiable], ['Selector', t => selectorText(t.labelSelector) || '—']]), { open: false }) : '',
    (spec.initContainers || []).length ? section(`Init containers (${spec.initContainers.length})`, (spec.initContainers || []).map(c => containerCard(selected, c, statuses.get(c.name), { init: true })), { open: false }) : '',
    section(`Containers (${(spec.containers || []).length})`, (spec.containers || []).map(c => containerCard(selected, c, statuses.get(c.name)))),
    (spec.ephemeralContainers || []).length ? section(`Ephemeral containers (${spec.ephemeralContainers.length})`, spec.ephemeralContainers.map(c => containerCard(selected, c, statuses.get(c.name), { ephemeral: true })), { open: false }) : '',
    volumes.length ? section(`Volumes (${volumes.length})`, simpleTable(volumes, [['Name', v => v.name], ['Type', v => v.type], ['Source', v => v.detail]])) : '',
  ];
}

// ---- Workloads ----------------------------------------------------------------------------------
const podTemplate = item => item.spec?.template?.spec || item.spec?.jobTemplate?.spec?.template?.spec || {};
function templateFacts(item) {
  const template = podTemplate(item);
  const images = [...new Set([...(template.initContainers || []), ...(template.containers || [])].map(c => c.image))];
  return [
    ['Selector', item.spec?.selector ? chips(item.spec.selector.matchLabels || (item.spec.selector.matchExpressions ? {} : item.spec.selector)) : ''],
    ['Selector expressions', item.spec?.selector?.matchExpressions?.length ? selectorText({ matchExpressions: item.spec.selector.matchExpressions }) : ''],
    ['Images', images.length ? el('div', {}, images.map(image => el('div', { class: 'mono wrap-anywhere', text: image }))) : ''],
    ['Node selector', Object.keys(template.nodeSelector || {}).length ? chips(template.nodeSelector) : ''],
    ['Service account', template.serviceAccountName ? refLink('ServiceAccount', template.serviceAccountName, item.metadata?.namespace) : ''],
    ['Priority class', template.priorityClassName ? refLink('PriorityClass', template.priorityClassName) : ''],
  ];
}
function strategyText(item) {
  const strategy = item.spec?.strategy || item.spec?.updateStrategy;
  if (!strategy) return '';
  const rolling = strategy.rollingUpdate;
  return `${strategy.type || 'RollingUpdate'}${rolling ? ` · ${[rolling.maxSurge !== undefined && `max surge ${rolling.maxSurge}`, rolling.maxUnavailable !== undefined && `max unavailable ${rolling.maxUnavailable}`, rolling.partition !== undefined && `partition ${rolling.partition}`].filter(Boolean).join(', ')}` : ''}`;
}
function replicaFacts(item) {
  const s = item.status || {};
  if (item.kind === 'DaemonSet') return [['Pods', `${s.numberReady || 0} ready · ${s.currentNumberScheduled || 0} scheduled · ${s.desiredNumberScheduled || 0} desired · ${s.updatedNumberScheduled || 0} updated · ${s.numberAvailable || 0} available${s.numberMisscheduled ? ` · ${s.numberMisscheduled} misscheduled` : ''}`]];
  if (item.kind === 'Job') return [];
  const desired = item.spec?.replicas ?? 1;
  return [['Replicas', [`${desired} desired`, s.updatedReplicas !== undefined ? `${s.updatedReplicas} updated` : '', `${s.replicas || 0} total`, `${s.readyReplicas || 0} ready`, `${s.availableReplicas || 0} available`, s.unavailableReplicas ? `${s.unavailableReplicas} unavailable` : ''].filter(Boolean).join(' · ')]];
}
function workloadSessionPredicate(item) {
  const { regex } = podPattern(item.kind, item.metadata.name);
  const pattern = new RegExp(`^${regex}$`);
  return (namespace, name) => namespace === item.metadata.namespace && pattern.test(name);
}
function revisionsSection(selected) {
  const item = selected.item;
  const holder = el('div', {}, loading('Loading revisions…'));
  (async () => {
    try {
      if (item.kind === 'Deployment') {
        const response = await get('/api/resources', { context: selected.context, namespace: selected.namespace, resource: 'replicasets' });
        const owned = (response.items || []).filter(rs => (rs.metadata?.ownerReferences || []).some(ref => ref.uid === item.metadata.uid)).map(rs => ({ rs, revision: Number(rs.metadata?.annotations?.['deployment.kubernetes.io/revision'] || 0) })).sort((a, b) => b.revision - a.revision);
        const current = Number(item.metadata?.annotations?.['deployment.kubernetes.io/revision'] || owned[0]?.revision || 0);
        holder.replaceChildren(owned.length ? simpleTable(owned, [
          ['Revision', row => el('span', {}, String(row.revision || '—'), row.revision === current ? badge('current', 'good') : '')],
          ['Replica set', row => refLink('ReplicaSet', row.rs.metadata.name, selected.namespace)],
          ['Pods', row => `${row.rs.status?.readyReplicas || 0}/${row.rs.spec?.replicas ?? 0}`],
          ['Images', row => el('span', { class: 'mono wrap-anywhere', text: (row.rs.spec?.template?.spec?.containers || []).map(c => c.image).join(', ') })],
          ['Created', row => `${age(row.rs.metadata.creationTimestamp)} ago`],
          ['', row => (row.revision && row.revision !== current ? button('Roll back', task(() => rollback(selected, row.revision)), 'quiet compact') : '')],
        ]) : muted('No ReplicaSets found for this Deployment.'));
      } else {
        const response = await get('/api/resources', { context: selected.context, namespace: selected.namespace, resource: 'controllerrevisions' });
        const owned = (response.items || []).filter(rev => (rev.metadata?.ownerReferences || []).some(ref => ref.uid === item.metadata.uid)).sort((a, b) => (b.revision || 0) - (a.revision || 0));
        const currentName = item.status?.updateRevision || item.status?.currentRevision;
        const currentRevision = owned.find(rev => rev.metadata.name === currentName)?.revision ?? owned[0]?.revision;
        holder.replaceChildren(owned.length ? simpleTable(owned, [
          ['Revision', rev => el('span', {}, String(rev.revision), rev.revision === currentRevision ? badge('current', 'good') : '')],
          ['Name', rev => el('span', { class: 'mono', text: rev.metadata.name })],
          ['Images', rev => el('span', { class: 'mono wrap-anywhere', text: (rev.data?.spec?.template?.spec?.containers || []).map(c => c.image).join(', ') || '—' })],
          ['Created', rev => `${age(rev.metadata.creationTimestamp)} ago`],
          ['', rev => (rev.revision !== currentRevision ? button('Roll back', task(() => rollback(selected, rev.revision)), 'quiet compact') : '')],
        ]) : muted('No controller revisions found.'));
      }
    } catch (error) { holder.replaceChildren(info(error.message, 'error')); }
  })();
  return section('Revisions', holder, { open: false });
}
function workloadOverview(selected) {
  const item = selected.item; const s = item.status || {};
  const usageHost = el('div', {}, loading('Measuring consumption…'));
  const kind = item.kind;
  const selector = item.spec?.selector ? selectorText(item.spec.selector) : '';
  const query = { namespace: selected.namespace, ...(selector && !item.spec?.selector?.matchExpressions?.length ? { labelSelector: selector } : {}) };
  const filter = pod => (pod.metadata?.ownerReferences || []).some(ref => ref.uid === item.metadata.uid) || (kind !== 'ReplicaSet' && kind !== 'Job' && podMatches(item, pod));
  const sections = [section('Consumption', usageHost)];
  const facts = [['Controlled by', controllerOf(item) ? kindRef({ ...controllerOf(item), namespace: selected.namespace }) : ''], ...replicaFacts(item)];
  if (kind === 'Deployment') facts.push(['Strategy', strategyText(item)], ['Min ready', item.spec?.minReadySeconds ? `${item.spec.minReadySeconds}s` : ''], ['Progress deadline', item.spec?.progressDeadlineSeconds ? `${item.spec.progressDeadlineSeconds}s` : ''], ['Revision history', item.spec?.revisionHistoryLimit !== undefined ? String(item.spec.revisionHistoryLimit) : ''], ['Revision', item.metadata?.annotations?.['deployment.kubernetes.io/revision']], ['Paused', item.spec?.paused ? badge('Paused', 'warn') : '']);
  if (kind === 'StatefulSet') facts.push(['Service', item.spec?.serviceName ? refLink('Service', item.spec.serviceName, selected.namespace) : ''], ['Pod management', item.spec?.podManagementPolicy || 'OrderedReady'], ['Update strategy', strategyText(item)], ['Current revision', s.currentRevision], ['Update revision', s.updateRevision !== s.currentRevision ? s.updateRevision : ''], ['PVC retention', item.spec?.persistentVolumeClaimRetentionPolicy ? Object.entries(item.spec.persistentVolumeClaimRetentionPolicy).map(([k, v]) => `${k}: ${v}`).join(' · ') : '']);
  if (kind === 'DaemonSet') facts.push(['Update strategy', strategyText(item)], ['Min ready', item.spec?.minReadySeconds ? `${item.spec.minReadySeconds}s` : '']);
  if (kind === 'Job') {
    const start = new Date(s.startTime).getTime(); const end = new Date(s.completionTime).getTime() || Date.now();
    facts.push(['Completions', `${s.succeeded || 0}/${item.spec?.completions ?? 1}`], ['Parallelism', String(item.spec?.parallelism ?? 1)], ['Active / failed', `${s.active || 0} active · ${s.failed || 0} failed${s.ready !== undefined ? ` · ${s.ready} ready` : ''}`],
      ['Backoff limit', String(item.spec?.backoffLimit ?? 6)], ['Completion mode', item.spec?.completionMode], ['Started', dateText(s.startTime)], ['Completed', dateText(s.completionTime)], ['Duration', start ? formatDuration(end - start) : ''],
      ['Active deadline', item.spec?.activeDeadlineSeconds ? `${item.spec.activeDeadlineSeconds}s` : ''], ['TTL after finished', item.spec?.ttlSecondsAfterFinished !== undefined ? `${item.spec.ttlSecondsAfterFinished}s` : ''], ['Suspended', item.spec?.suspend ? 'Yes' : '']);
  }
  sections.push(section(kind || 'Workload', dl([...facts, ...templateFacts(item)])));
  if (s.conditions?.length) sections.push(section('Conditions', conditionsList(s.conditions)));
  const template = podTemplate(item);
  if (template.tolerations?.length) sections.push(section(`Tolerations (${template.tolerations.length})`, tolerationsTable(template.tolerations), { open: false }));
  if (template.affinity) sections.push(section('Affinity', affinitySummary(template.affinity), { open: false }));
  if (kind === 'StatefulSet' && item.spec?.volumeClaimTemplates?.length) sections.push(section('Volume claim templates', simpleTable(item.spec.volumeClaimTemplates, [['Name', t => t.metadata?.name], ['Storage class', t => t.spec?.storageClassName || 'default'], ['Size', t => memText(t.spec?.resources?.requests?.storage)], ['Access modes', t => (t.spec?.accessModes || []).join(', ')]])));
  if (['Deployment', 'StatefulSet', 'DaemonSet'].includes(kind)) sections.push(revisionsSection(selected));
  sections.push(podsSection(selected, query, { filter, summaryInto: usageHost, onSummary: summary => consumption(summary) }));
  return sections;
}
function podMatches(item, pod) {
  const selector = item.spec?.selector;
  if (!selector) return false;
  const labels = pod.metadata?.labels || {};
  const plain = !selector.matchLabels && !selector.matchExpressions;
  const match = plain ? selector : selector.matchLabels || {};
  return Object.entries(match).every(([k, v]) => labels[k] === v) && (selector.matchExpressions || []).every(e => (e.operator === 'In' ? (e.values || []).includes(labels[e.key]) : e.operator === 'NotIn' ? !(e.values || []).includes(labels[e.key]) : e.operator === 'Exists' ? e.key in labels : !(e.key in labels)));
}
function cronJobOverview(selected) {
  const item = selected.item; const s = item.status || {};
  const next = cronNext(item);
  const jobsHolder = el('div', {}, loading('Loading jobs…'));
  (async () => {
    try {
      const response = await get('/api/resources', { context: selected.context, namespace: selected.namespace, resource: 'jobs' });
      const jobs = (response.items || []).filter(job => (job.metadata?.ownerReferences || []).some(ref => ref.uid === item.metadata.uid)).sort((a, b) => new Date(b.metadata.creationTimestamp) - new Date(a.metadata.creationTimestamp));
      const columns = kindColumns('jobs', pageContext(null)).filter(c => !['cpu', 'memory', 'cpuRequests', 'memoryRequests', 'namespace', 'controlledBy'].includes(c.id));
      jobsHolder.replaceChildren(table(jobs, columns, job => hooks.showResource(job, 'jobs'), { key: liveKey, menu: job => rowMenu('jobs', job), empty: 'No Jobs from this CronJob are present (finished Jobs are removed by its history limits).' }));
    } catch (error) { jobsHolder.replaceChildren(info(error.message, 'error')); }
  })();
  return [
    section('Schedule', dl([
      ['Schedule', el('span', { class: 'mono', text: item.spec?.schedule })],
      ['Time zone', item.spec?.timeZone || 'Controller local time'],
      ['Next run', item.spec?.suspend ? el('span', { class: 'warn-text', text: 'Suspended' }) : next ? `${next.toLocaleString()} (in ${formatDuration(next.getTime() - Date.now())})` : 'Unknown schedule format'],
      ['Suspend', yesNo(item.spec?.suspend)],
      ['Concurrency', item.spec?.concurrencyPolicy || 'Allow'],
      ['Starting deadline', item.spec?.startingDeadlineSeconds !== undefined ? `${item.spec.startingDeadlineSeconds}s` : ''],
      ['History limits', `${item.spec?.successfulJobsHistoryLimit ?? 3} successful · ${item.spec?.failedJobsHistoryLimit ?? 1} failed`],
      ['Last schedule', dateText(s.lastScheduleTime)],
      ['Last success', dateText(s.lastSuccessfulTime)],
      ['Active jobs', (s.active || []).length ? el('div', { class: 'link-list' }, s.active.map(ref => refLink('Job', ref.name, ref.namespace || selected.namespace))) : 'None'],
      ...templateFacts(item).filter(([label]) => label !== 'Selector' && label !== 'Selector expressions'),
    ])),
    section('Jobs', jobsHolder),
  ];
}

// ---- Nodes ---------------------------------------------------------------------------------------
function nodeOverview(selected) {
  const node = selected.item; const status = node.status || {}; const info_ = status.nodeInfo || {};
  const usageHost = el('div', {}, loading('Measuring consumption…'));
  const allocatable = status.allocatable || {}; const capacity = status.capacity || {};
  const rank = key => { const index = ['cpu', 'memory', 'pods', 'ephemeral-storage'].indexOf(key); return index < 0 ? 99 : index; };
  const resources = [...new Set([...Object.keys(capacity), ...Object.keys(allocatable)])].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const images = [...(status.images || [])].sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0));
  return [
    section('Consumption', usageHost),
    section('Node', dl([
      ['Conditions', badge(...nodeCondition(node))],
      ['Roles', nodeRoles(node).join(', ') || 'none'],
      ['Addresses', el('div', {}, (status.addresses || []).map(a => el('div', {}, muted(`${a.type}: `), el('span', { class: 'mono', text: a.address }))))],
      ['OS', `${info_.osImage || '—'} (${info_.operatingSystem || ''}/${info_.architecture || ''})`],
      ['Kernel', info_.kernelVersion], ['Container runtime', info_.containerRuntimeVersion], ['Kubelet', info_.kubeletVersion], ['Kube-proxy', info_.kubeProxyVersion],
      ['Pod CIDRs', (node.spec?.podCIDRs || (node.spec?.podCIDR ? [node.spec.podCIDR] : [])).join(', ')],
      ['Provider ID', node.spec?.providerID ? el('span', { class: 'mono wrap-anywhere', text: node.spec.providerID }) : ''],
      ['Scheduling', node.spec?.unschedulable ? el('span', { class: 'warn-text', text: 'Disabled (cordoned)' }) : 'Enabled'],
      ['Zone / region', [node.metadata?.labels?.['topology.kubernetes.io/zone'], node.metadata?.labels?.['topology.kubernetes.io/region']].filter(Boolean).join(' / ')],
      ['Instance type', node.metadata?.labels?.['node.kubernetes.io/instance-type']],
    ])),
    section('Capacity', simpleTable(resources, [['Resource', key => key], ['Capacity', key => quantityText(key, capacity[key])], ['Allocatable', key => quantityText(key, allocatable[key])]])),
    node.spec?.taints?.length ? section(`Taints (${node.spec.taints.length})`, simpleTable(node.spec.taints, [['Key', t => t.key], ['Value', t => t.value || '—'], ['Effect', t => t.effect], ['Added', t => (t.timeAdded ? `${age(t.timeAdded)} ago` : '—')]])) : '',
    section('Conditions', conditionsList(status.conditions), { open: false }),
    podsSection(selected, { namespace: '*', fieldSelector: `spec.nodeName=${node.metadata.name}` }, { summaryInto: usageHost, onSummary: (summary, pods) => {
      const measured = hooks.usage?.node(node.metadata.name);
      const active = pods.filter(p => !['Succeeded', 'Failed'].includes(p.status?.phase)).length;
      return consumption({ ...summary, cpu: measured?.cpu ?? NaN, memory: measured?.memory ?? NaN, measured: measured ? 1 : 0 }, { allocatableCPU: parseCPU(allocatable.cpu), allocatableMemory: parseMemory(allocatable.memory), allocatablePods: Number(allocatable.pods) || undefined, pods: active });
    } }),
    images.length ? section(`Images (${images.length})`, simpleTable(images.slice(0, 50), [['Image', image => el('span', { class: 'mono wrap-anywhere', text: (image.names || []).find(n => !n.includes('@sha256')) || (image.names || [])[0] || '—' })], ['Size', image => formatBytes(image.sizeBytes || 0)]]), { open: false }) : '',
  ];
}

// ---- Namespaces ----------------------------------------------------------------------------------
function quotaMeters(quota) {
  return el('div', { class: 'consumption' }, quotaUsage(quota).map(q => meter({ label: q.key, used: parseQuantity(q.used), total: parseQuantity(q.hard), detail: `${quantityText(q.key.replace(/^(requests|limits)\./, ''), q.used)} of ${quantityText(q.key.replace(/^(requests|limits)\./, ''), q.hard)} (${formatPercent(parseQuantity(q.used), parseQuantity(q.hard)) || '0%'})` })));
}
function namespaceOverview(selected) {
  const ns = selected.item;
  const usageHost = el('div', {}, loading('Measuring consumption…'));
  const quotas = el('div', {}, loading('Loading quotas…'));
  (async () => {
    try {
      const [quotaList, limitList] = await Promise.all([get('/api/resources', { context: selected.context, namespace: ns.metadata.name, resource: 'resourcequotas' }), get('/api/resources', { context: selected.context, namespace: ns.metadata.name, resource: 'limitranges' }).catch(() => ({ items: [] }))]);
      const nodes = [];
      for (const quota of quotaList.items || []) nodes.push(el('div', { class: 'quota-block' }, el('div', { class: 'quota-title' }, refLink('ResourceQuota', quota.metadata.name, ns.metadata.name)), quotaMeters(quota)));
      for (const limit of limitList.items || []) nodes.push(el('div', { class: 'quota-block' }, el('div', { class: 'quota-title' }, 'Limit range ', refLink('LimitRange', limit.metadata.name, ns.metadata.name)), limitRangeTable(limit)));
      quotas.replaceChildren(...(nodes.length ? nodes : [muted('No resource quotas or limit ranges in this namespace.')]));
    } catch (error) { quotas.replaceChildren(info(error.message, 'error')); }
  })();
  return [
    section('Consumption', usageHost),
    section('Namespace', dl([['Status', badge(ns.status?.phase || 'Active', ns.status?.phase === 'Terminating' ? 'warn' : 'good')]])),
    ns.status?.conditions?.length ? section('Conditions', conditionsList(ns.status.conditions)) : '',
    section('Quotas & limits', quotas),
    podsSection(selected, { namespace: ns.metadata.name }, { summaryInto: usageHost, onSummary: summary => consumption(summary) }),
  ];
}

// ---- Network -------------------------------------------------------------------------------------
function serviceOverview(selected) {
  const svc = selected.item; const spec = svc.spec || {};
  const endpoints = el('div', {}, loading('Loading endpoints…'));
  (async () => {
    try {
      const response = await get('/api/resources', { context: selected.context, namespace: selected.namespace, resource: 'endpointslices', labelSelector: `kubernetes.io/service-name=${svc.metadata.name}` });
      const rows = (response.items || []).flatMap(slice => (slice.endpoints || []).map(endpoint => ({ endpoint, slice })));
      endpoints.replaceChildren(rows.length ? simpleTable(rows, [
        ['Address', r => el('span', { class: 'mono', text: (r.endpoint.addresses || []).join(', ') })],
        ['Ports', r => (r.slice.ports || []).map(p => `${p.name ? `${p.name}:` : ''}${p.port}/${p.protocol || 'TCP'}`).join(', ')],
        ['Ready', r => (r.endpoint.conditions?.ready === false ? badge(r.endpoint.conditions?.terminating ? 'Terminating' : 'Not ready', 'warn') : badge('Ready', 'good'))],
        ['Target', r => (r.endpoint.targetRef ? kindRef({ ...r.endpoint.targetRef, namespace: r.endpoint.targetRef.namespace || selected.namespace }) : '—')],
        ['Node', r => (r.endpoint.nodeName ? refLink('Node', r.endpoint.nodeName) : '—')],
        ['Zone', r => r.endpoint.zone || '—'],
      ]) : muted(spec.selector ? 'No endpoints: no ready pods match this selector.' : 'This service has no selector; endpoints are managed manually.'));
    } catch (error) { endpoints.replaceChildren(info(error.message, 'error')); }
  })();
  const ports = spec.ports || [];
  return [
    section('Service', dl([
      ['Type', spec.type || 'ClusterIP'],
      ['Cluster IP', (spec.clusterIPs || [spec.clusterIP]).filter(Boolean).length ? el('span', { class: 'mono', text: (spec.clusterIPs || [spec.clusterIP]).join(', ') }) : ''],
      ['IP families', spec.ipFamilies ? `${spec.ipFamilies.join(', ')} · ${spec.ipFamilyPolicy || 'SingleStack'}` : ''],
      ['External IPs', externalIPs(svc).length ? el('span', { class: 'mono', text: externalIPs(svc).join(', ') }) : spec.type === 'LoadBalancer' ? el('span', { class: 'warn-text', text: 'Pending' }) : ''],
      ['External name', spec.externalName],
      ['Selector', Object.keys(spec.selector || {}).length ? chips(spec.selector) : 'None (manual endpoints)'],
      ['Session affinity', spec.sessionAffinity && spec.sessionAffinity !== 'None' ? `${spec.sessionAffinity}${spec.sessionAffinityConfig?.clientIP?.timeoutSeconds ? ` · ${spec.sessionAffinityConfig.clientIP.timeoutSeconds}s` : ''}` : 'None'],
      ['Traffic policy', [spec.externalTrafficPolicy && `external ${spec.externalTrafficPolicy}`, spec.internalTrafficPolicy && `internal ${spec.internalTrafficPolicy}`].filter(Boolean).join(' · ')],
      ['Health check port', spec.healthCheckNodePort],
      ['Load balancer class', spec.loadBalancerClass],
      ['DNS name', el('span', { class: 'mono', text: `${svc.metadata.name}.${svc.metadata.namespace}.svc` })],
    ])),
    ports.length ? section('Ports', simpleTable(ports, [
      ['Name', p => p.name || '—'], ['Port', p => `${p.port}/${p.protocol || 'TCP'}`], ['Target', p => String(p.targetPort ?? p.port)], ['Node port', p => p.nodePort || '—'], ['App protocol', p => p.appProtocol || '—'],
      ['', p => (spec.type !== 'ExternalName' && (p.protocol || 'TCP') === 'TCP' ? button('Forward…', () => forwardDialog(selected, { port: p.port }), 'quiet compact') : '')],
    ])) : '',
    section('Endpoints', endpoints),
    Object.keys(spec.selector || {}).length ? podsSection(selected, { namespace: selected.namespace, labelSelector: Object.entries(spec.selector).map(([k, v]) => `${k}=${v}`).join(',') }, { open: false, onSummary: summary => consumption(summary) }) : '',
  ];
}
function ingressOverview(selected) {
  const ing = selected.item; const spec = ing.spec || {};
  const rules = ingressRules(ing);
  const backendLink = backend => { if (!backend) return muted('—'); if (backend.service) return el('span', {}, refLink('Service', backend.service.name, selected.namespace), `:${backend.service.port?.number ?? backend.service.port?.name ?? ''}`); if (backend.serviceName) return el('span', {}, refLink('Service', backend.serviceName, selected.namespace), `:${backend.servicePort}`); if (backend.resource) return kindRef({ ...backend.resource, namespace: selected.namespace }); return muted('—'); };
  const lbs = (ing.status?.loadBalancer?.ingress || []).map(i => i.ip || i.hostname);
  return [
    section('Ingress', dl([
      ['Class', spec.ingressClassName ? refLink('IngressClass', spec.ingressClassName) : ing.metadata?.annotations?.['kubernetes.io/ingress.class'] || 'Cluster default'],
      ['Load balancers', lbs.length ? el('span', { class: 'mono', text: lbs.join(', ') }) : el('span', { class: 'warn-text', text: 'Not assigned yet' })],
      ['Default backend', spec.defaultBackend ? backendLink(spec.defaultBackend) : ''],
    ])),
    section('Rules', rules.length ? simpleTable((spec.rules || []).flatMap(rule => (rule.http?.paths || [{}]).map(path => ({ rule, path }))), [
      ['Host', r => r.rule.host || '*'],
      ['Path', r => el('span', { class: 'mono', text: `${r.path.path || '/'}${r.path.pathType ? ` (${r.path.pathType})` : ''}` })],
      ['Backend', r => backendLink(r.path.backend)],
      ['Link', r => { const tls = (spec.tls || []).some(t => (t.hosts || []).includes(r.rule.host)); const host = r.rule.host || lbs[0]; if (!host || host.includes('*')) return '—'; const url = `${tls ? 'https' : 'http'}://${host}${r.path.path || '/'}`; return link(url, () => openExternal(url)); }],
    ]) : muted('No rules; all traffic goes to the default backend.')),
    (spec.tls || []).length ? section('TLS', simpleTable(spec.tls, [['Hosts', t => (t.hosts || []).join(', ') || '(all)'], ['Secret', t => (t.secretName ? refLink('Secret', t.secretName, selected.namespace) : '—')]])) : '',
  ];
}
function peerText(peer, namespace) {
  if (peer.ipBlock) return `IP block ${peer.ipBlock.cidr}${peer.ipBlock.except?.length ? ` except ${peer.ipBlock.except.join(', ')}` : ''}`;
  const parts = [];
  if (peer.namespaceSelector) parts.push(`namespaces ${selectorText(peer.namespaceSelector) || '(all)'}`);
  if (peer.podSelector) parts.push(`pods ${selectorText(peer.podSelector) || '(all)'}${peer.namespaceSelector ? '' : ` in ${namespace}`}`);
  return parts.join(' · ') || 'anywhere';
}
function networkPolicyOverview(selected) {
  const np = selected.item; const spec = np.spec || {};
  const portText = ports => (ports || []).map(p => `${p.port ?? 'all'}${p.endPort ? `-${p.endPort}` : ''}/${p.protocol || 'TCP'}`).join(', ') || 'all ports';
  const rulesTable = (rules, key) => (rules?.length ? simpleTable(rules, [[key === 'from' ? 'From' : 'To', rule => el('div', {}, (rule[key] || [{}]).map(peer => el('div', { text: Object.keys(peer).length ? peerText(peer, selected.namespace) : 'anywhere' })))], ['Ports', rule => portText(rule.ports)]]) : muted(key === 'from' ? 'No ingress rules: all inbound traffic is denied for the selected pods.' : 'No egress rules: all outbound traffic is denied for the selected pods.'));
  const types = spec.policyTypes || ['Ingress', ...(spec.egress ? ['Egress'] : [])];
  return [
    section('Policy', dl([['Pod selector', selectorText(spec.podSelector) || 'All pods in the namespace'], ['Policy types', types.join(', ')]])),
    types.includes('Ingress') ? section('Ingress rules', rulesTable(spec.ingress, 'from')) : '',
    types.includes('Egress') ? section('Egress rules', rulesTable(spec.egress, 'to')) : '',
  ];
}
function endpointsOverview(selected) {
  const subsets = selected.item.subsets || [];
  const rows = subsets.flatMap(subset => [...(subset.addresses || []).map(a => ({ a, ready: true, subset })), ...(subset.notReadyAddresses || []).map(a => ({ a, ready: false, subset }))]);
  return [section('Addresses', rows.length ? simpleTable(rows, [
    ['IP', r => el('span', { class: 'mono', text: r.a.ip })], ['Hostname', r => r.a.hostname || '—'], ['Ready', r => badge(r.ready ? 'Ready' : 'Not ready', r.ready ? 'good' : 'warn')],
    ['Ports', r => (r.subset.ports || []).map(p => `${p.name ? `${p.name}:` : ''}${p.port}/${p.protocol || 'TCP'}`).join(', ')],
    ['Target', r => (r.a.targetRef ? kindRef({ ...r.a.targetRef, namespace: r.a.targetRef.namespace || selected.namespace }) : '—')], ['Node', r => (r.a.nodeName ? refLink('Node', r.a.nodeName) : '—')],
  ]) : muted('No addresses.'))];
}
function endpointSliceOverview(selected) {
  const slice = selected.item;
  return [
    section('Endpoint slice', dl([['Address type', slice.addressType], ['Service', slice.metadata?.labels?.['kubernetes.io/service-name'] ? refLink('Service', slice.metadata.labels['kubernetes.io/service-name'], selected.namespace) : ''], ['Managed by', slice.metadata?.labels?.['endpointslice.kubernetes.io/managed-by']], ['Ports', (slice.ports || []).map(p => `${p.name ? `${p.name}:` : ''}${p.port}/${p.protocol || 'TCP'}${p.appProtocol ? ` (${p.appProtocol})` : ''}`).join(', ')]])),
    section('Endpoints', (slice.endpoints || []).length ? simpleTable(slice.endpoints, [
      ['Addresses', e => el('span', { class: 'mono', text: (e.addresses || []).join(', ') })],
      ['Conditions', e => el('span', { class: 'condition-list' }, ['ready', 'serving', 'terminating'].filter(c => e.conditions?.[c] !== undefined).map(c => badge(`${c}: ${e.conditions[c]}`, (c === 'terminating' ? !e.conditions[c] : e.conditions[c]) ? 'good' : 'warn')))],
      ['Target', e => (e.targetRef ? kindRef({ ...e.targetRef, namespace: e.targetRef.namespace || selected.namespace }) : '—')], ['Node', e => (e.nodeName ? refLink('Node', e.nodeName) : '—')], ['Zone', e => e.zone || '—'],
    ]) : muted('No endpoints.')),
  ];
}
function classOverview(selected) {
  const item = selected.item; const ingress = selected.resource === 'ingressclasses';
  const isDefault = isDefaultClass(item);
  const facts = ingress
    ? [['Controller', item.spec?.controller], ['Parameters', item.spec?.parameters ? `${item.spec.parameters.kind} ${item.spec.parameters.name}${item.spec.parameters.namespace ? ` (${item.spec.parameters.namespace})` : ''} · ${item.spec.parameters.apiGroup || 'core'} · ${item.spec.parameters.scope || 'Cluster'}` : '']]
    : [['Provisioner', item.provisioner], ['Reclaim policy', item.reclaimPolicy || 'Delete'], ['Binding mode', item.volumeBindingMode || 'Immediate'], ['Volume expansion', yesNo(item.allowVolumeExpansion)], ['Mount options', (item.mountOptions || []).join(', ')], ['Parameters', Object.keys(item.parameters || {}).length ? chips(item.parameters) : ''], ['Allowed topologies', item.allowedTopologies ? jsonBlock(item.allowedTopologies, { title: 'Topologies' }) : '']];
  const sections = [section(ingress ? 'Ingress class' : 'Storage class', dl([['Default', isDefault ? badge('Cluster default', 'info') : el('span', {}, 'No ', button('Set as default', task(() => setDefaultClass(selected)), 'quiet compact'))], ...facts]))];
  if (!ingress) {
    const pvs = el('div', {}, loading('Loading volumes…'));
    get('/api/resources', { context: selected.context, namespace: '*', resource: 'persistentvolumes' }).then(response => {
      const list = (response.items || []).filter(pv => pv.spec?.storageClassName === item.metadata.name);
      pvs.replaceChildren(list.length ? simpleTable(list, [['Volume', pv => refLink('PersistentVolume', pv.metadata.name)], ['Capacity', pv => memText(pv.spec?.capacity?.storage)], ['Claim', pv => (pv.spec?.claimRef ? refLink('PersistentVolumeClaim', pv.spec.claimRef.name, pv.spec.claimRef.namespace) : '—')], ['Status', pv => badge(...statusOf(pv))]]) : muted('No persistent volumes use this class.'));
    }).catch(error => pvs.replaceChildren(info(error.message, 'error')));
    sections.push(section('Persistent volumes', pvs));
  }
  return sections;
}

// ---- Config --------------------------------------------------------------------------------------
function configMapOverview(selected) {
  const cm = selected.item;
  const editors = new Map();
  const rows = el('div', { class: 'data-editor' });
  const removed = new Set();
  const addRow = (key, value, isNew = false) => {
    const keyNode = isNew ? el('input', { class: 'data-key-input', value: key, placeholder: 'key', 'aria-label': 'Key' }) : el('span', { class: 'data-key mono', text: key });
    const area = el('textarea', { class: 'editor data-value', rows: Math.min(14, Math.max(2, String(value).split('\n').length + 1)), spellcheck: 'false', value: String(value) });
    const row = el('div', { class: 'data-row' }, el('div', { class: 'data-row-head' }, keyNode, el('span', { class: 'muted', text: isNew ? 'new' : formatBytes(new TextEncoder().encode(String(value)).length) }), el('span', { class: 'spacer' }), copyButton(() => area.value), button('Remove', () => { if (!isNew) removed.add(key); editors.delete(row); row.remove(); }, 'quiet compact')), area);
    editors.set(row, { key: () => (isNew ? keyNode.value.trim() : key), area, original: isNew ? null : String(value) });
    rows.append(row);
  };
  for (const [key, value] of Object.entries(cm.data || {})) addRow(key, value);
  const save = button('Save changes', task(async () => {
    const data = {};
    for (const { key, area, original } of editors.values()) { const k = key(); if (!k) continue; if (!/^[-._a-zA-Z0-9]+$/.test(k)) throw new Error(`Invalid key “${k}”: use letters, digits, '-', '_' or '.'`); if (area.value !== original) data[k] = area.value; }
    for (const key of removed) data[key] = null;
    if (!Object.keys(data).length) { toast('No changes to save.'); return; }
    if (!await confirmAction(`Update ${Object.keys(data).length} key(s) in ConfigMap ${cm.metadata.name}. Pods read new values only after a restart unless they watch the mounted files.`, cm.metadata.name)) return;
    const result = await post('/api/patch', { ...targetOf(selected), type: 'merge', patch: { data } });
    toast(result.output || 'ConfigMap updated.'); hooks.afterMutation?.();
  }), 'primary compact');
  const binary = Object.entries(cm.binaryData || {});
  return [
    section(`Data (${Object.keys(cm.data || {}).length})`, el('div', {}, rows, el('div', { class: 'form-actions' }, button('Add key', () => addRow('', '', true), 'compact'), save))),
    binary.length ? section(`Binary data (${binary.length})`, simpleTable(binary, [['Key', ([k]) => k], ['Size', ([, v]) => formatBytes(Math.floor((v.length * 3) / 4))]])) : '',
    cm.immutable ? info('This ConfigMap is immutable; its data cannot be changed.', 'warn') : '',
  ];
}
function certificateRows(pem) {
  const blocks = String(pem).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
  return blocks.map(certificateSummary).filter(Boolean);
}
function secretOverview(selected) {
  const secret = selected.item;
  const keys = secret.dataKeys || [];
  const body = el('div', { class: 'data-editor' });
  const certHost = el('div');
  let data = null;
  const renderMasked = () => body.replaceChildren(...(keys.length ? keys.map(key => el('div', { class: 'data-row' }, el('div', { class: 'data-row-head' }, el('span', { class: 'data-key mono', text: key }), el('span', { class: 'masked', text: '••••••••' })))) : [muted('This secret has no data keys.')]));
  renderMasked();
  const renderRevealed = () => {
    const editors = new Map();
    body.replaceChildren(...Object.entries(data.data).map(([key, value]) => {
      const text = decode(value);
      const binary = /[\u0000-\u0008\u000E-\u001F]/.test(text);
      const area = el('textarea', { class: 'editor data-value', rows: Math.min(14, Math.max(2, text.split('\n').length + 1)), spellcheck: 'false', value: binary ? value : text, readonly: binary ? 'readonly' : undefined });
      if (!binary) editors.set(key, { area, original: text });
      return el('div', { class: 'data-row' }, el('div', { class: 'data-row-head' }, el('span', { class: 'data-key mono', text: key }), el('span', { class: 'muted', text: binary ? 'binary (base64 shown)' : formatBytes(atob(value || '').length) }), el('span', { class: 'spacer' }), copyButton(() => area.value)), area);
    }), el('div', { class: 'form-actions' }, button('Hide values', () => { data = null; renderMasked(); certHost.replaceChildren(); revealButton.hidden = false; }, 'compact'), button('Save changes', task(async () => {
      const patch = {};
      for (const [key, { area, original }] of editors) if (area.value !== original) patch[key] = encode(area.value);
      if (!Object.keys(patch).length) { toast('No changes to save.'); return; }
      if (!await confirmAction(`Update ${Object.keys(patch).length} value(s) in Secret ${secret.metadata.name}.`, secret.metadata.name)) return;
      const result = await post('/api/patch', { ...targetOf(selected), type: 'merge', patch: { data: patch } });
      forgetSecret(selected.context, selected.namespace, secret.metadata.name);
      toast(result.output || 'Secret updated.'); hooks.afterMutation?.();
    }), 'primary compact')));
    const certs = ['tls.crt', 'ca.crt'].flatMap(key => (data.data[key] ? certificateRows(decode(data.data[key])).map(cert => ({ key, ...cert })) : []));
    certHost.replaceChildren(certs.length ? section('Certificates', simpleTable(certs, [['Key', c => c.key], ['Subject', c => c.subject || '—'], ['Issuer', c => c.issuer || '—'], ['Valid from', c => c.notBefore?.toLocaleDateString()], ['Expires', c => { const days = Math.floor((c.notAfter - Date.now()) / 86400000); return el('span', { class: days < 0 ? 'bad-text' : days < 30 ? 'warn-text' : '' }, `${c.notAfter?.toLocaleDateString()} (${days < 0 ? `expired ${-days}d ago` : `in ${days}d`})`); }]])) : '');
    if (data.data['.dockerconfigjson']) { try { const auths = JSON.parse(decode(data.data['.dockerconfigjson'])).auths || {}; certHost.append(section('Registries', simpleTable(Object.entries(auths), [['Registry', ([host]) => host], ['User', ([, auth]) => auth.username || (auth.auth ? decode(auth.auth).split(':')[0] : '—')]]))); } catch { /* Not JSON. */ } }
  };
  const revealButton = button('Reveal values', task(async () => { data = await secretData(selected.context, selected.namespace, secret.metadata.name); revealButton.hidden = true; renderRevealed(); }), 'compact');
  return [
    section('Secret', dl([['Type', secret.type || 'Opaque'], ['Service account', secret.metadata?.annotations?.['kubernetes.io/service-account.name'] ? refLink('ServiceAccount', secret.metadata.annotations['kubernetes.io/service-account.name'], selected.namespace) : ''], ['Immutable', secret.immutable ? 'Yes' : '']])),
    section(`Data (${keys.length})`, el('div', {}, info('Values stay hidden until you reveal them. They are fetched for this view only and never cached on disk.'), body, el('div', { class: 'form-actions' }, revealButton))),
    certHost,
  ];
}
function limitRangeTable(limit) {
  const rows = (limit.spec?.limits || []).flatMap(l => [...new Set([...Object.keys(l.min || {}), ...Object.keys(l.max || {}), ...Object.keys(l.default || {}), ...Object.keys(l.defaultRequest || {}), ...Object.keys(l.maxLimitRequestRatio || {})])].map(resource => ({ l, resource })));
  return rows.length ? simpleTable(rows, [['Type', r => r.l.type], ['Resource', r => r.resource], ['Min', r => quantityText(r.resource, r.l.min?.[r.resource])], ['Max', r => quantityText(r.resource, r.l.max?.[r.resource])], ['Default request', r => quantityText(r.resource, r.l.defaultRequest?.[r.resource])], ['Default limit', r => quantityText(r.resource, r.l.default?.[r.resource])], ['Max ratio', r => r.l.maxLimitRequestRatio?.[r.resource] ?? '—']]) : muted('No limits.');
}
function quotaOverview(selected) {
  const quota = selected.item;
  return [section('Usage', quotaMeters(quota)), section('Quota', dl([['Scopes', (quota.spec?.scopes || []).join(', ')], ['Scope selector', quota.spec?.scopeSelector ? (quota.spec.scopeSelector.matchExpressions || []).map(e => `${e.scopeName} ${e.operator} ${(e.values || []).join(',')}`).join(' · ') : '']]))];
}
function hpaOverview(selected) {
  const hpa = selected.item; const s = hpa.status || {}; const target = hpa.spec?.scaleTargetRef;
  return [
    section('Autoscaler', dl([
      ['Target', target ? kindRef({ ...target, namespace: selected.namespace }) : ''],
      ['Replicas', `${s.currentReplicas ?? 0} current · ${s.desiredReplicas ?? 0} desired · min ${hpa.spec?.minReplicas ?? 1} · max ${hpa.spec?.maxReplicas}`],
      ['Last scaled', dateText(s.lastScaleTime)],
    ])),
    section('Metrics', simpleTable(hpaMetrics(hpa), [['Metric', m => m.name], ['Type', m => m.type], ['Current', m => m.current], ['Target', m => m.target]])),
    section('Conditions', conditionsList(s.conditions)),
    hpa.spec?.behavior ? section('Behavior', jsonBlock(hpa.spec.behavior, { open: true, title: 'Scale up / down policies' }), { open: false }) : '',
  ];
}
function vpaOverview(selected) {
  const vpa = selected.item; const target = vpa.spec?.targetRef;
  const recs = vpa.status?.recommendation?.containerRecommendations || [];
  const pair = rec => `${cpuText(rec?.cpu)} / ${memText(rec?.memory)}`.replace(/undefined/g, '—');
  return [
    section('Autoscaler', dl([['Target', target ? kindRef({ ...target, namespace: selected.namespace }) : ''], ['Update mode', vpa.spec?.updatePolicy?.updateMode || 'Auto'], ['Min replicas', vpa.spec?.updatePolicy?.minReplicas], ['Resource policy', vpa.spec?.resourcePolicy ? jsonBlock(vpa.spec.resourcePolicy, { title: 'Container policies' }) : '']])),
    section('Recommendations (CPU / memory)', recs.length ? simpleTable(recs, [['Container', r => r.containerName], ['Target', r => pair(r.target)], ['Lower bound', r => pair(r.lowerBound)], ['Upper bound', r => pair(r.upperBound)], ['Uncapped', r => pair(r.uncappedTarget)]]) : muted('No recommendation yet.')),
    section('Conditions', conditionsList(vpa.status?.conditions)),
  ];
}
function pdbOverview(selected) {
  const pdb = selected.item; const s = pdb.status || {};
  return [
    section('Budget', dl([
      ['Selector', selectorText(pdb.spec?.selector) || 'All pods'], ['Min available', pdb.spec?.minAvailable], ['Max unavailable', pdb.spec?.maxUnavailable],
      ['Healthy', `${s.currentHealthy ?? 0} current · ${s.desiredHealthy ?? 0} desired · ${s.expectedPods ?? 0} expected`],
      ['Disruptions allowed', String(s.disruptionsAllowed ?? 0)], ['Unhealthy pod eviction', pdb.spec?.unhealthyPodEvictionPolicy || 'IfHealthyBudget'],
    ])),
    section('Conditions', conditionsList(s.conditions)),
    pdb.spec?.selector ? podsSection(selected, { namespace: selected.namespace, ...(pdb.spec.selector.matchExpressions?.length ? {} : { labelSelector: selectorText(pdb.spec.selector) }) }, { filter: pod => podMatches({ spec: { selector: pdb.spec.selector } }, pod), open: false }) : '',
  ];
}
function webhookOverview(selected) {
  const item = selected.item;
  return (item.webhooks || []).map(hook => {
    const client = hook.clientConfig || {};
    const ca = client.caBundle ? certificateRows(decode(client.caBundle))[0] : null;
    return section(hook.name, el('div', {}, dl([
      ['Client', client.service ? el('span', {}, refLink('Service', client.service.name, client.service.namespace), ` (${client.service.namespace}):${client.service.port || 443}${client.service.path || ''}`) : client.url ? el('span', { class: 'mono wrap-anywhere', text: client.url }) : ''],
      ['CA bundle', ca ? `${ca.subject} · expires ${ca.notAfter?.toLocaleDateString()}` : client.caBundle ? 'Present' : 'None'],
      ['Failure policy', hook.failurePolicy || 'Fail'], ['Match policy', hook.matchPolicy || 'Equivalent'], ['Side effects', hook.sideEffects], ['Timeout', hook.timeoutSeconds ? `${hook.timeoutSeconds}s` : '10s'],
      ['Review versions', (hook.admissionReviewVersions || []).join(', ')], ['Reinvocation', hook.reinvocationPolicy],
      ['Namespace selector', hook.namespaceSelector ? selectorText(hook.namespaceSelector) || 'All' : ''], ['Object selector', hook.objectSelector ? selectorText(hook.objectSelector) || 'All' : ''],
      ['Match conditions', (hook.matchConditions || []).map(c => `${c.name}: ${c.expression}`).join('\n')],
    ]), simpleTable(hook.rules || [], [['Operations', r => (r.operations || []).join(', ')], ['API groups', r => (r.apiGroups || []).map(g => g || 'core').join(', ')], ['Versions', r => (r.apiVersions || []).join(', ')], ['Resources', r => (r.resources || []).join(', ')], ['Scope', r => r.scope || '*']])));
  });
}
function admissionPolicyOverview(selected) {
  const item = selected.item; const spec = item.spec || {};
  if (selected.resource.includes('bindings')) return [section('Binding', dl([['Policy', spec.policyName ? refLink(item.kind.replace('Binding', ''), spec.policyName, '', item.apiVersion) : ''], ['Actions', (spec.validationActions || []).join(', ')], ['Params', spec.paramRef ? JSON.stringify(spec.paramRef) : ''], ['Match resources', spec.matchResources ? jsonBlock(spec.matchResources, { title: 'Match resources' }) : '']]))];
  return [
    section('Policy', dl([['Failure policy', spec.failurePolicy || 'Fail'], ['Param kind', spec.paramKind ? `${spec.paramKind.apiVersion} ${spec.paramKind.kind}` : ''], ['Match constraints', spec.matchConstraints ? jsonBlock(spec.matchConstraints, { title: 'Constraints' }) : '']])),
    (spec.validations || []).length ? section('Validations', simpleTable(spec.validations, [['Expression', v => el('span', { class: 'mono wrap-anywhere', text: v.expression })], ['Message', v => v.message || v.messageExpression || '—'], ['Reason', v => v.reason || '—']])) : '',
    (spec.mutations || []).length ? section('Mutations', jsonBlock(spec.mutations, { open: true, title: 'Mutations' })) : '',
    (spec.variables || []).length ? section('Variables', simpleTable(spec.variables, [['Name', v => v.name], ['Expression', v => el('span', { class: 'mono wrap-anywhere', text: v.expression })]])) : '',
    section('Status', dl([['Type checking', item.status?.typeChecking ? jsonBlock(item.status.typeChecking, { title: 'Warnings' }) : 'No warnings']]), { open: false }),
  ];
}

// ---- Storage -------------------------------------------------------------------------------------
function pvcOverview(selected) {
  const pvc = selected.item; const spec = pvc.spec || {};
  return [
    section('Claim', dl([
      ['Status', badge(...statusOf(pvc))],
      ['Storage class', spec.storageClassName ? refLink('StorageClass', spec.storageClassName) : 'Default / none'],
      ['Requested', memText(spec.resources?.requests?.storage)], ['Capacity', pvc.status?.capacity?.storage ? memText(pvc.status.capacity.storage) : ''],
      ['Access modes', (spec.accessModes || []).join(', ')], ['Volume mode', spec.volumeMode || 'Filesystem'],
      ['Volume', spec.volumeName ? refLink('PersistentVolume', spec.volumeName) : el('span', { class: 'warn-text', text: 'Not bound yet' })],
      ['Selector', spec.selector ? selectorText(spec.selector) : ''], ['Data source', spec.dataSource ? `${spec.dataSource.kind} ${spec.dataSource.name}` : ''],
      ['Resize status', pvc.status?.allocatedResourceStatuses ? JSON.stringify(pvc.status.allocatedResourceStatuses) : ''],
    ])),
    pvc.status?.conditions?.length ? section('Conditions', conditionsList(pvc.status.conditions)) : '',
    podsSection(selected, { namespace: selected.namespace }, { title: 'Used by pods', filter: pod => (pod.spec?.volumes || []).some(v => v.persistentVolumeClaim?.claimName === pvc.metadata.name) }),
  ];
}
function pvOverview(selected) {
  const pv = selected.item; const spec = pv.spec || {};
  const sourceKey = Object.keys(spec).find(key => ['csi', 'nfs', 'hostPath', 'local', 'awsElasticBlockStore', 'gcePersistentDisk', 'azureDisk', 'azureFile', 'iscsi', 'rbd', 'cephfs', 'fc', 'cinder', 'vsphereVolume', 'portworxVolume', 'flexVolume'].includes(key));
  const source = spec[sourceKey] || {};
  return [
    section('Volume', dl([
      ['Status', el('span', {}, badge(...statusOf(pv)), pv.status?.reason ? muted(` ${pv.status.reason}${pv.status.message ? `: ${pv.status.message}` : ''}`) : '')],
      ['Capacity', memText(spec.capacity?.storage)], ['Access modes', (spec.accessModes || []).join(', ')], ['Reclaim policy', spec.persistentVolumeReclaimPolicy || 'Retain'],
      ['Storage class', spec.storageClassName ? refLink('StorageClass', spec.storageClassName) : ''], ['Volume mode', spec.volumeMode || 'Filesystem'], ['Mount options', (spec.mountOptions || []).join(', ')],
      ['Claim', spec.claimRef ? el('span', {}, refLink('PersistentVolumeClaim', spec.claimRef.name, spec.claimRef.namespace), muted(` in ${spec.claimRef.namespace}`)) : 'Unclaimed'],
      ['Source', sourceKey ? `${sourceKey}${source.driver ? ` · ${source.driver}` : ''}${source.server ? ` · ${source.server}:${source.path}` : source.path ? ` · ${source.path}` : ''}` : ''],
      ['Volume handle', source.volumeHandle ? el('span', { class: 'mono wrap-anywhere', text: source.volumeHandle }) : ''], ['File system', source.fsType],
      ['Attributes', source.volumeAttributes ? chips(source.volumeAttributes) : ''],
      ['Node affinity', spec.nodeAffinity ? affinitySummary({ nodeAffinity: spec.nodeAffinity.required ? { requiredDuringSchedulingIgnoredDuringExecution: spec.nodeAffinity.required } : spec.nodeAffinity }) : ''],
    ])),
  ];
}

// ---- Access control ------------------------------------------------------------------------------
function rulesTable(rules = []) {
  if (!rules.length) return muted('No rules.');
  return simpleTable(rules, [
    ['Resources', r => el('span', { class: 'wrap-anywhere', text: [...(r.resources || []), ...(r.nonResourceURLs || [])].join(', ') || '—' })],
    ['Resource names', r => (r.resourceNames || []).join(', ') || '—'],
    ['API groups', r => (r.apiGroups || []).map(g => g || 'core').join(', ') || '—'],
    ['Verbs', r => el('span', { class: 'verbs' }, (r.verbs || []).map(v => el('span', { class: `verb ${v === '*' || ['delete', 'deletecollection', 'escalate', 'bind', 'impersonate'].includes(v) ? 'danger' : ['create', 'update', 'patch'].includes(v) ? 'write' : ''}`, text: v })))],
  ]);
}
function roleOverview(selected) {
  const role = selected.item;
  return [section(`Rules (${(role.rules || []).length})`, rulesTable(role.rules)), role.aggregationRule ? section('Aggregation', el('div', {}, (role.aggregationRule.clusterRoleSelectors || []).map(s => el('div', { text: selectorText(s) || 'all' })))) : ''];
}
function bindingOverview(selected) {
  const binding = selected.item; const subjects = binding.subjects || [];
  const checks = new Map();
  const patchSubjects = async (next, message) => {
    if (!await confirmAction(message, binding.metadata.name)) return;
    const result = await post('/api/patch', { ...targetOf(selected), type: 'merge', patch: { subjects: next } });
    toast(result.output || 'Bindings updated.'); hooks.afterMutation?.();
  };
  const removeSelected = button('Remove selected', task(async () => { const keep = subjects.filter((_, i) => !checks.get(i)?.checked); if (keep.length === subjects.length) { toast('Select bindings to remove.'); return; } await patchSubjects(keep, `Remove ${subjects.length - keep.length} subject(s) from ${binding.metadata.name}.`); }), 'danger compact');
  const addForm = () => modal('Add binding subject', `${binding.kind} ${binding.metadata.name}`, makeForm([
    { name: 'kind', label: 'Kind', options: ['ServiceAccount', 'User', 'Group'] },
    { name: 'name', label: 'Name', required: true },
    { name: 'namespace', label: 'Namespace (service accounts)', value: selected.namespace || 'default' },
  ], 'Add subject', async values => {
    const subject = values.kind === 'ServiceAccount' ? { kind: 'ServiceAccount', name: values.name, namespace: values.namespace || 'default' } : { kind: values.kind, name: values.name, apiGroup: 'rbac.authorization.k8s.io' };
    await patchSubjects([...subjects, subject], `Grant ${binding.roleRef?.kind} ${binding.roleRef?.name} to ${values.kind} ${values.name}.`);
    return 'Subject added.';
  }));
  return [
    section('Reference', dl([['Role', kindRef({ kind: binding.roleRef?.kind, name: binding.roleRef?.name, namespace: binding.roleRef?.kind === 'Role' ? selected.namespace : '' })], ['API group', binding.roleRef?.apiGroup]])),
    section(`Bindings (${subjects.length})`, el('div', {}, simpleTable(subjects.map((s, i) => ({ s, i })), [
      ['', r => { const box = el('input', { type: 'checkbox', 'aria-label': `Select ${r.s.name}` }); checks.set(r.i, box); return box; }],
      ['Kind', r => r.s.kind], ['Name', r => (r.s.kind === 'ServiceAccount' ? refLink('ServiceAccount', r.s.name, r.s.namespace) : r.s.name)], ['Namespace', r => r.s.namespace || '—'],
    ]), el('div', { class: 'form-actions' }, button('Add subject', addForm, 'compact'), removeSelected))),
  ];
}
function serviceAccountOverview(selected) {
  const sa = selected.item;
  const grants = el('div', {}, loading('Finding role bindings…'));
  (async () => {
    try {
      const [rb, crb] = await Promise.all([get('/api/resources', { context: selected.context, namespace: selected.namespace, resource: 'rolebindings' }), get('/api/resources', { context: selected.context, namespace: '*', resource: 'clusterrolebindings' }).catch(() => ({ items: [] }))]);
      const matches = [...(rb.items || []), ...(crb.items || [])].filter(b => (b.subjects || []).some(s => s.kind === 'ServiceAccount' && s.name === sa.metadata.name && (s.namespace || b.metadata.namespace) === sa.metadata.namespace));
      grants.replaceChildren(matches.length ? simpleTable(matches, [['Binding', b => kindRef({ kind: b.kind, name: b.metadata.name, namespace: b.metadata.namespace })], ['Role', b => kindRef({ kind: b.roleRef.kind, name: b.roleRef.name, namespace: b.roleRef.kind === 'Role' ? b.metadata.namespace : '' })]]) : muted('No role bindings reference this service account.'));
    } catch (error) { grants.replaceChildren(info(error.message, 'error')); }
  })();
  return [
    section('Service account', dl([
      ['Automount token', sa.automountServiceAccountToken === false ? 'No' : 'Yes'],
      ['Secrets', (sa.secrets || []).length ? el('div', { class: 'link-list' }, sa.secrets.map(s => refLink('Secret', s.name, selected.namespace))) : 'None'],
      ['Image pull secrets', (sa.imagePullSecrets || []).length ? el('div', { class: 'link-list' }, sa.imagePullSecrets.map(s => refLink('Secret', s.name, selected.namespace))) : 'None'],
      ['Kubeconfig', button('Create kubeconfig…', () => kubeconfigDialog(selected), 'quiet compact')],
    ])),
    section('Permissions', grants),
  ];
}

// ---- Other kinds ---------------------------------------------------------------------------------
function crdOverview(selected) {
  const crd = selected.item; const spec = crd.spec || {}; const names = spec.names || {};
  const version = crdStorageVersion(crd);
  return [
    section('Definition', dl([
      ['Group', spec.group], ['Kind', names.kind], ['Scope', spec.scope], ['Resource', `${names.plural} (singular ${names.singular || '—'})`], ['List kind', names.listKind],
      ['Short names', (names.shortNames || []).join(', ')], ['Categories', (names.categories || []).join(', ')], ['Conversion', spec.conversion?.strategy || 'None'],
      ['Stored versions', (crd.status?.storedVersions || []).join(', ')],
      ['Resources', button(`Open ${names.kind || 'resources'}`, () => hooks.openView('resource', `${names.plural}.${spec.group}`, names.kind), 'quiet compact')],
    ])),
    section('Versions', simpleTable(spec.versions || [], [['Name', v => v.name], ['Served', v => yesNo(v.served)], ['Storage', v => yesNo(v.storage)], ['Deprecated', v => (v.deprecated ? badge(v.deprecationWarning || 'Deprecated', 'warn') : 'No')]])),
    (version?.additionalPrinterColumns || []).length ? section('Printer columns', simpleTable(version.additionalPrinterColumns, [['Name', c => c.name], ['Type', c => c.type], ['JSON path', c => el('span', { class: 'mono', text: c.jsonPath })], ['Description', c => c.description || '—']])) : '',
    section('Conditions', conditionsList(crd.status?.conditions), { open: false }),
    version?.schema?.openAPIV3Schema ? section('Schema', jsonBlock(version.schema.openAPIV3Schema, { title: 'OpenAPI v3 schema' }), { open: false }) : '',
  ];
}
function eventOverview(selected) {
  const event = selected.item; const target = involved(event);
  return [section('Event', dl([
    ['Type', badge(event.type || 'Normal', event.type === 'Warning' ? 'warn' : 'good')], ['Reason', event.reason], ['Message', event.message || event.note],
    ['Involved object', target.name ? kindRef({ ...target, namespace: target.namespace || event.metadata?.namespace }) : ''],
    ['Field', target.fieldPath], ['Source', [event.source?.component || event.reportingController || event.reportingComponent, event.source?.host].filter(Boolean).join(' on ')],
    ['First seen', dateText(event.firstTimestamp || event.eventTime || event.metadata?.creationTimestamp)], ['Last seen', dateText(event.lastTimestamp || event.series?.lastObservedTime || event.eventTime)],
    ['Count', String(event.count || event.series?.count || 1)], ['Action', event.action],
  ]))];
}
function simpleFacts(selected) {
  const item = selected.item;
  switch (selected.resource) {
    case 'priorityclasses': return [section('Priority class', dl([['Value', String(item.value)], ['Global default', yesNo(item.globalDefault)], ['Preemption policy', item.preemptionPolicy || 'PreemptLowerPriority'], ['Description', item.description]]))];
    case 'runtimeclasses': return [section('Runtime class', dl([['Handler', item.handler], ['Pod overhead', item.overhead?.podFixed ? Object.entries(item.overhead.podFixed).map(([k, v]) => `${k}: ${quantityText(k, v)}`).join(' · ') : ''], ['Node selector', item.scheduling?.nodeSelector ? chips(item.scheduling.nodeSelector) : '']])), item.scheduling?.tolerations?.length ? section('Tolerations', tolerationsTable(item.scheduling.tolerations)) : ''];
    case 'leases': return [section('Lease', dl([['Holder', item.spec?.holderIdentity], ['Duration', item.spec?.leaseDurationSeconds ? `${item.spec.leaseDurationSeconds}s` : ''], ['Acquired', dateText(item.spec?.acquireTime)], ['Renewed', dateText(item.spec?.renewTime)], ['Transitions', item.spec?.leaseTransitions !== undefined ? String(item.spec.leaseTransitions) : ''], ['Strategy', item.spec?.strategy], ['Preferred holder', item.spec?.preferredHolder]]))];
    case 'limitranges': return [section('Limits', limitRangeTable(item))];
    default: return null;
  }
}
function fluxOverview(selected) {
  const item = selected.item; const spec = item.spec || {}; const s = item.status || {};
  return [
    section('Reconciliation', dl([
      ['Ready', (() => { const ready = (s.conditions || []).find(c => c.type === 'Ready'); return ready ? badge(ready.status === 'True' ? 'Ready' : ready.reason || 'Not ready', ready.status === 'True' ? 'good' : 'bad') : ''; })()],
      ['Suspended', yesNo(spec.suspend)], ['Interval', spec.interval], ['Source', spec.sourceRef ? kindRef({ ...spec.sourceRef, namespace: spec.sourceRef.namespace || selected.namespace }) : spec.url || ''],
      ['Path', spec.path], ['Chart', spec.chart?.spec?.chart ? `${spec.chart.spec.chart}@${spec.chart.spec.version || '*'}` : ''], ['Target namespace', spec.targetNamespace],
      ['Applied revision', s.lastAppliedRevision], ['Attempted revision', s.lastAttemptedRevision !== s.lastAppliedRevision ? s.lastAttemptedRevision : ''], ['Artifact', s.artifact?.revision],
      ['Last handled', s.lastHandledReconcileAt],
    ])),
    section('Conditions', conditionsList(s.conditions)),
    s.inventory?.entries?.length ? section(`Inventory (${s.inventory.entries.length})`, simpleTable(s.inventory.entries.slice(0, 300), [['Object', e => el('span', { class: 'mono wrap-anywhere', text: e.id })], ['Version', e => e.v]]), { open: false }) : '',
  ];
}
function gatewayOverview(selected) {
  const item = selected.item; const spec = item.spec || {};
  if (item.kind === 'Gateway') return [
    section('Gateway', dl([['Class', spec.gatewayClassName ? refLink('GatewayClass', spec.gatewayClassName, '', item.apiVersion) : ''], ['Addresses', (item.status?.addresses || []).map(a => a.value).join(', ')]])),
    section('Listeners', simpleTable(spec.listeners || [], [['Name', l => l.name], ['Protocol', l => `${l.protocol}/${l.port}`], ['Hostname', l => l.hostname || '*'], ['TLS', l => (l.tls?.certificateRefs || []).map(c => c.name).join(', ') || '—'], ['Attached routes', l => String((item.status?.listeners || []).find(s => s.name === l.name)?.attachedRoutes ?? '—')]])),
    section('Conditions', conditionsList(item.status?.conditions)),
  ];
  if (item.kind === 'GatewayClass') return [section('Gateway class', dl([['Controller', spec.controllerName], ['Description', spec.description], ['Parameters', spec.parametersRef ? `${spec.parametersRef.kind} ${spec.parametersRef.name}` : '']])), section('Conditions', conditionsList(item.status?.conditions))];
  return [
    section('Route', dl([['Hostnames', (spec.hostnames || []).join(', ') || '*'], ['Parents', el('div', {}, (spec.parentRefs || []).map(p => el('div', {}, refLink(p.kind || 'Gateway', p.name, p.namespace || selected.namespace, item.apiVersion), p.sectionName ? muted(` · ${p.sectionName}`) : '')))]])),
    section('Rules', simpleTable(spec.rules || [], [['Matches', r => (r.matches || [{}]).map(m => `${m.method || ''} ${m.path ? `${m.path.type || 'PathPrefix'} ${m.path.value}` : '/'}${m.headers ? ` headers ${m.headers.map(h => h.name).join(',')}` : ''}`).join(' · ')], ['Backends', r => el('div', {}, (r.backendRefs || []).map(b => el('div', {}, refLink(b.kind || 'Service', b.name, b.namespace || selected.namespace), `${b.port ? `:${b.port}` : ''}${b.weight !== undefined ? ` (weight ${b.weight})` : ''}`)))], ['Filters', r => (r.filters || []).map(f => f.type).join(', ') || '—']])),
    section('Parent status', simpleTable(item.status?.parents || [], [['Parent', p => p.parentRef?.name], ['Controller', p => p.controllerName], ['Conditions', p => el('span', {}, (p.conditions || []).map(c => badge(c.type, c.status === 'True' ? 'good' : 'warn')))]])),
  ];
}
function customOverview(selected) {
  const item = selected.item;
  const crd = (state.crds || []).find(c => `${c.spec?.names?.plural}.${c.spec?.group}` === selected.resource);
  const version = crd ? crdStorageVersion(crd) : null;
  const columns = (version?.additionalPrinterColumns || []).filter(c => !/^\.metadata\.(name|namespace|creationTimestamp)$/.test(c.jsonPath));
  const facts = columns.map(c => [c.name, jsonPath(item, c.jsonPath).map(v => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(', ')]);
  return [
    facts.length ? section(item.kind || 'Resource', dl(facts)) : '',
    item.status?.conditions?.length ? section('Conditions', conditionsList(item.status.conditions)) : '',
    item.spec ? section('Spec', jsonBlock(item.spec, { open: true, title: 'spec' }), { open: !facts.length }) : '',
    item.status && Object.keys(item.status).some(k => k !== 'conditions') ? section('Status', jsonBlock(Object.fromEntries(Object.entries(item.status).filter(([k]) => k !== 'conditions')), { open: true, title: 'status' }), { open: false }) : '',
  ];
}

// ---- Dispatch ------------------------------------------------------------------------------------
export function kindOverview(selected) {
  const item = selected.item; const r = selected.resource; const kind = item.kind;
  let sections;
  if (r === 'pods' || kind === 'Pod') sections = podOverview(selected);
  else if (workloadKinds.has(kind) || ['deployments', 'statefulsets', 'daemonsets', 'replicasets', 'replicationcontrollers', 'jobs'].includes(r)) sections = workloadOverview(selected);
  else if (r === 'cronjobs') sections = cronJobOverview(selected);
  else if (r === 'nodes') sections = nodeOverview(selected);
  else if (r === 'namespaces') sections = namespaceOverview(selected);
  else if (r === 'services') sections = serviceOverview(selected);
  else if (r === 'ingresses') sections = ingressOverview(selected);
  else if (r === 'networkpolicies') sections = networkPolicyOverview(selected);
  else if (r === 'endpoints') sections = endpointsOverview(selected);
  else if (r === 'endpointslices') sections = endpointSliceOverview(selected);
  else if (r === 'ingressclasses' || r === 'storageclasses') sections = classOverview(selected);
  else if (r === 'configmaps') sections = configMapOverview(selected);
  else if (r === 'secrets') sections = secretOverview(selected);
  else if (r === 'resourcequotas') sections = quotaOverview(selected);
  else if (r === 'horizontalpodautoscalers') sections = hpaOverview(selected);
  else if (r.startsWith('verticalpodautoscalers')) sections = vpaOverview(selected);
  else if (r === 'poddisruptionbudgets') sections = pdbOverview(selected);
  else if (r === 'mutatingwebhookconfigurations' || r === 'validatingwebhookconfigurations') sections = webhookOverview(selected);
  else if (/admissionpolic(y|ies)/.test(r)) sections = admissionPolicyOverview(selected);
  else if (r === 'persistentvolumeclaims') sections = pvcOverview(selected);
  else if (r === 'persistentvolumes') sections = pvOverview(selected);
  else if (r === 'roles' || r === 'clusterroles') sections = roleOverview(selected);
  else if (r === 'rolebindings' || r === 'clusterrolebindings') sections = bindingOverview(selected);
  else if (r === 'serviceaccounts') sections = serviceAccountOverview(selected);
  else if (r === 'customresourcedefinitions') sections = crdOverview(selected);
  else if (r === 'events') sections = eventOverview(selected);
  else if (/\.toolkit\.fluxcd\.io$/.test(r)) sections = fluxOverview(selected);
  else if (/\.gateway\.networking\.k8s\.io$/.test(r)) sections = gatewayOverview(selected);
  else sections = simpleFacts(selected) || (r.includes('.') && !r.endsWith('.argoproj.io') ? customOverview(selected) : []);
  return el('div', { class: 'kind-overview' }, sections, section('Metadata', metaSection(selected), { open: !sections.length }));
}

// Metrics tab definitions per kind; null when the kind has no metrics.
export function kindMetrics(selected) {
  const item = selected.item; const r = selected.resource; const usage = hooks.usage;
  const ns = item.metadata?.namespace; const name = item.metadata?.name;
  const cpuMem = (queries, extra = {}) => [
    { title: 'CPU', format: 'cpu', series: [{ key: 'cpu', name: 'Usage' }], lines: extra.cpuLines || [] },
    { title: 'Memory', format: 'bytes', series: [{ key: 'memory', name: 'Working set' }], lines: extra.memoryLines || [] },
  ];
  if (r === 'pods') {
    const resources = podResources(item);
    return { containers: (item.spec?.containers || []).map(c => c.name), queries: container => podQueries(ns, name, container || undefined), charts: [
      ...cpuMem(null, { cpuLines: [{ name: 'Requests', value: resources.cpuRequest }, { name: 'Limits', value: resources.cpuLimitMissing ? 0 : resources.cpuLimit }], memoryLines: [{ name: 'Requests', value: resources.memoryRequest }, { name: 'Limits', value: resources.memoryLimitMissing ? 0 : resources.memoryLimit }] }),
      { title: 'Network', format: 'rate', series: [{ key: 'networkReceive', name: 'Receive' }, { key: 'networkTransmit', name: 'Transmit' }] },
      { title: 'Filesystem I/O', format: 'rate', series: [{ key: 'fsReads', name: 'Reads' }, { key: 'fsWrites', name: 'Writes' }] },
      { title: 'CPU throttling', format: 'cpu', series: [{ key: 'cpuThrottled', name: 'Throttled' }] },
    ], session: container => { const h = container ? usage.containerHistory(item, container) : usage.history([item]); return [{ title: 'CPU', format: 'cpu', series: [{ name: 'Usage', values: h.cpu }, ...(resources.cpuRequest ? [{ name: 'Requests', dashed: true, values: h.cpu.length ? [[h.cpu[0][0], resources.cpuRequest], [h.cpu.at(-1)[0], resources.cpuRequest]] : [] }] : [])] }, { title: 'Memory', format: 'bytes', series: [{ name: 'Working set', values: h.memory }, ...(resources.memoryLimit && !resources.memoryLimitMissing ? [{ name: 'Limits', dashed: true, values: h.memory.length ? [[h.memory[0][0], resources.memoryLimit], [h.memory.at(-1)[0], resources.memoryLimit]] : [] }] : [])] }]; } };
  }
  if (workloadKinds.has(item.kind) || r === 'cronjobs') {
    const pattern = podPattern(item.kind || '', name);
    return { queries: () => podQueries(ns, pattern), charts: [...cpuMem(), { title: 'Network', format: 'rate', series: [{ key: 'networkReceive', name: 'Receive' }, { key: 'networkTransmit', name: 'Transmit' }] }, { title: 'Filesystem I/O', format: 'rate', series: [{ key: 'fsReads', name: 'Reads' }, { key: 'fsWrites', name: 'Writes' }] }],
      session: () => { const h = usage.historyWhere(workloadSessionPredicate(item)); return [{ title: 'CPU (all pods)', format: 'cpu', series: [{ name: 'Usage', values: h.cpu }] }, { title: 'Memory (all pods)', format: 'bytes', series: [{ name: 'Working set', values: h.memory }] }]; } };
  }
  if (r === 'nodes') {
    const allocatable = item.status?.allocatable || {};
    const address = (item.status?.addresses || []).find(a => a.type === 'InternalIP')?.address;
    return { queries: () => nodeQueries(name, address), charts: [
      ...cpuMem(null, { cpuLines: [{ name: 'Allocatable', value: parseCPU(allocatable.cpu) }], memoryLines: [{ name: 'Allocatable', value: parseMemory(allocatable.memory) }] }),
      { title: 'Disk (root filesystem)', format: 'bytes', series: [{ key: 'diskUsed', name: 'Used' }, { key: 'diskSize', name: 'Size', dashed: true }] },
      { title: 'Pods', format: 'count', series: [{ key: 'pods', name: 'Pods' }], lines: [{ name: 'Allocatable', value: Number(allocatable.pods) }] },
      { title: 'Network', format: 'rate', series: [{ key: 'networkReceive', name: 'Receive' }, { key: 'networkTransmit', name: 'Transmit' }] },
    ], session: () => { const h = usage.nodeHistory(name); const line = (values, value) => (values.length && value ? [[values[0][0], value], [values.at(-1)[0], value]] : []); return [{ title: 'CPU', format: 'cpu', series: [{ name: 'Usage', values: h.cpu }, { name: 'Allocatable', dashed: true, values: line(h.cpu, parseCPU(allocatable.cpu)) }] }, { title: 'Memory', format: 'bytes', series: [{ name: 'Working set', values: h.memory }, { name: 'Allocatable', dashed: true, values: line(h.memory, parseMemory(allocatable.memory)) }] }]; } };
  }
  if (r === 'namespaces') return { queries: () => namespaceQueries(name), charts: [{ title: 'CPU', format: 'cpu', series: [{ key: 'cpu', name: 'Usage' }, { key: 'cpuRequests', name: 'Requests', dashed: true }] }, { title: 'Memory', format: 'bytes', series: [{ key: 'memory', name: 'Working set' }, { key: 'memoryRequests', name: 'Requests', dashed: true }] }, { title: 'Network', format: 'rate', series: [{ key: 'networkReceive', name: 'Receive' }, { key: 'networkTransmit', name: 'Transmit' }] }],
    session: () => { const h = usage.historyWhere(namespace => namespace === name); return [{ title: 'CPU', format: 'cpu', series: [{ name: 'Usage', values: h.cpu }] }, { title: 'Memory', format: 'bytes', series: [{ name: 'Working set', values: h.memory }] }]; } };
  if (r === 'persistentvolumeclaims') return { queries: () => pvcQueries(ns, name), charts: [{ title: 'Disk usage', format: 'bytes', series: [{ key: 'used', name: 'Used' }, { key: 'capacity', name: 'Capacity', dashed: true }] }, { title: 'Inodes used', format: 'count', series: [{ key: 'inodesUsed', name: 'Inodes' }] }], session: () => [] };
  if (r === 'ingresses') return { queries: () => ingressQueries(ns, name), charts: [{ title: 'Requests', format: 'perSecond', series: [{ key: 'requests', name: 'All' }, { key: 'errors', name: '5xx' }] }, { title: 'Latency (p95)', format: 'seconds', series: [{ key: 'latency', name: 'p95' }] }], session: () => [] };
  return null;
}
export { metricsView };
