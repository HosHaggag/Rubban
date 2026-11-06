// Health of one list row, in a word and a tone ('good' | 'warn' | 'bad' | ''), so every list can
// tint the rows that need attention and offer "Healthy · Warning · Failing" filters. Pure: no DOM.

const WAITING_BAD = /BackOff|Err|Error|OOMKilled|Invalid|CreateContainerConfigError|DeadlineExceeded/;

function podTone(item) {
  if (item.metadata?.deletionTimestamp) return 'warn';
  const containers = [...(item.status?.initContainerStatuses || []), ...(item.status?.containerStatuses || [])];
  const reason = containers.map(c => c.state?.waiting?.reason || (c.state?.terminated && c.state.terminated.exitCode !== 0 ? c.state.terminated.reason || 'Error' : '')).find(value => value && !['ContainerCreating', 'PodInitializing'].includes(value));
  if (reason) return WAITING_BAD.test(reason) ? 'bad' : 'warn';
  const phase = item.status?.phase;
  if (phase === 'Failed' || phase === 'Unknown') return 'bad';
  if (phase === 'Pending') return 'warn';
  if (phase === 'Running' && containers.length && containers.some(c => !c.ready)) return 'warn';
  return phase === 'Running' || phase === 'Succeeded' ? 'good' : '';
}

// Desired, ready and updated replicas of a workload (DaemonSets count scheduled nodes).
export function replicaCounts(resource, item) {
  const status = item.status || {};
  if (resource === 'daemonsets') return { desired: status.desiredNumberScheduled ?? 0, ready: status.numberReady ?? 0, updated: status.updatedNumberScheduled ?? 0, available: status.numberAvailable ?? 0 };
  return { desired: item.spec?.replicas ?? 1, ready: status.readyReplicas ?? 0, updated: status.updatedReplicas ?? 0, available: status.availableReplicas ?? 0 };
}

// A workload's state in plain words: Healthy, Rolling out, Degraded, Unavailable, Scaled to zero, Paused.
export function workloadState(resource, item) {
  const { desired, ready, updated } = replicaCounts(resource, item);
  const conditions = item.status?.conditions || [];
  const progressing = conditions.find(c => c.type === 'Progressing');
  const failure = conditions.find(c => c.type === 'ReplicaFailure' && c.status === 'True');
  if (item.metadata?.deletionTimestamp) return { label: 'Terminating', tone: 'warn' };
  if (item.spec?.paused) return { label: 'Paused', tone: 'warn', detail: `${ready}/${desired} ready` };
  if (desired === 0) return { label: 'Scaled to zero', tone: '', detail: 'no replicas requested' };
  if (progressing?.reason === 'ProgressDeadlineExceeded') return { label: 'Rollout stuck', tone: 'bad', detail: progressing.message || `${ready}/${desired} ready` };
  if (failure) return { label: 'Failing', tone: 'bad', detail: failure.message || failure.reason };
  if (ready === 0) return { label: 'Unavailable', tone: 'bad', detail: `0/${desired} ready` };
  const generation = item.metadata?.generation; const observed = item.status?.observedGeneration;
  const rolling = (generation && observed && observed < generation) || (updated < desired && resource !== 'replicasets');
  if (ready < desired) return { label: rolling ? 'Rolling out' : 'Degraded', tone: 'warn', detail: `${ready}/${desired} ready` };
  if (rolling) return { label: 'Rolling out', tone: 'warn', detail: `${updated}/${desired} updated` };
  return { label: 'Healthy', tone: 'good', detail: `${ready}/${desired} ready` };
}

const WORKLOADS = new Set(['deployments', 'statefulsets', 'daemonsets', 'replicasets', 'replicationcontrollers']);

export function healthTone(resource, item) {
  if (!item || typeof item !== 'object') return '';
  if (resource === 'pods') return podTone(item);
  if (WORKLOADS.has(resource)) {
    // Old ReplicaSets of a Deployment sit at zero replicas: not a problem.
    if (resource === 'replicasets' && (item.spec?.replicas ?? 1) === 0) return '';
    return workloadState(resource, item).tone;
  }
  if (resource === 'jobs') {
    const conditions = item.status?.conditions || [];
    if (conditions.some(c => c.type === 'Failed' && c.status === 'True')) return 'bad';
    if (conditions.some(c => c.type === 'Complete' && c.status === 'True')) return 'good';
    return (item.status?.failed || 0) > 0 ? 'warn' : '';
  }
  if (resource === 'nodes') {
    const conditions = item.status?.conditions || [];
    const ready = conditions.find(c => c.type === 'Ready');
    if (!ready || ready.status !== 'True') return 'bad';
    if (conditions.some(c => c.type !== 'Ready' && c.status === 'True')) return 'warn';
    return item.spec?.unschedulable ? 'warn' : 'good';
  }
  if (resource === 'persistentvolumeclaims') return item.status?.phase === 'Bound' ? 'good' : item.status?.phase === 'Lost' ? 'bad' : 'warn';
  if (resource === 'events') return item.type === 'Warning' ? 'warn' : '';
  if (resource === 'applications.argoproj.io') {
    const health = item.status?.health?.status; const sync = item.status?.sync?.status;
    if (['Degraded', 'Missing'].includes(health)) return 'bad';
    if (health === 'Progressing' || health === 'Suspended' || sync === 'OutOfSync') return 'warn';
    return health === 'Healthy' ? 'good' : '';
  }
  return '';
}

const FACET_KINDS = new Set(['pods', 'jobs', 'nodes', 'persistentvolumeclaims', 'applications.argoproj.io', ...WORKLOADS]);
// Filter chips for a list: only for kinds whose health we can tell.
export function healthFacets(resource) {
  if (!FACET_KINDS.has(resource)) return null;
  const words = resource === 'pods' ? ['Running', 'Pending / not ready', 'Failing'] : resource === 'nodes' ? ['Ready', 'Pressure / cordoned', 'Not ready'] : ['Healthy', 'Degraded', 'Failing'];
  return [
    { id: 'good', label: words[0], tone: 'good', test: item => healthTone(resource, item) === 'good' },
    { id: 'warn', label: words[1], tone: 'warn', test: item => healthTone(resource, item) === 'warn' },
    { id: 'bad', label: words[2], tone: 'bad', test: item => healthTone(resource, item) === 'bad' },
  ];
}
