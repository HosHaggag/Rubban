// Live topology map, pure part: builds a graph of how a namespace's resources connect from plain
// object lists (Ingress → Service → workload → ConfigMap/Secret/PVC, plus HPAs and PDBs), and lays
// it out in layers from left to right. No DOM here; topology.js draws it. Covered by
// topology-core.test.mjs.

// Lists the map needs, by resource name (what liveList and showResource take).
export const TOPOLOGY_RESOURCES = ['ingresses', 'services', 'deployments', 'statefulsets', 'daemonsets', 'cronjobs', 'jobs', 'replicasets', 'pods', 'configmaps', 'secrets', 'persistentvolumeclaims', 'horizontalpodautoscalers', 'poddisruptionbudgets'];
// Enough for the namespace chooser: workloads and their pods.
export const CHOOSER_RESOURCES = ['deployments', 'statefulsets', 'daemonsets', 'cronjobs', 'jobs', 'replicasets', 'pods'];

export const RESOURCE_OF = {
  Ingress: 'ingresses', Service: 'services', Deployment: 'deployments', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets', CronJob: 'cronjobs', Job: 'jobs',
  ReplicaSet: 'replicasets', Pod: 'pods', ConfigMap: 'configmaps', Secret: 'secrets', PersistentVolumeClaim: 'persistentvolumeclaims',
  HorizontalPodAutoscaler: 'horizontalpodautoscalers', PodDisruptionBudget: 'poddisruptionbudgets',
};
// Columns, left to right. Anything that points at workloads (Services, HPAs, PDBs) sits just before them.
export const LAYER_TITLES = ['Ingresses', 'Services & policies', 'Workloads', 'Config & storage'];
const LAYER = { Ingress: 0, Service: 1, HorizontalPodAutoscaler: 1, PodDisruptionBudget: 1, ConfigMap: 3, Secret: 3, PersistentVolumeClaim: 3 };
const layerOf = kind => LAYER[kind] ?? 2;
// Order inside a column before crossing reduction.
const RANK = { Ingress: 0, Service: 0, HorizontalPodAutoscaler: 1, PodDisruptionBudget: 2, Deployment: 0, StatefulSet: 1, DaemonSet: 2, CronJob: 3, Job: 4, Pod: 6, ConfigMap: 0, Secret: 1, PersistentVolumeClaim: 2 };
const rankOf = kind => RANK[kind] ?? 5;
export const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'Job']);
const HEALTH_RANK = { none: -1, idle: -1, good: 0, warn: 1, bad: 2, missing: 2 };
export const worse = (a, b) => ((HEALTH_RANK[b] ?? 0) > (HEALTH_RANK[a] ?? 0) ? b : a);

export const nodeId = (kind, namespace, name) => `${kind}/${namespace || ''}/${name}`;
const metaOf = item => item?.metadata || {};
const nsOf = item => metaOf(item).namespace || '';
const ownerOf = item => { const refs = metaOf(item).ownerReferences || []; return refs.find(ref => ref.controller) || refs[0] || null; };
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// ---- Selectors and pod health -------------------------------------------------------------------
// A Service selector is a plain map; an empty or missing one selects nothing (manual endpoints).
export function serviceSelects(selector, labels) {
  const entries = Object.entries(selector || {});
  if (!entries.length) return false;
  return entries.every(([key, value]) => (labels || {})[key] === value);
}
// A LabelSelector ({ matchLabels, matchExpressions }). Missing selects nothing; {} selects everything.
export function labelSelectorMatches(selector, labels) {
  if (!selector || typeof selector !== 'object') return false;
  const own = labels || {};
  for (const [key, value] of Object.entries(selector.matchLabels || {})) if (own[key] !== value) return false;
  for (const expression of selector.matchExpressions || []) {
    const has = Object.prototype.hasOwnProperty.call(own, expression.key);
    const values = expression.values || [];
    switch (expression.operator) {
      case 'In': if (!has || !values.includes(own[expression.key])) return false; break;
      case 'NotIn': if (has && values.includes(own[expression.key])) return false; break;
      case 'Exists': if (!has) return false; break;
      case 'DoesNotExist': if (has) return false; break;
      default: return false;
    }
  }
  return true;
}
const BAD_REASONS = /BackOff|Err|Error|OOMKilled|Invalid|CreateContainerConfigError|CreateContainerError/;
export function podReady(pod) {
  return (pod?.status?.conditions || []).some(c => c.type === 'Ready' && c.status === 'True');
}
// good: running and ready, or finished; warn: starting, pending or not ready; bad: failing.
export function podHealth(pod) {
  const status = pod?.status || {};
  if (status.phase === 'Succeeded') return 'good';
  if (status.phase === 'Failed' || status.phase === 'Unknown') return 'bad';
  const containers = [...(status.initContainerStatuses || []), ...(status.containerStatuses || [])];
  const reason = containers.map(c => c.state?.waiting?.reason || (c.state?.terminated && c.state.terminated.exitCode !== 0 ? c.state.terminated.reason || 'Error' : '')).find(Boolean);
  if (reason && BAD_REASONS.test(reason)) return 'bad';
  if (metaOf(pod).deletionTimestamp) return 'warn';
  if (status.phase === 'Running' && (podReady(pod) || (!status.conditions && containers.length && containers.every(c => c.ready)))) return 'good';
  return 'warn';
}
const podReason = pod => {
  const containers = [...(pod?.status?.initContainerStatuses || []), ...(pod?.status?.containerStatuses || [])];
  return containers.map(c => c.state?.waiting?.reason || (c.state?.terminated && c.state.terminated.exitCode !== 0 ? c.state.terminated.reason || 'Error' : '')).find(Boolean) || pod?.status?.phase || '';
};

// ---- References from a pod spec -----------------------------------------------------------------
// Every ConfigMap, Secret and PVC a pod spec uses, with how (volume, env, envFrom, pull secret).
export function podSpecRefs(spec) {
  const refs = [];
  const add = (kind, name, how, optional = false) => { if (name) refs.push({ kind, name, how, optional: Boolean(optional) }); };
  for (const volume of spec?.volumes || []) {
    if (volume.configMap) add('ConfigMap', volume.configMap.name, 'volume', volume.configMap.optional);
    if (volume.secret) add('Secret', volume.secret.secretName, 'volume', volume.secret.optional);
    if (volume.persistentVolumeClaim) add('PersistentVolumeClaim', volume.persistentVolumeClaim.claimName, 'volume');
    for (const source of volume.projected?.sources || []) {
      if (source.configMap) add('ConfigMap', source.configMap.name, 'volume', source.configMap.optional);
      if (source.secret) add('Secret', source.secret.name, 'volume', source.secret.optional);
    }
  }
  for (const container of [...(spec?.initContainers || []), ...(spec?.containers || [])]) {
    for (const from of container.envFrom || []) {
      if (from.configMapRef) add('ConfigMap', from.configMapRef.name, 'envFrom', from.configMapRef.optional);
      if (from.secretRef) add('Secret', from.secretRef.name, 'envFrom', from.secretRef.optional);
    }
    for (const env of container.env || []) {
      const ref = env.valueFrom || {};
      if (ref.configMapKeyRef) add('ConfigMap', ref.configMapKeyRef.name, 'env', ref.configMapKeyRef.optional);
      if (ref.secretKeyRef) add('Secret', ref.secretKeyRef.name, 'env', ref.secretKeyRef.optional);
    }
  }
  for (const pull of spec?.imagePullSecrets || []) add('Secret', pull.name, 'image pull');
  return refs;
}
// Ingress backends (networking.k8s.io/v1, with the v1beta1 field names as a fallback).
export function ingressBackends(ingress) {
  const out = [];
  const backend = (b, host, path) => { const name = b?.service?.name || b?.serviceName; if (name) out.push({ service: name, port: b.service?.port?.number ?? b.service?.port?.name ?? b.servicePort ?? '', host: host || '', path: path || '' }); };
  backend(ingress?.spec?.defaultBackend || ingress?.spec?.backend, '*', '');
  for (const rule of ingress?.spec?.rules || []) for (const path of rule.http?.paths || []) backend(path.backend, rule.host || '*', path.path || '/');
  return out;
}
// Config the cluster creates in every namespace or for its own bookkeeping: hidden unless used.
const SYSTEM_CONFIG = new Set(['kube-root-ca.crt', 'istio-ca-root-cert', 'openshift-service-ca.crt']);
const SYSTEM_SECRET_TYPES = new Set(['helm.sh/release.v1', 'kubernetes.io/service-account-token', 'bootstrap.kubernetes.io/token']);
const isSystemConfig = (kind, item) => (kind === 'ConfigMap' && SYSTEM_CONFIG.has(metaOf(item).name)) || (kind === 'Secret' && SYSTEM_SECRET_TYPES.has(item?.type));

// ---- Graph --------------------------------------------------------------------------------------
// data: { [resource]: items[] }. A list that is missing (not loaded, or not permitted) is unknown:
// references into it are drawn but never reported as missing.
// Nodes: { id, kind, name, namespace, layer, resource, item, health, status, detail, lines, pods,
// missing, unverified, referrers }. Edges: { id, from, to, type, labels, tone, missing }.
export function buildGraph(data, { showUnreferenced = false, include = '' } = {}) {
  const has = resource => Array.isArray(data?.[resource]);
  const list = resource => (has(resource) ? data[resource] : []);
  const nodes = new Map(); const edges = new Map();
  const addNode = node => { if (!nodes.has(node.id)) nodes.set(node.id, { lines: [], pods: null, missing: false, unverified: false, referrers: [], health: 'none', status: '', detail: '', ...node, layer: layerOf(node.kind) }); return nodes.get(node.id); };
  const addEdge = (from, to, type, label = '') => {
    const id = `${from}->${to}`;
    if (!edges.has(id)) edges.set(id, { id, from, to, type, labels: [], tone: '', missing: false });
    const edge = edges.get(id);
    if (label && !edge.labels.includes(label)) edge.labels.push(label);
    return edge;
  };
  // A reference to an object that may not exist: real node, "missing" node, or unverified node.
  const index = {};
  for (const resource of TOPOLOGY_RESOURCES) index[resource] = new Map(list(resource).map(item => [`${nsOf(item)}/${metaOf(item).name}`, item]));
  const refTarget = (kind, namespace, name, referrer, optional) => {
    const id = nodeId(kind, namespace, name);
    if (nodes.has(id)) { const node = nodes.get(id); if (node.missing && !node.referrers.includes(referrer)) node.referrers.push(referrer); return id; }
    const resource = RESOURCE_OF[kind];
    const existing = index[resource]?.get(`${namespace}/${name}`);
    if (existing) { addNode({ id, kind, name, namespace, resource, item: existing }); return id; }
    if (!has(resource)) { addNode({ id, kind, name, namespace, resource, unverified: true, item: { kind, metadata: { name, namespace } }, status: 'not checked', detail: `${kind} list not available` }); return id; }
    if (optional) return null;
    addNode({ id, kind, name, namespace, resource, missing: true, health: 'missing', status: 'missing', detail: 'does not exist', referrers: [referrer] });
    return id;
  };

  // Workloads, with their pods: Deployment via its ReplicaSets, CronJob via its Jobs.
  const rsOwner = new Map();
  for (const rs of list('replicasets')) { const owner = ownerOf(rs); if (owner?.kind === 'Deployment') rsOwner.set(`${nsOf(rs)}/${metaOf(rs).name}`, owner.name); }
  const jobOwner = new Map();
  for (const job of list('jobs')) { const owner = ownerOf(job); if (owner?.kind === 'CronJob') jobOwner.set(`${nsOf(job)}/${metaOf(job).name}`, owner.name); }
  // Without the ReplicaSet or Job lists, the generated names (deploy-<hash>, cronjob-<n>) decide.
  const deployments = new Set(list('deployments').map(item => `${nsOf(item)}/${metaOf(item).name}`));
  const cronjobs = new Set(list('cronjobs').map(item => `${nsOf(item)}/${metaOf(item).name}`));
  const parentByName = (set, ns, name) => { const base = name.replace(/-[^-]+$/, ''); return base !== name && set.has(`${ns}/${base}`) ? base : ''; };
  const workloadOfPod = pod => {
    const ns = nsOf(pod); const owner = ownerOf(pod);
    if (!owner) return { kind: 'Pod', name: metaOf(pod).name };
    if (owner.kind === 'ReplicaSet') { const up = rsOwner.get(`${ns}/${owner.name}`) || (!has('replicasets') ? parentByName(deployments, ns, owner.name) : ''); return up ? { kind: 'Deployment', name: up } : { kind: 'ReplicaSet', name: owner.name, apiVersion: owner.apiVersion }; }
    if (owner.kind === 'Job') { const up = jobOwner.get(`${ns}/${owner.name}`) || (!has('jobs') ? parentByName(cronjobs, ns, owner.name) : ''); return up ? { kind: 'CronJob', name: up } : { kind: 'Job', name: owner.name }; }
    return { kind: owner.kind, name: owner.name, apiVersion: owner.apiVersion };
  };
  const podsOf = new Map();
  for (const pod of list('pods')) {
    const owner = workloadOfPod(pod); const id = nodeId(owner.kind, nsOf(pod), owner.name);
    if (!podsOf.has(id)) podsOf.set(id, { owner, pods: [] });
    podsOf.get(id).pods.push(pod);
  }
  const podSummary = pods => {
    const sorted = [...pods].sort((a, b) => (metaOf(a).name || '').localeCompare(metaOf(b).name || ''));
    const dots = sorted.map(pod => ({ name: metaOf(pod).name, health: podHealth(pod), reason: podReason(pod) }));
    const count = level => dots.filter(dot => dot.health === level).length;
    return { dots, good: count('good'), warn: count('warn'), bad: count('bad'), ready: sorted.filter(podReady).length, total: sorted.length };
  };
  const workloads = [];
  const addWorkload = (kind, item, template, extra = {}) => {
    const namespace = nsOf(item); const name = metaOf(item).name;
    const id = nodeId(kind, namespace, name);
    const pods = podSummary(podsOf.get(id)?.pods || []);
    const node = addNode({ id, kind, name, namespace, resource: RESOURCE_OF[kind] || '', item, pods, template, ...extra });
    workloads.push(node);
    return node;
  };
  const replicaHealth = (ready, desired, pods) => {
    if (!desired) return ['idle', 'scaled to 0'];
    if (ready >= desired) return [pods.bad ? 'warn' : 'good', `${ready}/${desired} ready`];
    return [ready ? 'warn' : 'bad', `${ready}/${desired} ready`];
  };
  for (const item of list('deployments')) { const node = addWorkload('Deployment', item, item.spec?.template); [node.health, node.status] = replicaHealth(item.status?.readyReplicas || 0, item.spec?.replicas ?? 1, node.pods); }
  for (const item of list('statefulsets')) {
    const node = addWorkload('StatefulSet', item, item.spec?.template); [node.health, node.status] = replicaHealth(item.status?.readyReplicas || 0, item.spec?.replicas ?? 1, node.pods);
    node.claimTemplates = (item.spec?.volumeClaimTemplates || []).map(t => metaOf(t).name).filter(Boolean);
  }
  for (const item of list('daemonsets')) { const node = addWorkload('DaemonSet', item, item.spec?.template); [node.health, node.status] = replicaHealth(item.status?.numberReady || 0, item.status?.desiredNumberScheduled || 0, node.pods); }
  const jobState = job => { const on = type => (job?.status?.conditions || []).some(c => c.type === type && c.status === 'True'); return on('Failed') ? 'failed' : on('Complete') ? 'complete' : 'running'; };
  for (const item of list('cronjobs')) {
    const node = addWorkload('CronJob', item, item.spec?.jobTemplate?.spec?.template);
    const own = list('jobs').filter(job => nsOf(job) === nsOf(item) && jobOwner.get(`${nsOf(job)}/${metaOf(job).name}`) === metaOf(item).name).sort((a, b) => String(metaOf(b).creationTimestamp || '').localeCompare(String(metaOf(a).creationTimestamp || '')) || (metaOf(b).name || '').localeCompare(metaOf(a).name || ''));
    const last = own[0];
    const stateOfLast = last ? jobState(last) : '';
    if (item.spec?.suspend) { node.health = 'idle'; node.status = 'suspended'; }
    else if (stateOfLast === 'failed') { node.health = 'bad'; node.status = 'last run failed'; }
    else if (stateOfLast === 'running') { node.health = node.pods.bad ? 'bad' : 'good'; node.status = 'running'; }
    else { node.health = 'good'; node.status = stateOfLast === 'complete' ? 'last run succeeded' : 'scheduled'; }
    node.detail = item.spec?.schedule || '';
  }
  for (const item of list('jobs')) {
    if (jobOwner.has(`${nsOf(item)}/${metaOf(item).name}`)) continue;
    const node = addWorkload('Job', item, item.spec?.template);
    const s = jobState(item);
    node.health = s === 'failed' ? 'bad' : s === 'complete' ? 'good' : node.pods.bad ? 'bad' : 'good';
    node.status = s === 'running' ? 'running' : s;
  }
  // Pods no listed workload owns: bare pods, and pods of other controllers (grouped by owner).
  for (const [id, { owner, pods }] of podsOf) {
    if (nodes.has(id)) continue;
    const first = pods[0];
    const kind = owner.kind;
    const summary = podSummary(pods);
    const node = addNode({ id, kind, name: owner.name, namespace: nsOf(first), resource: RESOURCE_OF[kind] || '', apiVersion: owner.apiVersion || '', item: kind === 'Pod' ? first : { kind, apiVersion: owner.apiVersion, metadata: { name: owner.name, namespace: nsOf(first) } }, pods: summary, template: { metadata: { labels: metaOf(first).labels || {} }, spec: first.spec } });
    node.health = summary.bad ? 'bad' : summary.warn ? 'warn' : 'good';
    node.status = `${summary.ready}/${summary.total} ready`;
    workloads.push(node);
  }
  for (const node of workloads) if (!node.detail) node.detail = node.pods?.total ? plural(node.pods.total, 'pod') : 'no pods';
  const workloadPodsMatch = (node, test) => test(node.template?.metadata?.labels || {}) || (podsOf.get(node.id)?.pods || []).some(pod => test(metaOf(pod).labels || {}));

  // Workloads → ConfigMaps, Secrets and PVCs.
  for (const node of workloads) {
    for (const ref of podSpecRefs(node.template?.spec)) {
      const target = refTarget(ref.kind, node.namespace, ref.name, node.id, ref.optional);
      if (target) { const edge = addEdge(node.id, target, 'config', ref.how); if (nodes.get(target).missing) edge.missing = true; }
    }
    for (const claim of node.claimTemplates || []) {
      const prefix = `${claim}-${node.name}-`;
      for (const pvc of list('persistentvolumeclaims')) if (nsOf(pvc) === node.namespace && (metaOf(pvc).name || '').startsWith(prefix) && /^\d+$/.test(metaOf(pvc).name.slice(prefix.length))) {
        addNode({ id: nodeId('PersistentVolumeClaim', node.namespace, metaOf(pvc).name), kind: 'PersistentVolumeClaim', name: metaOf(pvc).name, namespace: node.namespace, resource: 'persistentvolumeclaims', item: pvc });
        addEdge(node.id, nodeId('PersistentVolumeClaim', node.namespace, metaOf(pvc).name), 'config', 'volume claim template');
      }
    }
  }

  // Services → workloads whose pod template (or pods) the selector matches.
  const allPods = list('pods');
  for (const item of list('services')) {
    const namespace = nsOf(item); const name = metaOf(item).name; const id = nodeId('Service', namespace, name);
    const ports = (item.spec?.ports || []).map(p => `${p.port}${p.protocol && p.protocol !== 'TCP' ? `/${p.protocol}` : ''}`).join(', ');
    const node = addNode({ id, kind: 'Service', name, namespace, resource: 'services', item, detail: [item.spec?.type || 'ClusterIP', ports].filter(Boolean).join(' · ') });
    const selector = item.spec?.selector || {};
    if (item.spec?.type === 'ExternalName') { node.health = 'none'; node.status = `→ ${item.spec.externalName || ''}`; continue; }
    if (!Object.keys(selector).length) { node.health = 'none'; node.status = 'no selector'; continue; }
    const test = labels => serviceSelects(selector, labels);
    for (const workload of workloads) if (workload.namespace === namespace && workloadPodsMatch(workload, test)) addEdge(id, workload.id, 'select');
    if (has('pods')) {
      const matched = allPods.filter(pod => nsOf(pod) === namespace && test(metaOf(pod).labels) && pod.status?.phase !== 'Succeeded' && pod.status?.phase !== 'Failed');
      const ready = matched.filter(podReady).length;
      node.selected = { ready, total: matched.length };
      if (!matched.length) { node.health = 'bad'; node.status = 'selects no pods'; }
      else if (!ready) { node.health = 'bad'; node.status = `0/${matched.length} pods ready`; }
      else if (ready < matched.length) { node.health = 'warn'; node.status = `${ready}/${matched.length} pods ready`; }
      else { node.health = 'good'; node.status = `${ready} ${ready === 1 ? 'endpoint' : 'endpoints'}`; }
    } else { node.health = 'none'; node.status = Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(', '); }
  }

  // Ingresses → Services (and their TLS Secrets).
  for (const item of list('ingresses')) {
    const namespace = nsOf(item); const name = metaOf(item).name; const id = nodeId('Ingress', namespace, name);
    const backends = ingressBackends(item);
    const hosts = [...new Set((item.spec?.rules || []).map(rule => rule.host || '*'))];
    addNode({ id, kind: 'Ingress', name, namespace, resource: 'ingresses', item, lines: hosts.length ? hosts : ['*'], detail: item.spec?.ingressClassName || '' });
    for (const backend of backends) {
      const target = refTarget('Service', namespace, backend.service, id, false);
      if (!target) continue;
      const edge = addEdge(id, target, 'route', `${backend.host === '*' && !backend.path ? 'default backend' : `${backend.host}${backend.path}`}${backend.port !== '' ? ` → :${backend.port}` : ''}`);
      if (nodes.get(target).missing) edge.missing = true;
    }
    for (const tls of item.spec?.tls || []) {
      if (!tls.secretName) continue;
      const target = refTarget('Secret', namespace, tls.secretName, id, false);
      if (target) { const edge = addEdge(id, target, 'tls', `TLS ${(tls.hosts || []).join(', ')}`.trim()); if (nodes.get(target).missing) edge.missing = true; }
    }
  }

  // HPAs → their scale target; PDBs → workloads their selector matches.
  for (const item of list('horizontalpodautoscalers')) {
    const namespace = nsOf(item); const name = metaOf(item).name; const id = nodeId('HorizontalPodAutoscaler', namespace, name);
    const min = item.spec?.minReplicas ?? 1; const max = item.spec?.maxReplicas ?? '?';
    const current = item.status?.currentReplicas;
    const node = addNode({ id, kind: 'HorizontalPodAutoscaler', name, namespace, resource: 'horizontalpodautoscalers', item, detail: `${min}–${max} replicas${current !== undefined ? ` · now ${current}` : ''}` });
    const off = (item.status?.conditions || []).find(c => ['AbleToScale', 'ScalingActive'].includes(c.type) && c.status === 'False');
    node.health = off ? 'warn' : current !== undefined && current >= max ? 'warn' : 'good';
    node.status = off ? off.reason || 'cannot scale' : current !== undefined && current >= max ? 'at maximum' : 'scaling';
    const ref = item.spec?.scaleTargetRef;
    if (ref?.name && (WORKLOAD_KINDS.has(ref.kind) || nodes.has(nodeId(ref.kind, namespace, ref.name)))) {
      const target = refTarget(ref.kind, namespace, ref.name, id, false);
      if (target) { const edge = addEdge(id, target, 'scale', `scales ${ref.kind} ${ref.name}`); edge.missing = Boolean(nodes.get(target).missing); }
    }
  }
  for (const item of list('poddisruptionbudgets')) {
    const namespace = nsOf(item); const name = metaOf(item).name; const id = nodeId('PodDisruptionBudget', namespace, name);
    const rule = item.spec?.minAvailable !== undefined ? `min available ${item.spec.minAvailable}` : item.spec?.maxUnavailable !== undefined ? `max unavailable ${item.spec.maxUnavailable}` : '';
    const node = addNode({ id, kind: 'PodDisruptionBudget', name, namespace, resource: 'poddisruptionbudgets', item, detail: rule });
    const test = labels => labelSelectorMatches(item.spec?.selector, labels);
    let matched = 0;
    for (const workload of workloads) if (workload.namespace === namespace && workloadPodsMatch(workload, test)) { addEdge(id, workload.id, 'budget'); matched++; }
    const allowed = item.status?.disruptionsAllowed;
    if (!matched) { node.health = 'warn'; node.status = 'selects no workload'; }
    else if (allowed === 0 && (item.status?.expectedPods ?? 1) > 0) { node.health = 'warn'; node.status = 'no disruptions allowed'; }
    else { node.health = 'good'; node.status = allowed !== undefined ? `${allowed} disruption${allowed === 1 ? '' : 's'} allowed` : ''; }
  }

  // Config and storage: what exists but nothing above references.
  let hidden = 0;
  for (const [resource, kind] of [['configmaps', 'ConfigMap'], ['secrets', 'Secret'], ['persistentvolumeclaims', 'PersistentVolumeClaim']]) {
    for (const item of list(resource)) {
      const id = nodeId(kind, nsOf(item), metaOf(item).name);
      const used = nodes.has(id);
      if (!used && id !== include && (isSystemConfig(kind, item) || (kind !== 'PersistentVolumeClaim' && !showUnreferenced))) { hidden += isSystemConfig(kind, item) ? 0 : 1; continue; }
      const node = addNode({ id, kind, name: metaOf(item).name, namespace: nsOf(item), resource, item });
      node.item = item; node.unused = !used;
      if (kind === 'PersistentVolumeClaim') {
        const phase = item.status?.phase || 'Pending';
        node.health = phase === 'Bound' ? 'good' : phase === 'Lost' ? 'bad' : 'warn';
        node.status = phase;
        node.detail = [item.spec?.resources?.requests?.storage, item.spec?.storageClassName].filter(Boolean).join(' · ');
      } else if (kind === 'Secret') { node.detail = item.type || 'Opaque'; }
      else { const keys = Object.keys(item.data || {}).length + Object.keys(item.binaryData || {}).length; node.detail = plural(keys, 'key'); }
      if (!used) node.status = 'not referenced';
    }
  }
  // Ingress health from its backends; edges take the colour of the node they lead into.
  for (const node of nodes.values()) {
    if (node.kind !== 'Ingress') continue;
    const targets = [...edges.values()].filter(edge => edge.from === node.id && edge.type === 'route').map(edge => nodes.get(edge.to));
    if (!targets.length) { node.health = 'warn'; node.status = 'no backends'; continue; }
    const broken = targets.filter(target => ['bad', 'missing'].includes(target.health)).length;
    node.health = broken === targets.length ? 'bad' : broken || targets.some(target => target.health === 'warn') ? 'warn' : 'good';
    node.status = broken ? `${broken}/${targets.length} backends down` : plural(targets.length, 'backend');
  }
  for (const edge of edges.values()) {
    const target = nodes.get(edge.to);
    edge.tone = target.missing ? 'bad' : target.health === 'bad' ? 'bad' : target.health === 'warn' ? 'warn' : '';
  }
  for (const node of nodes.values()) node.search = `${node.kind} ${node.name} ${node.lines.join(' ')} ${node.status}`.toLowerCase();
  return { nodes: [...nodes.values()].sort(byId), edges: [...edges.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), hiddenUnreferenced: hidden, issues: issuesOf(nodes, edges) };
}
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
export const KIND_LABEL = { HorizontalPodAutoscaler: 'HPA', PodDisruptionBudget: 'PDB', PersistentVolumeClaim: 'PVC' };
const label = node => `${KIND_LABEL[node.kind] || node.kind} ${node.name}`;
// Wiring problems: references to objects that do not exist, and selectors that match nothing.
function issuesOf(nodes, edges) {
  const out = [];
  for (const node of nodes.values()) {
    if (node.missing) for (const referrer of node.referrers) {
      const from = nodes.get(referrer); const edge = edges.get(`${referrer}->${node.id}`);
      const verb = edge?.type === 'route' ? 'routes to' : edge?.type === 'scale' ? 'scales' : edge?.type === 'tls' ? 'uses TLS Secret' : 'uses';
      out.push({ level: 'bad', id: node.id, text: `${label(from)} ${verb} ${edge?.type === 'tls' ? node.name : label(node)}, which does not exist` });
    }
    if (node.kind === 'Service' && node.status === 'selects no pods') out.push({ level: 'bad', id: node.id, text: `Service ${node.name} selects no pods` });
    if (node.kind === 'PodDisruptionBudget' && node.status === 'selects no workload') out.push({ level: 'warn', id: node.id, text: `PDB ${node.name} selects no workload` });
  }
  return out.sort((a, b) => (a.level === b.level ? a.text.localeCompare(b.text) : a.level === 'bad' ? -1 : 1));
}

// Everything upstream of a node (what depends on it) and downstream (what it depends on): its
// "blast radius". Hovering a ConfigMap lights every workload, Service and Ingress that uses it.
export function connectedPath(graph, id) {
  const out = new Map(); const into = new Map();
  for (const edge of graph.edges) {
    if (!out.has(edge.from)) out.set(edge.from, []); out.get(edge.from).push(edge);
    if (!into.has(edge.to)) into.set(edge.to, []); into.get(edge.to).push(edge);
  }
  const nodes = new Set([id]); const edges = new Set();
  const walk = (start, links, next) => {
    const queue = [start]; const seen = new Set([start]);
    while (queue.length) {
      const current = queue.shift();
      for (const edge of links.get(current) || []) { edges.add(edge.id); const other = next(edge); nodes.add(other); if (!seen.has(other)) { seen.add(other); queue.push(other); } }
    }
  };
  walk(id, out, edge => edge.to); walk(id, into, edge => edge.from);
  return { nodes, edges };
}
// The part of the graph around one object (for the details drawer's Map tab).
export function neighbourhood(graph, id) {
  if (!graph.nodes.some(node => node.id === id)) return { ...graph, nodes: [], edges: [], issues: [] };
  const path = connectedPath(graph, id);
  // Also the HPAs and PDBs on the workloads in the path, which say how it scales and is protected.
  for (const edge of graph.edges) if ((edge.type === 'scale' || edge.type === 'budget') && path.nodes.has(edge.to)) { path.nodes.add(edge.from); path.edges.add(edge.id); }
  const nodes = graph.nodes.filter(node => path.nodes.has(node.id));
  const edges = graph.edges.filter(edge => path.edges.has(edge.id));
  return { ...graph, nodes, edges, issues: graph.issues.filter(issue => path.nodes.has(issue.id)) };
}
export function matchNodes(graph, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return new Set();
  return new Set(graph.nodes.filter(node => node.search.includes(needle)).map(node => node.id));
}

// Per-namespace summary for the chooser: workload count, pods and the worst workload health.
export function summarizeNamespaces(data, namespaces = []) {
  const byNs = new Map();
  const bucket = ns => { if (!byNs.has(ns)) byNs.set(ns, {}); return byNs.get(ns); };
  for (const resource of CHOOSER_RESOURCES) for (const item of Array.isArray(data?.[resource]) ? data[resource] : []) { const b = bucket(nsOf(item)); (b[resource] ||= []).push(item); }
  for (const ns of namespaces) bucket(ns);
  const out = [];
  for (const [namespace, lists] of byNs) {
    if (!namespace) continue;
    const graph = buildGraph(Object.fromEntries(CHOOSER_RESOURCES.map(resource => [resource, lists[resource] || []])));
    const workloads = graph.nodes.filter(node => node.layer === 2 && node.kind !== 'Pod');
    const health = { good: 0, warn: 0, bad: 0 };
    for (const node of graph.nodes.filter(n => n.layer === 2)) if (health[node.health] !== undefined) health[node.health]++;
    let worst = 'none';
    for (const node of graph.nodes) if (node.layer === 2) worst = worse(worst, node.health);
    out.push({ namespace, workloads: workloads.length, pods: (lists.pods || []).length, health, worst: worst === 'idle' ? 'none' : worst, system: /^(kube-|local-path-storage$|ingress-nginx$|cert-manager$|gatekeeper-system$)/.test(namespace) });
  }
  return out.sort((a, b) => Number(a.system) - Number(b.system) || a.namespace.localeCompare(b.namespace));
}

// ---- Layout -------------------------------------------------------------------------------------
export const SIZES = { width: 216, layerGap: 92, nodeGap: 14, componentGap: 34, base: 58, podRow: 16, line: 14, dummy: 6, maxDots: 16 };
export function nodeHeight(node) {
  let height = SIZES.base;
  if (node.kind === 'Ingress') height += SIZES.line * (Math.min(node.lines.length, 3) - 1);
  if (node.pods?.total) height += SIZES.podRow;
  return height;
}
// Crossings between two adjacent columns: segments are [upperIndex, lowerIndex] pairs.
export function countCrossings(segments) {
  let crossings = 0;
  for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length; j++) {
    const [a, b] = segments[i]; const [c, d] = segments[j];
    if ((a - c) * (b - d) < 0) crossings++;
  }
  return crossings;
}
// Pool-adjacent-violators: the tops closest to the wished ones that keep the order and spacing.
function placeColumn(items, gap) {
  const offsets = []; let sum = 0;
  for (const item of items) { offsets.push(sum); sum += item.h + gap; }
  const blocks = [];
  items.forEach((item, i) => {
    blocks.push({ total: item.want - offsets[i], count: 1, start: i });
    while (blocks.length > 1 && blocks.at(-2).total / blocks.at(-2).count >= blocks.at(-1).total / blocks.at(-1).count) {
      const last = blocks.pop(); blocks.at(-1).total += last.total; blocks.at(-1).count += last.count;
    }
  });
  for (const block of blocks) { const value = block.total / block.count; for (let i = block.start; i < block.start + block.count; i++) items[i].y = value + offsets[i]; }
}
// Layered layout: columns by kind, dummy nodes for edges that skip a column, barycenter sweeps
// to reduce crossings, then vertical placement that pulls nodes level with their neighbours.
// Connected groups are stacked; nodes without any edge are packed at the bottom.
export function layoutGraph(graph, sizes = SIZES) {
  const S = { ...SIZES, ...sizes };
  const nodes = [...graph.nodes].sort(byId);
  const known = new Set(nodes.map(node => node.id));
  const edges = [...graph.edges].filter(edge => known.has(edge.from) && known.has(edge.to)).sort(byId);
  const columnX = layer => layer * (S.width + S.layerGap);
  // Connected components (union-find).
  const parent = new Map(nodes.map(node => [node.id, node.id]));
  const find = id => { while (parent.get(id) !== id) { parent.set(id, parent.get(parent.get(id))); id = parent.get(id); } return id; };
  for (const edge of edges) { const a = find(edge.from); const b = find(edge.to); if (a !== b) parent.set(a < b ? b : a, a < b ? a : b); }
  const groups = new Map();
  for (const node of nodes) { const root = find(node.id); if (!groups.has(root)) groups.set(root, []); groups.get(root).push(node); }
  const components = [...groups.values()].filter(group => group.length > 1).sort((a, b) => b.length - a.length || byId(a[0], b[0]));
  const singles = [...groups.values()].filter(group => group.length === 1).map(group => group[0]);
  const placed = new Map(); const routes = new Map();
  let top = 0;
  for (const component of components) {
    const ids = new Set(component.map(node => node.id));
    const inner = edges.filter(edge => ids.has(edge.from));
    const { boxes, paths, height } = layoutComponent(component, inner, S, columnX);
    for (const box of boxes.values()) placed.set(box.id, { ...box, y: box.y + top });
    for (const [id, points] of paths) routes.set(id, points.map(([x, y]) => [x, y + top]));
    top += height + S.componentGap;
  }
  // Unconnected nodes, packed per column.
  const columns = new Map();
  for (const node of singles.sort((a, b) => a.layer - b.layer || rankOf(a.kind) - rankOf(b.kind) || a.name.localeCompare(b.name) || byId(a, b))) {
    const y = columns.get(node.layer) ?? top;
    placed.set(node.id, { id: node.id, x: columnX(node.layer), y, w: S.width, h: nodeHeight(node) });
    columns.set(node.layer, y + nodeHeight(node) + S.nodeGap);
  }
  const outNodes = nodes.map(node => ({ ...node, ...placed.get(node.id) }));
  const outEdges = edges.map(edge => ({ ...edge, points: routes.get(edge.id) || [] }));
  const maxLayer = Math.max(0, ...nodes.map(node => node.layer));
  const height = Math.max(0, ...outNodes.map(node => node.y + node.h));
  return { nodes: outNodes, edges: outEdges, width: columnX(maxLayer) + S.width, height, layers: maxLayer + 1, columnX };
}
function layoutComponent(nodes, edges, S, columnX) {
  // Items: real nodes and dummies, per column.
  const items = new Map();
  for (const node of nodes) items.set(node.id, { id: node.id, layer: node.layer, h: nodeHeight(node), rank: rankOf(node.kind), name: node.name, real: true, up: [], down: [] });
  const chains = new Map();
  for (const edge of edges) {
    const from = items.get(edge.from); const to = items.get(edge.to);
    const chain = [from];
    for (let layer = from.layer + 1; layer < to.layer; layer++) {
      const dummy = { id: `${edge.id}#${layer}`, layer, h: S.dummy, rank: 9, name: '', real: false, up: [], down: [] };
      items.set(dummy.id, dummy); chain.push(dummy);
    }
    chain.push(to);
    for (let i = 0; i + 1 < chain.length; i++) { chain[i].down.push(chain[i + 1]); chain[i + 1].up.push(chain[i]); }
    chains.set(edge.id, chain);
  }
  const layers = [];
  for (const item of items.values()) (layers[item.layer] ||= []).push(item);
  for (let i = 0; i < layers.length; i++) layers[i] ||= [];
  // Initial order: by kind, then name, then a depth-first pass from the left so related nodes start close.
  for (const column of layers) column.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
  const seen = new Set(); const order = new Map(); let counter = 0;
  const visit = item => { if (seen.has(item.id)) return; seen.add(item.id); order.set(item.id, counter++); for (const next of item.down) visit(next); for (const prev of item.up) visit(prev); };
  for (const column of layers) for (const item of column) visit(item);
  for (const column of layers) column.sort((a, b) => order.get(a.id) - order.get(b.id));
  const index = () => { for (const column of layers) column.forEach((item, i) => { item.pos = i; }); };
  index();
  const crossings = () => {
    let total = 0;
    for (let l = 0; l + 1 < layers.length; l++) {
      const segments = [];
      for (const item of layers[l]) for (const next of item.down) if (next.layer === l + 1) segments.push([item.pos, next.pos]);
      total += countCrossings(segments);
    }
    return total;
  };
  let best = crossings(); let bestOrder = layers.map(column => [...column]);
  const sweep = (l, side) => {
    const column = layers[l];
    for (const item of column) { const near = item[side]; item.bary = near.length ? near.reduce((sum, other) => sum + other.pos, 0) / near.length : item.pos; }
    column.sort((a, b) => a.bary - b.bary || a.pos - b.pos);
    column.forEach((item, i) => { item.pos = i; });
  };
  for (let round = 0; round < 12 && best > 0; round++) {
    if (round % 2 === 0) for (let l = 1; l < layers.length; l++) sweep(l, 'up');
    else for (let l = layers.length - 2; l >= 0; l--) sweep(l, 'down');
    const now = crossings();
    if (now < best) { best = now; bestOrder = layers.map(column => [...column]); }
  }
  bestOrder.forEach((column, l) => { layers[l] = column; });
  index();
  // Vertical placement.
  const center = item => item.y + item.h / 2;
  for (const column of layers) { let y = 0; for (const item of column) { item.y = y; y += item.h + (item.real ? S.nodeGap : S.nodeGap / 2); } }
  const place = (l, sides) => {
    const column = layers[l];
    for (const item of column) {
      const near = sides.flatMap(side => item[side]);
      item.want = near.length ? near.reduce((sum, other) => sum + center(other), 0) / near.length - item.h / 2 : item.y;
    }
    placeColumn(column, S.nodeGap);
  };
  for (let round = 0; round < 6; round++) {
    for (let l = 1; l < layers.length; l++) place(l, ['up']);
    for (let l = layers.length - 2; l >= 0; l--) place(l, ['down']);
  }
  for (let l = 0; l < layers.length; l++) place(l, ['up', 'down']);
  const minY = Math.min(...[...items.values()].map(item => item.y));
  for (const item of items.values()) item.y = Math.round((item.y - minY) * 10) / 10;
  const boxes = new Map();
  for (const item of items.values()) if (item.real) boxes.set(item.id, { id: item.id, x: columnX(item.layer), y: item.y, w: S.width, h: item.h });
  const paths = new Map();
  for (const [id, chain] of chains) {
    const points = [[columnX(chain[0].layer) + S.width, center(chain[0])]];
    for (const dummy of chain.slice(1, -1)) points.push([columnX(dummy.layer), center(dummy)], [columnX(dummy.layer) + S.width, center(dummy)]);
    const last = chain.at(-1); points.push([columnX(last.layer), center(last)]);
    paths.set(id, points);
  }
  const height = Math.max(...[...items.values()].map(item => item.y + item.h));
  return { boxes, paths, height };
}
