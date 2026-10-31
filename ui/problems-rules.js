// What is wrong in a cluster, judged from the objects the live feeds already hold. Pure: the clock and the
// "first seen" memory are passed in, so every rule can be tested with fixture objects.
//
// A problem is { id, context, resource, namespace, name, severity: 'critical'|'warning'|'info', title,
// detail, since } with id = context|resource|namespace|name|rule, stable while the problem lasts.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const GRACE = 5 * MINUTE;
const FATAL_WAITING = new Set(['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError', 'InvalidImageName']);

const time = value => { const t = Date.parse(value); return Number.isFinite(t) ? t : NaN; };
const meta = item => item.metadata || {};
const condition = (item, type) => (item.status?.conditions || []).find(c => c.type === type);

// Builds the problem record for an item.
function make(ctx, resource, item, rule, severity, title, detail = '', since = null) {
  const m = meta(item);
  const namespace = m.namespace || '';
  return { id: [ctx.context, resource, namespace, m.name, rule].join('|'), context: ctx.context, resource, namespace, name: m.name, severity, title, detail, since };
}
// The time a condition began, or when we first saw it when the object does not say.
const startedAt = (ctx, id, hint) => (Number.isFinite(hint) ? hint : ctx.firstSeen ? ctx.firstSeen(id) : ctx.now);

function podProblems(pod, ctx) {
  const out = [];
  if (meta(pod).deletionTimestamp) return out;
  const status = pod.status || {};
  const statuses = [...(status.initContainerStatuses || []), ...(status.containerStatuses || [])];
  const seen = new Set();
  for (const cs of statuses) {
    const reason = cs.state?.waiting?.reason;
    if (FATAL_WAITING.has(reason) && !seen.has(reason)) {
      seen.add(reason);
      out.push(make(ctx, 'pods', pod, `waiting-${reason}`, 'critical', reason, `${cs.name}: ${cs.state.waiting.message || reason}`.slice(0, 300), cs.lastState?.terminated?.finishedAt || null));
    }
  }
  const oom = statuses.find(cs => [cs.lastState?.terminated, cs.state?.terminated].some(t => t?.reason === 'OOMKilled' && ctx.now - time(t.finishedAt) < HOUR));
  if (oom) {
    const t = [oom.state?.terminated, oom.lastState?.terminated].find(x => x?.reason === 'OOMKilled');
    out.push(make(ctx, 'pods', pod, 'oomkilled', 'warning', 'OOMKilled', `${oom.name} ran out of memory`, t.finishedAt));
  }
  const restarting = statuses.find(cs => cs.restartCount >= 5 && ctx.now - time(cs.lastState?.terminated?.finishedAt) < HOUR);
  if (restarting) out.push(make(ctx, 'pods', pod, 'restarts', 'warning', `${restarting.restartCount} restarts`, `${restarting.name} keeps restarting (${restarting.lastState.terminated.reason || 'exit ' + restarting.lastState.terminated.exitCode})`, restarting.lastState.terminated.finishedAt));
  const phase = status.phase;
  const created = time(meta(pod).creationTimestamp);
  if (phase === 'Pending' && ctx.now - created > GRACE) {
    const scheduled = condition(pod, 'PodScheduled');
    if (scheduled?.status === 'False' && scheduled.reason === 'Unschedulable') out.push(make(ctx, 'pods', pod, 'unschedulable', 'critical', 'Unschedulable', (scheduled.message || '').slice(0, 300), meta(pod).creationTimestamp));
    else out.push(make(ctx, 'pods', pod, 'pending', 'warning', 'Pending', `Pending for ${Math.floor((ctx.now - created) / MINUTE)} minutes`, meta(pod).creationTimestamp));
  }
  const ready = condition(pod, 'Ready');
  if (phase === 'Running' && ready?.status === 'False' && ctx.now - time(ready.lastTransitionTime) > GRACE && !seen.size) {
    out.push(make(ctx, 'pods', pod, 'not-ready', 'warning', 'Not ready', ready.message || ready.reason || 'The pod is running but not ready', ready.lastTransitionTime));
  }
  if (status.reason === 'Evicted') out.push(make(ctx, 'pods', pod, 'evicted', 'info', 'Evicted', (status.message || '').slice(0, 300), meta(pod).creationTimestamp));
  else if (phase === 'Failed' && !(meta(pod).ownerReferences || []).some(o => o.kind === 'Job')) out.push(make(ctx, 'pods', pod, 'failed', 'warning', 'Failed', status.message || status.reason || 'The pod failed', meta(pod).creationTimestamp));
  return out;
}

function workloadProblems(resource, item, ctx) {
  const out = [];
  const status = item.status || {};
  let desired; let available;
  if (resource === 'daemonsets') { desired = status.desiredNumberScheduled ?? 0; available = status.numberAvailable ?? status.numberReady ?? 0; }
  else { desired = item.spec?.replicas ?? 1; available = status.availableReplicas ?? status.readyReplicas ?? 0; }
  const progressing = condition(item, 'Progressing');
  if (progressing?.status === 'False' && progressing.reason === 'ProgressDeadlineExceeded') {
    out.push(make(ctx, resource, item, 'deadline', 'critical', 'Rollout stuck', progressing.message || 'ProgressDeadlineExceeded', progressing.lastUpdateTime || progressing.lastTransitionTime));
  } else if (available < desired) {
    const id = [ctx.context, resource, meta(item).namespace || '', meta(item).name, 'unavailable'].join('|');
    const availableCondition = condition(item, 'Available');
    const hint = availableCondition?.status === 'False' ? time(availableCondition.lastTransitionTime) : NaN;
    const since = startedAt(ctx, id, hint);
    if (ctx.now - since > GRACE) out.push(make(ctx, resource, item, 'unavailable', 'critical', `${available}/${desired} available`, 'Fewer replicas are available than requested', new Date(since).toISOString()));
  }
  return out;
}

function jobProblems(job, ctx) {
  const failed = condition(job, 'Failed');
  return failed?.status === 'True' ? [make(ctx, 'jobs', job, 'failed', 'warning', 'Job failed', failed.message || failed.reason || '', failed.lastTransitionTime)] : [];
}

function pvcProblems(pvc, ctx) {
  if (pvc.status?.phase !== 'Pending' || ctx.now - time(meta(pvc).creationTimestamp) <= GRACE) return [];
  return [make(ctx, 'persistentvolumeclaims', pvc, 'pending', 'warning', 'Claim pending', `Not bound after ${Math.floor((ctx.now - time(meta(pvc).creationTimestamp)) / MINUTE)} minutes`, meta(pvc).creationTimestamp)];
}

function nodeProblems(node, ctx) {
  const out = [];
  const ready = condition(node, 'Ready');
  if (ready?.status !== 'True') out.push(make(ctx, 'nodes', node, 'not-ready', 'critical', 'Node not ready', ready?.message || ready?.reason || 'The node reports no Ready condition', ready?.lastTransitionTime || null));
  for (const type of ['MemoryPressure', 'DiskPressure', 'PIDPressure']) {
    const c = condition(node, type);
    if (c?.status === 'True') out.push(make(ctx, 'nodes', node, type.toLowerCase(), 'critical', type.replace('Pressure', ' pressure'), c.message || '', c.lastTransitionTime));
  }
  if (node.spec?.unschedulable) out.push(make(ctx, 'nodes', node, 'cordoned', 'info', 'Cordoned', 'The node does not accept new pods'));
  return out;
}

function argoProblems(app, ctx) {
  const out = [];
  const sync = app.status?.sync?.status; const health = app.status?.health?.status;
  if (health === 'Degraded' || health === 'Missing') out.push(make(ctx, 'applications.argoproj.io', app, 'health', 'critical', `Argo CD: ${health}`, app.status?.health?.message || ''));
  else if (health === 'Unknown') out.push(make(ctx, 'applications.argoproj.io', app, 'health', 'info', 'Argo CD: health unknown', app.status?.health?.message || ''));
  if (sync === 'OutOfSync') out.push(make(ctx, 'applications.argoproj.io', app, 'sync', 'warning', 'Argo CD: out of sync', ''));
  else if (sync === 'Unknown') out.push(make(ctx, 'applications.argoproj.io', app, 'sync', 'info', 'Argo CD: sync unknown', ''));
  return out;
}

const RULES = {
  pods: podProblems, deployments: (i, c) => workloadProblems('deployments', i, c), statefulsets: (i, c) => workloadProblems('statefulsets', i, c),
  daemonsets: (i, c) => workloadProblems('daemonsets', i, c), jobs: jobProblems, persistentvolumeclaims: pvcProblems, nodes: nodeProblems,
  'applications.argoproj.io': argoProblems,
};
export const RESOURCES = Object.keys(RULES);

// Problems of one resource kind. ctx: { context, now (ms), firstSeen?(id) -> ms }.
export function evaluate(resource, items, ctx) {
  const rule = RULES[resource];
  if (!rule) return [];
  const out = [];
  for (const item of items || []) { try { out.push(...rule(item, ctx)); } catch { /* A malformed object must not hide the others. */ } }
  return out;
}

const RANK = { critical: 0, warning: 1, info: 2 };
export const bySeverity = (a, b) => RANK[a.severity] - RANK[b.severity] || (a.namespace || '').localeCompare(b.namespace || '') || (a.name || '').localeCompare(b.name || '');

export function counts(problems) {
  const out = { critical: 0, warning: 0, info: 0 };
  for (const problem of problems) out[problem.severity]++;
  return out;
}
