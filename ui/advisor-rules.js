// Advisor: reliability, security, efficiency and hygiene checks over the objects the live feeds hold,
// the Pod Security Standards level of every workload, and a 0–100 score. Pure: no DOM, no clock, no
// network, so every rule is tested with fixture objects (advisor-rules.test.mjs).
//
// A finding is { id, rule, category, severity, title, why, fix, resource, kind, namespace, name, detail,
// containers, patch?, manifest? } with id = rule|resource|namespace|name, stable while the cause lasts.
// `patch` is a strategic-merge patch for the object itself; `manifest` is a new object to create.
import { parseCPU, parseMemory, formatCPU, formatBytes, matchesSelector } from './format.js';

export const CATEGORIES = ['Reliability', 'Security', 'Efficiency', 'Hygiene'];
export const SEVERITIES = ['critical', 'warning', 'info'];
export const WEIGHTS = { critical: 10, warning: 3, info: 1 };
export const PSS_LEVELS = ['privileged', 'baseline', 'restricted'];

// Everything the page subscribes to. Cluster-scoped kinds are always watched across the cluster.
export const RESOURCES = ['deployments', 'statefulsets', 'daemonsets', 'jobs', 'cronjobs', 'pods', 'services', 'ingresses', 'poddisruptionbudgets', 'horizontalpodautoscalers', 'resourcequotas', 'limitranges', 'serviceaccounts', 'namespaces', 'nodes'];
export const CLUSTER_SCOPED = new Set(['namespaces', 'nodes']);
const KINDS = { deployments: 'Deployment', statefulsets: 'StatefulSet', daemonsets: 'DaemonSet', jobs: 'Job', cronjobs: 'CronJob', pods: 'Pod', services: 'Service', ingresses: 'Ingress', poddisruptionbudgets: 'PodDisruptionBudget', horizontalpodautoscalers: 'HorizontalPodAutoscaler', namespaces: 'Namespace' };
export const kindOf = resource => KINDS[resource] || resource;

// Namespaces that belong to Kubernetes itself; their findings are expected and hidden unless asked for.
export const isSystemNamespace = name => /^kube-/.test(name || '');

// ---- Small helpers --------------------------------------------------------------------------------
const meta = item => item?.metadata || {};
const list = value => (Array.isArray(value) ? value : []);
const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
const names = containers => containers.map(c => c.name).join(', ');
const LONG_RUNNING = new Set(['deployments', 'statefulsets', 'daemonsets']);

// The pod template inside each kind, and the path to it for patches.
const POD_PATH = { deployments: ['spec', 'template'], statefulsets: ['spec', 'template'], daemonsets: ['spec', 'template'], jobs: ['spec', 'template'], cronjobs: ['spec', 'jobTemplate', 'spec', 'template'] };
function nest(path, value) { return path.reduceRight((inner, key) => ({ [key]: inner }), value); }

// One subject per object that runs pods: controllers, plus pods nobody owns.
function subjectsOf(objects) {
  const out = [];
  for (const resource of ['deployments', 'statefulsets', 'daemonsets', 'jobs', 'cronjobs']) {
    for (const item of list(objects[resource])) {
      if (meta(item).deletionTimestamp) continue;
      // A Job a CronJob created is judged through its CronJob.
      if (resource === 'jobs' && list(meta(item).ownerReferences).some(ref => ref.kind === 'CronJob')) continue;
      const template = POD_PATH[resource].reduce((value, key) => value?.[key], item) || {};
      out.push({ resource, kind: kindOf(resource), item, namespace: meta(item).namespace || '', name: meta(item).name, pod: template.spec || {}, podMeta: template.metadata || {}, podPath: [...POD_PATH[resource], 'spec'], patchable: true });
    }
  }
  for (const pod of list(objects.pods)) {
    if (meta(pod).deletionTimestamp || list(meta(pod).ownerReferences).length) continue;
    if (['Succeeded', 'Failed'].includes(pod.status?.phase)) continue;
    // A running pod's spec is immutable: findings name the fix but offer no patch.
    out.push({ resource: 'pods', kind: 'Pod', item: pod, namespace: meta(pod).namespace || '', name: meta(pod).name, pod: pod.spec || {}, podMeta: meta(pod), podPath: ['spec'], patchable: false });
  }
  return out;
}
const containersOf = (pod, { ephemeral = false } = {}) => [
  ...list(pod.initContainers).map(c => ({ ...c, list: 'initContainers' })),
  ...list(pod.containers).map(c => ({ ...c, list: 'containers' })),
  ...(ephemeral ? list(pod.ephemeralContainers).map(c => ({ ...c, list: 'ephemeralContainers' })) : []),
];
// Containers that keep running (regular ones and native sidecars) — the ones probes apply to.
const servingContainers = pod => list(pod.containers).map(c => ({ ...c, list: 'containers' }));

// A strategic-merge patch for some containers of a subject's pod template.
function containerPatch(subject, containers, change) {
  const podPatch = {};
  for (const container of containers) {
    const body = change(container);
    if (!body) continue;
    (podPatch[container.list] ||= []).push({ name: container.name, ...body });
  }
  return Object.keys(podPatch).length ? nest(subject.podPath, podPatch) : undefined;
}
const podPatch = (subject, body) => nest(subject.podPath, body);

// Security context fields that a container inherits from the pod when it does not set them.
const effective = (pod, container, field) => container.securityContext?.[field] ?? pod.securityContext?.[field];
const normCap = cap => String(cap || '').toUpperCase().replace(/^CAP_/, '');

// ---- Pod Security Standards -----------------------------------------------------------------------
// https://kubernetes.io/docs/concepts/security/pod-security-standards/ (v1.30+).
const BASELINE_CAPS = new Set(['AUDIT_WRITE', 'CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'KILL', 'MKNOD', 'NET_BIND_SERVICE', 'SETFCAP', 'SETGID', 'SETPCAP', 'SETUID', 'SYS_CHROOT']);
const SAFE_SYSCTLS = new Set(['kernel.shm_rmid_forced', 'net.ipv4.ip_local_port_range', 'net.ipv4.ip_unprivileged_port_start', 'net.ipv4.tcp_syncookies', 'net.ipv4.ping_group_range', 'net.ipv4.ip_local_reserved_ports', 'net.ipv4.tcp_keepalive_time', 'net.ipv4.tcp_fin_timeout', 'net.ipv4.tcp_keepalive_intvl', 'net.ipv4.tcp_keepalive_probes']);
const SELINUX_TYPES = new Set(['', 'container_t', 'container_init_t', 'container_kvm_t', 'container_engine_t']);
const RESTRICTED_VOLUMES = new Set(['configMap', 'csi', 'downwardAPI', 'emptyDir', 'ephemeral', 'persistentVolumeClaim', 'projected', 'secret']);
const SECCOMP_OK = new Set(['RuntimeDefault', 'Localhost']);

// Returns { level, baseline: [why not baseline], restricted: [why not restricted] }.
export function podSecurityLevel(pod = {}, podMeta = {}) {
  const baseline = new Set(); const restricted = new Set();
  const sc = pod.securityContext || {};
  const all = containersOf(pod, { ephemeral: true });
  if (sc.windowsOptions?.hostProcess || all.some(c => c.securityContext?.windowsOptions?.hostProcess)) baseline.add('Windows HostProcess');
  for (const field of ['hostNetwork', 'hostPID', 'hostIPC']) if (pod[field]) baseline.add(field);
  if (all.some(c => c.securityContext?.privileged)) baseline.add('privileged container');
  const added = all.flatMap(c => list(c.securityContext?.capabilities?.add).map(normCap));
  if (added.some(cap => !BASELINE_CAPS.has(cap))) baseline.add(`capabilities ${[...new Set(added.filter(cap => !BASELINE_CAPS.has(cap)))].join(', ')}`);
  if (list(pod.volumes).some(v => v.hostPath)) baseline.add('hostPath volume');
  if (all.some(c => list(c.ports).some(p => p.hostPort))) baseline.add('hostPort');
  const apparmorBad = type => type && !['RuntimeDefault', 'Localhost'].includes(type);
  const apparmorAnnotations = Object.entries(podMeta.annotations || {}).filter(([key]) => key.startsWith('container.apparmor.security.beta.kubernetes.io/'));
  if (apparmorBad(sc.appArmorProfile?.type) || all.some(c => apparmorBad(c.securityContext?.appArmorProfile?.type)) || apparmorAnnotations.some(([, value]) => value !== 'runtime/default' && !String(value).startsWith('localhost/'))) baseline.add('AppArmor unconfined');
  const selinuxBad = options => options && (!SELINUX_TYPES.has(options.type || '') || options.user || options.role);
  if (selinuxBad(sc.seLinuxOptions) || all.some(c => selinuxBad(c.securityContext?.seLinuxOptions))) baseline.add('custom SELinux options');
  if (all.some(c => c.securityContext?.procMount && c.securityContext.procMount !== 'Default')) baseline.add('unmasked /proc');
  if (sc.seccompProfile?.type === 'Unconfined' || all.some(c => c.securityContext?.seccompProfile?.type === 'Unconfined')) baseline.add('seccomp Unconfined');
  if (list(sc.sysctls).some(s => !SAFE_SYSCTLS.has(s.name))) baseline.add('unsafe sysctls');

  const volumes = list(pod.volumes).filter(v => !Object.keys(v).some(key => key !== 'name' && RESTRICTED_VOLUMES.has(key)));
  if (volumes.length) restricted.add(`volume types (${volumes.map(v => v.name).join(', ')})`);
  if (all.some(c => c.securityContext?.allowPrivilegeEscalation !== false)) restricted.add('allowPrivilegeEscalation not false');
  if (all.some(c => effective(pod, c, 'runAsNonRoot') !== true)) restricted.add('runAsNonRoot not true');
  if (sc.runAsUser === 0 || all.some(c => c.securityContext?.runAsUser === 0)) restricted.add('runAsUser 0');
  if (all.some(c => !SECCOMP_OK.has(effective(pod, c, 'seccompProfile')?.type))) restricted.add('seccomp profile not RuntimeDefault or Localhost');
  if (all.some(c => !list(c.securityContext?.capabilities?.drop).map(normCap).includes('ALL'))) restricted.add('capabilities not dropping ALL');
  if (added.some(cap => cap !== 'NET_BIND_SERVICE')) restricted.add('capabilities other than NET_BIND_SERVICE added');
  const level = baseline.size ? 'privileged' : restricted.size ? 'baseline' : 'restricted';
  return { level, baseline: [...baseline], restricted: [...baseline, ...restricted] };
}

// ---- Rules ----------------------------------------------------------------------------------------
// Each rule: id, category, severity, title, why, fix, scope (what it looks at), needs (feeds it depends
// on — skipped when one is unavailable), applies(subject, ctx) and check(subject, ctx) → null when the
// object passes, or { detail, containers?, patch?, manifest? }.
const DANGEROUS_CAPS = new Set(['ALL', 'SYS_ADMIN', 'NET_ADMIN', 'SYS_MODULE', 'SYS_PTRACE', 'SYS_RAWIO', 'BPF']);
const probeKinds = ['readinessProbe', 'livenessProbe', 'startupProbe'];
const probePort = probe => probe?.httpGet?.port ?? probe?.tcpSocket?.port ?? probe?.grpc?.port;
const imageTag = image => {
  const value = String(image || '');
  if (value.includes('@')) return { digest: true, tag: '' };
  const last = value.split('/').pop();
  const index = last.lastIndexOf(':');
  return { digest: false, tag: index >= 0 ? last.slice(index + 1) : '' };
};

export const RULES = [
  // Reliability
  { id: 'readiness-missing', category: 'Reliability', severity: 'warning', title: 'No readiness probe', scope: 'workload',
    why: 'Without a readiness probe a pod receives traffic as soon as its process starts, before it can answer, and keeps receiving it when it stops answering.',
    fix: 'Add a readiness probe that checks the endpoint the container serves. The suggested patch probes the first declared port over TCP; an HTTP health path is better when the app has one.',
    applies: s => LONG_RUNNING.has(s.resource),
    check: s => {
      const missing = servingContainers(s.pod).filter(c => !c.readinessProbe);
      if (!missing.length) return null;
      return { detail: `Missing in ${names(missing)}`, containers: missing.map(c => c.name), patch: s.patchable ? containerPatch(s, missing, c => (c.ports?.[0]?.containerPort ? { readinessProbe: { tcpSocket: { port: c.ports[0].containerPort }, periodSeconds: 10 } } : null)) : undefined };
    } },
  { id: 'liveness-missing', category: 'Reliability', severity: 'info', title: 'No liveness probe', scope: 'workload',
    why: 'A container that hangs without exiting is never restarted unless a liveness probe notices.',
    fix: 'Add a liveness probe that fails only when the process is stuck (not when a dependency is down), with a generous initial delay. The suggested patch checks the first declared port over TCP.',
    applies: s => LONG_RUNNING.has(s.resource),
    check: s => {
      const missing = servingContainers(s.pod).filter(c => !c.livenessProbe);
      if (!missing.length) return null;
      return { detail: `Missing in ${names(missing)}`, containers: missing.map(c => c.name), patch: s.patchable ? containerPatch(s, missing, c => (c.ports?.[0]?.containerPort ? { livenessProbe: { tcpSocket: { port: c.ports[0].containerPort }, initialDelaySeconds: 15, periodSeconds: 20 } } : null)) : undefined };
    } },
  { id: 'probe-port-unknown', category: 'Reliability', severity: 'warning', title: 'Probe checks a port the container does not declare', scope: 'workload',
    why: 'A probe aimed at the wrong port never succeeds: a readiness probe keeps the pod out of its Service for good, a liveness probe restarts it in a loop.',
    fix: 'Point the probe at a port the container listens on. When the container declares a single port, the suggested patch uses it.',
    applies: s => list(s.pod.containers).length > 0,
    check: s => {
      const wrong = []; const details = [];
      for (const c of servingContainers(s.pod)) {
        const ports = list(c.ports);
        const bad = probeKinds.filter(kind => {
          const port = probePort(c[kind]);
          if (port === undefined) return false;
          if (typeof port === 'string' && !/^\d+$/.test(port)) return !ports.some(p => p.name === port);
          return ports.length > 0 && !ports.some(p => p.containerPort === Number(port));
        });
        if (bad.length) { wrong.push({ ...c, bad }); details.push(`${c.name}: ${bad.map(kind => `${kind.replace('Probe', '')} → ${probePort(c[kind])}`).join(', ')}`); }
      }
      if (!wrong.length) return null;
      return { detail: `${details.join('; ')} (declared: ${wrong.map(c => list(c.ports).map(p => p.containerPort).join(', ') || 'none').join(' / ')})`, containers: wrong.map(c => c.name),
        patch: s.patchable ? containerPatch(s, wrong, c => {
          if (list(c.ports).length !== 1) return null;
          const port = c.ports[0].containerPort; const body = {};
          for (const kind of c.bad) body[kind] = c[kind].httpGet ? { httpGet: { port } } : c[kind].grpc ? { grpc: { port } } : { tcpSocket: { port } };
          return body;
        }) : undefined };
    } },
  { id: 'image-latest', category: 'Reliability', severity: 'warning', title: 'Image tag is latest or missing', scope: 'workload',
    why: 'A floating tag means two pods of the same revision can run different code, and a rollback does not bring the old code back.',
    fix: 'Deploy an immutable version tag (or a digest) and change it on every release.',
    applies: () => true,
    check: s => {
      const floating = containersOf(s.pod).filter(c => { const { digest, tag } = imageTag(c.image); return !digest && (!tag || tag === 'latest'); });
      return floating.length ? { detail: floating.map(c => `${c.name}: ${c.image}`).join('; '), containers: floating.map(c => c.name) } : null;
    } },
  { id: 'single-replica-production', category: 'Reliability', severity: 'warning', title: 'Single replica on a production cluster', scope: 'workload', needs: ['horizontalpodautoscalers'],
    why: 'One replica means every rollout, node drain or crash is an outage for this Deployment.',
    fix: 'Run at least two replicas (and add a PodDisruptionBudget), or let a HorizontalPodAutoscaler with minReplicas ≥ 2 manage it.',
    applies: (s, ctx) => ctx.production && s.resource === 'deployments' && !ctx.hpaTargets.has(`${s.namespace}/Deployment/${s.name}`),
    check: s => ((s.item.spec?.replicas ?? 1) === 1 ? { detail: '1 replica', patch: { spec: { replicas: 2 } } } : null) },
  { id: 'pdb-missing', category: 'Reliability', severity: 'warning', title: 'No PodDisruptionBudget', scope: 'workload', needs: ['poddisruptionbudgets'],
    why: 'Without a PodDisruptionBudget a node drain or cluster upgrade may evict every replica at the same time.',
    fix: 'Create a PodDisruptionBudget that selects the pods and allows one of them to be unavailable at a time.',
    applies: s => ['deployments', 'statefulsets'].includes(s.resource) && (s.item.spec?.replicas ?? 1) >= 2,
    check: (s, ctx) => {
      const labels = s.podMeta.labels || {};
      if (ctx.pdbs.some(pdb => meta(pdb).namespace === s.namespace && matchesSelector(pdb.spec?.selector, labels))) return null;
      const matchLabels = s.item.spec?.selector?.matchLabels;
      const manifest = matchLabels && !list(s.item.spec?.selector?.matchExpressions).length ? { apiVersion: 'policy/v1', kind: 'PodDisruptionBudget', metadata: { name: s.name, namespace: s.namespace }, spec: { maxUnavailable: 1, selector: { matchLabels } } } : undefined;
      return { detail: `${s.item.spec?.replicas} replicas, no budget selects them`, manifest };
    } },
  { id: 'pdb-blocks-disruption', category: 'Reliability', severity: 'warning', title: 'PodDisruptionBudget allows no disruption', scope: 'pdb',
    why: 'A budget that never allows an eviction blocks node drains, so cluster upgrades and autoscaler scale-downs hang until someone deletes pods by hand.',
    fix: 'Allow at least one pod to be unavailable: maxUnavailable: 1, or a minAvailable below the number of replicas.',
    applies: () => true,
    check: pdb => {
      const spec = pdb.spec || {}; const expected = pdb.status?.expectedPods;
      if (spec.maxUnavailable === 0 || spec.maxUnavailable === '0%') return { detail: `maxUnavailable: ${spec.maxUnavailable}`, patch: { spec: { maxUnavailable: 1 } } };
      if (spec.minAvailable === '100%') return { detail: 'minAvailable: 100%', patch: expected >= 2 ? { spec: { minAvailable: expected - 1 } } : undefined };
      if (typeof spec.minAvailable === 'number' && expected > 0 && spec.minAvailable >= expected) return { detail: `minAvailable: ${spec.minAvailable} with ${plural(expected, 'pod')}`, patch: expected >= 2 ? { spec: { minAvailable: expected - 1 } } : undefined };
      return null;
    } },
  { id: 'ingress-backend-missing', category: 'Reliability', severity: 'critical', title: 'Ingress routes to a Service that does not exist', scope: 'ingress', needs: ['services'],
    why: 'Requests for these paths fail with 503 from the ingress controller.',
    fix: 'Create the Service, or correct the backend service name in the Ingress.',
    applies: () => true,
    check: (ingress, ctx) => {
      const wanted = new Set([ingress.spec?.defaultBackend?.service?.name, ...list(ingress.spec?.rules).flatMap(rule => list(rule.http?.paths).map(path => path.backend?.service?.name))].filter(Boolean));
      const missing = [...wanted].filter(name => !ctx.serviceNames.has(`${meta(ingress).namespace}/${name}`));
      return missing.length ? { detail: `Missing: ${missing.join(', ')}` } : null;
    } },
  { id: 'cronjob-concurrency', category: 'Reliability', severity: 'info', title: 'CronJob allows overlapping runs', scope: 'workload',
    why: 'With concurrencyPolicy Allow (the default) a slow run and the next scheduled one execute side by side, which doubles the load and can corrupt work that is not idempotent.',
    fix: 'Set concurrencyPolicy to Forbid (skip the new run) or Replace (stop the old one).',
    applies: s => s.resource === 'cronjobs',
    check: s => ((s.item.spec?.concurrencyPolicy || 'Allow') === 'Allow' ? { detail: 'concurrencyPolicy: Allow', patch: { spec: { concurrencyPolicy: 'Forbid' } } } : null) },
  { id: 'requests-exceed-nodes', category: 'Reliability', severity: 'critical', title: 'Requests more than any node can offer', scope: 'workload', needs: ['nodes'],
    why: 'The scheduler can never place this pod: it stays Pending until the requests shrink or a larger node joins.',
    fix: 'Lower the CPU or memory request to what the application needs, or add a node pool with larger machines.',
    applies: (s, ctx) => ctx.largest.cpu > 0,
    check: (s, ctx) => {
      const sum = (key, parse) => {
        const one = c => parse(c.resources?.requests?.[key] ?? c.resources?.limits?.[key]) || 0;
        const regular = list(s.pod.containers).reduce((total, c) => total + one(c), 0) + list(s.pod.initContainers).filter(c => c.restartPolicy === 'Always').reduce((total, c) => total + one(c), 0);
        return Math.max(regular, ...list(s.pod.initContainers).filter(c => c.restartPolicy !== 'Always').map(one));
      };
      const cpu = sum('cpu', parseCPU); const memory = sum('memory', parseMemory);
      const parts = [];
      if (cpu > ctx.largest.cpu) parts.push(`CPU ${formatCPU(cpu)} > ${formatCPU(ctx.largest.cpu)}`);
      if (memory > ctx.largest.memory) parts.push(`memory ${formatBytes(memory)} > ${formatBytes(ctx.largest.memory)}`);
      return parts.length ? { detail: `${parts.join(', ')} (largest node's allocatable)` } : null;
    } },

  // Security
  { id: 'privileged', category: 'Security', severity: 'critical', title: 'Privileged container', scope: 'workload',
    why: 'A privileged container has every capability and the host\'s devices: escaping it gives root on the node.',
    fix: 'Set securityContext.privileged to false and grant only the specific capabilities the container needs.',
    applies: () => true,
    check: s => {
      const bad = containersOf(s.pod).filter(c => c.securityContext?.privileged);
      return bad.length ? { detail: `Privileged: ${names(bad)}`, containers: bad.map(c => c.name), patch: s.patchable ? containerPatch(s, bad, () => ({ securityContext: { privileged: false } })) : undefined } : null;
    } },
  { id: 'host-namespaces', category: 'Security', severity: 'critical', title: 'Shares the host network, PID or IPC namespace', scope: 'workload',
    why: 'hostNetwork, hostPID and hostIPC let the pod see and reach the node\'s own processes, sockets and traffic, bypassing network policies.',
    fix: 'Remove hostNetwork, hostPID and hostIPC unless this is a node agent that genuinely needs them.',
    applies: () => true,
    check: s => {
      const used = ['hostNetwork', 'hostPID', 'hostIPC'].filter(field => s.pod[field]);
      return used.length ? { detail: used.join(', '), patch: s.patchable ? podPatch(s, Object.fromEntries(used.map(field => [field, false]))) : undefined } : null;
    } },
  { id: 'dangerous-capabilities', category: 'Security', severity: 'critical', title: 'Adds dangerous Linux capabilities', scope: 'workload',
    why: 'SYS_ADMIN, NET_ADMIN, ALL and similar capabilities are close to root on the node: mounting file systems, rewriting routing and firewall rules, loading kernel modules.',
    fix: 'Remove these capabilities from securityContext.capabilities.add; add only narrow ones such as NET_BIND_SERVICE.',
    applies: () => true,
    check: s => {
      const bad = containersOf(s.pod).filter(c => list(c.securityContext?.capabilities?.add).some(cap => DANGEROUS_CAPS.has(normCap(cap))));
      if (!bad.length) return null;
      return { detail: bad.map(c => `${c.name}: ${list(c.securityContext.capabilities.add).filter(cap => DANGEROUS_CAPS.has(normCap(cap))).join(', ')}`).join('; '), containers: bad.map(c => c.name),
        patch: s.patchable ? containerPatch(s, bad, c => ({ securityContext: { capabilities: { add: list(c.securityContext.capabilities.add).filter(cap => !DANGEROUS_CAPS.has(normCap(cap))) } } })) : undefined };
    } },
  { id: 'host-path', category: 'Security', severity: 'warning', title: 'Mounts a hostPath volume', scope: 'workload',
    why: 'A hostPath volume exposes the node\'s file system to the pod; a writable one can be used to take over the node.',
    fix: 'Use a PersistentVolumeClaim, ConfigMap, Secret or emptyDir instead. If a node agent needs it, mount it read-only and narrow the path.',
    applies: () => true,
    check: s => {
      const volumes = list(s.pod.volumes).filter(v => v.hostPath);
      return volumes.length ? { detail: volumes.map(v => `${v.name}: ${v.hostPath.path}`).join('; ') } : null;
    } },
  { id: 'host-port', category: 'Security', severity: 'warning', title: 'Binds a port on the node', scope: 'workload',
    why: 'A hostPort exposes the container directly on the node\'s address, outside Services and network policies, and limits the pod to one replica per node.',
    fix: 'Remove hostPort and expose the container through a Service (NodePort or LoadBalancer if it must be reachable from outside).',
    applies: () => true,
    check: s => {
      const bad = containersOf(s.pod).filter(c => list(c.ports).some(p => p.hostPort));
      return bad.length ? { detail: bad.map(c => `${c.name}: ${list(c.ports).filter(p => p.hostPort).map(p => p.hostPort).join(', ')}`).join('; '), containers: bad.map(c => c.name) } : null;
    } },
  { id: 'privilege-escalation', category: 'Security', severity: 'warning', title: 'Privilege escalation not disabled', scope: 'workload',
    why: 'Unless allowPrivilegeEscalation is false, a process can gain more privileges than its parent (setuid binaries, file capabilities).',
    fix: 'Set securityContext.allowPrivilegeEscalation: false on every container.',
    applies: () => true,
    check: s => {
      const bad = containersOf(s.pod).filter(c => c.securityContext?.allowPrivilegeEscalation !== false);
      if (!bad.length) return null;
      // The API refuses allowPrivilegeEscalation: false on a privileged container: fix that one first.
      const fixable = bad.filter(c => !c.securityContext?.privileged);
      return { detail: `Not set to false in ${names(bad)}`, containers: bad.map(c => c.name), patch: s.patchable && fixable.length ? containerPatch(s, fixable, () => ({ securityContext: { allowPrivilegeEscalation: false } })) : undefined };
    } },
  { id: 'run-as-root', category: 'Security', severity: 'warning', title: 'May run as root', scope: 'workload',
    why: 'Without runAsNonRoot the container runs as whatever user its image says, often root; a container escape then starts as root on the node.',
    fix: 'Set runAsNonRoot: true in the pod securityContext. The image must declare a numeric non-root USER (or set runAsUser), otherwise the kubelet refuses to start it, and the rollout stops with the old pods still serving.',
    applies: () => true,
    check: s => {
      const bad = containersOf(s.pod).filter(c => effective(s.pod, c, 'runAsNonRoot') !== true || effective(s.pod, c, 'runAsUser') === 0);
      if (!bad.length) return null;
      const root = bad.filter(c => effective(s.pod, c, 'runAsUser') === 0);
      let patch;
      if (s.patchable && !root.length) {
        const pod = { securityContext: { runAsNonRoot: true } };
        for (const c of bad.filter(c => c.securityContext?.runAsNonRoot === false)) (pod[c.list] ||= []).push({ name: c.name, securityContext: { runAsNonRoot: true } });
        patch = podPatch(s, pod);
      }
      return { detail: root.length ? `runAsUser: 0 in ${names(root)}` : `runAsNonRoot not set for ${names(bad)}`, containers: bad.map(c => c.name), patch };
    } },
  { id: 'drop-capabilities', category: 'Security', severity: 'info', title: 'Does not drop all capabilities', scope: 'workload',
    why: 'Containers start with a default set of Linux capabilities most applications never use. The restricted Pod Security Standard requires dropping ALL.',
    fix: 'Set securityContext.capabilities.drop: [ALL] and add back only what the process needs (usually nothing, sometimes NET_BIND_SERVICE).',
    applies: () => true,
    check: s => {
      const bad = containersOf(s.pod).filter(c => !list(c.securityContext?.capabilities?.drop).map(normCap).includes('ALL'));
      return bad.length ? { detail: `Not dropped in ${names(bad)}`, containers: bad.map(c => c.name), patch: s.patchable ? containerPatch(s, bad, () => ({ securityContext: { capabilities: { drop: ['ALL'] } } })) : undefined } : null;
    } },
  { id: 'seccomp-missing', category: 'Security', severity: 'info', title: 'No seccomp profile', scope: 'workload',
    why: 'Without a seccomp profile every system call is allowed, including the rarely used ones most kernel exploits go through. The restricted Pod Security Standard requires RuntimeDefault or Localhost.',
    fix: 'Set securityContext.seccompProfile.type: RuntimeDefault on the pod.',
    applies: () => true,
    check: s => {
      const bad = containersOf(s.pod).filter(c => !SECCOMP_OK.has(effective(s.pod, c, 'seccompProfile')?.type));
      if (!bad.length) return null;
      const unconfined = bad.filter(c => effective(s.pod, c, 'seccompProfile')?.type === 'Unconfined');
      const pod = { securityContext: { seccompProfile: { type: 'RuntimeDefault' } } };
      for (const c of bad.filter(c => c.securityContext?.seccompProfile)) (pod[c.list] ||= []).push({ name: c.name, securityContext: { seccompProfile: { type: 'RuntimeDefault' } } });
      return { detail: unconfined.length ? `Unconfined in ${names(unconfined)}` : `Not set for ${names(bad)}`, containers: bad.map(c => c.name), patch: s.patchable ? podPatch(s, pod) : undefined };
    } },
  { id: 'readonly-root-fs', category: 'Security', severity: 'info', title: 'Root file system is writable', scope: 'workload',
    why: 'A read-only root file system stops an attacker, or a bug, from changing the container\'s binaries and configuration at run time.',
    fix: 'Set securityContext.readOnlyRootFilesystem: true, and mount an emptyDir where the application writes (/tmp, caches).',
    applies: () => true,
    check: s => {
      const bad = containersOf(s.pod).filter(c => c.securityContext?.readOnlyRootFilesystem !== true);
      return bad.length ? { detail: `Writable in ${names(bad)}`, containers: bad.map(c => c.name), patch: s.patchable ? containerPatch(s, bad, () => ({ securityContext: { readOnlyRootFilesystem: true } })) : undefined } : null;
    } },
  { id: 'default-sa-token', category: 'Security', severity: 'info', title: 'Default service account token is mounted', scope: 'workload',
    why: 'Every pod gets an API token for its service account unless told otherwise. Pods that never call the Kubernetes API should not carry one an attacker could use.',
    fix: 'Set automountServiceAccountToken: false on the pod (or on the default ServiceAccount), or give the workload its own ServiceAccount with only the permissions it needs.',
    applies: s => !s.pod.serviceAccountName || s.pod.serviceAccountName === 'default',
    check: (s, ctx) => {
      if (s.pod.automountServiceAccountToken === false) return null;
      if (s.pod.automountServiceAccountToken !== true && ctx.defaultSANoToken.has(s.namespace)) return null;
      return { detail: 'Uses the default ServiceAccount with its token mounted', patch: s.patchable ? podPatch(s, { automountServiceAccountToken: false }) : undefined };
    } },

  // Efficiency
  { id: 'requests-missing', category: 'Efficiency', severity: 'warning', title: 'No CPU or memory request', scope: 'workload',
    why: 'Without requests the scheduler places the pod as if it used nothing, so nodes get overcommitted and the pod is the first to be evicted under pressure.',
    fix: 'Set CPU and memory requests to what the container normally uses. The suggested patch uses the limits when they exist, otherwise 100m CPU and 128Mi memory as a starting point.',
    applies: () => true,
    check: s => {
      const has = (c, key) => c.resources?.requests?.[key] !== undefined || c.resources?.limits?.[key] !== undefined;
      const bad = containersOf(s.pod).filter(c => !has(c, 'cpu') || !has(c, 'memory'));
      if (!bad.length) return null;
      return { detail: bad.map(c => `${c.name}: ${['cpu', 'memory'].filter(key => !has(c, key)).join(' and ')}`).join('; '), containers: bad.map(c => c.name),
        patch: s.patchable ? containerPatch(s, bad, c => ({ resources: { requests: { ...(has(c, 'cpu') ? {} : { cpu: '100m' }), ...(has(c, 'memory') ? {} : { memory: '128Mi' }) } } })) : undefined };
    } },
  { id: 'memory-limit-missing', category: 'Efficiency', severity: 'warning', title: 'No memory limit', scope: 'workload',
    why: 'A container without a memory limit can use all of the node\'s memory; the kernel then kills processes in other pods.',
    fix: 'Set a memory limit. Equal to the memory request gives the most predictable behaviour; the suggested patch does that (256Mi when there is no request).',
    applies: () => true,
    check: s => {
      const bad = containersOf(s.pod).filter(c => c.resources?.limits?.memory === undefined);
      return bad.length ? { detail: `Missing in ${names(bad)}`, containers: bad.map(c => c.name), patch: s.patchable ? containerPatch(s, bad, c => ({ resources: { limits: { memory: c.resources?.requests?.memory || '256Mi' } } })) : undefined } : null;
    } },
  { id: 'hpa-no-range', category: 'Efficiency', severity: 'warning', title: 'Autoscaler cannot scale', scope: 'hpa',
    why: 'With minReplicas equal to maxReplicas the HorizontalPodAutoscaler never changes the replica count; it only adds moving parts.',
    fix: 'Raise maxReplicas above minReplicas, or remove the autoscaler and set replicas on the workload.',
    applies: () => true,
    check: hpa => {
      const min = hpa.spec?.minReplicas ?? 1; const max = hpa.spec?.maxReplicas;
      return max !== undefined && min >= max ? { detail: `minReplicas ${min}, maxReplicas ${max}`, patch: { spec: { maxReplicas: Math.max(min * 2, min + 1) } } } : null;
    } },
  { id: 'namespace-no-quota', category: 'Efficiency', severity: 'info', title: 'Namespace has no ResourceQuota', scope: 'namespace', needs: ['resourcequotas'],
    why: 'Without a quota one team or one runaway deployment can take the whole cluster\'s capacity.',
    fix: 'Create a ResourceQuota with the CPU, memory and object counts this namespace is allowed.',
    applies: () => true,
    check: (ns, ctx) => (ctx.quotaNamespaces.has(meta(ns).name) ? null : { detail: 'No ResourceQuota' }) },
  { id: 'namespace-no-limitrange', category: 'Efficiency', severity: 'info', title: 'Namespace has no LimitRange', scope: 'namespace', needs: ['limitranges'],
    why: 'A LimitRange gives containers that forget their requests and limits sensible defaults, so they are scheduled and capped like the others.',
    fix: 'Create a LimitRange with default requests and limits for containers.',
    applies: () => true,
    check: (ns, ctx) => (ctx.limitNamespaces.has(meta(ns).name) ? null : { detail: 'No LimitRange', manifest: { apiVersion: 'v1', kind: 'LimitRange', metadata: { name: 'defaults', namespace: meta(ns).name }, spec: { limits: [{ type: 'Container', defaultRequest: { cpu: '100m', memory: '128Mi' }, default: { memory: '256Mi' } }] } } }) },

  // Hygiene
  { id: 'hpa-target-missing', category: 'Hygiene', severity: 'warning', title: 'Autoscaler targets a missing workload', scope: 'hpa', needs: ['deployments', 'statefulsets'],
    why: 'The HorizontalPodAutoscaler has nothing to scale; it reports errors and the workload you meant to scale is not scaled.',
    fix: 'Correct scaleTargetRef, or delete the autoscaler.',
    applies: hpa => ['Deployment', 'StatefulSet'].includes(hpa.spec?.scaleTargetRef?.kind),
    check: (hpa, ctx) => {
      const ref = hpa.spec.scaleTargetRef;
      return ctx.workloadNames.has(`${meta(hpa).namespace}/${ref.kind}/${ref.name}`) ? null : { detail: `${ref.kind} ${ref.name} not found` };
    } },
  { id: 'service-selects-nothing', category: 'Hygiene', severity: 'warning', title: 'Service selects no pods', scope: 'service', needs: ['pods'],
    why: 'Traffic to this Service has nowhere to go: connections are refused or time out.',
    fix: 'Correct the Service selector to match the pod labels, or scale up the workload it is meant to front.',
    applies: svc => svc.spec?.type !== 'ExternalName' && Object.keys(svc.spec?.selector || {}).length > 0,
    check: (svc, ctx) => {
      const pods = ctx.podsByNamespace.get(meta(svc).namespace) || [];
      return pods.some(pod => matchesSelector(svc.spec.selector, meta(pod).labels || {})) ? null : { detail: `Selector ${Object.entries(svc.spec.selector).map(([k, v]) => `${k}=${v}`).join(',')} matches nothing` };
    } },
  { id: 'cronjob-history', category: 'Hygiene', severity: 'info', title: 'CronJob keeps a long job history', scope: 'workload',
    why: 'Every kept Job keeps its pods and their logs around; hundreds of them slow down listing and clutter the namespace.',
    fix: 'Keep a few: successfulJobsHistoryLimit: 3 and failedJobsHistoryLimit: 1 are the defaults.',
    applies: s => s.resource === 'cronjobs',
    check: s => {
      const ok = s.item.spec?.successfulJobsHistoryLimit ?? 3; const failed = s.item.spec?.failedJobsHistoryLimit ?? 1;
      return ok > 10 || failed > 10 ? { detail: `successful ${ok}, failed ${failed}`, patch: { spec: { successfulJobsHistoryLimit: Math.min(ok, 3), failedJobsHistoryLimit: Math.min(failed, 1) } } } : null;
    } },
  { id: 'job-ttl-missing', category: 'Hygiene', severity: 'info', title: 'Job is never cleaned up', scope: 'workload',
    why: 'A finished Job and its pods stay until someone deletes them. ttlSecondsAfterFinished lets Kubernetes remove them.',
    fix: 'Set ttlSecondsAfterFinished, for example to one day. Note that a Job that finished longer ago than that is deleted as soon as the field is set.',
    applies: s => s.resource === 'jobs',
    check: s => (s.item.spec?.ttlSecondsAfterFinished === undefined ? { detail: 'ttlSecondsAfterFinished not set', patch: { spec: { ttlSecondsAfterFinished: 86400 } } } : null) },
];
export const RULE_BY_ID = new Map(RULES.map(rule => [rule.id, rule]));

// ---- Engine ---------------------------------------------------------------------------------------
// objects: { [resource]: items[] } — a missing key means that feed is unavailable and its rules are skipped.
// options: { context, namespace ('*' or a name), production, includeSystem }.
// Returns { findings, checks: [{ id, rule, namespace, category, severity, failed }], pss: [...], skipped: [rule ids] }.
export function analyze(objects = {}, { namespace = '*', production = false, includeSystem = false } = {}) {
  const inScope = ns => (namespace === '*' ? includeSystem || !isSystemNamespace(ns) : ns === namespace);
  const scoped = resource => list(objects[resource]).filter(item => inScope(meta(item).namespace || ''));
  const available = resource => Array.isArray(objects[resource]);
  const nodes = list(objects.nodes).filter(node => !node.spec?.unschedulable);
  const largest = { cpu: Math.max(0, ...nodes.map(node => parseCPU(node.status?.allocatable?.cpu) || 0)), memory: Math.max(0, ...nodes.map(node => parseMemory(node.status?.allocatable?.memory) || 0)) };
  const podsByNamespace = new Map();
  for (const pod of list(objects.pods)) { const ns = meta(pod).namespace || ''; if (!podsByNamespace.has(ns)) podsByNamespace.set(ns, []); podsByNamespace.get(ns).push(pod); }
  const ctx = {
    production, largest, podsByNamespace,
    pdbs: list(objects.poddisruptionbudgets),
    hpaTargets: new Set(list(objects.horizontalpodautoscalers).map(hpa => `${meta(hpa).namespace}/${hpa.spec?.scaleTargetRef?.kind}/${hpa.spec?.scaleTargetRef?.name}`)),
    serviceNames: new Set(list(objects.services).map(svc => `${meta(svc).namespace}/${meta(svc).name}`)),
    workloadNames: new Set([...list(objects.deployments).map(item => `${meta(item).namespace}/Deployment/${meta(item).name}`), ...list(objects.statefulsets).map(item => `${meta(item).namespace}/StatefulSet/${meta(item).name}`)]),
    quotaNamespaces: new Set(list(objects.resourcequotas).map(item => meta(item).namespace)),
    limitNamespaces: new Set(list(objects.limitranges).map(item => meta(item).namespace)),
    defaultSANoToken: new Set(list(objects.serviceaccounts).filter(sa => meta(sa).name === 'default' && sa.automountServiceAccountToken === false).map(sa => meta(sa).namespace)),
  };
  const subjects = subjectsOf(Object.fromEntries(['deployments', 'statefulsets', 'daemonsets', 'jobs', 'cronjobs', 'pods'].map(resource => [resource, scoped(resource)])));
  const busy = new Set(subjects.map(s => s.namespace));
  const scopes = {
    workload: subjects,
    pdb: scoped('poddisruptionbudgets').map(item => ({ resource: 'poddisruptionbudgets', item })),
    hpa: scoped('horizontalpodautoscalers').map(item => ({ resource: 'horizontalpodautoscalers', item })),
    service: scoped('services').map(item => ({ resource: 'services', item })),
    ingress: scoped('ingresses').map(item => ({ resource: 'ingresses', item })),
    // Only namespaces that run something: an empty namespace needs no quota.
    namespace: list(objects.namespaces).filter(ns => inScope(meta(ns).name) && busy.has(meta(ns).name) && ns.status?.phase !== 'Terminating').map(item => ({ resource: 'namespaces', item })),
  };
  const findings = []; const checks = []; const skipped = [];
  for (const rule of RULES) {
    const scopeAvailable = rule.scope === 'workload' ? true : available({ pdb: 'poddisruptionbudgets', hpa: 'horizontalpodautoscalers', service: 'services', ingress: 'ingresses', namespace: 'namespaces' }[rule.scope]);
    if (!scopeAvailable || (rule.needs || []).some(resource => !available(resource))) { skipped.push(rule.id); continue; }
    for (const entry of scopes[rule.scope]) {
      const subject = rule.scope === 'workload' ? entry : entry.item;
      if (!rule.applies(subject, ctx)) continue;
      const item = entry.item; const m = meta(item);
      const ns = rule.scope === 'namespace' ? m.name : m.namespace || '';
      const id = [rule.id, entry.resource, ns, m.name].join('|');
      const result = rule.check(subject, ctx);
      checks.push({ id, rule: rule.id, namespace: ns, category: rule.category, severity: rule.severity, failed: Boolean(result) });
      if (!result) continue;
      findings.push({ id, rule: rule.id, category: rule.category, severity: rule.severity, title: rule.title, why: rule.why, fix: rule.fix, resource: entry.resource, kind: kindOf(entry.resource), namespace: ns, name: m.name, detail: result.detail || '', containers: result.containers || [], patch: result.patch, manifest: result.manifest });
    }
  }
  const pss = subjects.map(s => ({ resource: s.resource, kind: s.kind, namespace: s.namespace, name: s.name, ...podSecurityLevel(s.pod, s.podMeta) }));
  return { findings: findings.sort(bySeverity), checks, pss, skipped };
}

export const bySeverity = (a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || (a.namespace || '').localeCompare(b.namespace || '') || (a.name || '').localeCompare(b.name || '') || a.rule.localeCompare(b.rule);

// ---- Score ----------------------------------------------------------------------------------------
// score = 100 × (weight of passed checks) / (weight of all checks), weights critical 10, warning 3,
// info 1. A suppressed finding counts as passed. No checks → null (nothing to grade).
export const SCORE_FORMULA = 'Score = 100 × passed weight ÷ total weight over every check that applies (critical 10, warning 3, info 1). Suppressed findings count as passed. A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, F below.';
export function gradeOf(score) {
  if (score === null || score === undefined || !Number.isFinite(score)) return '—';
  return score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';
}
function tally(checks, suppressed) {
  let total = 0; let passed = 0;
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const check of checks) {
    const weight = WEIGHTS[check.severity] || 1;
    total += weight;
    if (!check.failed || suppressed.has(check.id)) passed += weight;
    else counts[check.severity]++;
  }
  const score = total ? Math.round((100 * passed) / total) : null;
  return { score, grade: gradeOf(score), checks: checks.length, ...counts };
}
// → { ...overall, categories: { Reliability: {score, grade, …}, … }, namespaces: [{ namespace, …tally }] }
export function scoreOf(checks, suppressed = new Set()) {
  const overall = tally(checks, suppressed);
  const categories = Object.fromEntries(CATEGORIES.map(category => [category, tally(checks.filter(check => check.category === category), suppressed)]));
  const byNamespace = new Map();
  for (const check of checks) { if (!byNamespace.has(check.namespace)) byNamespace.set(check.namespace, []); byNamespace.get(check.namespace).push(check); }
  const namespaces = [...byNamespace].map(([namespace, items]) => ({ namespace, ...tally(items, suppressed) })).sort((a, b) => (a.score ?? 101) - (b.score ?? 101) || a.namespace.localeCompare(b.namespace));
  return { ...overall, categories, namespaces };
}
// Score and findings of a single object (the details drawer).
export function objectSummary(result, resource, namespace, name, suppressed = new Set()) {
  const suffix = `|${resource}|${namespace}|${name}`;
  const checks = result.checks.filter(check => check.id.endsWith(suffix));
  const findings = result.findings.filter(finding => finding.id.endsWith(suffix) && !suppressed.has(finding.id));
  const pss = result.pss.find(entry => entry.resource === resource && entry.namespace === namespace && entry.name === name);
  return { ...tally(checks, suppressed), findings, pss };
}
export function pssCounts(pss) {
  const counts = { privileged: 0, baseline: 0, restricted: 0 };
  for (const entry of pss) counts[entry.level]++;
  return counts;
}

// ---- Filtering and grouping -----------------------------------------------------------------------
export function filterFindings(findings, { severities, categories, text = '', suppressed = new Set(), showSuppressed = false } = {}) {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return findings.filter(finding => (!severities || severities.has(finding.severity))
    && (!categories || categories.has(finding.category))
    && (showSuppressed || !suppressed.has(finding.id))
    && words.every(word => `${finding.title} ${finding.kind} ${finding.namespace} ${finding.name} ${finding.detail} ${finding.rule} ${finding.category}`.toLowerCase().includes(word)));
}
// by 'rule' → [{ key, rule, findings }], by 'workload' → [{ key, resource, kind, namespace, name, findings }],
// worst first.
export function groupFindings(findings, by = 'rule') {
  const groups = new Map();
  for (const finding of findings) {
    const key = by === 'rule' ? finding.rule : `${finding.resource}|${finding.namespace}|${finding.name}`;
    if (!groups.has(key)) groups.set(key, by === 'rule' ? { key, rule: RULE_BY_ID.get(finding.rule), findings: [] } : { key, resource: finding.resource, kind: finding.kind, namespace: finding.namespace, name: finding.name, findings: [] });
    groups.get(key).findings.push(finding);
  }
  const worst = group => Math.min(...group.findings.map(finding => SEVERITIES.indexOf(finding.severity)));
  const weight = group => group.findings.reduce((total, finding) => total + WEIGHTS[finding.severity], 0);
  return [...groups.values()].sort((a, b) => worst(a) - worst(b) || weight(b) - weight(a) || a.key.localeCompare(b.key));
}

// ---- Patches --------------------------------------------------------------------------------------
// Lists Kubernetes merges by a key in a strategic-merge patch; every other list is replaced.
const MERGE_KEYS = { containers: 'name', initContainers: 'name', ephemeralContainers: 'name', volumes: 'name', env: 'name', volumeMounts: 'mountPath', ports: 'containerPort', imagePullSecrets: 'name', tolerations: null };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Applies a strategic-merge patch to a copy of the object. null deletes a key.
export function applyPatch(target, patch) {
  if (!isObject(patch)) return structuredClone(patch);
  const out = isObject(target) ? structuredClone(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) { delete out[key]; continue; }
    const mergeKey = MERGE_KEYS[key];
    if (Array.isArray(value) && mergeKey && Array.isArray(out[key])) {
      const merged = out[key].map(item => structuredClone(item));
      for (const entry of value) {
        const index = merged.findIndex(item => isObject(item) && item[mergeKey] === entry[mergeKey]);
        if (index >= 0) merged[index] = applyPatch(merged[index], entry); else merged.push(structuredClone(entry));
      }
      out[key] = merged;
    } else if (isObject(value)) out[key] = applyPatch(out[key], value);
    else out[key] = structuredClone(value);
  }
  return out;
}
// What the editor shows for an object before applying: no status, no server-managed metadata.
const DROP_META = ['uid', 'resourceVersion', 'generation', 'creationTimestamp', 'managedFields', 'selfLink', 'ownerReferences', 'finalizers', 'deletionTimestamp', 'deletionGracePeriodSeconds'];
const DROP_ANNOTATIONS = ['kubectl.kubernetes.io/last-applied-configuration', 'deployment.kubernetes.io/revision'];
function stripNulls(value) {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([k, v]) => [k, stripNulls(v)]));
}
export function cleanForApply(object) {
  const out = stripNulls(structuredClone(object || {}));
  delete out.status;
  const m = out.metadata || {};
  for (const key of DROP_META) delete m[key];
  if (m.annotations) { for (const key of DROP_ANNOTATIONS) delete m.annotations[key]; if (!Object.keys(m.annotations).length) delete m.annotations; }
  return out;
}
// The manifest a Fix… review applies: the live object with the patch merged in, or the object to create.
export function fixDocument(finding, live) {
  if (finding.manifest) return finding.manifest;
  if (!finding.patch || !live) return null;
  return applyPatch(cleanForApply(live), finding.patch);
}
// A kubectl command applying the patch, or the manifest to create, for the clipboard.
const shellQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
export function patchText(finding, context = '') {
  if (finding.manifest) return toYAML(finding.manifest);
  if (!finding.patch) return '';
  const ctx = context ? `--context ${shellQuote(context)} ` : '';
  const ns = finding.namespace && finding.resource !== 'namespaces' ? `-n ${shellQuote(finding.namespace)} ` : '';
  return `kubectl ${ctx}${ns}patch ${finding.resource} ${shellQuote(finding.name)} --type=strategic -p ${shellQuote(JSON.stringify(finding.patch))}`;
}
// Marks objects managed by Helm or Argo CD, whose next sync would undo a direct change.
export function managedBy(object) {
  const labels = meta(object).labels || {}; const annotations = meta(object).annotations || {};
  if (annotations['argocd.argoproj.io/tracking-id'] || labels['argocd.argoproj.io/instance']) return 'Argo CD';
  if (labels['app.kubernetes.io/managed-by'] === 'Helm' || annotations['meta.helm.sh/release-name']) return 'Helm';
  if (labels['kustomize.toolkit.fluxcd.io/name'] || labels['helm.toolkit.fluxcd.io/name']) return 'Flux';
  return '';
}

// ---- YAML -----------------------------------------------------------------------------------------
// A small YAML writer for JSON-shaped values. Strings that could be read as anything else are written
// as JSON strings, which YAML accepts as double-quoted scalars.
const RESERVED = /^(true|false|yes|no|on|off|y|n|null|~)$/i;
// Plain when it can only be read as this string: starts with a letter, '_' or '/', no ': ' or trailing ':'
// (a mapping), not a YAML 1.1 boolean or null; or a Kubernetes quantity such as 250m or 128Mi.
const plainSafe = text => (/^[A-Za-z_/][A-Za-z0-9_./:@-]*$/.test(text) && !text.endsWith(':') && !RESERVED.test(text)) || /^\d+(\.\d+)?(m|k|Ki|Mi|Gi|Ti|M|G|T)$/.test(text);
const scalar = value => {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const text = String(value);
  return plainSafe(text) ? text : JSON.stringify(text);
};
const keyText = key => (plainSafe(key) ? key : JSON.stringify(key));
export function toYAML(value, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return `${pad}[]\n`;
    return value.map(item => {
      if (isObject(item) && Object.keys(item).length) { const body = toYAML(item, indent + 2); return `${pad}- ${body.slice(indent + 2)}`; }
      if (Array.isArray(item) && item.length) return `${pad}-\n${toYAML(item, indent + 2)}`;
      return `${pad}- ${isObject(item) ? '{}' : Array.isArray(item) ? '[]' : scalar(item)}\n`;
    }).join('');
  }
  if (isObject(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (!entries.length) return `${pad}{}\n`;
    return entries.map(([key, v]) => {
      if (isObject(v) && Object.keys(v).length) return `${pad}${keyText(key)}:\n${toYAML(v, indent + 2)}`;
      if (Array.isArray(v) && v.length) return `${pad}${keyText(key)}:\n${toYAML(v, indent)}`;
      return `${pad}${keyText(key)}: ${isObject(v) ? '{}' : Array.isArray(v) ? '[]' : scalar(v)}\n`;
    }).join('');
  }
  return `${pad}${scalar(value)}\n`;
}
