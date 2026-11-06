// The change timeline: everything that changed in a cluster (or one namespace), normalised into one
// chronological list of entries. Pure: no DOM, no network; timeline.js feeds it the live lists and
// draws the result.
//
// Entry: { id, time, first?, category, severity, change, title, summary, detail[], ref, namespace,
//          target, affects[], diff?, count, source }
//   time      ms of the entry (for grouped events, the last occurrence; first is the first one)
//   category  one of CATEGORIES
//   severity  'critical' | 'warning' | 'info'
//   change    true for things someone or something changed (rollouts, config, scaling, Helm, Argo CD):
//             the candidates for "likely related"
//   ref       { kind, apiVersion?, namespace, name } of the object to open
//   target    workload key ("Deployment/shop/storefront") the entry is about, for correlation
//   affects   workload keys a change can affect (a rollout its own workload; a ConfigMap its users)
//   diff      { before, after, beforeLabel, afterLabel } YAML texts of a pod-template change

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const RANGES = [
  { id: '1h', label: '1h', ms: HOUR },
  { id: '6h', label: '6h', ms: 6 * HOUR },
  { id: '24h', label: '24h', ms: DAY },
  { id: '7d', label: '7d', ms: 7 * DAY },
];
export const CATEGORIES = [
  { id: 'rollouts', label: 'Rollouts' },
  { id: 'config', label: 'Config' },
  { id: 'restarts', label: 'Restarts' },
  { id: 'warnings', label: 'Warnings' },
  { id: 'scaling', label: 'Scaling' },
  { id: 'jobs', label: 'Jobs' },
  { id: 'gitops', label: 'GitOps/Helm' },
  { id: 'nodes', label: 'Nodes' },
];
// Correlation: a change is "likely related" to a burst of warnings or restarts on a workload it affects
// when it happened at most WINDOW before the burst began (SLACK after, for clock skew between sources).
export const CORRELATION_WINDOW = 30 * MINUTE;
export const CORRELATION_SLACK = 2 * MINUTE;
// Incidents on one workload further apart than this start a new burst.
export const BURST_GAP = 15 * MINUTE;
// Changes this close after a healthy baseline revision were part of rolling it out.
export const BASELINE_GRACE = 10_000;
// "What changed?" from the Problems page looks this far back from when the problem started.
export const FOCUS_BEFORE = 30 * MINUTE;
export const FOCUS_AFTER = 5 * MINUTE;

const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };
const ms = value => { const t = Date.parse(value); return Number.isFinite(t) ? t : NaN; };
const meta = item => item?.metadata || {};
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const clip = (text, max = 160) => { const s = String(text ?? '').replace(/\s+/g, ' ').trim(); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };
export const workloadKey = (kind, namespace, name) => `${kind}/${namespace || ''}/${name}`;
const splitKey = key => { const [kind, namespace, ...rest] = String(key).split('/'); return { kind, namespace, name: rest.join('/') }; };
export const keyName = key => splitKey(key).name;
const controller = item => (meta(item).ownerReferences || []).find(ref => ref.controller) || (meta(item).ownerReferences || [])[0] || null;

// Resource of the kinds the timeline links to (the page falls back to discovery for the rest).
export const KIND_RESOURCES = { Pod: 'pods', Deployment: 'deployments', ReplicaSet: 'replicasets', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets', Job: 'jobs', CronJob: 'cronjobs', ConfigMap: 'configmaps', Secret: 'secrets', Node: 'nodes', HorizontalPodAutoscaler: 'horizontalpodautoscalers', PersistentVolumeClaim: 'persistentvolumeclaims', Service: 'services', Application: 'applications.argoproj.io' };
const RESOURCE_KINDS = Object.fromEntries(Object.entries(KIND_RESOURCES).map(([kind, resource]) => [resource, kind]));
export const kindForResource = resource => RESOURCE_KINDS[resource] || '';

// ---- Ownership index ---------------------------------------------------------------------------------

// Which workload owns what, which ConfigMaps and Secrets each workload reads, and which Helm release or
// Argo CD application manages it: what correlation needs to connect a change with a symptom.
export function configRefs(podSpec) {
  const out = new Set();
  if (!podSpec) return out;
  const add = (kind, name) => { if (name) out.add(`${kind}/${name}`); };
  for (const volume of podSpec.volumes || []) {
    add('ConfigMap', volume.configMap?.name); add('Secret', volume.secret?.secretName);
    for (const source of volume.projected?.sources || []) { add('ConfigMap', source.configMap?.name); add('Secret', source.secret?.name); }
  }
  for (const container of [...(podSpec.initContainers || []), ...(podSpec.containers || [])]) {
    for (const from of container.envFrom || []) { add('ConfigMap', from.configMapRef?.name); add('Secret', from.secretRef?.name); }
    for (const env of container.env || []) { add('ConfigMap', env.valueFrom?.configMapKeyRef?.name); add('Secret', env.valueFrom?.secretKeyRef?.name); }
  }
  for (const secret of podSpec.imagePullSecrets || []) add('Secret', secret.name);
  return out;
}

const INSTANCE_LABELS = ['app.kubernetes.io/instance', 'argocd.argoproj.io/instance'];

export function buildIndex({ pods = [], replicaSets = [], deployments = [], statefulSets = [], daemonSets = [], jobs = [], cronJobs = [], hpas = [] } = {}) {
  const parent = new Map(); // object key -> owner key
  const known = new Set();
  const note = (kind, list) => {
    for (const item of list) {
      const key = workloadKey(kind, meta(item).namespace, meta(item).name);
      known.add(key);
      const owner = controller(item);
      if (owner?.kind && owner.name) parent.set(key, workloadKey(owner.kind, meta(item).namespace, owner.name));
    }
  };
  note('Pod', pods); note('ReplicaSet', replicaSets); note('Deployment', deployments); note('StatefulSet', statefulSets);
  note('DaemonSet', daemonSets); note('Job', jobs); note('CronJob', cronJobs);
  // An autoscaler's warnings are about the workload it scales.
  for (const hpa of hpas) {
    const ref = hpa.spec?.scaleTargetRef;
    const key = workloadKey('HorizontalPodAutoscaler', meta(hpa).namespace, meta(hpa).name);
    known.add(key);
    if (ref?.name) parent.set(key, workloadKey(ref.kind || 'Deployment', meta(hpa).namespace, ref.name));
  }

  // Objects that are gone (a pod replaced by a rollout) are matched by their generated names.
  function guessParent(kind, namespace, name) {
    const has = (k, n) => known.has(workloadKey(k, namespace, n));
    if (kind === 'Pod') {
      const rs = name.replace(/-[a-z0-9]{5}$/, '');
      if (rs !== name && has('ReplicaSet', rs)) return workloadKey('ReplicaSet', namespace, rs);
      const deploy = name.replace(/-[a-z0-9]{6,10}-[a-z0-9]{5}$/, '');
      if (deploy !== name && has('Deployment', deploy)) return workloadKey('Deployment', namespace, deploy);
      const ordinal = name.replace(/-\d+$/, '');
      if (ordinal !== name && has('StatefulSet', ordinal)) return workloadKey('StatefulSet', namespace, ordinal);
      if (rs !== name && has('DaemonSet', rs)) return workloadKey('DaemonSet', namespace, rs);
      if (rs !== name && has('Job', rs)) return workloadKey('Job', namespace, rs);
    }
    if (kind === 'ReplicaSet') {
      const deploy = name.replace(/-[a-z0-9]{6,10}$/, '');
      if (deploy !== name && has('Deployment', deploy)) return workloadKey('Deployment', namespace, deploy);
    }
    if (kind === 'Job') {
      const cron = name.replace(/-\d{6,}$/, '');
      if (cron !== name && has('CronJob', cron)) return workloadKey('CronJob', namespace, cron);
    }
    return null;
  }
  // The top of the owner chain: the workload a person deploys.
  function ownerOf(kind, namespace, name) {
    if (!kind || !name) return null;
    let key = workloadKey(kind, namespace, name);
    for (let depth = 0; depth < 6; depth++) {
      let next = parent.get(key);
      if (!next && !known.has(key)) { const { kind: k, namespace: ns, name: n } = splitKey(key); next = guessParent(k, ns, n); }
      if (!next) break;
      key = next;
    }
    return key;
  }

  const configUsers = new Map(); // 'ConfigMap/ns/name' -> Set(workload keys)
  const instances = new Map(); // 'ns/instance' -> Set(workload keys)
  const addUse = (map, key, user) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(user); };
  const useSpec = (spec, namespace, user) => { for (const ref of configRefs(spec)) { const [kind, name] = ref.split('/'); addUse(configUsers, workloadKey(kind, namespace, name), user); } };
  const useLabels = (item, user) => {
    const labels = meta(item).labels || {}; const annotations = meta(item).annotations || {};
    for (const name of [...INSTANCE_LABELS.map(label => labels[label]), annotations['meta.helm.sh/release-name']]) if (name) addUse(instances, `${meta(item).namespace || ''}/${name}`, user);
  };
  for (const [kind, list] of [['Deployment', deployments], ['StatefulSet', statefulSets], ['DaemonSet', daemonSets]]) {
    for (const item of list) { const user = workloadKey(kind, meta(item).namespace, meta(item).name); useSpec(item.spec?.template?.spec, meta(item).namespace, user); useLabels(item, user); }
  }
  for (const item of cronJobs) { const user = workloadKey('CronJob', meta(item).namespace, meta(item).name); useSpec(item.spec?.jobTemplate?.spec?.template?.spec, meta(item).namespace, user); useLabels(item, user); }
  for (const [kind, list] of [['Job', jobs], ['Pod', pods]]) {
    for (const item of list) {
      const user = ownerOf(kind, meta(item).namespace, meta(item).name);
      useSpec(kind === 'Job' ? item.spec?.template?.spec : item.spec, meta(item).namespace, user);
      useLabels(item, user);
    }
  }
  return { ownerOf, configUsers, instances, users: key => [...(configUsers.get(key) || [])], managed: (namespace, name) => [...(instances.get(`${namespace || ''}/${name}`) || [])] };
}

// ---- Pod templates: YAML for diffs and a one-line summary of what changed --------------------------

const PLAIN = /^[A-Za-z_./][A-Za-z0-9_./ =()-]*$/;
const RESERVED = /^(true|false|null|yes|no|on|off|y|n|~)$/i;
const scalar = value => {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const s = String(value);
  return s && PLAIN.test(s) && !RESERVED.test(s) && !/\s$/.test(s) && !/: /.test(s) ? s : JSON.stringify(s);
};
// A small YAML writer with sorted keys, enough to diff two pod templates line by line.
export function toYaml(value, indent = '') {
  const isObject = v => v && typeof v === 'object' && !Array.isArray(v);
  const empty = v => (Array.isArray(v) ? '[]' : '{}');
  if (Array.isArray(value)) {
    if (!value.length) return `${indent}[]`;
    return value.map(item => {
      if ((isObject(item) && Object.keys(item).length) || (Array.isArray(item) && item.length)) {
        const body = toYaml(item, `${indent}  `);
        return `${indent}- ${body.slice(indent.length + 2)}`;
      }
      return `${indent}- ${isObject(item) || Array.isArray(item) ? empty(item) : scalar(item)}`;
    }).join('\n');
  }
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    if (!keys.length) return `${indent}{}`;
    return keys.map(key => {
      const v = value[key];
      const k = scalar(key);
      if ((isObject(v) && Object.keys(v).length) || (Array.isArray(v) && v.length)) return `${indent}${k}:\n${toYaml(v, Array.isArray(v) ? indent : `${indent}  `)}`;
      return `${indent}${k}: ${isObject(v) || Array.isArray(v) ? empty(v) : scalar(v)}`;
    }).join('\n');
  }
  return `${indent}${scalar(value)}`;
}

// The template without what always differs between revisions (the hash label, an empty timestamp).
export function cleanTemplate(template) {
  if (!template) return {};
  const copy = JSON.parse(JSON.stringify(template));
  if (copy.metadata) {
    delete copy.metadata.creationTimestamp;
    if (copy.metadata.labels) { delete copy.metadata.labels['pod-template-hash']; delete copy.metadata.labels['controller-revision-hash']; if (!Object.keys(copy.metadata.labels).length) delete copy.metadata.labels; }
    if (!Object.keys(copy.metadata).length) delete copy.metadata;
  }
  return copy;
}

const stable = value => JSON.stringify(value, (key, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v));
const same = (a, b) => stable(a ?? null) === stable(b ?? null);

// "registry/shop/storefront:4.2.1" -> { repo: "registry/shop/storefront", tag: "4.2.1" }
export function splitImage(image) {
  const text = String(image || '');
  const at = text.indexOf('@');
  if (at >= 0) return { repo: text.slice(0, at), tag: text.slice(at + 1).replace(/^sha256:/, '').slice(0, 12) };
  const slash = text.lastIndexOf('/'); const colon = text.lastIndexOf(':');
  return colon > slash ? { repo: text.slice(0, colon), tag: text.slice(colon + 1) } : { repo: text, tag: 'latest' };
}
export function imageChange(name, before, after) {
  const a = splitImage(before); const b = splitImage(after);
  return a.repo === b.repo ? `${name} ${a.tag} → ${b.tag}` : `${name} ${before} → ${after}`;
}

const SECRET_NAME = /pass|secret|token|key|cred|auth|private|cert/i;
function envValue(env) {
  const from = env.valueFrom;
  if (from?.secretKeyRef) return `from Secret ${from.secretKeyRef.name}/${from.secretKeyRef.key}`;
  if (from?.configMapKeyRef) return `from ConfigMap ${from.configMapKeyRef.name}/${from.configMapKeyRef.key}`;
  if (from?.fieldRef) return `from ${from.fieldRef.fieldPath}`;
  if (from?.resourceFieldRef) return `from ${from.resourceFieldRef.resource}`;
  return clip(env.value ?? '', 40);
}
// env FOO added / removed / a → b; values of secret-looking names are never shown.
export function envChanges(before = [], after = []) {
  const a = new Map(before.map(env => [env.name, env])); const b = new Map(after.map(env => [env.name, env]));
  const out = [];
  for (const [name, env] of b) {
    if (!a.has(name)) out.push(`${name} added`);
    else if (!same(a.get(name), env)) {
      const was = envValue(a.get(name)); const now = envValue(env);
      out.push(SECRET_NAME.test(name) && !env.valueFrom && !a.get(name).valueFrom ? `${name} changed` : `${name} ${was || '""'} → ${now || '""'}`);
    }
  }
  for (const name of a.keys()) if (!b.has(name)) out.push(`${name} removed`);
  return out;
}
function resourceChanges(before = {}, after = {}) {
  const out = [];
  for (const group of ['requests', 'limits']) {
    const label = group === 'requests' ? 'request' : 'limit';
    const a = before[group] || {}; const b = after[group] || {};
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (a[key] === b[key]) continue;
      if (a[key] === undefined) out.push(`${key} ${label} ${b[key]} added`);
      else if (b[key] === undefined) out.push(`${key} ${label} ${a[key]} removed`);
      else out.push(`${key} ${label} ${a[key]} → ${b[key]}`);
    }
  }
  return out;
}
const FIELD_LABELS = { command: 'command changed', args: 'args changed', ports: 'ports changed', readinessProbe: 'readiness probe changed', livenessProbe: 'liveness probe changed', startupProbe: 'startup probe changed', volumeMounts: 'volume mounts changed', envFrom: 'envFrom changed', securityContext: 'security context changed', imagePullPolicy: 'image pull policy changed', lifecycle: 'lifecycle hooks changed' };
const listWithMore = (items, limit = 3) => (items.length > limit ? `${items.slice(0, limit).join(', ')}, +${items.length - limit} more` : items.join(', '));

function containerChanges(before, after, { prefix, label }) {
  const out = [];
  if (before.image !== after.image) out.push(imageChange(label, before.image, after.image));
  const env = envChanges(before.env, after.env);
  if (env.length) out.push(`${prefix}env ${listWithMore(env)}`);
  const resources = resourceChanges(before.resources, after.resources);
  if (resources.length) out.push(`${prefix}${listWithMore(resources)}`);
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => !['name', 'image', 'env', 'resources'].includes(key) && !same(before[key], after[key])).sort();
  for (const key of keys) out.push(`${prefix}${FIELD_LABELS[key] || `${key} changed`}`);
  return out;
}

// What changed between two pod templates, as short phrases: "storefront 4.2.1 → 4.3.0", "env BUILD added".
export function summarizeTemplateChange(beforeTemplate, afterTemplate) {
  const a = cleanTemplate(beforeTemplate); const b = cleanTemplate(afterTemplate);
  const out = [];
  const annotationsA = { ...(a.metadata?.annotations || {}) }; const annotationsB = { ...(b.metadata?.annotations || {}) };
  const restartKey = 'kubectl.kubernetes.io/restartedAt';
  if (annotationsA[restartKey] !== annotationsB[restartKey] && annotationsB[restartKey]) out.push('restarted (rollout restart)');
  delete annotationsA[restartKey]; delete annotationsB[restartKey];
  const changedAnnotations = [...new Set([...Object.keys(annotationsA), ...Object.keys(annotationsB)])].filter(key => annotationsA[key] !== annotationsB[key]).sort();
  if (changedAnnotations.length) out.push(`annotations ${listWithMore(changedAnnotations, 2)} changed`);
  if (!same(a.metadata?.labels, b.metadata?.labels)) out.push('labels changed');
  const specA = a.spec || {}; const specB = b.spec || {};
  for (const [field, kindLabel] of [['initContainers', 'init container'], ['containers', 'container']]) {
    const listA = specA[field] || []; const listB = specB[field] || [];
    const multiple = listA.length + listB.length > 2 || field === 'initContainers';
    const byName = new Map(listA.map(c => [c.name, c]));
    for (const container of listB) {
      const previous = byName.get(container.name);
      if (!previous) { out.push(`${kindLabel} ${container.name} added (${container.image})`); continue; }
      out.push(...containerChanges(previous, container, { prefix: multiple ? `${container.name}: ` : '', label: field === 'initContainers' ? `init ${container.name}` : container.name }));
    }
    const names = new Set(listB.map(c => c.name));
    for (const container of listA) if (!names.has(container.name)) out.push(`${kindLabel} ${container.name} removed`);
  }
  const POD_LABELS = { volumes: 'volumes changed', serviceAccountName: 'service account changed', nodeSelector: 'node selector changed', affinity: 'affinity changed', tolerations: 'tolerations changed', securityContext: 'pod security context changed', imagePullSecrets: 'image pull secrets changed' };
  const podKeys = [...new Set([...Object.keys(specA), ...Object.keys(specB)])].filter(key => !['containers', 'initContainers'].includes(key) && !same(specA[key], specB[key])).sort();
  for (const key of podKeys) {
    if (key === 'serviceAccountName' && specA[key] && specB[key]) out.push(`service account ${specA[key]} → ${specB[key]}`);
    else out.push(POD_LABELS[key] || `${key} changed`);
  }
  if (!out.length && !same(a, b)) out.push('pod template changed');
  return out;
}

// For the diff: literal values of secret-looking env vars become a short fingerprint, so a change
// still shows as a changed line without the value being on screen.
function fingerprint(text) { let h = 0x811c9dc5; for (const ch of String(text)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return (h & 0xffff).toString(16).padStart(4, '0'); }
export function redactTemplate(template) {
  const copy = cleanTemplate(template);
  for (const container of [...(copy.spec?.initContainers || []), ...(copy.spec?.containers || [])]) {
    for (const env of container.env || []) if (SECRET_NAME.test(env.name || '') && typeof env.value === 'string' && env.value) env.value = `<redacted ${fingerprint(env.value)}>`;
  }
  return copy;
}

function imagesOf(template) { return (template?.spec?.containers || []).map(c => `${c.name} ${splitImage(c.image).tag}`); }

// ---- Normalisers: one per source ---------------------------------------------------------------------

// A ReplicaSet with every wanted replica available is a known-good baseline for correlation.
const fullyAvailable = item => (item.spec?.replicas ?? 0) > 0 && (item.status?.availableReplicas ?? 0) >= item.spec.replicas;
const revisionOf = item => Number(meta(item).annotations?.['deployment.kubernetes.io/revision'] ?? item.revision) || 0;

// Rollouts of Deployments (ReplicaSets) and of StatefulSets and DaemonSets (ControllerRevisions).
export function rolloutEntries({ replicaSets = [], controllerRevisions = [], deployments = [] } = {}) {
  const groups = new Map();
  const add = (ownerKind, item, template) => {
    const owner = controller(item);
    if (!owner || owner.kind !== ownerKind) return;
    const key = workloadKey(ownerKind, meta(item).namespace, owner.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ item, template, revision: revisionOf(item) });
  };
  for (const rs of replicaSets) add('Deployment', rs, rs.spec?.template);
  for (const cr of controllerRevisions) { const kind = controller(cr)?.kind; if (kind === 'StatefulSet' || kind === 'DaemonSet') add(kind, cr, cr.data?.spec?.template); }
  const deploymentByKey = new Map(deployments.map(d => [workloadKey('Deployment', meta(d).namespace, meta(d).name), d]));
  const out = [];
  for (const [key, list] of groups) {
    list.sort((x, y) => x.revision - y.revision);
    const { kind, namespace, name } = splitKey(key);
    list.forEach((current, index) => {
      const previous = index > 0 ? list[index - 1] : null;
      const created = ms(meta(current.item).creationTimestamp);
      let time = created;
      const history = meta(current.item).annotations?.['deployment.kubernetes.io/revision-history'];
      const detail = [];
      // An old ReplicaSet brought back by a rollback keeps its creation time; the newest revision's
      // real time is when the Deployment last progressed.
      if (history && index === list.length - 1) {
        const progressing = (deploymentByKey.get(key)?.status?.conditions || []).find(c => c.type === 'Progressing');
        const moved = ms(progressing?.lastUpdateTime || progressing?.lastTransitionTime);
        if (Number.isFinite(moved) && moved > created) time = moved;
        detail.push(`Rolled back: this template was revision ${history} before.`);
      }
      if (!Number.isFinite(time)) return;
      const changes = previous ? summarizeTemplateChange(previous.template, current.template) : [];
      const rollback = Boolean(history);
      const title = !previous ? `${name} created` : rollback ? `${name} rolled back (revision ${current.revision})` : `${name} rolled out revision ${current.revision}`;
      const summary = previous ? changes.join(' · ') || 'No pod template change' : `${kind} created · ${imagesOf(current.template).join(', ')}`;
      detail.push(`${kind === 'Deployment' ? 'ReplicaSet' : 'ControllerRevision'} ${meta(current.item).name} · revision ${current.revision}`);
      if (previous) detail.push(...changes.map(change => `• ${change}`));
      out.push({
        id: `rollout|${key}|${meta(current.item).uid || meta(current.item).name}`,
        time, category: 'rollouts', severity: 'info', change: true, title, summary: clip(summary, 220), detail,
        ref: { kind, namespace, name }, namespace, target: key, affects: [key],
        diff: previous ? { before: toYaml(redactTemplate(previous.template)), after: toYaml(redactTemplate(current.template)), beforeLabel: `revision ${previous.revision}`, afterLabel: `revision ${current.revision}` } : null,
        count: 1, source: kind === 'Deployment' ? 'replicasets' : 'controllerrevisions', healthy: fullyAvailable(current.item), revisionName: meta(current.item).name,
      });
    });
  }
  return out;
}

const WAITING_REASONS = new Set(['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError', 'CreateContainerError', 'InvalidImageName', 'RunContainerError']);
const condition = (item, type) => (item?.status?.conditions || []).find(c => c.type === type);

// Restarts and terminations from pod status: last terminations, and containers stuck waiting.
export function podEntries(pods = [], index = buildIndex()) {
  const out = [];
  for (const pod of pods) {
    const { namespace, name } = meta(pod);
    const target = index.ownerOf('Pod', namespace, name);
    const ref = { kind: 'Pod', namespace, name };
    const statuses = [...(pod.status?.initContainerStatuses || []).map(s => ({ ...s, init: true })), ...(pod.status?.containerStatuses || [])];
    for (const cs of statuses) {
      const label = `${cs.init ? 'init container' : 'container'} ${cs.name}`;
      const last = cs.lastState?.terminated;
      if (last && Number.isFinite(ms(last.finishedAt))) {
        const failed = last.exitCode !== 0 || (last.reason && last.reason !== 'Completed');
        const severity = last.reason === 'OOMKilled' ? 'critical' : failed ? 'warning' : 'info';
        out.push({
          id: `term|${namespace}/${name}|${cs.name}|${last.finishedAt}`, time: ms(last.finishedAt), first: ms(last.startedAt) || undefined, category: 'restarts', severity, change: false,
          title: `${label} ${last.reason === 'OOMKilled' ? 'was OOMKilled' : `restarted (${[last.reason, `exit ${last.exitCode}`].filter(Boolean).join(', ')})`}`,
          summary: `${plural(cs.restartCount || 0, 'restart')} so far${last.message ? ` · ${clip(last.message, 120)}` : ''}`,
          detail: [`Started ${last.startedAt || '—'}`, `Finished ${last.finishedAt}`, last.signal ? `Signal ${last.signal}` : '', last.message ? `Message: ${clip(last.message, 400)}` : ''].filter(Boolean),
          ref, namespace, target, affects: [], count: 1, source: 'pods',
        });
      }
      const waiting = cs.state?.waiting;
      if (waiting && WAITING_REASONS.has(waiting.reason)) {
        const since = ms(last?.finishedAt) || ms(condition(pod, 'ContainersReady')?.lastTransitionTime) || ms(condition(pod, 'Ready')?.lastTransitionTime) || ms(pod.status?.startTime) || ms(meta(pod).creationTimestamp);
        if (!Number.isFinite(since)) continue;
        out.push({
          id: `wait|${namespace}/${name}|${cs.name}|${waiting.reason}`, time: since, category: 'restarts', severity: 'critical', change: false,
          title: `${label} ${waiting.reason}`, summary: clip(waiting.message || waiting.reason, 200), detail: [waiting.message ? `Message: ${clip(waiting.message, 400)}` : '', `Image ${cs.image || '—'}`].filter(Boolean),
          ref, namespace, target, affects: [], count: 1, source: 'pods',
        });
      }
    }
    if (pod.status?.reason === 'Evicted') {
      const time = ms(condition(pod, 'Ready')?.lastTransitionTime) || ms(pod.status?.startTime) || ms(meta(pod).creationTimestamp);
      if (Number.isFinite(time)) out.push({ id: `evict|${namespace}/${name}`, time, category: 'restarts', severity: 'warning', change: false, title: 'Pod evicted', summary: clip(pod.status.message || 'Evicted', 200), detail: [], ref, namespace, target, affects: [], count: 1, source: 'pods' });
    }
  }
  return out;
}

// Normal events worth a line: the rest (Scheduled, Pulling, Created, Started…) is noise here.
const NORMAL_EVENTS = {
  ScalingReplicaSet: 'scaling', SuccessfulRescale: 'scaling', Killing: 'restarts', Pulled: 'rollouts',
  SuccessfulCreate: 'scaling', SuccessfulDelete: 'scaling', SawCompletedJob: 'jobs', Completed: 'jobs',
  NodeReady: 'nodes', NodeNotReady: 'nodes', NodeNotSchedulable: 'nodes', NodeSchedulable: 'nodes', Rebooted: 'nodes', RegisteredNode: 'nodes', RemovingNode: 'nodes',
  NodeHasDiskPressure: 'nodes', NodeHasInsufficientMemory: 'nodes', NodeHasInsufficientPID: 'nodes',
};
// Repeated per pod or container: one entry per object and reason, with the count.
const GROUPED_NORMAL = new Set(['SuccessfulCreate', 'SuccessfulDelete', 'Killing', 'Pulled']);
const NODE_PROBLEM_EVENTS = new Set(['NodeNotReady', 'NodeHasDiskPressure', 'NodeHasInsufficientMemory', 'NodeHasInsufficientPID', 'Rebooted']);
export const eventTime = event => ms(event.lastTimestamp || event.eventTime || event.series?.lastObservedTime || meta(event).creationTimestamp);
const eventFirst = event => ms(event.firstTimestamp || event.eventTime || meta(event).creationTimestamp);
const eventCount = event => event.series?.count || event.count || 1;
const involvedOf = event => event.involvedObject || event.regarding || {};

function normalCategory(event) {
  const reason = event.reason;
  const kind = involvedOf(event).kind;
  if (reason === 'Pulled') return /^Successfully pulled/i.test(event.message || event.note || '') ? 'rollouts' : null;
  if ((reason === 'SuccessfulCreate' || reason === 'SuccessfulDelete') && (kind === 'Job' || kind === 'CronJob')) return 'jobs';
  return NORMAL_EVENTS[reason] || null;
}

// Warning events grouped by object and reason (count, first and last time); a curated set of Normal ones.
export function eventEntries(events = [], index = buildIndex()) {
  const groups = new Map();
  for (const event of events) {
    const warning = event.type === 'Warning';
    const category = warning ? (involvedOf(event).kind === 'Node' ? 'nodes' : 'warnings') : normalCategory(event);
    if (!category) continue;
    const obj = involvedOf(event);
    const message = (event.message || event.note || '').replace(/^\(combined from similar events\):\s*/, '');
    const key = warning || GROUPED_NORMAL.has(event.reason) ? `${obj.kind}|${obj.namespace || ''}|${obj.name}|${event.reason}` : `${obj.kind}|${obj.namespace || ''}|${obj.name}|${event.reason}|${message}`;
    const last = eventTime(event); const first = eventFirst(event);
    if (!Number.isFinite(last)) continue;
    const group = groups.get(key);
    if (!group) groups.set(key, { event, category, warning, message, last, first: Number.isFinite(first) ? first : last, count: eventCount(event) });
    else {
      group.count += eventCount(event);
      if (Number.isFinite(first)) group.first = Math.min(group.first, first);
      if (last >= group.last) { group.last = last; group.message = message; group.event = event; }
    }
  }
  const out = [];
  for (const [key, group] of groups) {
    const obj = involvedOf(group.event);
    const namespace = obj.namespace || meta(group.event).namespace || '';
    const kind = obj.kind || '';
    const target = ['Pod', 'ReplicaSet', 'Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'HorizontalPodAutoscaler'].includes(kind) ? index.ownerOf(kind, namespace, obj.name) : obj.name ? workloadKey(kind, namespace, obj.name) : null;
    const severity = group.warning ? 'warning' : NODE_PROBLEM_EVENTS.has(group.event.reason) ? 'warning' : 'info';
    const scaling = group.category === 'scaling' && ['ScalingReplicaSet', 'SuccessfulRescale'].includes(group.event.reason);
    out.push({
      id: `event|${key}`, time: group.last, first: group.first, category: group.category, severity, change: scaling,
      title: group.warning ? group.event.reason : clip(group.message || group.event.reason, 140),
      summary: group.warning ? clip(group.message, 220) : group.count > 1 ? `${group.event.reason} · ${group.count} events, the latest shown` : group.event.reason,
      detail: [group.count > 1 ? `${plural(group.count, 'time')} between ${new Date(group.first).toISOString()} and ${new Date(group.last).toISOString()}` : '', group.event.source?.component || group.event.reportingController ? `Reported by ${group.event.source?.component || group.event.reportingController}` : '', group.warning ? `Message: ${clip(group.message, 600)}` : ''].filter(Boolean),
      ref: { kind, apiVersion: obj.apiVersion, namespace, name: obj.name }, namespace, target, affects: scaling && target ? [target] : [], count: group.count, source: 'events', reason: group.event.reason,
    });
  }
  return out;
}

// ConfigMaps and Secrets (names only) from /api/timeline/config: creation and each writer's last write.
const CONFIG_NOISE = [/^kube-root-ca\.crt$/, /^sh\.helm\.release\.v1\./, /-token-[a-z0-9]{5}$/];
export function configEntries(items = [], index = buildIndex()) {
  const out = [];
  for (const item of items) {
    if (!item?.name || CONFIG_NOISE.some(re => re.test(item.name))) continue;
    const key = workloadKey(item.kind, item.namespace, item.name);
    const affects = index.users(key);
    const users = affects.length ? `Used by ${listWithMore(affects.map(keyName), 4)}` : 'Not used by a workload in view';
    const ref = { kind: item.kind, namespace: item.namespace, name: item.name };
    const created = ms(item.created);
    if (Number.isFinite(created)) out.push({ id: `config|${key}|created`, time: created, category: 'config', severity: 'info', change: true, title: `${item.kind} ${item.name} created`, summary: users, detail: [item.owner ? `Owned by ${item.owner}` : ''].filter(Boolean), ref, namespace: item.namespace, target: key, affects, count: 1, source: 'config' });
    const writes = (item.writes || []).filter(write => !write.subresource && ['Update', 'Apply'].includes(write.operation) && ms(write.time) > (Number.isFinite(created) ? created + 2000 : -Infinity));
    for (const write of writes) {
      out.push({
        id: `config|${key}|${write.manager}|${write.operation}|${write.time}`, time: ms(write.time), category: 'config', severity: 'info', change: true,
        title: `${item.kind} ${item.name} updated`, summary: `by ${write.manager || 'unknown'} (${write.operation === 'Apply' ? 'server-side apply' : 'update'}) · ${users}`,
        detail: [`Kubernetes keeps the last write time per writer; earlier writes by ${write.manager || 'this writer'} are not recorded.`, item.kind === 'Secret' ? 'Secret values are never read for the timeline.' : ''].filter(Boolean),
        ref, namespace: item.namespace, target: key, affects, count: 1, source: 'config',
      });
    }
  }
  return out;
}

export function hpaEntries(hpas = []) {
  const out = [];
  for (const hpa of hpas) {
    const time = ms(hpa.status?.lastScaleTime);
    if (!Number.isFinite(time)) continue;
    const { namespace, name } = meta(hpa);
    const scaleRef = hpa.spec?.scaleTargetRef || {};
    const target = scaleRef.name ? workloadKey(scaleRef.kind || 'Deployment', namespace, scaleRef.name) : null;
    out.push({
      id: `hpa|${namespace}/${name}|${hpa.status.lastScaleTime}`, time, category: 'scaling', severity: 'info', change: true,
      title: `Autoscaler scaled ${scaleRef.name || name} to ${hpa.status?.desiredReplicas ?? hpa.status?.currentReplicas ?? '?'}`,
      summary: `${hpa.status?.currentReplicas ?? '?'} running · min ${hpa.spec?.minReplicas ?? 1}, max ${hpa.spec?.maxReplicas ?? '?'}`,
      detail: [], ref: { kind: 'HorizontalPodAutoscaler', namespace, name }, namespace, target, affects: target ? [target] : [], count: 1, source: 'horizontalpodautoscalers',
    });
  }
  return out;
}

export function jobEntries({ jobs = [], cronJobs = [] } = {}, index = buildIndex()) {
  const out = [];
  for (const job of jobs) {
    const { namespace, name } = meta(job);
    const ref = { kind: 'Job', namespace, name };
    const target = index.ownerOf('Job', namespace, name);
    const base = { category: 'jobs', change: false, ref, namespace, target, affects: [], count: 1, source: 'jobs' };
    const started = ms(job.status?.startTime);
    if (Number.isFinite(started)) out.push({ ...base, id: `job|${namespace}/${name}|start`, time: started, severity: 'info', title: `Job ${name} started`, summary: target && !target.startsWith('Job/') ? `Run of ${keyName(target)}` : 'Started', detail: [] });
    const completed = ms(job.status?.completionTime);
    if (Number.isFinite(completed)) out.push({ ...base, id: `job|${namespace}/${name}|complete`, time: completed, severity: 'info', title: `Job ${name} completed`, summary: `${plural(job.status?.succeeded || 0, 'pod')} succeeded`, detail: [] });
    const failed = (job.status?.conditions || []).find(c => c.type === 'Failed' && c.status === 'True');
    if (failed && Number.isFinite(ms(failed.lastTransitionTime))) out.push({ ...base, id: `job|${namespace}/${name}|failed`, time: ms(failed.lastTransitionTime), first: started || undefined, severity: 'warning', title: `Job ${name} failed${failed.reason ? `: ${failed.reason}` : ''}`, summary: clip(failed.message || failed.reason || 'Failed', 200), detail: [`${plural(job.status?.failed || 0, 'failed pod')}`] });
  }
  for (const cron of cronJobs) {
    const { namespace, name } = meta(cron);
    const time = ms(cron.status?.lastScheduleTime);
    if (!Number.isFinite(time)) continue;
    const success = cron.status?.lastSuccessfulTime;
    out.push({ id: `cron|${namespace}/${name}|${cron.status.lastScheduleTime}`, time, category: 'jobs', severity: 'info', change: false, title: `CronJob ${name} scheduled a run`, summary: `Schedule ${cron.spec?.schedule || '—'}${success ? ` · last success ${success}` : ''}${cron.spec?.suspend ? ' · suspended' : ''}`, detail: [], ref: { kind: 'CronJob', namespace, name }, namespace, target: workloadKey('CronJob', namespace, name), affects: [], count: 1, source: 'cronjobs' });
  }
  return out;
}

const chartVersion = chart => { const m = /^(.*)-(\d[\w.+-]*)$/.exec(chart || ''); return m ? { name: m[1], version: m[2] } : { name: chart || '', version: '' }; };
// Helm release revisions from /api/timeline/helm.
export function helmEntries(releases = [], index = buildIndex()) {
  const out = [];
  for (const release of releases) {
    const history = [...(release.history || [])].sort((a, b) => a.revision - b.revision);
    const affects = index.managed(release.namespace, release.name);
    history.forEach((revision, i) => {
      const time = ms(revision.updated);
      if (!Number.isFinite(time)) return;
      const previous = i > 0 ? history[i - 1] : null;
      const changes = [];
      if (previous) {
        const a = chartVersion(previous.chart); const b = chartVersion(revision.chart);
        if (previous.chart !== revision.chart) changes.push(a.name === b.name ? `${b.name} ${a.version} → ${b.version}` : `${previous.chart} → ${revision.chart}`);
        if (previous.appVersion !== revision.appVersion && revision.appVersion) changes.push(`app ${previous.appVersion || '—'} → ${revision.appVersion}`);
      }
      const failed = /failed/i.test(revision.status || '');
      const rollback = /^rollback/i.test(revision.description || '');
      const verb = revision.revision === 1 || (!previous && /install/i.test(revision.description || '')) ? 'installed' : rollback ? 'rolled back' : 'upgraded';
      out.push({
        id: `helm|${release.namespace}/${release.name}|${revision.revision}`, time, category: 'gitops', severity: failed ? 'warning' : 'info', change: true,
        title: `Helm release ${release.name} ${verb}${verb === 'installed' ? '' : ` to revision ${revision.revision}`}${failed ? ' (failed)' : ''}`,
        summary: [changes.join(' · ') || revision.chart, revision.description].filter(Boolean).join(' · '),
        detail: [`Revision ${revision.revision} · ${revision.status || '—'}`, `Chart ${revision.chart || '—'}${revision.appVersion ? ` · app ${revision.appVersion}` : ''}`, revision.description ? `Description: ${clip(revision.description, 300)}` : ''].filter(Boolean),
        ref: { kind: 'HelmRelease', namespace: release.namespace, name: release.name }, namespace: release.namespace, target: `HelmRelease/${release.namespace}/${release.name}`, affects, count: 1, source: 'helm',
      });
    });
  }
  return out;
}

const shortRevision = revision => (/^[0-9a-f]{12,}$/i.test(revision || '') ? revision.slice(0, 7) : revision || '');
// Argo CD applications whose app or destination namespace is in scope ('*' = all).
export function argoEntries(apps = [], index = buildIndex(), namespace = '*') {
  const out = [];
  for (const app of apps) {
    const { namespace: appNamespace, name } = meta(app);
    const destination = app.spec?.destination?.namespace || '';
    if (namespace !== '*' && namespace !== appNamespace && namespace !== destination) continue;
    const ref = { kind: 'Application', apiVersion: 'argoproj.io/v1alpha1', namespace: appNamespace, name };
    const affects = index.managed(destination, name);
    const base = { category: 'gitops', ref, namespace: destination || appNamespace, target: `Application/${appNamespace}/${name}`, affects, count: 1, source: 'applications' };
    const op = app.status?.operationState;
    const opTime = ms(op?.finishedAt || op?.startedAt);
    const opRevision = op?.syncResult?.revision || op?.operation?.sync?.revision || '';
    if (op && Number.isFinite(opTime)) {
      const failed = ['Failed', 'Error'].includes(op.phase);
      out.push({ ...base, id: `argo|${appNamespace}/${name}|op|${op.startedAt}`, time: opTime, first: ms(op.startedAt) || undefined, severity: failed ? 'warning' : 'info', change: !failed,
        title: failed ? `Argo CD sync of ${name} failed` : op.phase === 'Running' ? `Argo CD is syncing ${name}` : `Argo CD synced ${name}${opRevision ? ` to ${shortRevision(opRevision)}` : ''}`,
        summary: clip(op.message || op.phase || '', 220), detail: [`Phase ${op.phase || '—'}`, op.startedAt ? `Started ${op.startedAt}` : '', op.finishedAt ? `Finished ${op.finishedAt}` : '', opRevision ? `Revision ${opRevision}` : '', op.message ? `Message: ${clip(op.message, 400)}` : ''].filter(Boolean) });
    }
    for (const deployed of app.status?.history || []) {
      const time = ms(deployed.deployedAt);
      if (!Number.isFinite(time) || (Math.abs(time - opTime) < 2000 && (deployed.revision || '') === opRevision)) continue;
      out.push({ ...base, id: `argo|${appNamespace}/${name}|history|${deployed.id ?? deployed.deployedAt}`, time, severity: 'info', change: true, title: `Argo CD deployed ${name}${deployed.revision ? ` at ${shortRevision(deployed.revision)}` : ''}`, summary: deployed.source?.repoURL ? clip(`${deployed.source.repoURL}${deployed.source.path ? ` · ${deployed.source.path}` : ''}`, 200) : 'Deployment recorded in the application history', detail: [] });
    }
    const health = app.status?.health;
    if (health?.lastTransitionTime && Number.isFinite(ms(health.lastTransitionTime))) {
      const bad = ['Degraded', 'Missing'].includes(health.status);
      out.push({ ...base, id: `argo|${appNamespace}/${name}|health|${health.lastTransitionTime}`, time: ms(health.lastTransitionTime), severity: bad ? 'warning' : 'info', change: false, title: `${name} became ${health.status}`, summary: clip(health.message || `Argo CD health ${health.status}`, 200), detail: [] });
    }
  }
  return out;
}

const PRESSURE = new Set(['MemoryPressure', 'DiskPressure', 'PIDPressure', 'NetworkUnavailable']);
// Node condition transitions; the ones that happened while the node booted are not changes.
export function nodeEntries(nodes = []) {
  const out = [];
  for (const node of nodes) {
    const { name } = meta(node);
    const created = ms(meta(node).creationTimestamp);
    const ref = { kind: 'Node', namespace: '', name };
    const base = { category: 'nodes', change: false, ref, namespace: '', target: workloadKey('Node', '', name), affects: [], count: 1, source: 'nodes' };
    if (Number.isFinite(created)) out.push({ ...base, id: `node|${name}|joined`, time: created, severity: 'info', title: `Node ${name} joined`, summary: [node.status?.nodeInfo?.kubeletVersion, node.status?.nodeInfo?.osImage].filter(Boolean).join(' · '), detail: [] });
    for (const c of node.status?.conditions || []) {
      const time = ms(c.lastTransitionTime);
      if (!Number.isFinite(time)) continue;
      const healthy = c.type === 'Ready' ? c.status === 'True' : c.status !== 'True';
      if (healthy && Number.isFinite(created) && time - created < 5 * MINUTE) continue;
      if (c.type !== 'Ready' && !PRESSURE.has(c.type) && healthy) continue;
      const title = c.type === 'Ready' ? (healthy ? `Node ${name} became Ready` : `Node ${name} became NotReady`) : healthy ? `${c.type} cleared on ${name}` : `${c.type} on ${name}`;
      out.push({ ...base, id: `node|${name}|${c.type}|${c.lastTransitionTime}`, time, severity: healthy ? 'info' : c.type === 'Ready' ? 'critical' : 'warning', title, summary: clip(c.message || c.reason || '', 200), detail: c.reason ? [`Reason ${c.reason}`] : [] });
    }
  }
  return out;
}

// The events a rollout makes (scaling its ReplicaSets, creating and stopping pods) are folded into the
// rollout's entry instead of each taking a line: what is left is what someone changed and what broke.
const ROLLOUT_MECHANICS = new Set(['ScalingReplicaSet', 'SuccessfulCreate', 'SuccessfulDelete', 'Killing']);
export const ROLLOUT_SPAN = 10 * MINUTE;
export const ROLLOUT_GAP = 45_000;
const namesRevision = (event, name) => Boolean(name) && (event.ref?.name === name || (event.ref?.kind === 'Pod' && event.ref.name.startsWith(`${name}-`)) || new RegExp(`(?:Scaled up replica set|Created pod:) ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(event.title || ''));
export function absorbRolloutEvents(entries) {
  const rollouts = new Map(); const candidates = new Map();
  for (const entry of entries) {
    if (entry.category === 'rollouts' && entry.change && entry.target) { if (!rollouts.has(entry.target)) rollouts.set(entry.target, []); rollouts.get(entry.target).push(entry); }
    else if (entry.source === 'events' && entry.severity === 'info' && ROLLOUT_MECHANICS.has(entry.reason) && entry.target) { if (!candidates.has(entry.target)) candidates.set(entry.target, []); candidates.get(entry.target).push(entry); }
  }
  const absorbed = new Map(); const taken = new Set();
  for (const [target, list] of rollouts) {
    list.sort((a, b) => a.time - b.time);
    const events = (candidates.get(target) || []).sort((a, b) => startOf(a) - startOf(b));
    list.forEach((rollout, i) => {
      const next = list[i + 1];
      // A rollout's events follow it closely; a pause longer than ROLLOUT_GAP ends it (a later manual
      // scale is a change of its own).
      let last = rollout.time;
      for (const event of events) {
        if (taken.has(event.id)) continue;
        const start = startOf(event);
        if (start < rollout.time - 5000) continue;
        if (start - last > ROLLOUT_GAP || event.time > rollout.time + ROLLOUT_SPAN || (next && start >= next.time - 5000)) break;
        taken.add(event.id); last = Math.max(last, start);
        // Two rollouts in the same second: an event naming a ReplicaSet goes to the rollout that made it.
        const named = list.find(other => namesRevision(event, other.revisionName) && start >= other.time - 5000 && start <= other.time + ROLLOUT_SPAN) || rollout;
        if (!absorbed.has(named.id)) absorbed.set(named.id, []);
        absorbed.get(named.id).push(event);
      }
    });
  }
  return entries.filter(entry => !taken.has(entry.id)).map(entry => {
    const events = absorbed.get(entry.id);
    return events ? { ...entry, progress: events.map(event => ({ time: event.time, text: event.title, count: event.count })) } : entry;
  });
}

// Every source normalised, newest first.
export function buildEntries(sources = {}, { namespace = '*' } = {}) {
  const index = buildIndex(sources);
  const entries = [
    ...rolloutEntries(sources),
    ...podEntries(sources.pods, index),
    ...eventEntries(sources.events, index),
    ...configEntries(sources.config, index),
    ...hpaEntries(sources.hpas),
    ...jobEntries(sources, index),
    ...helmEntries(sources.helm, index),
    ...argoEntries(sources.applications, index, namespace),
    ...nodeEntries(sources.nodes),
  ];
  const seen = new Set();
  const unique = entries.filter(entry => { if (seen.has(entry.id)) return false; seen.add(entry.id); return true; });
  return { entries: absorbRolloutEvents(unique).sort(byTimeDesc), index };
}
export const byTimeDesc = (a, b) => b.time - a.time || (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3) || a.id.localeCompare(b.id);

// ---- Correlation -------------------------------------------------------------------------------------

const isIncident = entry => (entry.severity === 'warning' || entry.severity === 'critical') && ['warnings', 'restarts', 'jobs'].includes(entry.category) && entry.target;
const startOf = entry => (Number.isFinite(entry.first) ? Math.min(entry.first, entry.time) : entry.time);

// Warnings and restarts on one workload, clustered in time.
export function bursts(entries, { gap = BURST_GAP } = {}) {
  const byTarget = new Map();
  for (const entry of entries) if (isIncident(entry)) { if (!byTarget.has(entry.target)) byTarget.set(entry.target, []); byTarget.get(entry.target).push(entry); }
  const out = [];
  for (const [target, list] of byTarget) {
    list.sort((a, b) => startOf(a) - startOf(b));
    let current = null;
    for (const entry of list) {
      const start = startOf(entry);
      if (!current || start - current.end > gap) { current = { id: `${target}@${start}`, target, start, end: entry.time, entries: [], count: 0 }; out.push(current); }
      current.entries.push(entry); current.count += entry.count || 1; current.end = Math.max(current.end, entry.time);
    }
  }
  return out.sort((a, b) => b.start - a.start);
}

const minutesText = delta => { const m = Math.round(delta / MINUTE); return m <= 0 ? 'just before' : `${m} min before`; };

// Marks changes that happened shortly before a burst of warnings or restarts on a workload they affect:
// change.related = [{ burst, text }], incident.causes = [change ids]. Returns new entry objects.
export function correlate(entries, { window = CORRELATION_WINDOW, slack = CORRELATION_SLACK, gap = BURST_GAP } = {}) {
  const found = bursts(entries, { gap });
  const related = new Map(); const causes = new Map();
  const changes = entries.filter(entry => entry.change && entry.affects?.length);
  for (const burst of found) {
    // The newest revision of the workload that is fully available and older than the burst ran with
    // everything changed before it: only what changed after it can explain the burst.
    const baseline = Math.max(-Infinity, ...entries.filter(entry => entry.category === 'rollouts' && entry.healthy && entry.target === burst.target && entry.time < burst.start).map(entry => entry.time));
    for (const change of changes) {
      if (!change.affects.includes(burst.target)) continue;
      if (change.time < burst.start - window || change.time > burst.start + slack) continue;
      if (change.time <= baseline + BASELINE_GRACE) continue;
      // A change is not the cause of the symptoms it reports itself (an autoscaler reacting to a crash).
      if (burst.entries.some(entry => entry.id === change.id)) continue;
      const what = burst.entries.some(entry => entry.category === 'restarts') ? (burst.entries.every(entry => entry.category === 'restarts') ? 'restarts' : 'warnings and restarts') : burst.entries.some(entry => entry.category === 'jobs') ? 'job failures' : 'warnings';
      const text = `${minutesText(burst.start - change.time)} ${plural(burst.count, what.replace(/s$/, ''), what)} on ${keyName(burst.target)}`.replace(/^just before/, 'Just before');
      if (!related.has(change.id)) related.set(change.id, []);
      related.get(change.id).push({ burst: burst.id, target: burst.target, start: burst.start, text: text[0].toUpperCase() + text.slice(1) });
      for (const entry of burst.entries) { if (!causes.has(entry.id)) causes.set(entry.id, new Set()); causes.get(entry.id).add(change.id); }
    }
  }
  return entries.map(entry => {
    if (!related.has(entry.id) && !causes.has(entry.id)) return entry;
    return { ...entry, ...(related.has(entry.id) ? { related: related.get(entry.id) } : {}), ...(causes.has(entry.id) ? { causes: [...causes.get(entry.id)] } : {}) };
  });
}

// ---- Problem focus ("What changed?") -----------------------------------------------------------------

// The window to show for a problem: FOCUS_BEFORE before it started until FOCUS_AFTER after. The
// problem's own time can be its latest symptom (a crash loop's last exit), so the start of the burst of
// incidents on the same workload wins when it is earlier.
export function focusWindow(problem, entries, index, { now = Date.now(), before = FOCUS_BEFORE, after = FOCUS_AFTER, gap = BURST_GAP } = {}) {
  const kind = kindForResource(problem.resource) || problem.kind || '';
  const target = kind && index ? index.ownerOf(kind, problem.namespace, problem.name) : null;
  const since = ms(problem.since);
  let start = Number.isFinite(since) ? since : now;
  if (target) {
    const burst = bursts(entries, { gap }).find(item => item.target === target && item.start <= start + gap && item.end >= start - gap);
    if (burst && burst.start < start) start = burst.start;
  }
  return { from: start - before, to: start + after, start, target, ref: { kind, namespace: problem.namespace, name: problem.name } };
}
export const matchesFocus = (entry, focus) => Boolean(focus && ((focus.target && (entry.target === focus.target || entry.affects?.includes(focus.target))) || (entry.ref?.kind === focus.ref?.kind && entry.ref?.name === focus.ref?.name && (entry.ref?.namespace || '') === (focus.ref?.namespace || ''))));

// ---- Filtering, counting, grouping, the density strip ------------------------------------------------

export function matchesText(entry, text) {
  const needle = String(text || '').trim().toLowerCase();
  if (!needle) return true;
  const hay = [entry.title, entry.summary, entry.ref?.kind, entry.ref?.name, entry.ref?.namespace, entry.target ? keyName(entry.target) : '', ...(entry.detail || [])].join(' ').toLowerCase();
  return needle.split(/\s+/).every(word => hay.includes(word));
}
// Entries in [from, to] matching the text, before the category filter: what the chips count. A grouped
// entry that began in the window but was last seen after it is placed at its first time (firstShown).
export function inWindow(entries, { from = -Infinity, to = Infinity, text = '', relatedOnly = false } = {}) {
  const out = [];
  for (const entry of entries) {
    if (!matchesText(entry, text) || (relatedOnly && !entry.related?.length && !entry.causes?.length)) continue;
    if (entry.time >= from && entry.time <= to) out.push(entry);
    else if (entry.time > to && Number.isFinite(entry.first) && entry.first >= from && entry.first <= to) out.push({ ...entry, time: entry.first, lastTime: entry.time, firstShown: true });
  }
  return out.sort(byTimeDesc);
}
export function filterEntries(entries, { categories = null, ...rest } = {}) {
  return inWindow(entries, rest).filter(entry => !categories || categories.has(entry.category));
}
export function countByCategory(entries) {
  const counts = Object.fromEntries(CATEGORIES.map(category => [category.id, 0]));
  for (const entry of entries) counts[entry.category] = (counts[entry.category] || 0) + 1;
  return counts;
}

// The size of the time buckets entries are grouped under, for a window of rangeMs.
export function bucketSize(rangeMs) {
  if (rangeMs <= 2 * HOUR) return 5 * MINUTE;
  if (rangeMs <= 6 * HOUR) return 30 * MINUTE;
  if (rangeMs <= DAY) return 2 * HOUR;
  return DAY;
}
// Groups (newest first) of entries by bucket; buckets align to local time (offsetMs = minutes east × 60000).
export function groupEntries(entries, size, { offsetMs = 0 } = {}) {
  const groups = [];
  let current = null;
  for (const entry of [...entries].sort(byTimeDesc)) {
    const start = Math.floor((entry.time + offsetMs) / size) * size - offsetMs;
    if (!current || current.start !== start) { current = { start, end: start + size, entries: [] }; groups.push(current); }
    current.entries.push(entry);
  }
  return groups;
}
// The density strip: bins across [from, to] with totals, warnings and whether a rollout happened.
export function histogram(entries, { from, to, bins = 60 } = {}) {
  const width = Math.max(1, (to - from) / bins);
  const out = Array.from({ length: bins }, (_, i) => ({ index: i, start: from + i * width, end: from + (i + 1) * width, total: 0, warnings: 0, changes: 0, rollouts: 0, related: 0 }));
  for (const entry of entries) {
    if (entry.time < from || entry.time > to) continue;
    const bin = out[Math.min(bins - 1, Math.floor((entry.time - from) / width))];
    bin.total++;
    if (entry.severity === 'warning' || entry.severity === 'critical') bin.warnings++; else bin.changes++;
    if (entry.category === 'rollouts' && entry.change) bin.rollouts++;
    if (entry.related?.length) bin.related++;
  }
  return out;
}

// "14:05" for the strip and group labels, in the viewer's time zone (offsetMs as above).
export function clock(time, { offsetMs = 0, seconds = false, day = false } = {}) {
  const d = new Date(time + offsetMs);
  const pad = n => String(n).padStart(2, '0');
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${seconds ? `:${pad(d.getUTCSeconds())}` : ''}`;
  if (!day) return hm;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${hm}`;
}
// "3 min ago", "2 h ago", "4 d ago".
export function ago(time, now = Date.now()) {
  const delta = Math.max(0, now - time);
  if (delta < MINUTE) return 'just now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)} min ago`;
  if (delta < DAY) { const h = Math.floor(delta / HOUR); const m = Math.floor((delta % HOUR) / MINUTE); return m && h < 6 ? `${h} h ${m} min ago` : `${h} h ago`; }
  return `${Math.floor(delta / DAY)} d ago`;
}
