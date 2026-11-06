// Capacity map and drain simulator: pure logic, no DOM. Request aggregation (init containers,
// native sidecars, pod overhead), node facts, a squarified treemap for pod tiles, and a
// scheduler-like placement used to answer "what if I drain this node?". Unit tested in Node.
import { parseCPU, parseMemory, formatCPU, formatBytes } from './format.js';

// ---- Requests -----------------------------------------------------------------------------------
const quantity = (resources, key, parse) => {
  const requests = resources?.requests || {}; const limits = resources?.limits || {};
  // A missing request defaults to the limit (the API server fills it in the same way).
  return parse(requests[key] ?? limits[key]) || 0;
};
// The scheduler's view of a pod's requests: the larger of (app containers + native sidecars) and
// every ordinary init container plus the sidecars started before it, plus the pod's overhead.
export function podRequests(pod) {
  const spec = pod?.spec || {};
  const out = {};
  for (const [key, parse] of [['cpu', parseCPU], ['memory', parseMemory]]) {
    let sidecars = 0; let initPeak = 0;
    for (const container of spec.initContainers || []) {
      const value = quantity(container.resources, key, parse);
      if (container.restartPolicy === 'Always') sidecars += value;
      else initPeak = Math.max(initPeak, value + sidecars);
    }
    let app = 0;
    for (const container of spec.containers || []) app += quantity(container.resources, key, parse);
    out[key] = Math.max(app + sidecars, initPeak) + (parse(spec.overhead?.[key]) || 0);
  }
  return out;
}

// ---- Pods ---------------------------------------------------------------------------------------
const controllerOf = pod => (pod?.metadata?.ownerReferences || []).find(ref => ref.controller) || null;
export const podKey = pod => `${pod?.metadata?.namespace || ''}/${pod?.metadata?.name || ''}`;
export const isTerminal = pod => ['Succeeded', 'Failed'].includes(pod?.status?.phase);
// What is wrong with a pod, in the words kubectl uses ('' when nothing is).
export function podProblem(pod) {
  if (pod?.metadata?.deletionTimestamp) return '';
  if (pod?.status?.phase === 'Failed') return pod.status.reason || 'Failed';
  const containers = [...(pod?.status?.initContainerStatuses || []), ...(pod?.status?.containerStatuses || [])];
  for (const c of containers) {
    const waiting = c.state?.waiting?.reason;
    if (waiting && !['ContainerCreating', 'PodInitializing'].includes(waiting)) return waiting;
    const terminated = c.state?.terminated;
    if (terminated && terminated.exitCode !== 0 && pod.status?.phase !== 'Succeeded') return terminated.reason || 'Error';
  }
  if (pod?.status?.phase === 'Running' && (pod.status.containerStatuses || []).some(c => !c.ready)) return 'Not ready';
  if (pod?.status?.phase === 'Pending' && !pod.spec?.nodeName) return 'Unschedulable';
  return '';
}
// How a drain treats a pod: kubectl drain's own filters.
export function podKind(pod) {
  if (pod?.metadata?.annotations?.['kubernetes.io/config.mirror']) return 'mirror';
  const owner = controllerOf(pod);
  if (owner?.kind === 'DaemonSet') return 'daemonset';
  return owner ? 'controller' : 'unmanaged';
}
export const usesEmptyDir = pod => (pod?.spec?.volumes || []).some(volume => volume.emptyDir);
export const claimsOf = pod => (pod?.spec?.volumes || []).map(volume => volume.persistentVolumeClaim?.claimName).filter(Boolean);
// Why a pod is waiting for a node, from its PodScheduled condition.
export function pendingReason(pod) {
  const condition = (pod?.status?.conditions || []).find(c => c.type === 'PodScheduled' && c.status === 'False');
  if (condition) return condition.message || condition.reason || 'Not scheduled yet';
  return pod?.spec?.schedulingGates?.length ? `Waiting for scheduling gates: ${pod.spec.schedulingGates.map(g => g.name).join(', ')}` : 'Not scheduled yet';
}
export function podFacts(pod) {
  const owner = controllerOf(pod);
  return {
    key: podKey(pod), name: pod?.metadata?.name || '', namespace: pod?.metadata?.namespace || '', node: pod?.spec?.nodeName || '',
    phase: pod?.status?.phase || '', terminal: isTerminal(pod), requests: podRequests(pod), kind: podKind(pod),
    owner: owner ? { kind: owner.kind, name: owner.name } : null, emptyDir: usesEmptyDir(pod), claims: claimsOf(pod), problem: podProblem(pod),
    priority: Number(pod?.spec?.priority) || 0, pod,
  };
}

// ---- Nodes --------------------------------------------------------------------------------------
const label = (labels, ...keys) => { for (const key of keys) if (labels[key]) return labels[key]; return ''; };
export function nodeRoles(node) {
  const labels = node?.metadata?.labels || {};
  const roles = Object.keys(labels).filter(key => key.startsWith('node-role.kubernetes.io/')).map(key => key.slice('node-role.kubernetes.io/'.length) || 'node');
  if (labels['kubernetes.io/role'] && !roles.includes(labels['kubernetes.io/role'])) roles.push(labels['kubernetes.io/role']);
  return roles;
}
export const taintText = taint => `${taint.key}${taint.value ? `=${taint.value}` : ''}:${taint.effect}`;
export function nodeFacts(node) {
  const labels = node?.metadata?.labels || {};
  const conditions = node?.status?.conditions || [];
  const ready = conditions.find(c => c.type === 'Ready');
  const allocatable = node?.status?.allocatable || {};
  return {
    name: node?.metadata?.name || '', labels, roles: nodeRoles(node),
    zone: label(labels, 'topology.kubernetes.io/zone', 'failure-domain.beta.kubernetes.io/zone'),
    instanceType: label(labels, 'node.kubernetes.io/instance-type', 'beta.kubernetes.io/instance-type'),
    ready: ready?.status === 'True', cordoned: Boolean(node?.spec?.unschedulable),
    pressures: conditions.filter(c => c.type !== 'Ready' && c.status === 'True').map(c => c.type),
    taints: node?.spec?.taints || [],
    allocatable: { cpu: parseCPU(allocatable.cpu) || 0, memory: parseMemory(allocatable.memory) || 0, pods: Number(allocatable.pods) || 0 },
    node,
  };
}

// ---- The cluster model --------------------------------------------------------------------------
// Pods grouped by node with their requests added up; finished pods are counted but use nothing
// (the scheduler ignores them); pods without a node wait in their own lane.
export function buildModel(nodeItems = [], podItems = []) {
  const nodes = nodeItems.map(node => ({ ...nodeFacts(node), pods: [], finished: 0, requested: { cpu: 0, memory: 0, pods: 0 } }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const byName = new Map(nodes.map(entry => [entry.name, entry]));
  const waiting = []; const orphans = [];
  for (const pod of podItems) {
    const facts = podFacts(pod);
    if (!facts.node) { if (!facts.terminal && !pod?.metadata?.deletionTimestamp) waiting.push({ ...facts, reason: pendingReason(pod) }); continue; }
    const entry = byName.get(facts.node);
    if (!entry) { orphans.push(facts); continue; }
    if (facts.terminal) { entry.finished++; continue; }
    entry.pods.push(facts);
    entry.requested.cpu += facts.requests.cpu; entry.requested.memory += facts.requests.memory; entry.requested.pods++;
  }
  for (const entry of nodes) entry.pods.sort((a, b) => b.requests.cpu - a.requests.cpu || b.requests.memory - a.requests.memory || a.key.localeCompare(b.key));
  waiting.sort((a, b) => b.requests.cpu - a.requests.cpu || a.key.localeCompare(b.key));
  const totals = { allocatable: { cpu: 0, memory: 0, pods: 0 }, requested: { cpu: 0, memory: 0, pods: 0 } };
  for (const entry of nodes) for (const key of ['cpu', 'memory', 'pods']) { totals.allocatable[key] += entry.allocatable[key]; totals.requested[key] += entry.requested[key]; }
  return { nodes, byName, waiting, orphans, totals };
}

// ---- Scheduling filters -------------------------------------------------------------------------
export function tolerates(tolerations = [], taint) {
  return tolerations.some(t => {
    if (t.effect && t.effect !== taint.effect) return false;
    if (!t.key) return t.operator === 'Exists';
    if (t.key !== taint.key) return false;
    return t.operator === 'Exists' || (t.value || '') === (taint.value || '');
  });
}
export const untoleratedTaints = (pod, taints = []) => taints.filter(taint => ['NoSchedule', 'NoExecute'].includes(taint.effect) && !tolerates(pod?.spec?.tolerations || [], taint));
function matchExpression(expression, value, has) {
  const values = expression.values || [];
  switch (expression.operator) {
    case 'In': return has && values.includes(value);
    case 'NotIn': return !has || !values.includes(value);
    case 'Exists': return has;
    case 'DoesNotExist': return !has;
    case 'Gt': return has && Number.isFinite(Number(value)) && Number(value) > Number(values[0]);
    case 'Lt': return has && Number.isFinite(Number(value)) && Number(value) < Number(values[0]);
    default: return false;
  }
}
function matchTerm(term, node) {
  const labels = node.labels || {};
  for (const expression of term.matchExpressions || []) if (!matchExpression(expression, labels[expression.key], Object.prototype.hasOwnProperty.call(labels, expression.key))) return false;
  for (const expression of term.matchFields || []) if (!matchExpression(expression, expression.key === 'metadata.name' ? node.name : undefined, expression.key === 'metadata.name')) return false;
  return Boolean((term.matchExpressions || []).length || (term.matchFields || []).length);
}
// nodeSelector and required node affinity (terms are ORed, expressions within a term ANDed).
export function matchesNode(pod, node) {
  const labels = node.labels || {};
  for (const [key, value] of Object.entries(pod?.spec?.nodeSelector || {})) if (labels[key] !== value) return false;
  const terms = pod?.spec?.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms;
  if (terms && terms.length && !terms.some(term => matchTerm(term, node))) return false;
  return true;
}
const UNSCHEDULABLE_TAINT = { key: 'node.kubernetes.io/unschedulable', effect: 'NoSchedule' };
// Why a node cannot take a pod right now, the way the scheduler words it, or null when it can.
// slot: { cpu, memory, pods } already requested on the node (including earlier placements).
export function rejectReason(facts, node, slot, { draining = new Set() } = {}) {
  if (draining.has(node.name)) return { code: 'draining', text: 'being drained' };
  if (node.cordoned && !tolerates(facts.pod?.spec?.tolerations || [], UNSCHEDULABLE_TAINT)) return { code: 'cordoned', text: 'unschedulable (cordoned)' };
  if (!node.ready) return { code: 'notready', text: 'not ready' };
  if (!matchesNode(facts.pod, node)) return { code: 'affinity', text: "didn't match the pod's node selector or affinity" };
  const taints = untoleratedTaints(facts.pod, node.taints);
  if (taints.length) return { code: 'taint', text: `has untolerated taint ${taints.map(taintText).join(', ')}`, taints };
  if (node.allocatable.pods && slot.pods + 1 > node.allocatable.pods) return { code: 'pods', text: 'too many pods' };
  const cpu = facts.requests.cpu > 0 && slot.cpu + facts.requests.cpu > node.allocatable.cpu + 1e-9;
  const memory = facts.requests.memory > 0 && slot.memory + facts.requests.memory > node.allocatable.memory;
  if (cpu || memory) {
    const parts = [];
    if (cpu) parts.push(`insufficient cpu (needs ${formatCPU(facts.requests.cpu)}, ${formatCPU(Math.max(0, node.allocatable.cpu - slot.cpu))} free)`);
    if (memory) parts.push(`insufficient memory (needs ${formatBytes(facts.requests.memory)}, ${formatBytes(Math.max(0, node.allocatable.memory - slot.memory))} free)`);
    return { code: cpu && memory ? 'resources' : cpu ? 'cpu' : 'memory', text: parts.join(', ') };
  }
  return null;
}
const REASON_LABEL = { draining: 'being drained', cordoned: 'cordoned', notready: 'not ready', affinity: "didn't match node selector/affinity", taint: 'untolerated taint', pods: 'too many pods', cpu: 'insufficient cpu', memory: 'insufficient memory', resources: 'insufficient cpu and memory' };
// "0/3 nodes are available: 1 being drained, 2 untolerated taint {…}" — the scheduler's summary.
export function schedulerMessage(rejections, total) {
  const groups = new Map();
  for (const { reason } of rejections) {
    const text = reason.code === 'taint' ? `untolerated taint {${reason.taints.map(taintText).join(', ')}}` : REASON_LABEL[reason.code] || reason.text;
    groups.set(text, (groups.get(text) || 0) + 1);
  }
  return `0/${total} node${total === 1 ? '' : 's'} available: ${[...groups].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([text, count]) => `${count} ${text}`).join(', ')}`;
}
// Where a pod could run right now (ignoring nothing but inter-pod rules), with each node's refusal.
export function explainPlacement(facts, model, { draining = new Set(), slots } = {}) {
  const rejections = []; const fits = [];
  for (const node of model.nodes) {
    const reason = rejectReason(facts, node, slots?.get(node.name) || node.requested, { draining });
    if (reason) rejections.push({ node: node.name, reason }); else fits.push(node.name);
  }
  return { fits, rejections, message: fits.length ? `fits on ${fits.join(', ')}` : schedulerMessage(rejections, model.nodes.length) };
}

// ---- Free space and fragmentation ---------------------------------------------------------------
const free = (node, slot = node.requested) => ({ cpu: Math.max(0, node.allocatable.cpu - slot.cpu), memory: Math.max(0, node.allocatable.memory - slot.memory), pods: Math.max(0, node.allocatable.pods - slot.pods) });
const openForWork = node => node.ready && !node.cordoned && !untoleratedTaints({ spec: {} }, node.taints).length;
// The largest free CPU and memory on one node that takes ordinary pods, and how the biggest
// waiting pod compares with it: a cluster can have room in total yet none in one piece.
export function fragmentation(model) {
  const open = model.nodes.filter(openForWork);
  const pool = open.length ? open : model.nodes.filter(node => node.ready && !node.cordoned);
  let cpu = { value: 0, node: '' }; let memory = { value: 0, node: '' };
  const total = { cpu: 0, memory: 0 };
  for (const node of pool) {
    const room = free(node);
    total.cpu += room.cpu; total.memory += room.memory;
    if (room.cpu > cpu.value) cpu = { value: room.cpu, node: node.name };
    if (room.memory > memory.value) memory = { value: room.memory, node: node.name };
  }
  const largest = { cpu, memory, total, nodes: pool.length, untaintedOnly: Boolean(open.length) };
  // The waiting pod that is hardest to place: the largest share of the biggest node.
  const maxCPU = Math.max(0, ...model.nodes.map(n => n.allocatable.cpu)) || 1; const maxMemory = Math.max(0, ...model.nodes.map(n => n.allocatable.memory)) || 1;
  const biggest = [...model.waiting].sort((a, b) => Math.max(b.requests.cpu / maxCPU, b.requests.memory / maxMemory) - Math.max(a.requests.cpu / maxCPU, a.requests.memory / maxMemory))[0];
  if (!biggest) return { largest, pending: null, hint: '' };
  // Free room on the nodes this pod may use at all (selectors and taints), resources aside.
  let podCPU = { value: 0, node: '' }; let podMemory = { value: 0, node: '' };
  const eligible = model.nodes.filter(node => { const reason = rejectReason({ ...biggest, requests: { cpu: 0, memory: 0 } }, node, { cpu: 0, memory: 0, pods: 0 }); return !reason; });
  let eligibleTotal = { cpu: 0, memory: 0 };
  for (const node of eligible) {
    const room = free(node);
    eligibleTotal = { cpu: eligibleTotal.cpu + room.cpu, memory: eligibleTotal.memory + room.memory };
    if (room.cpu > podCPU.value) podCPU = { value: room.cpu, node: node.name };
    if (room.memory > podMemory.value) podMemory = { value: room.memory, node: node.name };
  }
  const who = `${biggest.namespace}/${biggest.name}`;
  let hint;
  if (!eligible.length) hint = `${who} is waiting, and no node accepts it at all (node selectors, affinity, taints or cordons rule every node out), so free space would not help.`;
  else {
    const short = [];
    if (biggest.requests.cpu > podCPU.value) short.push(['cpu', biggest.requests.cpu, podCPU, eligibleTotal.cpu]);
    if (biggest.requests.memory > podMemory.value) short.push(['memory', biggest.requests.memory, podMemory, eligibleTotal.memory]);
    if (!short.length) hint = `${who} is waiting although a node it may use has room for it (${podCPU.node}); it is probably held by something this view does not model, such as inter-pod affinity, topology spread or a volume.`;
    else hint = short.map(([kind, need, best, sum]) => {
      const fmt = kind === 'cpu' ? formatCPU : formatBytes;
      const piece = `${who} asks for ${fmt(need)} of ${kind === 'cpu' ? 'CPU' : 'memory'}; the most free on one node it may use is ${fmt(best.value)}${best.node ? ` (${best.node})` : ''}`;
      return sum >= need ? `${piece}. Those nodes have ${fmt(sum)} free together: the room exists but is split across nodes (fragmentation).` : `${piece}, and ${fmt(sum)} across all of them: the cluster is short of ${kind === 'cpu' ? 'CPU' : 'memory'}, not just fragmented. It needs a bigger node.`;
    }).join(' ');
  }
  return { largest, pending: { key: biggest.key, requests: biggest.requests, cpu: podCPU, memory: podMemory, eligible: eligible.map(n => n.name) }, hint };
}

// ---- Pod disruption budgets ---------------------------------------------------------------------
const matchesSelector = (selector, labels = {}) => {
  if (!selector) return false;
  for (const [key, value] of Object.entries(selector.matchLabels || {})) if (labels[key] !== value) return false;
  for (const e of selector.matchExpressions || []) {
    const has = Object.prototype.hasOwnProperty.call(labels, e.key);
    if (!matchExpression(e, labels[e.key], has)) return false;
  }
  return true;
};
const isReady = pod => (pod?.status?.conditions || []).some(c => c.type === 'Ready' && c.status === 'True');
const scaled = (value, total, roundUp) => {
  if (typeof value === 'string' && value.endsWith('%')) { const n = (Number(value.slice(0, -1)) / 100) * total; return roundUp ? Math.ceil(n) : Math.floor(n); }
  return Number(value) || 0;
};
// How many pods a PDB lets go right now: the controller's own count when it has one, else
// worked out from minAvailable / maxUnavailable and the pods' readiness.
export function pdbAllowance(pdb, podItems = []) {
  const namespace = pdb?.metadata?.namespace;
  const pods = podItems.filter(pod => pod?.metadata?.namespace === namespace && !isTerminal(pod) && matchesSelector(pdb?.spec?.selector, pod?.metadata?.labels || {}));
  const status = pdb?.status || {};
  const healthy = Number.isFinite(status.currentHealthy) ? status.currentHealthy : pods.filter(isReady).length;
  const expected = Number.isFinite(status.expectedPods) ? status.expectedPods : pods.length;
  let allowed;
  if (Number.isFinite(status.disruptionsAllowed) && status.observedGeneration !== undefined) allowed = status.disruptionsAllowed;
  else {
    const spec = pdb?.spec || {};
    const desired = spec.minAvailable !== undefined ? scaled(spec.minAvailable, expected, true) : spec.maxUnavailable !== undefined ? expected - scaled(spec.maxUnavailable, expected, true) : expected;
    allowed = Math.max(0, healthy - desired);
  }
  return { allowed, healthy, expected, pods };
}

// ---- The drain simulation -----------------------------------------------------------------------
const share = (requests, node) => Math.max(node.allocatable.cpu ? requests.cpu / node.allocatable.cpu : 0, node.allocatable.memory ? requests.memory / node.allocatable.memory : 0);
// LeastAllocated scoring: the node with the most room left after placing the pod wins.
const score = (facts, node, slot) => {
  const cpu = node.allocatable.cpu ? (node.allocatable.cpu - slot.cpu - facts.requests.cpu) / node.allocatable.cpu : 0;
  const memory = node.allocatable.memory ? (node.allocatable.memory - slot.memory - facts.requests.memory) / node.allocatable.memory : 0;
  return (cpu + memory) / 2;
};
// What happens to every pod on the drained nodes, and whether the rest of the cluster can take
// them. pdbs are PodDisruptionBudget objects; podItems the cluster's pods (for PDB counts).
export function simulateDrain(model, drainNames, { pdbs = [], podItems } = {}) {
  const draining = new Set(drainNames);
  const drained = model.nodes.filter(node => draining.has(node.name));
  const remaining = model.nodes.filter(node => !draining.has(node.name));
  const slots = new Map(model.nodes.map(node => [node.name, { ...node.requested }]));
  const before = new Map(remaining.map(node => [node.name, { ...node.requested }]));
  const ignored = []; const lost = []; const toPlace = [];
  for (const node of drained) {
    for (const facts of node.pods) {
      if (facts.kind === 'daemonset') ignored.push({ ...facts, why: 'DaemonSet pod: stays until the node goes away' });
      else if (facts.kind === 'mirror') ignored.push({ ...facts, why: 'Static (mirror) pod: managed by the kubelet, not evicted' });
      else if (facts.kind === 'unmanaged') lost.push({ ...facts, why: 'No controller: deleted for good (kubectl drain needs --force)' });
      else toPlace.push(facts);
    }
  }
  // Higher priority first, then the biggest pods while there is still room for them.
  const queue = [...toPlace].sort((a, b) => b.priority - a.priority || Math.max(...remaining.map(n => share(b.requests, n)), 0) - Math.max(...remaining.map(n => share(a.requests, n)), 0) || a.key.localeCompare(b.key));
  const placed = []; const unplaced = [];
  for (const facts of queue) {
    let best = null; let bestScore = -Infinity; const rejections = [];
    for (const node of model.nodes) {
      const slot = slots.get(node.name);
      const reason = rejectReason(facts, node, slot, { draining });
      if (reason) { rejections.push({ node: node.name, reason }); continue; }
      const value = score(facts, node, slot);
      if (value > bestScore + 1e-12) { best = node; bestScore = value; }
    }
    if (best) {
      const slot = slots.get(best.name);
      slot.cpu += facts.requests.cpu; slot.memory += facts.requests.memory; slot.pods++;
      placed.push({ ...facts, from: facts.node, to: best.name });
    } else unplaced.push({ ...facts, from: facts.node, rejections, message: schedulerMessage(rejections, model.nodes.length) });
  }
  const destinations = remaining.map(node => ({ name: node.name, allocatable: node.allocatable, before: before.get(node.name), after: { ...slots.get(node.name) }, incoming: placed.filter(p => p.to === node.name) }));
  const pdbResults = checkPDBs(pdbs, podItems || model.nodes.flatMap(n => n.pods.map(p => p.pod)), { evicting: toPlace, unplaced });
  return { drained: drained.map(n => n.name), placed, unplaced, ignored, lost, pdbs: pdbResults, destinations, verdict: verdict({ drained, remaining, placed, unplaced, lost, toPlace, pdbs: pdbResults, ignored }) };
}
export function checkPDBs(pdbs, podItems, { evicting, unplaced }) {
  const unplacedKeys = new Set(unplaced.map(p => p.key));
  const out = [];
  for (const pdb of pdbs) {
    const affected = evicting.filter(facts => facts.namespace === pdb.metadata?.namespace && matchesSelector(pdb.spec?.selector, facts.pod?.metadata?.labels || {}));
    if (!affected.length) continue;
    const { allowed, healthy, expected } = pdbAllowance(pdb, podItems);
    const stuck = affected.filter(facts => unplacedKeys.has(facts.key)).length;
    const name = `${pdb.metadata.namespace}/${pdb.metadata.name}`;
    let level; let text;
    if (affected.length <= allowed) { level = 'ok'; text = `${name} allows ${allowed} disruption${allowed === 1 ? '' : 's'} now; the drain evicts ${affected.length} of its pods.`; }
    else if (stuck || allowed === 0) {
      level = 'blocks';
      if (allowed === 0 && healthy >= expected) text = `${name} allows no disruptions even with all ${expected} pods healthy, so the drain would hang at its first pod until the budget is relaxed or the workload scaled up.`;
      else if (allowed === 0) text = `${name} allows no disruptions now (${healthy} of ${expected} pods healthy), so the drain would stop at its first pod${stuck ? ', and its replacements could not be scheduled anyway' : ' until more of its pods are Ready'}.`;
      else text = `${name} allows ${allowed} disruption${allowed === 1 ? '' : 's'} at a time; the drain evicts ${affected.length} of its pods, and ${stuck === affected.length ? 'none' : `${affected.length - stuck}`} of the replacements would fit, so the drain would wait for them forever.`;
    } else { level = 'waits'; text = `${name} allows ${allowed} disruption${allowed === 1 ? '' : 's'} at a time; the drain evicts ${affected.length} of its pods, so it waits for replacements to become Ready between evictions.`; }
    out.push({ name, allowed, healthy, expected, evicting: affected.length, stuck, level, text });
  }
  return out;
}
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const list = names => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
// One headline and the lines that explain it. level: safe | caution | unsafe | none.
function verdict({ drained, remaining, placed, unplaced, lost, toPlace, pdbs, ignored }) {
  const target = list(drained.map(n => n.name));
  const lines = [];
  if (!drained.length) return { level: 'none', headline: 'Pick one or more nodes to simulate a drain.', lines };
  const blocking = pdbs.filter(p => p.level === 'blocks');
  const waits = pdbs.filter(p => p.level === 'waits');
  const emptyDir = [...placed, ...unplaced].filter(p => p.emptyDir);
  let level; let headline;
  if (unplaced.length) {
    level = 'unsafe';
    const closed = closedNodes(remaining, unplaced);
    const allClosed = remaining.length > 0 && closed.length === remaining.length;
    const all = unplaced.length === toPlace.length;
    // "none of its 31 pods" / "its only pod" / "3 of its 31 pods"
    const its = drained.length > 1 ? 'their' : 'its';
    const who = all ? (toPlace.length === 1 ? `${its} only pod that needs a new home` : `none of ${its} ${toPlace.length} pods`) : `${unplaced.length} of ${its} ${toPlace.length} pods`;
    if (!remaining.length) headline = `Not safe to drain ${target}: no node would be left to run ${its} ${plural(unplaced.length, 'pod')}.`;
    else if (allClosed) {
      headline = `Not safe to drain ${target}: ${who} would have ${all && toPlace.length > 1 ? 'anywhere' : 'nowhere'} to go.`;
      lines.push(remaining.length === 1 ? `The only other node, ${closed[0].name}, ${closed[0].why(unplaced.length)}.` : `Every remaining node is closed to them: ${closed.map(c => `${c.name} ${c.why(unplaced.length)}`).join('; ')}.`);
    } else {
      headline = `Not safe to drain ${target}: ${who} would ${all && toPlace.length > 1 ? '' : 'not '}fit on the remaining nodes.`;
      if (closed.length) lines.push(`${closed.map(c => `${c.name} ${c.why(unplaced.length)}`).join('; ')}.`);
      const groups = new Map();
      for (const pod of unplaced) groups.set(pod.message, (groups.get(pod.message) || 0) + 1);
      for (const [message, count] of [...groups].sort((a, b) => b[1] - a[1]).slice(0, 4)) lines.push(`${plural(count, 'pod')}: ${message}.`);
    }
    const tainted = closed.filter(c => c.code === 'taint');
    lines.push(`Draining now would leave ${unplaced.length === 1 ? 'it' : 'them'} Pending${unplaced.some(p => p.owner) ? ', with their workloads short of replicas,' : ''} until ${allClosed ? (tainted.length ? 'a node they may use is added (or the taint is removed or tolerated)' : 'a node they may use is added') : 'more room is made'}.`);
    if (tainted.some(c => c.controlPlane)) lines.push('Add a worker node first. Control-plane nodes are tainted on purpose: tolerating the taint would put application pods next to the API server and etcd.');
    if (placed.length) lines.push(`The other ${plural(placed.length, 'pod')} would fit.`);
  } else if (blocking.length) {
    level = 'unsafe';
    headline = `The drain of ${target} would stall: ${blocking.length === 1 ? 'a disruption budget blocks it' : `${blocking.length} disruption budgets block it`}.`;
  } else {
    const where = [...new Set(placed.map(p => p.to))];
    const onto = where.length === 1 ? where[0] : `${where.length} other nodes`;
    headline = !toPlace.length ? `Safe to drain ${target}: no pods need a new home.` : toPlace.length === 1 ? `Safe to drain ${target}: the one pod that needs a new home fits on ${onto}.` : `Safe to drain ${target}: all ${toPlace.length} pods fit on ${onto}.`;
    level = lost.length || emptyDir.length || waits.length ? 'caution' : 'safe';
  }
  if (unplaced.length && blocking.length) lines.push(`${blocking.length === 1 ? 'A disruption budget' : `${blocking.length} disruption budgets`} would also hold up the drain (${list(blocking.map(p => p.name))}).`);
  else for (const pdb of blocking) lines.push(pdb.text);
  if (lost.length) lines.push(`${plural(lost.length, 'pod')} with no controller would be deleted and not come back: ${list(lost.slice(0, 4).map(p => `${p.namespace}/${p.name}`))}${lost.length > 4 ? ', …' : ''}.`);
  if (emptyDir.length) lines.push(`${plural(emptyDir.length, 'pod')} keep${emptyDir.length === 1 ? 's' : ''} data in emptyDir volumes, which is lost on eviction.`);
  if (!unplaced.length) for (const pdb of waits) lines.push(pdb.text);
  if (ignored.length) lines.push(`${plural(ignored.length, 'DaemonSet or static pod')} stay${ignored.length === 1 ? 's' : ''} on the node and ${ignored.length === 1 ? 'is' : 'are'} not moved.`);
  return { level, headline, lines };
}
// Remaining nodes that refuse every unplaced pod for one reason other than room (taint, cordon,
// not ready, selector): freeing space elsewhere cannot change their answer.
function closedNodes(remaining, unplaced) {
  const out = [];
  for (const node of remaining) {
    const reasons = unplaced.map(pod => pod.rejections.find(r => r.node === node.name)?.reason).filter(Boolean);
    if (!reasons.length || reasons.length !== unplaced.length) continue;
    const codes = new Set(reasons.map(r => r.code));
    if (codes.size !== 1) continue;
    const code = [...codes][0];
    if (code === 'taint') {
      const taints = [...new Set(reasons.flatMap(r => r.taints.map(taintText)))];
      const controlPlane = reasons.some(r => r.taints.some(t => /node-role\.kubernetes\.io\/(control-plane|master)/.test(t.key)));
      out.push({ name: node.name, code, controlPlane, why: count => `has the taint ${list(taints)}, which ${count === 1 ? 'this pod does not tolerate' : 'none of these pods tolerate'}` });
    } else if (code === 'cordoned') out.push({ name: node.name, code, why: () => 'is cordoned' });
    else if (code === 'notready') out.push({ name: node.name, code, why: () => 'is not Ready' });
    else if (code === 'affinity') out.push({ name: node.name, code, why: count => `does not match ${count === 1 ? "the pod's" : "these pods'"} node selector or affinity` });
  }
  return out;
}

// ---- Tiles --------------------------------------------------------------------------------------
// Squarified treemap (Bruls, Huizing, van Wijk): rectangles whose areas are proportional to the
// values, laid out in rows along the shorter side so they stay close to square.
// values: numbers (>= 0). Returns [{ index, x, y, w, h }] in the same units as width/height.
export function squarify(values, width, height) {
  const items = values.map((value, index) => ({ index, value: Math.max(0, Number(value) || 0) })).filter(item => item.value > 0).sort((a, b) => b.value - a.value || a.index - b.index);
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const out = [];
  if (!total || width <= 0 || height <= 0) return out;
  const scale = (width * height) / total;
  const areas = items.map(item => ({ index: item.index, area: item.value * scale }));
  let x = 0; let y = 0; let w = width; let h = height;
  const worst = (row, side) => {
    const sum = row.reduce((s, r) => s + r.area, 0); let max = 0; let min = Infinity;
    for (const r of row) { max = Math.max(max, r.area); min = Math.min(min, r.area); }
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };
  const lay = row => {
    const sum = row.reduce((s, r) => s + r.area, 0);
    if (w >= h) { // a column on the left
      const cw = sum / h; let cy = y;
      for (const r of row) { const rh = r.area / cw; out.push({ index: r.index, x, y: cy, w: cw, h: rh }); cy += rh; }
      x += cw; w -= cw;
    } else { // a row on top
      const rh = sum / w; let cx = x;
      for (const r of row) { const rw = r.area / rh; out.push({ index: r.index, x: cx, y, w: rw, h: rh }); cx += rw; }
      y += rh; h -= rh;
    }
  };
  let row = [];
  for (const item of areas) {
    const side = Math.min(w, h);
    if (!row.length || worst([...row, item], side) <= worst(row, side)) row.push(item);
    else { lay(row); row = [item]; }
  }
  if (row.length) lay(row);
  return out;
}
// Tile values for one node: each pod's request, with a floor so pods without requests still show.
export function tileValues(pods, basis = 'cpu') {
  const values = pods.map(p => p.requests[basis] || 0);
  const max = Math.max(0, ...values);
  const floor = max > 0 ? max * 0.04 : 1;
  return values.map(value => Math.max(value, floor));
}

// ---- Colours ------------------------------------------------------------------------------------
const hash = text => { let h = 2166136261; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
// A palette slot per namespace. The preferred slot comes from the name, so a namespace keeps its
// colour from one render to the next; names may repeat (one per pod) and the namespaces with
// the most pods claim their slots first, so only the smallest share a colour once it runs out.
export function namespaceColors(names, size) {
  const counts = new Map();
  for (const name of names) counts.set(name, (counts.get(name) || 0) + 1);
  const out = new Map(); const claimed = [];
  let overflow = 0;
  for (const name of [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b))) {
    let slot;
    if (claimed.length < size) { slot = hash(name) % size; while (claimed.includes(slot)) slot = (slot + 1) % size; claimed.push(slot); }
    else slot = claimed[size - 1 - (overflow++ % size)]; // reuse the smallest namespaces' colours first
    out.set(name, slot);
  }
  return out;
}
