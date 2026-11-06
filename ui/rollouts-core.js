// Live rollout tracker, pure part: how far a Deployment, StatefulSet or DaemonSet rollout has got,
// whether it is going well, stuck or failing (in plain words), and what Undo goes back to.
// Works on Kubernetes objects only (the workload, its ReplicaSets or ControllerRevisions, its pods):
// no DOM, no clock of its own (`now` is passed in), so every state can be tested.
import { diagnosePods } from './diagnose.js';

export const TRACKED = new Set(['deployments', 'statefulsets', 'daemonsets']);
export const KIND = { deployments: 'Deployment', statefulsets: 'StatefulSet', daemonsets: 'DaemonSet' };
// No change in the counts for this long, while not complete: "Stalled".
export const STALL_MS = 60000;
// Right after an action the cluster may not have seen the change yet; give it this long.
export const SETTLE_MS = 4000;
// A completed rollout's card folds itself after this long.
export const COLLAPSE_AFTER_MS = 20000;
// Pod problems that make a rollout "Failing" (from diagnose.js finding codes).
const FAILING = new Set(['image', 'crashloop', 'oom', 'config', 'unschedulable', 'failed', 'evicted']);

export const ACTION_LABELS = { restart: 'Restart', scale: 'Scale', rollback: 'Roll back', undo: 'Undo', pause: 'Pause', resume: 'Resume', apply: 'Apply', create: 'Create', watch: 'Watching' };

const num = value => (Number.isFinite(Number(value)) && value !== '' && value !== null && value !== undefined ? Number(value) : null);
const ownedBy = (object, uid) => Boolean(uid) && (object.metadata?.ownerReferences || []).some(ref => ref.uid === uid);
const deploymentRevision = object => num(object?.metadata?.annotations?.['deployment.kubernetes.io/revision']);
const isReady = pod => (pod.status?.conditions || []).some(c => c.type === 'Ready' && c.status === 'True');
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// What the workload looked like before an action, so the tracker knows the change has landed and
// which revision Undo goes back to.
export function snapshotBefore(resource, item) {
  if (!item?.metadata) return null;
  return {
    generation: num(item.metadata.generation),
    revision: resource === 'deployments' ? deploymentRevision(item) : null,
    updateRevision: resource === 'statefulsets' ? item.status?.updateRevision || null : null,
    replicas: resource === 'daemonsets' ? null : num(item.spec?.replicas ?? 1),
    paused: Boolean(item.spec?.paused),
  };
}

// The hash values a pod of this ControllerRevision carries in its controller-revision-hash label:
// StatefulSet pods carry the revision's name, DaemonSet pods only its hash suffix.
function revisionHashes(revision, workloadName) {
  const name = revision.metadata?.name || '';
  const hashes = new Set([name]);
  if (workloadName && name.startsWith(`${workloadName}-`)) hashes.add(name.slice(workloadName.length + 1));
  const label = revision.metadata?.labels?.['controller-revision-hash'];
  if (label) hashes.add(label);
  return hashes;
}

// The workload's revisions, newest first: [{ revision, name, hash, matches(pod) }].
export function revisionsOf(resource, workload, { replicasets = [], controllerrevisions = [] } = {}) {
  const uid = workload?.metadata?.uid;
  const name = workload?.metadata?.name;
  let list = [];
  if (resource === 'deployments') {
    list = replicasets.filter(rs => ownedBy(rs, uid)).map(rs => {
      const hash = rs.metadata?.labels?.['pod-template-hash'] || '';
      return { revision: deploymentRevision(rs), name: rs.metadata?.name, hash, uid: rs.metadata?.uid, image: (rs.spec?.template?.spec?.containers || []).map(c => c.image).join(', '), matches: pod => ownedBy(pod, rs.metadata?.uid) || (Boolean(hash) && pod.metadata?.labels?.['pod-template-hash'] === hash) };
    });
  } else {
    list = controllerrevisions.filter(cr => ownedBy(cr, uid)).map(cr => {
      // StatefulSet pods carry the revision's name, DaemonSet pods its hash.
      const hashes = revisionHashes(cr, name);
      return { revision: num(cr.revision), name: cr.metadata?.name, hash: resource === 'statefulsets' ? cr.metadata?.name : cr.metadata?.labels?.['controller-revision-hash'] || [...hashes].at(-1), uid: cr.metadata?.uid, matches: pod => hashes.has(pod.metadata?.labels?.['controller-revision-hash']) };
    });
  }
  return list.filter(entry => entry.revision !== null).sort((a, b) => b.revision - a.revision);
}

// Pods that belong to the workload (directly, or through one of its ReplicaSets).
export function podsOf(resource, workload, pods = [], revisions = []) {
  const uid = workload?.metadata?.uid;
  if (resource === 'deployments') {
    const owners = new Set(revisions.map(r => r.uid).filter(Boolean));
    return pods.filter(pod => (pod.metadata?.ownerReferences || []).some(ref => owners.has(ref.uid)));
  }
  return pods.filter(pod => ownedBy(pod, uid));
}

// Which revision is the new one, from the workload's own status.
function currentRevision(resource, workload, revisions) {
  if (resource === 'deployments') {
    const number = deploymentRevision(workload);
    return revisions.find(r => r.revision === number) || (number !== null ? { revision: number, matches: () => false } : revisions[0] || null);
  }
  if (resource === 'statefulsets') {
    const update = workload.status?.updateRevision;
    return revisions.find(r => r.name === update) || revisions[0] || null;
  }
  return revisions[0] || null;
}

// How far the rollout has got. `before` (snapshotBefore) is optional.
export function progressOf(resource, workload, { replicasets = [], controllerrevisions = [], pods = [] } = {}, before = null) {
  if (!workload?.metadata) return null;
  const spec = workload.spec || {}; const status = workload.status || {};
  const revisions = revisionsOf(resource, workload, { replicasets, controllerrevisions });
  const current = currentRevision(resource, workload, revisions);
  const mine = podsOf(resource, workload, pods, revisions);
  const generation = num(workload.metadata.generation) ?? 0;
  const observed = num(status.observedGeneration) ?? 0;
  const counts = resource === 'daemonsets'
    ? { desired: status.desiredNumberScheduled ?? 0, updated: status.updatedNumberScheduled ?? 0, ready: status.numberReady ?? 0, available: status.numberAvailable ?? 0, total: status.currentNumberScheduled ?? 0 }
    : { desired: spec.replicas ?? 1, updated: status.updatedReplicas ?? 0, ready: status.readyReplicas ?? 0, available: status.availableReplicas ?? (resource === 'statefulsets' ? status.readyReplicas ?? 0 : 0), total: status.replicas ?? 0 };
  const isNew = pod => Boolean(current?.matches?.(pod));
  const live = mine.filter(pod => !pod.metadata?.deletionTimestamp);
  const newPods = live.filter(isNew);
  const segments = {
    newReady: newPods.filter(isReady).length,
    newNotReady: newPods.filter(pod => !isReady(pod)).length,
    old: live.filter(pod => !isNew(pod)).length,
    terminating: mine.length - live.length,
  };
  // The revision the rollout started from: what the workload ran before the action, else the
  // newest older revision that still has pods, else simply the one before the current revision.
  let fromRevision = null;
  if (before?.revision !== null && before?.revision !== undefined && before.revision !== current?.revision) fromRevision = before.revision;
  if (fromRevision === null && before?.updateRevision) fromRevision = revisions.find(r => r.name === before.updateRevision && r.revision !== current?.revision)?.revision ?? null;
  if (fromRevision === null && resource === 'statefulsets' && status.currentRevision && status.currentRevision !== status.updateRevision) fromRevision = revisions.find(r => r.name === status.currentRevision)?.revision ?? null;
  if (fromRevision === null) fromRevision = revisions.find(r => r.revision < (current?.revision ?? Infinity) && mine.some(pod => r.matches(pod) && !pod.metadata?.deletionTimestamp))?.revision ?? null;
  // After an action whose revision moved (its old pods may already be gone): the one before.
  if (fromRevision === null && before && before.generation !== null && (num(workload.metadata.generation) ?? 0) > before.generation) fromRevision = revisions.find(r => r.revision < (current?.revision ?? Infinity))?.revision ?? null;
  const conditions = status.conditions || [];
  const progressing = conditions.find(c => c.type === 'Progressing');
  const strategy = resource === 'deployments' ? spec.strategy?.type || 'RollingUpdate' : spec.updateStrategy?.type || 'RollingUpdate';
  const partition = resource === 'statefulsets' ? num(spec.updateStrategy?.rollingUpdate?.partition) || 0 : 0;

  // kubectl rollout status, rule for rule.
  let complete = false; let waiting = '';
  if (observed < generation || !status.observedGeneration) waiting = 'Waiting for the controller to pick up the change.';
  else if (resource === 'deployments') {
    if (counts.updated < counts.desired) waiting = `${counts.updated} of ${plural(counts.desired, 'new pod')} created.`;
    else if (counts.total > counts.updated) waiting = `${plural(counts.total - counts.updated, 'old pod')} still running.`;
    else if (counts.available < counts.updated) waiting = `${counts.available} of ${counts.updated} new pods available.`;
    else complete = true;
  } else if (resource === 'statefulsets') {
    if (counts.ready < counts.desired) waiting = `${counts.ready} of ${plural(counts.desired, 'pod')} ready.`;
    else if (strategy === 'OnDelete') complete = true;
    else if (partition > 0) { if (counts.updated < counts.desired - partition) waiting = `${counts.updated} of ${counts.desired - partition} pods above the partition updated.`; else complete = true; }
    else if (status.updateRevision && status.currentRevision && status.updateRevision !== status.currentRevision) waiting = `${counts.updated} of ${plural(counts.desired, 'pod')} on the new revision.`;
    else complete = true;
  } else {
    if (counts.updated < counts.desired) waiting = `${counts.updated} of ${plural(counts.desired, 'node')} updated.`;
    else if (counts.available < counts.desired) waiting = `${counts.available} of ${plural(counts.desired, 'pod')} available.`;
    else complete = true;
  }
  return {
    resource, ...counts, segments, complete, waiting,
    observed: observed >= generation && Boolean(status.observedGeneration),
    generation, strategy, partition,
    paused: Boolean(spec.paused),
    deadline: progressing?.reason === 'ProgressDeadlineExceeded' ? (progressing.message || 'The rollout did not progress within its deadline.') : '',
    newRevision: current?.revision ?? null, fromRevision,
    newHash: current?.hash || '', newPods, pods: mine,
    revisions: revisions.map(({ revision, name, hash, image }) => ({ revision, name, hash, image })),
  };
}

// The pod problem that makes the rollout fail, from the new pods (diagnose.js), or null.
export function failureOf(progress, { now = Date.now() } = {}) {
  if (!progress?.newPods?.length) return null;
  const finding = diagnosePods(progress.newPods, { now }).find(f => f.tone === 'bad' && FAILING.has(f.code));
  return finding || null;
}

// A signature of the counts: any change counts as progress for stall detection.
export const progressSignature = p => (p ? [p.observed ? p.generation : -1, p.newRevision, p.desired, p.updated, p.ready, p.available, p.total, p.segments.newReady, p.segments.newNotReady, p.segments.old, p.segments.terminating].join('|') : '');

export function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0 s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ''}`.trim();
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

// Advance the tracker's state machine. `track` is { action, startedAt, before, lastSignature,
// lastProgressAt, completeAt }; returns { track (updated copy), state }. States: starting,
// progressing, complete, stalled, failing, deadline, paused, gone.
export function evaluate(track, progress, { now = Date.now(), failure = undefined, deleted = false, stallMs = STALL_MS, settleMs = SETTLE_MS } = {}) {
  const next = { ...track };
  if (deleted) return { track: next, state: { id: 'gone', tone: 'bad', label: 'Deleted', detail: 'The workload no longer exists in the cluster.' } };
  if (!progress) return { track: next, state: { id: 'loading', tone: '', label: 'Connecting', detail: 'Waiting for the cluster…' } };
  const signature = progressSignature(progress);
  if (signature !== next.lastSignature) { next.lastSignature = signature; next.lastProgressAt = now; }
  next.lastProgressAt ??= track.startedAt ?? now;
  const elapsed = now - (track.startedAt ?? now);
  // The action has not reached the workload yet: it still looks finished and its generation did not
  // move (or, without a snapshot from before, these are the first seconds). Anything else (rolling,
  // failing) is shown as it is, so a stale snapshot can never hide a failure.
  const expectsChange = ['restart', 'rollback', 'undo', 'apply', 'scale', 'pause', 'resume'].includes(track.action);
  const known = track.before?.generation !== null && track.before?.generation !== undefined;
  const unchanged = known ? progress.generation <= track.before.generation : true;
  const settling = expectsChange && unchanged && progress.complete && elapsed < (known ? Math.max(settleMs, 15000) : settleMs);
  const problem = failure === undefined ? failureOf(progress, { now }) : failure;
  const idle = now - next.lastProgressAt;
  let state;
  if (settling) state = { id: 'starting', tone: 'info', label: 'Starting', detail: 'Waiting for the controller to pick up the change.' };
  else if (progress.deadline && !progress.complete) state = { id: 'deadline', tone: 'bad', label: 'Progress deadline exceeded', detail: problem ? `${problem.title}: ${problem.text}` : progress.deadline, finding: problem };
  else if (problem && !progress.complete) state = { id: 'failing', tone: 'bad', label: 'Failing', detail: `${problem.title}. ${problem.text}`, finding: problem };
  else if (progress.paused) state = { id: 'paused', tone: 'warn', label: 'Paused', detail: progress.complete ? 'Rollouts are paused: template changes wait until you resume.' : `Paused with ${progress.updated} of ${plural(progress.desired, 'pod')} updated. Resume to continue.` };
  else if (progress.complete) state = { id: 'complete', tone: 'good', label: 'Complete', detail: completeText(progress) };
  else if (idle >= stallMs) state = { id: 'stalled', tone: 'warn', label: 'Stalled', detail: `No progress for ${formatElapsed(idle)}. ${progress.waiting}`.trim() };
  else state = { id: 'progressing', tone: 'info', label: 'Progressing', detail: progress.waiting };
  if (state.id === 'complete') next.completeAt ??= now; else next.completeAt = null;
  return { track: next, state };
}

function completeText(p) {
  if (p.desired === 0) return 'Scaled to zero: no pods requested.';
  const rev = p.newRevision !== null ? ` revision ${p.newRevision}` : '';
  if (p.desired === 1) return `${p.resource === 'daemonsets' ? 'The pod on the only node' : 'The only pod'} runs${rev || ' the latest template'} and is available.`;
  return `All ${p.resource === 'daemonsets' ? `${p.desired} nodes run` : `${p.desired} pods run`}${rev || ' the latest template'} and are available.`;
}

// What Undo does: { type: 'rollback', revision } back to the revision the change started from,
// { type: 'scale', replicas } after a scale, or null when there is nothing to undo.
export function undoPlan(track, progress) {
  if (!progress) return null;
  if (track.action === 'scale') {
    const replicas = track.before?.replicas;
    return Number.isFinite(replicas) && replicas !== progress.desired ? { type: 'scale', replicas, label: `Scale back to ${replicas}` } : null;
  }
  // Undo of an Undo would bring the broken revision back: roll back from the details instead.
  if (['pause', 'resume', 'create', 'undo'].includes(track.action)) return null;
  const current = progress.newRevision;
  if (current === null) return null;
  const known = new Set(progress.revisions.map(r => r.revision));
  let target = null;
  if (track.before?.revision !== null && track.before?.revision !== undefined && track.before.revision !== current && known.has(track.before.revision)) target = track.before.revision;
  if (target === null && track.before?.updateRevision) target = progress.revisions.find(r => r.name === track.before.updateRevision && r.revision !== current)?.revision ?? null;
  if (target === null) target = progress.revisions.find(r => r.revision < current)?.revision ?? null;
  return target === null ? null : { type: 'rollback', revision: target, label: `Undo · back to rev ${target}` };
}

// Label selector for the new revision's pods (for their logs).
export function newPodsSelector(resource, progress, workloadSelector) {
  if (!workloadSelector || !progress?.newHash) return workloadSelector || '';
  return `${workloadSelector},${resource === 'deployments' ? 'pod-template-hash' : 'controller-revision-hash'}=${progress.newHash}`;
}

// Bar segments as fractions of the larger of desired and present pods.
export function barSegments(progress) {
  if (!progress) return [];
  const { newReady, newNotReady, old, terminating } = progress.segments;
  const total = Math.max(progress.desired, newReady + newNotReady + old + terminating, 1);
  return [
    { id: 'ready', count: newReady, label: 'new, ready' },
    { id: 'notready', count: newNotReady, label: 'new, not ready' },
    { id: 'old', count: old, label: 'old revision' },
    { id: 'terminating', count: terminating, label: 'terminating' },
  ].filter(s => s.count > 0).map(s => ({ ...s, fraction: s.count / total }));
}

export const trackKey = ref => JSON.stringify([ref.context, ref.namespace, ref.resource, ref.name]);
