// Incident snapshot: everything an on-call engineer needs about one pod, workload or namespace, as
// one Markdown report that is safe to paste into a ticket or a chat. Pure: redaction, the report
// model and its Markdown, with no DOM and no requests; snapshot.js collects the data and draws.
import { diagnosePod, diagnosePods } from './diagnose.js';
import { healthTone, workloadState, replicaCounts } from './health.js';
import { matchesSelector, parseCPU, parseMemory, formatCPU, formatBytes } from './format.js';

export const MASK = '‹redacted›';
export const WORKLOAD_RESOURCES = ['deployments', 'statefulsets', 'daemonsets', 'replicasets', 'jobs', 'cronjobs'];
export const SNAPSHOT_RESOURCES = new Set(['pods', ...WORKLOAD_RESOURCES, 'namespaces']);
const KIND_OF = { pods: 'Pod', deployments: 'Deployment', statefulsets: 'StatefulSet', daemonsets: 'DaemonSet', replicasets: 'ReplicaSet', jobs: 'Job', cronjobs: 'CronJob', namespaces: 'Namespace' };
export const kindOf = resource => KIND_OF[resource] || resource;

// ---- Redaction ---------------------------------------------------------------------------------
// Names that say "the value next to me is a secret". Keys that only point at a secret (secretName,
// tokenPath, passwordFile) end in one of SAFE_SUFFIX and are left alone.
const SENSITIVE = 'passw(?:or)?d|passphrase|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|session[_-]?(?:id|key|token)|cookie|signature|dsn|connection[_-]?string|auth';
const SENSITIVE_KEY = new RegExp(`(?:${SENSITIVE})`, 'i');
const SAFE_SUFFIX = /(?:name|names|ref|path|file|dir|type|kind|url|uri|endpoint|length|count|size|ttl|seconds|expiry|expires|expiration|enabled|required|mode|header|policy|version|provider|method|issuer|audience|format)$/i;
export const sensitiveKey = key => SENSITIVE_KEY.test(key) && !SAFE_SUFFIX.test(String(key).replace(/[^A-Za-z]+$/, ''));
// Values that are clearly not secrets: empty, placeholders and references.
const HARMLESS = /^(?:|null|nil|none|<none>|true|false|yes|no|on|off|\*+|x+|‹redacted›|\[redacted\]|<redacted>|redacted|\$\(.*\)|\$\{.*\}|changeme)$/i;

const PATTERNS = [
  // PEM private keys, also when the block was cut off by the tail.
  [/-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?(?:-----END \1PRIVATE KEY-----|$)/g, () => MASK],
  // JSON Web Tokens.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g, () => MASK],
  // Authorization headers and bearer tokens.
  [/\b(authorization["']?[ \t]*[:=][ \t]*["']?)(?:(bearer|basic|token|digest|negotiate)[ \t]+)?([^\s"',;]+)/gi, (all, head, scheme) => `${head}${scheme ? `${scheme} ` : ''}${MASK}`],
  [/\b(bearer)([ \t]+)([A-Za-z0-9._~+/=-]{8,})/gi, (all, scheme, space) => `${scheme}${space}${MASK}`],
  // user:password@ in URLs.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:)([^\s@/'"]+)@/gi, (all, head) => `${head}${MASK}@`],
  // AWS access key ids and well-known token formats.
  [/\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|AROA|APKA)[A-Z0-9]{16}\b/g, () => MASK],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|glpat-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{35})\b/g, () => MASK],
  // password=…, "token": "…", api_key: …, --secret=…
  [/(^|[^A-Za-z0-9])([A-Za-z0-9_.-]*(?:passw(?:or)?d|passphrase|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|session[_-]?(?:id|key|token)|cookie|signature)[A-Za-z0-9_.-]*)(["']?[ \t]*[:=][ \t]*)(?:"([^"\n]*)"|'([^'\n]*)'|(\$\([^)\s]*\)|\$\{[^}\s]*\}|[^\s"'&,;}\])]+))/gi,
    (all, lead, key, sep, dq, sq, bare) => {
      const value = dq ?? sq ?? bare ?? '';
      if (!sensitiveKey(key.replace(/^[-.]+/, '')) || HARMLESS.test(value) || /^(?:\d{1,4}|[\d.]+(?:ms|s|m|h))$/.test(value)) return all;
      const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : '';
      return `${lead}${key}${sep}${quote}${MASK}${quote}`;
    }],
];

// A redactor counts what it masks, so the report can say how much it hid.
export function createRedactor() {
  const redactor = {
    count: 0,
    text(value) {
      if (typeof value !== 'string' || !value) return value;
      let out = value;
      for (const [pattern, replace] of PATTERNS) {
        out = out.replace(pattern, (...args) => {
          const next = replace(...args);
          if (next !== args[0]) redactor.count++;
          return next;
        });
      }
      return out;
    },
    mask() { redactor.count++; return MASK; },
  };
  return redactor;
}
export function redactText(text) { const r = createRedactor(); return { text: r.text(text), count: r.count }; }

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// A copy of a Kubernetes object fit for a report: no managedFields or last-applied configuration,
// Secret values replaced by their key names, likely secrets in env values, args and annotations masked.
export function sanitizeObject(object, redactor = createRedactor()) {
  if (!isObject(object)) return object;
  const copy = structuredClone(object);
  if (copy.metadata) {
    delete copy.metadata.managedFields;
    if (copy.metadata.annotations) {
      delete copy.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'];
      if (!Object.keys(copy.metadata.annotations).length) delete copy.metadata.annotations;
    }
  }
  if (copy.kind === 'Secret') {
    for (const field of ['data', 'stringData']) if (isObject(copy[field])) for (const key of Object.keys(copy[field])) copy[field][key] = redactor.mask();
  }
  const walk = (value, key) => {
    if (typeof value === 'string') return key && sensitiveKey(key) && !HARMLESS.test(value) ? redactor.mask() : redactor.text(value);
    if (Array.isArray(value)) {
      // ["--password", "hunter2"]: the value follows its flag.
      if ((key === 'args' || key === 'command') && value.every(item => typeof item === 'string')) {
        return value.map((item, index) => (index > 0 && /^--?[A-Za-z0-9_.-]+$/.test(value[index - 1]) && sensitiveKey(value[index - 1].replace(/^-+/, '')) && !HARMLESS.test(item) ? redactor.mask() : redactor.text(item)));
      }
      return value.map(item => walk(item, ''));
    }
    if (!isObject(value)) return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, k);
    // An env entry { name: DB_PASSWORD, value: … }.
    if (typeof value.name === 'string' && typeof value.value === 'string' && sensitiveKey(value.name) && !HARMLESS.test(value.value) && out.value !== MASK) out.value = redactor.mask();
    return out;
  };
  const result = {};
  for (const [k, v] of Object.entries(copy)) {
    if (k === 'kind' || k === 'apiVersion') { result[k] = v; continue; }
    if (copy.kind === 'Secret' && (k === 'data' || k === 'stringData')) { result[k] = v; continue; }
    // Labels, names and ids are not secrets; walking them only invites false positives.
    if (k === 'metadata' && isObject(v)) { result.metadata = { ...v, ...(v.annotations ? { annotations: walk(v.annotations, 'annotations') } : {}) }; continue; }
    result[k] = walk(v, k);
  }
  return result;
}

// ---- YAML --------------------------------------------------------------------------------------
const YAML_PLAIN = /^[A-Za-z0-9_./][A-Za-z0-9_./ ()@+=,:%~-]*$/;
const YAML_RESERVED = /^(?:true|false|yes|no|on|off|y|n|null|~|[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|0x[0-9a-f]+|0o[0-7]+|[-+]?\.inf|\.nan)$/i;
function yamlString(value) {
  if (value === '') return "''";
  if (YAML_PLAIN.test(value) && !YAML_RESERVED.test(value) && !/[\s:]$/.test(value) && !value.includes(': ') && !value.includes(' #') && !/^\d+:\d/.test(value)) return value;
  return JSON.stringify(value);
}
function yamlScalar(value, indent) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return '[]';
  if (isObject(value)) return '{}';
  const text = String(value);
  if (text.includes('\n') && !/^\s/.test(text) && !/[ \t]\n/.test(text) && !/\n\n$/.test(text)) {
    const body = text.endsWith('\n') ? text.slice(0, -1) : text;
    return `${text.endsWith('\n') ? '|' : '|-'}\n${body.split('\n').map(line => (line ? ' '.repeat(indent) + line : '')).join('\n')}`;
  }
  return yamlString(text);
}
function yamlLines(value, indent) {
  const pad = ' '.repeat(indent);
  const out = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if ((isObject(item) && Object.keys(item).length) || (Array.isArray(item) && item.length)) {
        const inner = yamlLines(item, indent + 2);
        out.push(`${pad}- ${inner[0].slice(indent + 2)}`, ...inner.slice(1));
      } else out.push(`${pad}- ${yamlScalar(item, indent + 2)}`);
    }
    return out;
  }
  for (const [key, item] of Object.entries(value)) {
    const name = yamlString(key);
    if (isObject(item) && Object.keys(item).length) out.push(`${pad}${name}:`, ...yamlLines(item, indent + 2));
    else if (Array.isArray(item) && item.length) out.push(`${pad}${name}:`, ...yamlLines(item, indent));
    else out.push(`${pad}${name}: ${yamlScalar(item, indent + 2)}`);
  }
  return out;
}
export function toYAML(value) {
  if (!isObject(value) && !Array.isArray(value)) return `${yamlScalar(value, 0)}\n`;
  if ((isObject(value) && !Object.keys(value).length) || (Array.isArray(value) && !value.length)) return `${yamlScalar(value, 0)}\n`;
  return `${yamlLines(value, 0).join('\n')}\n`;
}

// ---- Small formatters --------------------------------------------------------------------------
const time = value => { const t = Date.parse(value); return Number.isFinite(t) ? t : NaN; };
export function ageText(from, now) {
  const ms = now - (typeof from === 'number' ? from : time(from));
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
const ago = (from, now) => { const text = ageText(from, now); return text ? `${text} ago` : ''; };
export const isoTime = ms => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z').replace('T', ' ').replace('Z', ' UTC');
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
// One table cell: no line breaks, no pipes, bounded length.
export function cell(value, max = 200) {
  let text = String(value ?? '').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim();
  if (text.length > max) text = `${text.slice(0, max - 1)}…`;
  return text || ' ';
}
const code = value => { const text = String(value ?? ''); const ticks = text.includes('`') ? '``' : '`'; return `${ticks}${ticks.length > 1 ? ' ' : ''}${text}${ticks.length > 1 ? ' ' : ''}${ticks}`; };
// A fence that the content cannot close early.
export function fenced(text, lang = '') {
  const body = String(text ?? '').replace(/\n+$/, '');
  const fence = /^\s*```/m.test(body) ? '~~~~' : '```';
  return `${fence}${lang}\n${body}\n${fence}`;
}
function table(head, rows) {
  if (!rows.length) return '';
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(row => `| ${row.map(value => cell(value)).join(' | ')} |`)].join('\n');
}

// ---- Pods, containers, owners ------------------------------------------------------------------
// The word kubectl shows in its STATUS column.
export function podStatusText(pod) {
  if (pod.metadata?.deletionTimestamp) return 'Terminating';
  const status = pod.status || {};
  for (const cs of status.initContainerStatuses || []) {
    if (cs.state?.waiting?.reason && cs.state.waiting.reason !== 'PodInitializing') return `Init:${cs.state.waiting.reason}`;
    if (cs.state?.terminated && cs.state.terminated.exitCode !== 0) return `Init:${cs.state.terminated.reason || 'Error'}`;
  }
  for (const cs of status.containerStatuses || []) {
    if (cs.state?.waiting?.reason) return cs.state.waiting.reason;
  }
  for (const cs of status.containerStatuses || []) {
    if (cs.state?.terminated) return cs.state.terminated.reason || (cs.state.terminated.exitCode === 0 ? 'Completed' : 'Error');
  }
  if (status.reason) return status.reason;
  if (status.phase === 'Running' && (status.containerStatuses || []).some(cs => !cs.ready)) return 'Running (not ready)';
  return status.phase || 'Unknown';
}
export const restartsOf = pod => [...(pod.status?.initContainerStatuses || []), ...(pod.status?.containerStatuses || [])].reduce((sum, cs) => sum + (cs.restartCount || 0), 0);
export const readyOf = pod => { const statuses = pod.status?.containerStatuses || []; const total = (pod.spec?.containers || []).length || statuses.length; return `${statuses.filter(cs => cs.ready).length}/${total}`; };
const unhealthy = pod => ['bad', 'warn'].includes(healthTone('pods', pod));
const severityOfPod = pod => ({ bad: 0, warn: 1 }[healthTone('pods', pod)] ?? 2);

// The container a crash-looping run is explained by: the current terminated state, or the last one.
function lastTermination(cs, pod) {
  const terminated = cs.state?.terminated;
  if (terminated && terminated.exitCode !== 0 && pod?.spec?.restartPolicy !== 'Never' && cs.restartCount > 0) return terminated;
  return cs.lastState?.terminated || null;
}
// Whether a container's previous run is worth reading: it restarted, and that run ended badly.
export const crashed = (cs, pod) => (cs.restartCount || 0) > 0 && Boolean(lastTermination(cs, pod));

// Pods owned by an object: directly (owner uid), through owned ReplicaSets or Jobs, or by selector.
export function podsOf(object, resource, pods, intermediates = []) {
  const uid = object?.metadata?.uid;
  if (resource === 'pods') return pods.filter(pod => pod.metadata?.uid === uid || pod.metadata?.name === object?.metadata?.name);
  if (resource === 'namespaces') return pods;
  const owners = new Set([uid, ...intermediates.filter(item => (item.metadata?.ownerReferences || []).some(ref => ref.uid === uid)).map(item => item.metadata?.uid)].filter(Boolean));
  const selector = resource === 'cronjobs' ? null : object?.spec?.selector;
  return pods.filter(pod => (pod.metadata?.ownerReferences || []).some(ref => owners.has(ref.uid)) || (resource !== 'replicasets' && resource !== 'jobs' && selector && matchesSelector(selector, pod.metadata?.labels || {})));
}

// Which containers get their logs read, worst pods first: every container of up to maxPods pods,
// and the previous run of each container that crashed.
export function logTargets(pods, { maxPods = 4, previous = true, onlyUnhealthy = false } = {}) {
  const ranked = [...pods].filter(pod => !onlyUnhealthy || unhealthy(pod)).sort((a, b) => severityOfPod(a) - severityOfPod(b) || restartsOf(b) - restartsOf(a));
  const chosen = ranked.slice(0, maxPods);
  const targets = [];
  for (const pod of chosen) {
    const statuses = new Map([...(pod.status?.initContainerStatuses || []).map(cs => [cs.name, { ...cs, init: true }]), ...(pod.status?.containerStatuses || []).map(cs => [cs.name, cs])]);
    const init = (pod.spec?.initContainers || []).filter(c => { const cs = statuses.get(c.name); return cs && (cs.restartCount > 0 || (cs.state?.terminated && cs.state.terminated.exitCode !== 0) || cs.state?.running); });
    for (const container of [...init, ...(pod.spec?.containers || [])]) {
      const cs = statuses.get(container.name);
      const withPrevious = previous && cs && crashed(cs, pod);
      if (withPrevious) targets.push({ pod: pod.metadata.name, container: container.name, previous: true });
      // A container waiting to restart has no current run: kubectl would print the crashed run again.
      if (!withPrevious || cs.state?.running) targets.push({ pod: pod.metadata.name, container: container.name, previous: false });
    }
  }
  return { targets, chosen: chosen.map(pod => pod.metadata.name), skipped: ranked.length - chosen.length };
}

// ConfigMaps and Secrets a pod spec refers to, by name.
export function podSpecRefs(spec) {
  const configmaps = new Map(); const secrets = new Map();
  const add = (map, name, optional) => { if (name && !map.has(name)) map.set(name, Boolean(optional)); };
  // kube-api-access-* is the service account token volume Kubernetes adds to every pod.
  for (const volume of (spec?.volumes || []).filter(item => !/^kube-api-access-/.test(item.name || ''))) {
    if (volume.configMap) add(configmaps, volume.configMap.name, volume.configMap.optional);
    if (volume.secret) add(secrets, volume.secret.secretName, volume.secret.optional);
    for (const source of volume.projected?.sources || []) {
      if (source.configMap) add(configmaps, source.configMap.name, source.configMap.optional);
      if (source.secret) add(secrets, source.secret.name, source.secret.optional);
    }
  }
  for (const container of [...(spec?.initContainers || []), ...(spec?.containers || [])]) {
    for (const from of container.envFrom || []) {
      if (from.configMapRef) add(configmaps, from.configMapRef.name, from.configMapRef.optional);
      if (from.secretRef) add(secrets, from.secretRef.name, from.secretRef.optional);
    }
    for (const env of container.env || []) {
      if (env.valueFrom?.configMapKeyRef) add(configmaps, env.valueFrom.configMapKeyRef.name, env.valueFrom.configMapKeyRef.optional);
      if (env.valueFrom?.secretKeyRef) add(secrets, env.valueFrom.secretKeyRef.name, env.valueFrom.secretKeyRef.optional);
    }
  }
  for (const pull of spec?.imagePullSecrets || []) add(secrets, pull.name, false);
  return { configmaps, secrets };
}
const templateSpec = (object, resource) => (resource === 'pods' ? object?.spec : resource === 'cronjobs' ? object?.spec?.jobTemplate?.spec?.template?.spec : object?.spec?.template?.spec);

// ---- Events ------------------------------------------------------------------------------------
const eventTime = event => time(event.lastTimestamp || event.eventTime || event.series?.lastObservedTime || event.metadata?.creationTimestamp);
export function sortEvents(events) {
  return [...events].sort((a, b) => (a.type === 'Warning' ? 0 : 1) - (b.type === 'Warning' ? 0 : 1) || (eventTime(b) || 0) - (eventTime(a) || 0));
}
// Events about any of the objects (by uid, or kind and name when the event has no uid).
export function eventsAbout(events, objects) {
  const uids = new Set(objects.map(item => item?.metadata?.uid).filter(Boolean));
  const names = new Set(objects.map(item => `${item?.kind || ''}/${item?.metadata?.name || ''}`));
  return events.filter(event => (event.involvedObject?.uid && uids.has(event.involvedObject.uid)) || names.has(`${event.involvedObject?.kind || ''}/${event.involvedObject?.name || ''}`));
}

// ---- The report model --------------------------------------------------------------------------
// raw: { target: { context, namespace, resource, name }, cluster: { label, env }, version, takenAt,
//   object, owners (nearest first), intermediates (ReplicaSets/Jobs owned by the target), pods,
//   events, services, configmaps, secrets, ingresses, hpas, nodes, problems, logs, notes, options }.
// Lists that could not be read are undefined, and the report says so instead of guessing.
export function buildSnapshot(raw) {
  const now = raw.takenAt ?? Date.now();
  const target = raw.target;
  const resource = target.resource;
  const options = { logLines: 100, previous: true, yaml: true, ...raw.options };
  const yamlRedactor = createRedactor(); const logRedactor = createRedactor(); const textRedactor = createRedactor();
  const object = raw.object || null;
  const pods = raw.pods || [];
  const allEvents = raw.events || [];
  const nodes = raw.nodes || [];
  const owners = raw.owners || [];
  const intermediates = raw.intermediates || [];
  const t = value => textRedactor.text(String(value ?? ''));

  // Events about the target, its owners, the pods and the objects in between.
  const scoped = resource === 'namespaces' ? allEvents : eventsAbout(allEvents, [object, ...owners, ...intermediates, ...pods.map(pod => ({ kind: 'Pod', metadata: pod.metadata })), ...pods.flatMap(pod => (pod.metadata?.ownerReferences || []).map(ref => ({ kind: ref.kind, metadata: { name: ref.name, uid: ref.uid } })))].filter(Boolean));
  const events = sortEvents(scoped);

  // What Rubban thinks is wrong.
  const eventsByPod = new Map();
  for (const event of allEvents) {
    if (event.involvedObject?.kind !== 'Pod') continue;
    const name = event.involvedObject.name;
    if (!eventsByPod.has(name)) eventsByPod.set(name, []);
    eventsByPod.get(name).push(event);
  }
  const sick = pods.filter(unhealthy);
  let findings = resource === 'pods' && pods[0]
    ? diagnosePod(pods[0], { events: eventsByPod.get(pods[0].metadata?.name) || [], nodes, now }).map(finding => ({ ...finding, pods: [pods[0].metadata.name] }))
    : diagnosePods(sick, { eventsByPod, nodes, now });
  let state = null;
  if (object && ['deployments', 'statefulsets', 'daemonsets', 'replicasets'].includes(resource)) {
    state = workloadState(resource, object);
    const counts = replicaCounts(resource, object);
    state = { ...state, ready: counts.ready, desired: counts.desired };
    if (!findings.length && state.tone && state.tone !== 'good') findings = [{ tone: state.tone, code: 'state', title: state.label, text: state.detail || '', hints: state.label === 'Rollout stuck' ? ['The rollout passed its progress deadline. Look at the newest pods, or roll back.'] : [], pods: [] }];
  }
  if (object && resource === 'jobs') {
    const failed = (object.status?.conditions || []).find(c => c.type === 'Failed' && c.status === 'True');
    if (failed && !findings.some(f => f.tone === 'bad')) findings.unshift({ tone: 'bad', code: 'job-failed', title: 'Job failed', text: `${failed.reason || 'Failed'}${failed.message ? `: ${failed.message}` : ''}`, hints: ['Read the logs of its last pod: the reason it failed is usually the last thing it printed.'], pods: [] });
  }
  findings = findings.map(finding => ({ ...finding, title: t(finding.title), text: t(finding.text), hints: (finding.hints || []).map(t) }));

  // Pods and containers, worst first.
  const orderedPods = [...pods].sort((a, b) => severityOfPod(a) - severityOfPod(b) || restartsOf(b) - restartsOf(a) || String(a.metadata?.name).localeCompare(String(b.metadata?.name)));
  const podRows = orderedPods.map(pod => ({ name: pod.metadata?.name, status: podStatusText(pod), ready: readyOf(pod), restarts: restartsOf(pod), node: pod.spec?.nodeName || '', age: ageText(pod.metadata?.creationTimestamp, now), tone: healthTone('pods', pod) }));
  const containerPods = resource === 'namespaces' ? orderedPods.filter(unhealthy) : orderedPods;
  const containers = [];
  for (const pod of containerPods.slice(0, 12)) {
    const statuses = new Map([...(pod.status?.initContainerStatuses || []).map(cs => [cs.name, { ...cs, init: true }]), ...(pod.status?.containerStatuses || []).map(cs => [cs.name, cs])]);
    for (const spec of [...(pod.spec?.initContainers || []).map(c => ({ ...c, init: true })), ...(pod.spec?.containers || [])]) {
      const cs = statuses.get(spec.name) || {};
      const last = lastTermination(cs, pod);
      const state = cs.state?.running ? `Running${cs.ready === false && !spec.init ? ', not ready' : ''}` : cs.state?.waiting ? `Waiting: ${cs.state.waiting.reason || 'unknown'}` : cs.state?.terminated ? `Terminated: ${cs.state.terminated.reason || 'exit'} (${cs.state.terminated.exitCode})` : 'Not started';
      containers.push({ pod: pod.metadata?.name, name: spec.name, init: Boolean(spec.init), state, restarts: cs.restartCount || 0, last: last ? { exitCode: last.exitCode, reason: last.reason || '', finishedAt: last.finishedAt || '', ago: last.finishedAt ? ago(last.finishedAt, now) : '', message: t(last.message || '') } : null, image: spec.image || cs.image || '', waitingMessage: t(cs.state?.waiting?.message || '') });
    }
  }

  // Related objects.
  const specs = resource === 'namespaces' ? pods.map(pod => pod.spec) : [templateSpec(object, resource), ...pods.map(pod => pod.spec)].filter(Boolean);
  const refs = { configmaps: new Map(), secrets: new Map() };
  for (const spec of specs) { const found = podSpecRefs(spec); for (const kind of ['configmaps', 'secrets']) for (const [name, optional] of found[kind]) if (!refs[kind].has(name)) refs[kind].set(name, optional); }
  const existing = list => (list ? new Set(list.map(item => item.metadata?.name)) : null);
  const refRows = (kind, list) => {
    const names = existing(list);
    if (resource === 'namespaces') return list ? list.map(item => ({ name: item.metadata?.name, missing: false })).slice(0, 40) : [];
    return [...refs[kind]].map(([name, optional]) => ({ name, optional, missing: names ? !names.has(name) : false })).sort((a, b) => Number(b.missing) - Number(a.missing) || a.name.localeCompare(b.name));
  };
  const labelsOfPods = pods.map(pod => pod.metadata?.labels || {});
  const templateLabels = object?.spec?.template?.metadata?.labels;
  const selects = service => { const selector = service.spec?.selector; if (!selector || !Object.keys(selector).length) return false; return labelsOfPods.some(labels => matchesSelector(selector, labels)) || (templateLabels && matchesSelector(selector, templateLabels)); };
  const services = raw.services ? (resource === 'namespaces' ? raw.services : raw.services.filter(selects)) : null;
  const serviceNames = new Set((services || []).map(service => service.metadata?.name));
  const backendsOf = ingress => [ingress.spec?.defaultBackend?.service?.name, ...(ingress.spec?.rules || []).flatMap(rule => (rule.http?.paths || []).map(path => path.backend?.service?.name))].filter(Boolean);
  const ingresses = raw.ingresses ? raw.ingresses.filter(ingress => backendsOf(ingress).some(name => serviceNames.has(name))) : null;
  const topOwner = owners.at(-1) || object;
  const hpas = raw.hpas ? raw.hpas.filter(hpa => resource === 'namespaces' || [object, topOwner].some(item => item && hpa.spec?.scaleTargetRef?.name === item.metadata?.name && hpa.spec?.scaleTargetRef?.kind === item.kind)) : null;
  const related = {
    services: services?.map(service => ({ name: service.metadata?.name, type: service.spec?.type || 'ClusterIP', ports: (service.spec?.ports || []).map(port => `${port.port}${port.targetPort !== undefined && port.targetPort !== port.port ? `→${port.targetPort}` : ''}/${port.protocol || 'TCP'}`).join(', ') })) ?? null,
    ingresses: ingresses?.map(ingress => ({ name: ingress.metadata?.name, hosts: [...new Set((ingress.spec?.rules || []).map(rule => rule.host).filter(Boolean))].join(', ') })) ?? null,
    configmaps: refRows('configmaps', raw.configmaps),
    secrets: refRows('secrets', raw.secrets),
    configmapsKnown: Boolean(raw.configmaps), secretsKnown: Boolean(raw.secrets),
    hpas: hpas?.map(hpa => ({ name: hpa.metadata?.name, current: hpa.status?.currentReplicas ?? 0, desired: hpa.status?.desiredReplicas ?? 0, min: hpa.spec?.minReplicas ?? 1, max: hpa.spec?.maxReplicas, target: `${hpa.spec?.scaleTargetRef?.kind || ''} ${hpa.spec?.scaleTargetRef?.name || ''}`.trim() })) ?? null,
  };

  // Nodes the pods run on (or all nodes, when a pod cannot be scheduled).
  const podsPerNode = new Map();
  for (const pod of pods) if (pod.spec?.nodeName) podsPerNode.set(pod.spec.nodeName, (podsPerNode.get(pod.spec.nodeName) || 0) + 1);
  const nodeRows = nodes.filter(node => podsPerNode.has(node.metadata?.name) || raw.allNodes).map(node => {
    const conditions = node.status?.conditions || [];
    const ready = conditions.find(c => c.type === 'Ready');
    return { name: node.metadata?.name, ready: ready ? ready.status : 'Unknown', readyMessage: ready && ready.status !== 'True' ? t(ready.message || ready.reason || '') : '', pressure: conditions.filter(c => c.type !== 'Ready' && c.status === 'True').map(c => c.type), cordoned: Boolean(node.spec?.unschedulable), taints: (node.spec?.taints || []).map(taint => `${taint.key}${taint.value ? `=${taint.value}` : ''}:${taint.effect}`), kubelet: node.status?.nodeInfo?.kubeletVersion || '', cpu: formatCPU(parseCPU(node.status?.allocatable?.cpu)), memory: formatBytes(parseMemory(node.status?.allocatable?.memory)), pods: podsPerNode.get(node.metadata?.name) || 0 };
  }).sort((a, b) => (a.ready === 'True' ? 1 : 0) - (b.ready === 'True' ? 1 : 0) || b.pods - a.pods || a.name.localeCompare(b.name));

  // Logs, each redacted as a whole (a private key spans lines) and cut to the requested tail.
  const logs = (raw.logs || []).map(entry => {
    const text = logRedactor.text(String(entry.text || '').replace(/\r\n?/g, '\n').replace(/\n$/, ''));
    const lines = text ? text.split('\n') : [];
    const kept = lines.slice(-options.logLines);
    const pod = pods.find(item => item.metadata?.name === entry.pod);
    const cs = [...(pod?.status?.initContainerStatuses || []), ...(pod?.status?.containerStatuses || [])].find(item => item.name === entry.container);
    const last = cs ? lastTermination(cs, pod) : null;
    return { pod: entry.pod, container: entry.container, previous: Boolean(entry.previous), lines: kept, total: lines.length, truncated: Boolean(entry.truncated), unavailable: t(entry.unavailable || ''), error: t(entry.error || ''), crash: entry.previous && last ? { exitCode: last.exitCode, reason: last.reason || '', ago: last.finishedAt ? ago(last.finishedAt, now) : '' } : null };
  });

  const problems = (raw.problems || []).map(problem => ({ severity: problem.severity, kind: kindOf(problem.resource), name: problem.name, title: t(problem.title), detail: t(problem.detail || ''), since: problem.since ? ageText(problem.since, now) : '' }))
    .sort((a, b) => ({ critical: 0, warning: 1, info: 2 }[a.severity] ?? 3) - ({ critical: 0, warning: 1, info: 2 }[b.severity] ?? 3));

  const yaml = object && resource !== 'namespaces' ? toYAML(sanitizeObject(object, yamlRedactor)) : '';
  const eventRows = events.map(event => ({ type: event.type || 'Normal', reason: event.reason || '', object: `${event.involvedObject?.kind || ''} ${event.involvedObject?.name || ''}`.trim(), count: event.count || event.series?.count || 1, last: ageText(eventTime(event), now), message: t(event.message || event.note || '') }));

  const kind = kindOf(resource);
  const ownerChain = [...owners].reverse().map(owner => ({ kind: owner.kind, name: owner.metadata?.name }));
  const restarts = pods.reduce((sum, pod) => sum + restartsOf(pod), 0);
  const statusCounts = new Map();
  for (const row of podRows) statusCounts.set(row.status, (statusCounts.get(row.status) || 0) + 1);
  return {
    title: resource === 'namespaces' ? `Namespace ${target.name}` : `${kind} ${target.namespace ? `${target.namespace}/` : ''}${target.name}`,
    kind, target, cluster: raw.cluster || { label: target.context, env: '' }, version: raw.version || '', takenAt: now, options,
    state: state ? { label: state.label, tone: state.tone, ready: state.ready, desired: state.desired, detail: t(state.detail || '') } : null,
    podStatus: object && resource === 'pods' ? { status: podStatusText(object), ready: readyOf(object), restarts: restartsOf(object), node: object.spec?.nodeName || '', ip: object.status?.podIP || '', qos: object.status?.qosClass || '' } : null,
    summary: { pods: pods.length, restarts, statuses: [...statusCounts].sort((a, b) => b[1] - a[1]), unhealthy: sick.length },
    findings, pods: podRows, containers, containerPodsShown: Math.min(containerPods.length, 12), containerPodsTotal: containerPods.length,
    events: eventRows, ownerChain, related, nodes: nodeRows, allNodes: Boolean(raw.allNodes), problems, logs, yaml,
    logPods: raw.logPods || null,
    notes: (raw.notes || []).map(note => ({ step: note.step, message: t(note.message) })),
    redactions: { yaml: yamlRedactor.count, logs: logRedactor.count, text: textRedactor.count },
  };
}

export const redactionTotal = (model, { yaml = model.options.yaml } = {}) => model.redactions.logs + model.redactions.text + (yaml ? model.redactions.yaml : 0);

// ---- Markdown ----------------------------------------------------------------------------------

function statusLine(model) {
  if (model.podStatus) return `${model.podStatus.status} · ${model.podStatus.ready} ready · ${plural(model.podStatus.restarts, 'restart')}${model.podStatus.node ? ` · node \`${model.podStatus.node}\`` : ' · not scheduled'}`;
  const parts = [];
  if (model.state) parts.push(`${model.state.label} · ${model.state.ready}/${model.state.desired} ready`);
  const statuses = model.summary.statuses.map(([status, n]) => `${n} ${status}`).join(', ');
  parts.push(model.summary.pods ? `${plural(model.summary.pods, 'pod')}: ${statuses}` : 'no pods');
  if (model.summary.restarts) parts.push(`${plural(model.summary.restarts, 'restart')} in total`);
  return parts.join(' · ');
}

function logBlock(entry, { full = true, head = 12, collapseOver = 25 } = {}) {
  const title = `**${entry.pod} › ${entry.container}**${entry.previous ? ` · previous run${entry.crash ? `, ended ${entry.crash.reason || 'with an error'} (exit ${entry.crash.exitCode})${entry.crash.ago ? ` ${entry.crash.ago}` : ''}` : ''}` : ' · current run'}`;
  if (entry.error) return `${title}\n\n_Could not read: ${entry.error}_`;
  if (entry.unavailable) return `${title}\n\n_No logs: ${entry.unavailable}_`;
  if (!entry.lines.length) return `${title}\n\n_No output._`;
  const count = `last ${plural(entry.lines.length, 'line')}${entry.total > entry.lines.length ? ` of ${entry.total}` : ''}`;
  if (!full || entry.lines.length <= collapseOver) return `${title} · ${count}\n\n${fenced(entry.lines.join('\n'), 'text')}`;
  return `${title} · ${count}\n\n${fenced(entry.lines.slice(-head).join('\n'), 'text')}\n\n<details><summary>All ${plural(entry.lines.length, 'line')}</summary>\n\n${fenced(entry.lines.join('\n'), 'text')}\n\n</details>`;
}

// options: { yaml, collapse (use <details> for long logs and the YAML), logLines (cap per block, for the AI),
//   eventLimit, maxPodRows }
export function snapshotMarkdown(model, options = {}) {
  const o = { yaml: model.options.yaml, collapse: true, eventLimit: 30, maxPodRows: 40, ...options };
  const out = [];
  const env = model.cluster.env ? ` (${model.cluster.env})` : '';
  out.push(`# Incident snapshot: ${model.title}`);
  out.push([
    `- **Cluster:** \`${model.cluster.label}\`${env}${model.cluster.label !== model.target.context ? ` · context \`${model.target.context}\`` : ''}`,
    model.target.namespace || model.target.resource === 'namespaces' ? `- **Namespace:** \`${model.target.namespace || model.target.name}\`` : null,
    `- **Status:** ${statusLine(model)}`,
    model.ownerChain.length ? `- **Owned by:** ${model.ownerChain.map(owner => `${owner.kind} \`${owner.name}\``).join(' → ')}` : null,
    `- **Taken:** ${isoTime(model.takenAt)}${model.version ? ` with Rubban ${model.version}` : ''}`,
  ].filter(Boolean).join('\n'));

  out.push('## What Rubban thinks is wrong');
  if (!model.findings.length) out.push(model.summary.pods ? 'Nothing: the pods looked healthy when this snapshot was taken. Check the events and logs below for anything intermittent.' : 'No pods to judge. Check the events below.');
  else {
    out.push(model.findings.map((finding, index) => {
      const count = finding.pods?.length > 1 ? ` · ${plural(finding.pods.length, 'pod')}` : '';
      const parts = [`### ${index + 1}. ${finding.title}${finding.tone === 'bad' ? '' : ' (warning)'}${count}`];
      if (finding.text) parts.push(finding.text);
      for (const hint of finding.hints || []) parts.push(`**Next step:** ${hint}`);
      if (finding.pods?.length > 1) parts.push(`Pods: ${finding.pods.slice(0, 6).map(name => `\`${name}\``).join(', ')}${finding.pods.length > 6 ? `, and ${finding.pods.length - 6} more` : ''}`);
      return parts.join('\n\n');
    }).join('\n\n'));
  }

  if (model.pods.length) {
    const shown = model.pods.slice(0, o.maxPodRows);
    out.push(`## Pods (${model.pods.length})`);
    out.push(table(['Pod', 'Status', 'Ready', 'Restarts', 'Node', 'Age'], shown.map(pod => [code(pod.name), pod.status, pod.ready, pod.restarts, pod.node || '—', pod.age])) + (model.pods.length > shown.length ? `\n\n_${model.pods.length - shown.length} more healthy pods not listed._` : ''));
  }
  if (model.containers.length) {
    out.push(`## Containers${model.containerPodsTotal > model.containerPodsShown ? ` (first ${model.containerPodsShown} of ${model.containerPodsTotal} pods)` : ''}`);
    out.push(table(['Pod', 'Container', 'State', 'Restarts', 'Last termination', 'Image'], model.containers.map(c => [code(c.pod), `${c.name}${c.init ? ' (init)' : ''}`, c.state, c.restarts, c.last ? `${c.last.reason || 'Exited'}, exit ${c.last.exitCode}${c.last.ago ? `, ${c.last.ago}` : ''}${c.last.message ? `: ${c.last.message}` : ''}` : '—', code(c.image)])));
    const waiting = model.containers.filter(c => c.waitingMessage);
    if (waiting.length) out.push(waiting.map(c => `- \`${c.pod}\` › ${c.name}: ${c.waitingMessage}`).join('\n'));
  }

  out.push('## Events (warnings first)');
  if (!model.events.length) out.push('_No events. Kubernetes keeps events for about an hour, so older ones are gone._');
  else {
    const shown = model.events.slice(0, o.eventLimit);
    out.push(table(['Last seen', 'Type', 'Reason', 'Object', 'Count', 'Message'], shown.map(event => [event.last, event.type, event.reason, event.object, event.count, cell(event.message, o.eventMessageMax || 300)])) + (model.events.length > shown.length ? `\n\n_${model.events.length - shown.length} older events not listed._` : ''));
  }

  if (model.logs.length || model.logPods) {
    out.push(`## Logs (last ${model.options.logLines} lines per container${model.options.previous ? ', plus the run that crashed' : ''})`);
    if (model.logPods?.skipped) out.push(`_Logs of ${plural(model.logPods.chosen.length, 'pod')} shown (the least healthy first); ${model.logPods.skipped} more not read._`);
    const ordered = [...model.logs].sort((a, b) => Number(b.previous) - Number(a.previous));
    const pods = [...new Set(ordered.map(entry => entry.pod))];
    const blocks = [];
    for (const pod of pods) for (const entry of [...ordered.filter(item => item.pod === pod && item.previous), ...ordered.filter(item => item.pod === pod && !item.previous)]) {
      const capped = o.logLines ? { ...entry, lines: entry.lines.slice(-o.logLines), total: entry.total } : entry;
      blocks.push(logBlock(capped, { full: o.collapse }));
    }
    out.push(blocks.length ? blocks.join('\n\n') : '_No logs were read._');
  }

  const related = model.related;
  const relatedLines = [];
  const names = list => list.map(item => `\`${item.name}\`${item.missing ? (item.optional ? ' (missing, optional)' : ' (**missing**)') : ''}`).join(', ');
  if (related.services) relatedLines.push(`- **Services:** ${related.services.length ? related.services.map(service => `\`${service.name}\` (${service.type}${service.ports ? `, ${service.ports}` : ''})`).join(', ') : 'none select these pods'}`);
  else relatedLines.push('- **Services:** could not be listed');
  if (related.ingresses?.length) relatedLines.push(`- **Ingresses:** ${related.ingresses.map(ingress => `\`${ingress.name}\`${ingress.hosts ? ` (${ingress.hosts})` : ''}`).join(', ')}`);
  if (related.hpas?.length) relatedLines.push(`- **Autoscalers:** ${related.hpas.map(hpa => `HPA \`${hpa.name}\` → ${hpa.target}: ${hpa.current} running, wants ${hpa.desired} (min ${hpa.min}, max ${hpa.max})`).join('; ')}`);
  relatedLines.push(`- **ConfigMaps:** ${related.configmaps.length ? names(related.configmaps) : 'none referenced'}${related.configmapsKnown ? '' : ' (could not check which exist)'}`);
  relatedLines.push(`- **Secrets (names only):** ${related.secrets.length ? names(related.secrets) : 'none referenced'}${related.secretsKnown ? '' : ' (could not check which exist)'}`);
  out.push(model.target.resource === 'namespaces' ? '## In this namespace' : '## Related objects');
  out.push(relatedLines.join('\n'));

  if (model.nodes.length) {
    out.push(model.allNodes ? '## Nodes (all, because a pod cannot be scheduled)' : '## Nodes');
    out.push(table(['Node', 'Ready', 'Pressure', 'Cordoned', 'Taints', 'Allocatable', 'Pods here', 'Kubelet'], model.nodes.map(node => [code(node.name), node.ready === 'True' ? 'Yes' : `**${node.ready}**${node.readyMessage ? `: ${node.readyMessage}` : ''}`, node.pressure.join(', ') || 'none', node.cordoned ? '**yes**' : 'no', node.taints.join(', ') || '—', `${node.cpu} CPU, ${node.memory}`, node.pods, node.kubelet])));
  }

  out.push(`## Open problems in namespace ${model.target.namespace || model.target.name}`);
  out.push(model.problems.length ? table(['Severity', 'Kind', 'Name', 'Problem', 'Since'], model.problems.map(problem => [problem.severity, problem.kind, code(problem.name), `${problem.title}${problem.detail ? `: ${problem.detail}` : ''}`, problem.since])) : '_None reported by Rubban\'s Problems page._');

  if (o.yaml && model.yaml) {
    out.push(`## ${model.kind} YAML`);
    const note = 'managedFields and the last-applied annotation removed';
    out.push(o.collapse ? `<details><summary>${model.kind} ${model.target.name} (${note})</summary>\n\n${fenced(model.yaml, 'yaml')}\n\n</details>` : `_${note}._\n\n${fenced(model.yaml, 'yaml')}`);
  }

  const notes = [];
  for (const note of model.notes) notes.push(`- ${note.step}: ${note.message}`);
  const redacted = redactionTotal(model, { yaml: o.yaml });
  out.push('## About this snapshot');
  out.push([
    notes.length ? `Some parts could not be collected:\n\n${notes.join('\n')}\n` : null,
    `- Secret values are never included; Secrets appear by name only.`,
    `- ${redacted ? `${plural(redacted, 'value')} that looked like ${redacted === 1 ? 'a secret was' : 'secrets were'} replaced with ${MASK} (tokens, passwords, keys, credentials in URLs).` : `Nothing that looked like a secret was found in env values, args or logs; the redaction still ran.`}`,
    `- Generated by Rubban${model.version ? ` ${model.version}` : ''} from the live cluster at ${isoTime(model.takenAt)}.`,
  ].filter(Boolean).join('\n'));
  return `${out.join('\n\n')}\n`;
}

// ---- Asking an AI CLI ---------------------------------------------------------------------------
export const AI_PROMPT_LIMIT = 32000;
export const AI_INSTRUCTIONS = [
  'You are helping an on-call engineer during an incident. Below is a redacted incident snapshot of a Kubernetes object, taken by Rubban.',
  'Write a short root-cause analysis in Markdown with these sections:',
  '1. **Most likely root cause**: one or two sentences, citing the evidence (log lines, exit codes, events) from the snapshot.',
  '2. **Evidence**: bullet points quoting the decisive lines.',
  '3. **Fix**: concrete next steps, most likely to help first, with kubectl commands where useful (do not run them).',
  '4. **If that is not it**: what to check next.',
  'Say so plainly when the snapshot does not contain enough to be sure. Values shown as ‹redacted› were removed on purpose; do not ask for them.',
].join('\n');

// The snapshot as sent to an AI CLI: no YAML collapse markup, and log tails cut until the whole prompt
// fits the limit of the /api/ai route.
export function aiPrompt(model, { limit = AI_PROMPT_LIMIT } = {}) {
  const head = `${AI_INSTRUCTIONS}\n\n---\n\n`;
  const steps = [
    { logLines: 60, yaml: true, eventLimit: 30 },
    { logLines: 40, yaml: true, eventLimit: 25 },
    { logLines: 25, yaml: false, eventLimit: 20 },
    { logLines: 15, yaml: false, eventLimit: 15, maxPodRows: 20 },
    { logLines: 8, yaml: false, eventLimit: 10, maxPodRows: 10, eventMessageMax: 160 },
  ];
  for (const step of steps) {
    const body = snapshotMarkdown(model, { ...step, yaml: step.yaml && model.options.yaml, collapse: false });
    const yaml = step.yaml && model.options.yaml && Boolean(model.yaml);
    const trimmed = model.logs.some(entry => entry.lines.length > step.logLines) || (model.options.yaml && Boolean(model.yaml) && !yaml) || model.events.length > step.eventLimit;
    if (head.length + body.length <= limit) return { prompt: head + body, trimmed, logLines: step.logLines, yaml };
  }
  const body = snapshotMarkdown(model, { ...steps.at(-1), yaml: false, collapse: false });
  const room = limit - head.length - 40;
  return { prompt: `${head}${body.slice(0, room)}\n\n[snapshot cut to fit]\n`, trimmed: true, logLines: steps.at(-1).logLines, yaml: false };
}

// ---- Helpers for the preview and the file ------------------------------------------------------
// Splits Markdown into plain parts and <details> blocks, so a renderer without HTML support can still
// draw the collapsible sections.
export function splitDetails(markdown) {
  const parts = [];
  const pattern = /<details><summary>([^<]*)<\/summary>\n([\s\S]*?)\n<\/details>/g;
  let last = 0; let match;
  while ((match = pattern.exec(markdown))) {
    if (match.index > last) parts.push({ type: 'markdown', text: markdown.slice(last, match.index) });
    parts.push({ type: 'details', summary: match[1], text: match[2].replace(/^\n+|\n+$/g, '') });
    last = pattern.lastIndex;
  }
  if (last < markdown.length) parts.push({ type: 'markdown', text: markdown.slice(last) });
  return parts.filter(part => part.type === 'details' || part.text.trim());
}

export function snapshotFileName(model) {
  const stamp = new Date(model.takenAt).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const safe = value => String(value || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `snapshot-${[safe(model.cluster.label), safe(model.target.namespace), safe(model.target.resource === 'namespaces' ? '' : model.kind.toLowerCase()), safe(model.target.name)].filter(Boolean).join('-')}-${stamp}.md`;
}
