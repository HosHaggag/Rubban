// Live resource consumption from metrics.k8s.io (metrics-server), refreshed every 15 seconds
// for the selected cluster, plus helpers that aggregate it for pods, workloads, namespaces and nodes.
import { parseCPU, parseMemory, podResources, matchesSelector } from './format.js';

const REFRESH_MS = 15000;
const HISTORY_SAMPLES = 240; // one hour of session history at the refresh interval

export function createUsage({ api }) {
  let context = '';
  let pods = new Map();
  let nodes = new Map();
  let version = 0;
  let available = null;
  let message = '';
  let timer = null;
  let controller = null;
  let snapshots = [];
  let missing = {};
  const listeners = new Set();

  async function refresh() {
    if (!context) return;
    const forContext = context;
    controller?.abort();
    controller = new AbortController();
    try {
      const data = await api('/api/metrics', { query: { context: forContext, namespace: '*' }, signal: controller.signal });
      if (forContext !== context) return;
      const nextPods = new Map();
      for (const item of data.pods?.items || []) {
        const containers = new Map();
        let cpu = 0; let memory = 0;
        for (const container of item.containers || []) {
          const c = parseCPU(container.usage?.cpu) || 0; const m = parseMemory(container.usage?.memory) || 0;
          containers.set(container.name, { cpu: c, memory: m }); cpu += c; memory += m;
        }
        nextPods.set(`${item.metadata?.namespace}/${item.metadata?.name}`, { cpu, memory, containers, timestamp: item.timestamp, source: item.source || 'metrics-server' });
      }
      const nextNodes = new Map();
      for (const item of data.nodes?.items || []) nextNodes.set(item.metadata?.name, { cpu: parseCPU(item.usage?.cpu) || 0, memory: parseMemory(item.usage?.memory) || 0, timestamp: item.timestamp, source: item.source || 'metrics-server' });
      pods = nextPods; nodes = nextNodes; missing = data.missingNodes || {};
      if (nextPods.size || nextNodes.size) { snapshots.push({ t: Date.now() / 1000, pods: nextPods, nodes: nextNodes }); if (snapshots.length > HISTORY_SAMPLES) snapshots.shift(); }
      available = nextPods.size > 0 || nextNodes.size > 0;
      message = available ? '' : (data.warnings || []).join(' · ') || 'metrics.k8s.io returned no samples';
    } catch (error) {
      if (error.name === 'AbortError' || forContext !== context) return;
      available = false; message = error.message;
    }
    version++;
    for (const listener of [...listeners]) { try { listener(); } catch { /* Keep other views updating. */ } }
  }

  return {
    setContext(next) {
      if (next === context) return;
      context = next; pods = new Map(); nodes = new Map(); missing = {}; snapshots = []; available = null; message = ''; version++;
      clearInterval(timer); timer = null; controller?.abort();
      if (context) { refresh(); timer = setInterval(refresh, REFRESH_MS); }
    },
    refresh,
    onChange(listener, signal) { if (signal?.aborted) return () => {}; listeners.add(listener); signal?.addEventListener('abort', () => listeners.delete(listener), { once: true }); return () => listeners.delete(listener); },
    get version() { return version; },
    get available() { return available; },
    get message() { return message; },
    pod(item) { return pods.get(`${item?.metadata?.namespace}/${item?.metadata?.name}`) || null; },
    node(name) { return nodes.get(name) || null; },
    // Why a node has no usage (metrics-server left it out and the kubelet could not be read).
    nodeMissing(name) { return missing[name] || ''; },
    get nodes() { return nodes; },
    get pods() { return pods; },
    // Session history (since this cluster was selected) for a set of pods or one node.
    history(podList) {
      const keys = podList.map(pod => `${pod.metadata?.namespace}/${pod.metadata?.name}`);
      const cpu = []; const memory = [];
      for (const snap of snapshots) {
        let c = 0; let m = 0; let seen = 0;
        for (const key of keys) { const sample = snap.pods.get(key); if (sample) { c += sample.cpu; m += sample.memory; seen++; } }
        if (seen) { cpu.push([snap.t, c]); memory.push([snap.t, m]); }
      }
      return { cpu, memory };
    },
    // History for pods whose "namespace/name" key satisfies the predicate.
    historyWhere(predicate) {
      const cpu = []; const memory = [];
      for (const snap of snapshots) {
        let c = 0; let m = 0; let seen = 0;
        for (const [key, sample] of snap.pods) { const slash = key.indexOf('/'); if (predicate(key.slice(0, slash), key.slice(slash + 1))) { c += sample.cpu; m += sample.memory; seen++; } }
        if (seen) { cpu.push([snap.t, c]); memory.push([snap.t, m]); }
      }
      return { cpu, memory };
    },
    containerHistory(pod, container) {
      const key = `${pod.metadata?.namespace}/${pod.metadata?.name}`;
      const cpu = []; const memory = [];
      for (const snap of snapshots) { const sample = snap.pods.get(key)?.containers.get(container); if (sample) { cpu.push([snap.t, sample.cpu]); memory.push([snap.t, sample.memory]); } }
      return { cpu, memory };
    },
    nodeHistory(name) {
      const cpu = []; const memory = [];
      for (const snap of snapshots) { const sample = snap.nodes.get(name); if (sample) { cpu.push([snap.t, sample.cpu]); memory.push([snap.t, sample.memory]); } }
      return { cpu, memory };
    },
    clusterHistory(filter = () => true) {
      const cpu = []; const memory = [];
      for (const snap of snapshots) { let c = 0; let m = 0; let seen = 0; for (const [name, sample] of snap.nodes) if (filter(name)) { c += sample.cpu; m += sample.memory; seen++; } if (seen) { cpu.push([snap.t, c]); memory.push([snap.t, m]); } }
      return { cpu, memory };
    },
    get samples() { return snapshots.length; },
    // Totals for a set of pods: usage plus requests and limits declared in their specs.
    summarize(podList) {
      const total = { cpu: 0, memory: 0, cpuRequest: 0, memoryRequest: 0, cpuLimit: 0, memoryLimit: 0, cpuLimitMissing: false, memoryLimitMissing: false, measured: 0, pods: podList.length };
      for (const pod of podList) {
        const usage = pods.get(`${pod.metadata?.namespace}/${pod.metadata?.name}`);
        if (usage) { total.cpu += usage.cpu; total.memory += usage.memory; total.measured++; }
        if (['Succeeded', 'Failed'].includes(pod.status?.phase)) continue;
        const r = podResources(pod);
        total.cpuRequest += r.cpuRequest; total.memoryRequest += r.memoryRequest; total.cpuLimit += r.cpuLimit; total.memoryLimit += r.memoryLimit;
        total.cpuLimitMissing ||= r.cpuLimitMissing; total.memoryLimitMissing ||= r.memoryLimitMissing;
      }
      return total;
    },
  };
}

// Pods selected by a workload (same namespace, label selector match), with Job/CronJob handling.
export function podsForWorkload(workload, podList, { kind } = {}) {
  const namespace = workload.metadata?.namespace;
  const k = kind || workload.kind;
  if (k === 'CronJob') return [];
  if (k === 'Node') return podList.filter(pod => pod.spec?.nodeName === workload.metadata?.name);
  const selector = k === 'Service' ? workload.spec?.selector : workload.spec?.selector;
  if (!selector) return [];
  return podList.filter(pod => pod.metadata?.namespace === namespace && matchesSelector(selector, pod.metadata?.labels || {}));
}

// Groups pods by namespace for cheaper repeated selector matching.
export function indexPods(podList) {
  const byNamespace = new Map();
  for (const pod of podList) {
    const ns = pod.metadata?.namespace || '';
    if (!byNamespace.has(ns)) byNamespace.set(ns, []);
    byNamespace.get(ns).push(pod);
  }
  return {
    all: podList,
    inNamespace: ns => byNamespace.get(ns) || [],
    forWorkload(workload) {
      if (workload.kind === 'Node') return podList.filter(pod => pod.spec?.nodeName === workload.metadata?.name);
      const selector = workload.spec?.selector;
      if (!selector) return [];
      return (byNamespace.get(workload.metadata?.namespace || '') || []).filter(pod => matchesSelector(selector, pod.metadata?.labels || {}));
    },
  };
}
