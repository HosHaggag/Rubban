// Rightsizing: what a workload asks for against what it uses, what that costs and what to change.
// Pure logic (no DOM, no network): recommendations, classification, cost, the session sample store,
// the strategic-merge patch, the manifest for the reviewed apply and the equivalent kubectl command.
// Units: CPU in cores, memory in bytes, prices per vCPU-hour and per GiB-hour.

export const HOURS_PER_MONTH = 730;
export const DEFAULT_PRICES = Object.freeze({ cpu: 0.031, memory: 0.004, currency: 'USD' });
export const CPU_HEADROOM = 1.2;
export const MEMORY_HEADROOM = 1.15;
const MI = 2 ** 20;
const GI = 2 ** 30;
export const CPU_FLOOR = 0.01; // 10m
export const MEMORY_FLOOR = 32 * MI;
// A request is over-provisioned when the recommendation frees at least a third of it and the
// difference is worth a change (a restart of every pod).
const OVER_RATIO = 2 / 3;
const OVER_MIN_CPU = 0.02;
const OVER_MIN_MEMORY = 32 * MI;
// Usage this close to a limit is throttled (CPU) or about to be OOM-killed (memory).
const LIMIT_PRESSURE = 0.9;
// Below this many session samples the p95 is meaningless: the peak is used instead.
const MIN_SAMPLES_FOR_P95 = 20;
export const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration';

export const STATUSES = Object.freeze({
  over: { label: 'Over-provisioned', level: 'warn' },
  under: { label: 'Under-provisioned', level: 'bad' },
  none: { label: 'No requests set', level: 'info' },
  ok: { label: 'About right', level: 'good' },
  nodata: { label: 'No usage data', level: '' },
});
// Worst first: a workload takes the status of its most urgent container.
const STATUS_ORDER = ['under', 'none', 'over', 'ok', 'nodata'];

const finite = value => typeof value === 'number' && Number.isFinite(value);
const positive = value => finite(value) && value > 0;

// Kubernetes quantities ("250m", "1.5", "512Mi", "2G") in base units; NaN when absent or invalid.
const BINARY = { Ki: 2 ** 10, Mi: MI, Gi: GI, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };
const DECIMAL = { n: 1e-9, u: 1e-6, m: 1e-3, '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };
export function quantity(value) {
  if (value === undefined || value === null || value === '') return NaN;
  if (typeof value === 'number') return value;
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(Ki|Mi|Gi|Ti|Pi|Ei|n|u|m|k|K|M|G|T|P|E)?$/.exec(String(value).trim());
  if (!match) return NaN;
  return Number(match[1]) * (BINARY[match[2] || ''] ?? DECIMAL[match[2] || ''] ?? 1);
}

// ---- Rounding to values people would write ---------------------------------------------------
// CPU rounds up to 10m below 100m, to 50m below one core and to 100m above.
export function roundCPU(cores) {
  if (!finite(cores) || cores <= 0) return CPU_FLOOR;
  const milli = cores * 1000;
  const step = milli <= 100 ? 10 : milli <= 1000 ? 50 : 100;
  return Math.max(CPU_FLOOR, (Math.ceil(milli / step - 1e-9) * step) / 1000);
}
// Memory rounds up to 16Mi up to 256Mi and to 64Mi above.
export function roundMemory(bytes) {
  if (!finite(bytes) || bytes <= 0) return MEMORY_FLOOR;
  const mi = bytes / MI;
  const step = mi <= 256 ? 16 : 64;
  return Math.max(MEMORY_FLOOR, Math.ceil(mi / step - 1e-9) * step * MI);
}
// Quantity strings for manifests and kubectl.
export function cpuQuantity(cores) {
  const milli = Math.round(cores * 1000);
  return milli % 1000 === 0 ? String(milli / 1000) : `${milli}m`;
}
export function memoryQuantity(bytes) {
  if (bytes >= GI && bytes % GI === 0) return `${bytes / GI}Gi`;
  return `${Math.ceil(bytes / MI)}Mi`;
}

// Nearest-rank percentile of a list of numbers (NaN for an empty list).
export function percentile(values, p) {
  const list = values.filter(finite).sort((a, b) => a - b);
  if (!list.length) return NaN;
  const rank = Math.ceil((p / 100) * list.length);
  return list[Math.min(list.length - 1, Math.max(0, rank - 1))];
}

// ---- Cost -------------------------------------------------------------------------------------
// Prices from storage are trusted only when they are sensible numbers.
export function normalizePrices(value) {
  const out = { ...DEFAULT_PRICES };
  if (value && typeof value === 'object') {
    const cpu = Number(value.cpu); const memory = Number(value.memory);
    if (Number.isFinite(cpu) && cpu >= 0 && cpu < 1000) out.cpu = cpu;
    if (Number.isFinite(memory) && memory >= 0 && memory < 1000) out.memory = memory;
    const currency = typeof value.currency === 'string' ? value.currency.trim().slice(0, 8) : '';
    if (currency) out.currency = currency;
  }
  return out;
}
// Monthly cost of holding this much CPU and memory, from the per-hour prices.
export function monthlyCost(cpuCores, memoryBytes, prices) {
  const cpu = finite(cpuCores) ? cpuCores : 0; const memory = finite(memoryBytes) ? memoryBytes : 0;
  return (cpu * prices.cpu + (memory / GI) * prices.memory) * HOURS_PER_MONTH;
}
export function formatMoney(value, currency = DEFAULT_PRICES.currency) {
  if (!finite(value)) return '—';
  const digits = Math.abs(value) >= 100 ? 0 : 2;
  if (/^[A-Za-z]{3}$/.test(currency)) {
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value); } catch { /* Not an ISO code: fall through. */ }
  }
  const text = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${value < 0 ? '-' : ''}${currency}${/^[A-Za-z]/.test(currency) ? ' ' : ''}${text}`;
}

// Prices are small numbers: keep the digits that matter (0.031, 0.0045).
export function formatPrice(value, currency = DEFAULT_PRICES.currency) {
  if (!finite(value)) return '—';
  const text = String(Number(value.toPrecision(3)));
  if (/^[A-Za-z]{3}$/.test(currency)) {
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: 2, maximumFractionDigits: Math.max(2, (text.split('.')[1] || '').length) }).format(value); } catch { /* Not an ISO code. */ }
  }
  return `${currency}${/^[A-Za-z]/.test(currency) ? ' ' : ''}${text}`;
}

// ---- Which pods belong to a workload -----------------------------------------------------------
// Pod names follow the controller: <deployment>-<template hash>-<5>, <statefulset>-<ordinal>,
// <daemonset>-<5>. History outlives the pods it was recorded for, so it is matched by name.
const escapeRE = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function podPattern(kind, name) {
  const base = escapeRE(name);
  if (kind === 'StatefulSet') return new RegExp(`^${base}-\\d+$`);
  if (kind === 'DaemonSet') return new RegExp(`^${base}-[a-z0-9]{5}$`);
  return new RegExp(`^${base}-[a-z0-9]{1,10}-[a-z0-9]{5}$`);
}
export const podMatchesWorkload = (kind, name, podName) => podPattern(kind, name).test(podName);

// ---- Session samples (metrics-server) -----------------------------------------------------------
// metrics-server only knows the present. While Rubban runs, every usage refresh is kept here per
// cluster, pod and container, so recommendations improve the longer a cluster stays open.
export function createSampleStore({ maxSamples = 2880, maxAgeMs = 12 * 3600_000 } = {}) {
  const refreshes = new Map(); // context -> refreshes that brought new samples
  const contexts = new Map(); // context -> Map(namespace -> Map(pod -> { stamp, last, containers: Map(name -> { cpu: [], memory }) }))
  return {
    // pods: Map("namespace/name" -> { timestamp, containers: Map(name -> { cpu, memory }) }), as usage.js keeps them.
    add(context, pods, now = Date.now()) {
      if (!context || !pods) return 0;
      if (!contexts.has(context)) contexts.set(context, new Map());
      const namespaces = contexts.get(context);
      let added = 0;
      for (const [key, sample] of pods) {
        const slash = key.indexOf('/');
        if (slash < 0 || !sample?.containers) continue;
        const namespace = key.slice(0, slash); const pod = key.slice(slash + 1);
        if (!namespaces.has(namespace)) namespaces.set(namespace, new Map());
        const byPod = namespaces.get(namespace);
        let entry = byPod.get(pod);
        // The same metrics-server sample is reported until the next scrape: count it once.
        const stamp = sample.timestamp || '';
        if (entry && stamp && entry.stamp === stamp) continue;
        if (!entry) { entry = { stamp: '', first: now, last: now, containers: new Map() }; byPod.set(pod, entry); }
        entry.stamp = stamp; entry.last = now;
        for (const [name, value] of sample.containers) {
          if (!entry.containers.has(name)) entry.containers.set(name, { cpu: [], memory: 0, first: now });
          const series = entry.containers.get(name);
          if (finite(value.cpu)) { series.cpu.push(value.cpu); if (series.cpu.length > maxSamples) series.cpu.shift(); }
          if (finite(value.memory)) series.memory = Math.max(series.memory, value.memory);
        }
        added++;
      }
      if (added) refreshes.set(context, (refreshes.get(context) || 0) + 1);
      // Pods gone for longer than the window no longer describe their workload.
      for (const byPod of namespaces.values()) for (const [pod, entry] of byPod) if (now - entry.last > maxAgeMs) byPod.delete(pod);
      return added;
    },
    // Per container of a workload: { cpu (p95, or peak when there are few samples), cpuPeak, memory (max), samples, since, until, source }.
    forWorkload(context, namespace, kind, name) {
      const out = new Map();
      const byPod = contexts.get(context)?.get(namespace);
      if (!byPod) return out;
      const pattern = podPattern(kind, name);
      const pooled = new Map();
      for (const [pod, entry] of byPod) {
        if (!pattern.test(pod)) continue;
        for (const [container, series] of entry.containers) {
          if (!pooled.has(container)) pooled.set(container, { cpu: [], memory: 0, since: Infinity, until: 0 });
          const agg = pooled.get(container);
          agg.cpu.push(...series.cpu); agg.memory = Math.max(agg.memory, series.memory);
          agg.since = Math.min(agg.since, series.first); agg.until = Math.max(agg.until, entry.last);
        }
      }
      for (const [container, agg] of pooled) {
        if (!agg.cpu.length) continue;
        const peak = Math.max(...agg.cpu);
        out.set(container, { cpu: agg.cpu.length >= MIN_SAMPLES_FOR_P95 ? percentile(agg.cpu, 95) : peak, cpuPeak: peak, memory: agg.memory, samples: agg.cpu.length, since: agg.since, until: agg.until, source: 'session' });
      }
      return out;
    },
    // How long this cluster has been sampled and how many refreshes were kept.
    coverage(context) {
      let since = Infinity; let until = 0; let pods = 0;
      const namespaces = contexts.get(context);
      for (const byPod of namespaces?.values() || []) for (const entry of byPod.values()) { pods++; since = Math.min(since, entry.first); until = Math.max(until, entry.last); }
      return pods ? { since, until, pods, refreshes: refreshes.get(context) || 0 } : null;
    },
    clear(context) { if (context) { contexts.delete(context); refreshes.delete(context); } else { contexts.clear(); refreshes.clear(); } },
  };
}

// Prometheus rows ({ namespace, pod, container, cpu, memory }) folded into a workload's containers:
// the busiest pod of the window decides, since every pod gets the same request.
export function historyForWorkload(rows, namespace, kind, name, window) {
  const out = new Map();
  const pattern = podPattern(kind, name);
  for (const row of rows || []) {
    if (row.namespace !== namespace || !pattern.test(row.pod || '')) continue;
    const current = out.get(row.container) || { cpu: NaN, memory: NaN, pods: 0, source: 'prometheus', window };
    if (finite(row.cpu)) current.cpu = finite(current.cpu) ? Math.max(current.cpu, row.cpu) : row.cpu;
    if (finite(row.memory)) current.memory = finite(current.memory) ? Math.max(current.memory, row.memory) : row.memory;
    current.pods++;
    out.set(row.container, current);
  }
  for (const [container, value] of out) if (!finite(value.cpu) || !finite(value.memory)) out.delete(container);
  return out;
}

// ---- Recommendations -------------------------------------------------------------------------
// Requests and limits of a container spec; a missing request defaults to the limit (as in Kubernetes).
export function containerResources(container) {
  const requests = container?.resources?.requests || {}; const limits = container?.resources?.limits || {};
  const limit = { cpu: quantity(limits.cpu), memory: quantity(limits.memory) };
  return {
    name: container?.name || '',
    request: { cpu: finite(quantity(requests.cpu)) ? quantity(requests.cpu) : limit.cpu, memory: finite(quantity(requests.memory)) ? quantity(requests.memory) : limit.memory },
    limit,
  };
}

const hasData = usage => Boolean(usage) && finite(usage.cpu) && finite(usage.memory);

// One container: current requests/limits and usage in, the change (if any) and why out.
// usage: { cpu (p95 or peak), cpuPeak?, memory (max), source, samples? }.
export function recommendContainer(spec, usage) {
  const { request, limit } = spec;
  const flags = [];
  if (!positive(request.cpu)) flags.push('no-cpu-request');
  if (!positive(request.memory)) flags.push('no-memory-request');
  const base = { name: spec.name, request, limit, usage: usage || null, flags };
  if (!hasData(usage)) return { ...base, status: flags.length ? 'none' : 'nodata', next: null, changed: false };

  const cpuTarget = roundCPU(usage.cpu * CPU_HEADROOM);
  const memoryTarget = roundMemory(usage.memory * MEMORY_HEADROOM);
  const peak = finite(usage.cpuPeak) ? Math.max(usage.cpuPeak, usage.cpu) : usage.cpu;
  if (positive(limit.cpu) && peak >= LIMIT_PRESSURE * limit.cpu) flags.push('throttle-risk');
  if (positive(limit.memory) && usage.memory >= LIMIT_PRESSURE * limit.memory) flags.push('oom-risk');
  if (positive(request.cpu) && usage.cpu > request.cpu) flags.push('cpu-under');
  if (positive(request.memory) && usage.memory > request.memory) flags.push('memory-under');
  if (positive(request.cpu) && cpuTarget <= request.cpu * OVER_RATIO && request.cpu - cpuTarget >= OVER_MIN_CPU) flags.push('cpu-over');
  if (positive(request.memory) && memoryTarget <= request.memory * OVER_RATIO && request.memory - memoryTarget >= OVER_MIN_MEMORY) flags.push('memory-over');

  // Only what is wrong changes; a request within the band stays, so pods are not restarted for nothing.
  const changeCPU = flags.some(flag => ['no-cpu-request', 'cpu-under', 'cpu-over'].includes(flag));
  const changeMemory = flags.some(flag => ['no-memory-request', 'memory-under', 'memory-over', 'oom-risk'].includes(flag));
  const next = { request: { cpu: changeCPU ? cpuTarget : request.cpu, memory: changeMemory ? Math.max(memoryTarget, flags.includes('oom-risk') && positive(request.memory) ? request.memory : 0) : request.memory }, limit: { ...limit } };
  // A limit stays unless it is below the new request (invalid) or the container is pressed against it.
  if (positive(limit.cpu)) {
    let cpuLimit = limit.cpu;
    if (flags.includes('throttle-risk')) cpuLimit = Math.max(cpuLimit, roundCPU(peak * 1.5));
    next.limit.cpu = Math.max(cpuLimit, next.request.cpu);
  }
  if (positive(limit.memory)) {
    let memoryLimit = limit.memory;
    if (flags.includes('oom-risk')) memoryLimit = Math.max(memoryLimit, roundMemory(usage.memory * 1.3));
    next.limit.memory = Math.max(memoryLimit, next.request.memory);
  }
  // Requests equal to limits make the pod Guaranteed; lowering a request alone makes it Burstable.
  const guaranteed = positive(limit.cpu) && positive(limit.memory) && request.cpu === limit.cpu && request.memory === limit.memory;
  if (guaranteed && (next.request.cpu !== next.limit.cpu || next.request.memory !== next.limit.memory)) flags.push('qos-change');
  const changed = next.request.cpu !== request.cpu || next.request.memory !== request.memory || (positive(limit.cpu) && next.limit.cpu !== limit.cpu) || (positive(limit.memory) && next.limit.memory !== limit.memory);
  let status = 'ok';
  if (flags.some(flag => ['cpu-under', 'memory-under', 'throttle-risk', 'oom-risk'].includes(flag))) status = 'under';
  else if (flags.includes('no-cpu-request') || flags.includes('no-memory-request')) status = 'none';
  else if (flags.includes('cpu-over') || flags.includes('memory-over')) status = 'over';
  return { ...base, status, next: changed ? next : null, changed };
}

export const FLAG_TEXT = {
  'no-cpu-request': 'No CPU request: the scheduler treats it as free',
  'no-memory-request': 'No memory request: first to be evicted under pressure',
  'cpu-under': 'Uses more CPU than it requests',
  'memory-under': 'Uses more memory than it requests',
  'throttle-risk': 'CPU at its limit: it is being throttled',
  'oom-risk': 'Memory close to its limit: OOM-kill risk',
  'cpu-over': 'CPU request well above what it uses',
  'memory-over': 'Memory request well above what it uses',
  'exceeds-node': 'Requests more than any node can offer',
  'qos-change': 'Guaranteed QoS becomes Burstable (requests below limits)',
};

const worst = statuses => STATUS_ORDER.find(status => statuses.includes(status)) || 'nodata';

// A workload: per-container recommendations, its status, the cost of its requests and the saving.
// input: { kind, name, namespace, containers (pod template containers), pods (scheduled pods),
//   replicas (desired), usage: Map(container -> usage), prices, largestNode?: { cpu, memory } }
export function analyzeWorkload(input) {
  const prices = input.prices || DEFAULT_PRICES;
  const pods = Math.max(0, input.pods || 0);
  const containers = (input.containers || []).map(container => recommendContainer(containerResources(container), input.usage?.get(container.name)));
  const perPod = { cpu: 0, memory: 0 }; const nextPerPod = { cpu: 0, memory: 0 };
  for (const c of containers) {
    perPod.cpu += positive(c.request.cpu) ? c.request.cpu : 0; perPod.memory += positive(c.request.memory) ? c.request.memory : 0;
    const next = c.next?.request || c.request;
    nextPerPod.cpu += positive(next.cpu) ? next.cpu : 0; nextPerPod.memory += positive(next.memory) ? next.memory : 0;
  }
  const flags = [];
  const largest = input.largestNode;
  const exceeds = largest && ((positive(largest.cpu) && perPod.cpu > largest.cpu) || (positive(largest.memory) && perPod.memory > largest.memory));
  if (exceeds) flags.push('exceeds-node');
  let status = worst(containers.map(c => c.status));
  if (exceeds) status = 'over';
  const cost = monthlyCost(perPod.cpu * pods, perPod.memory * pods, prices);
  const changes = containers.filter(c => c.changed);
  const newCost = monthlyCost(nextPerPod.cpu * pods, nextPerPod.memory * pods, prices);
  const replicas = Math.max(pods, input.replicas || 0);
  return {
    kind: input.kind, name: input.name, namespace: input.namespace, pods, replicas, containers, status, flags,
    requested: { cpu: perPod.cpu * pods, memory: perPod.memory * pods }, perPod, nextPerPod,
    cost, newCost, savings: changes.length ? cost - newCost : 0,
    // What the requests would hold once every desired replica runs (pods that cannot be scheduled cost nothing yet).
    desiredCost: monthlyCost(perPod.cpu * replicas, perPod.memory * replicas, prices),
    applicable: changes.length > 0,
    sources: [...new Set(containers.map(c => c.usage?.source).filter(Boolean))],
  };
}

// One line for the table: what would change, or why nothing does.
export function recommendationText(analysis, largestNode) {
  if (analysis.flags.includes('exceeds-node')) {
    const parts = [];
    if (largestNode && positive(largestNode.cpu) && analysis.perPod.cpu > largestNode.cpu) parts.push(`${cpuQuantity(analysis.perPod.cpu)} CPU per pod, the largest node offers ${trimNumber(largestNode.cpu)}`);
    if (largestNode && positive(largestNode.memory) && analysis.perPod.memory > largestNode.memory) parts.push(`${memoryQuantity(analysis.perPod.memory)} memory per pod, the largest node offers ${memoryQuantity(Math.floor(largestNode.memory / MI) * MI)}`);
    return `Cannot be scheduled: asks for ${parts.join('; ')}`;
  }
  const changes = analysis.containers.filter(c => c.changed);
  if (!changes.length) {
    if (analysis.containers.every(c => !c.usage)) return analysis.status === 'none' ? 'Set requests once usage is known' : 'No usage data yet';
    return 'Keep as is';
  }
  const multi = analysis.containers.length > 1;
  return changes.map(c => {
    const parts = [];
    if (c.next.request.cpu !== c.request.cpu) parts.push(`CPU ${positive(c.request.cpu) ? `${cpuQuantity(c.request.cpu)} → ` : ''}${cpuQuantity(c.next.request.cpu)}`);
    if (c.next.request.memory !== c.request.memory) parts.push(`memory ${positive(c.request.memory) ? `${memoryQuantity(c.request.memory)} → ` : ''}${memoryQuantity(c.next.request.memory)}`);
    if (positive(c.limit.memory) && c.next.limit.memory !== c.limit.memory) parts.push(`memory limit → ${memoryQuantity(c.next.limit.memory)}`);
    if (positive(c.limit.cpu) && c.next.limit.cpu !== c.limit.cpu) parts.push(`CPU limit → ${cpuQuantity(c.next.limit.cpu)}`);
    const text = parts.join(', ');
    return multi ? `${c.name}: ${text}` : text.charAt(0).toUpperCase() + text.slice(1);
  }).join(' · ');
}
const trimNumber = value => (Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, ''));

// ---- Applying a recommendation ---------------------------------------------------------------
// The resources block of a changed container: only the values that change (a limit is never added).
function resourcesOf(c) {
  const requests = {}; const limits = {};
  if (c.next.request.cpu !== c.request.cpu) requests.cpu = cpuQuantity(c.next.request.cpu);
  if (c.next.request.memory !== c.request.memory) requests.memory = memoryQuantity(c.next.request.memory);
  if (positive(c.limit.cpu) && c.next.limit.cpu !== c.limit.cpu) limits.cpu = cpuQuantity(c.next.limit.cpu);
  if (positive(c.limit.memory) && c.next.limit.memory !== c.limit.memory) limits.memory = memoryQuantity(c.next.limit.memory);
  const out = {};
  if (Object.keys(requests).length) out.requests = requests;
  if (Object.keys(limits).length) out.limits = limits;
  return out;
}
// The strategic-merge patch (containers are merged by name) that applies the recommendation.
export function strategicPatch(analysis) {
  const containers = analysis.containers.filter(c => c.changed).map(c => ({ name: c.name, resources: resourcesOf(c) }));
  return containers.length ? { spec: { template: { spec: { containers } } } } : null;
}

// The manifest sent through the reviewed apply (kubectl diff, server dry-run, kubectl apply). kubectl
// apply merges three ways against the last-applied configuration, so the manifest starts from that
// configuration when the object has one (only the resources differ, nothing else is removed) and
// from a bare object naming the containers when it has none (apply then patches just those fields).
export function manifestFor(live, analysis) {
  const meta = live?.metadata || {};
  let base = null;
  const lastApplied = meta.annotations?.[LAST_APPLIED];
  if (lastApplied) {
    try {
      const parsed = JSON.parse(lastApplied);
      if (parsed?.kind === live.kind && parsed?.metadata?.name === meta.name) base = parsed;
    } catch { /* A broken annotation: fall back to the bare object. */ }
  }
  if (!base) base = { apiVersion: live.apiVersion, kind: live.kind, metadata: { name: meta.name, namespace: meta.namespace } };
  const manifest = JSON.parse(JSON.stringify(base));
  manifest.metadata = { ...(manifest.metadata || {}), name: meta.name, namespace: meta.namespace };
  manifest.spec ??= {}; manifest.spec.template ??= {}; manifest.spec.template.spec ??= {};
  const containers = manifest.spec.template.spec.containers ??= [];
  for (const c of analysis.containers.filter(item => item.changed)) {
    let target = containers.find(item => item?.name === c.name);
    if (!target) { target = { name: c.name }; containers.push(target); }
    const next = resourcesOf(c);
    target.resources = { ...(target.resources || {}) };
    if (next.requests) target.resources.requests = { ...(target.resources.requests || {}), ...next.requests };
    if (next.limits) target.resources.limits = { ...(target.resources.limits || {}), ...next.limits };
  }
  return manifest;
}

// The same change as kubectl commands, one per container (set resources takes one container at a time).
const shellQuote = value => (/^[A-Za-z0-9_./:=,@-]+$/.test(value) ? value : `'${String(value).replace(/'/g, `'\\''`)}'`);
export function kubectlCommand(analysis, { context } = {}) {
  const resource = { Deployment: 'deployment', StatefulSet: 'statefulset', DaemonSet: 'daemonset' }[analysis.kind] || String(analysis.kind || '').toLowerCase();
  return analysis.containers.filter(c => c.changed).map(c => {
    const r = resourcesOf(c);
    const args = ['kubectl'];
    if (context) args.push(`--context=${shellQuote(context)}`);
    args.push(`--namespace=${shellQuote(analysis.namespace)}`, 'set', 'resources', `${resource}/${shellQuote(analysis.name)}`, `--containers=${shellQuote(c.name)}`);
    if (r.requests) args.push(`--requests=${Object.entries(r.requests).map(([k, v]) => `${k}=${v}`).join(',')}`);
    if (r.limits) args.push(`--limits=${Object.entries(r.limits).map(([k, v]) => `${k}=${v}`).join(',')}`);
    return args.join(' ');
  }).join('\n');
}

// ---- Totals ----------------------------------------------------------------------------------
export function totals(analyses) {
  const out = { workloads: analyses.length, cpu: 0, memory: 0, cost: 0, savings: 0, freed: 0, added: 0, applicable: 0, byStatus: Object.fromEntries(Object.keys(STATUSES).map(key => [key, 0])) };
  for (const a of analyses) {
    out.cpu += a.requested.cpu; out.memory += a.requested.memory; out.cost += a.cost; out.savings += a.savings;
    if (a.savings > 0) out.freed += a.savings; else out.added -= a.savings;
    if (a.applicable) out.applicable++;
    out.byStatus[a.status]++;
  }
  return out;
}
export function byNamespace(analyses) {
  const groups = new Map();
  for (const a of analyses) { if (!groups.has(a.namespace)) groups.set(a.namespace, []); groups.get(a.namespace).push(a); }
  return [...groups].map(([namespace, list]) => ({ namespace, ...totals(list) })).sort((a, b) => b.cost - a.cost || a.namespace.localeCompare(b.namespace));
}

// The largest allocatable CPU and memory of any schedulable node (a pod must fit on one node).
export function largestNode(nodes) {
  let cpu = 0; let memory = 0;
  for (const node of nodes || []) {
    if (node?.spec?.unschedulable) continue;
    cpu = Math.max(cpu, quantity(node?.status?.allocatable?.cpu) || 0);
    memory = Math.max(memory, quantity(node?.status?.allocatable?.memory) || 0);
  }
  return cpu || memory ? { cpu, memory } : null;
}
