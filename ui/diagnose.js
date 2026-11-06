// Plain-language diagnosis of why a pod (or a workload's pods) is not healthy: what is wrong, the
// most likely cause and what to do next. Pure: works on Kubernetes objects and events, no DOM.
import { parseCPU, parseMemory, formatCPU, formatBytes } from './format.js';

const SIGNALS = { 137: 'SIGKILL', 143: 'SIGTERM', 139: 'SIGSEGV', 134: 'SIGABRT' };
const ago = (time, now) => {
  const ms = now - new Date(time).getTime();
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};

// What an exit code usually means, as a hint.
export function exitHint(code, reason, limits = {}) {
  if (reason === 'OOMKilled') return `The container used more memory than its limit${limits.memory ? ` (${limits.memory})` : ''} and was killed. Raise the memory limit or find the leak.`;
  if (code === 137) return 'Killed with SIGKILL: usually out of memory, or a liveness probe that kept failing so the kubelet restarted it.';
  if (code === 143) return 'Stopped with SIGTERM: something asked it to shut down (a failing liveness probe, a rollout or a node drain).';
  if (code === 139) return 'Segmentation fault (SIGSEGV) inside the process: a bug or an incompatible native library in the image.';
  if (code === 126) return 'The command exists but cannot be executed: check its permissions and the image architecture.';
  if (code === 127) return 'The command was not found in the image: check `command`/`args` and the image entrypoint.';
  if (code === 0) return 'The process finished successfully, but this workload expects it to keep running. Check the command, or use a Job for one-off work.';
  if (code === 1 || code === 2) return 'The application exited with an error. Its own log output from the run that crashed usually says why.';
  return code !== undefined ? `Exited with code ${code}${SIGNALS[code] ? ` (${SIGNALS[code]})` : ''}. The logs of the previous run usually say why.` : '';
}

function imagePullHint(message = '', image = '') {
  const tag = image.includes('@') ? image.split('@')[1] : image.includes(':') && !image.endsWith(':') ? image.slice(image.lastIndexOf(':') + 1) : 'latest';
  const repo = image.includes('@') ? image.split('@')[0] : image.includes(':') ? image.slice(0, image.lastIndexOf(':')) : image;
  if (/not found|manifest unknown|does not exist|no such manifest/i.test(message)) return `The tag \`${tag}\` does not exist in \`${repo}\`. Fix the tag, or roll back to the previous revision.`;
  if (/unauthorized|denied|authentication required|403|401/i.test(message)) return 'The registry refused the pull: add or fix `imagePullSecrets` for this registry, or check the image path.';
  if (/no such host|i\/o timeout|dial tcp|connection refused|TLS handshake/i.test(message)) return 'The nodes cannot reach the registry: check the registry address, DNS, the network path and any proxy.';
  if (/toomanyrequests|rate limit/i.test(message)) return 'The registry is rate-limiting pulls: authenticate, or use a mirror.';
  return 'Check the image name and tag, and that the nodes can reach and authenticate to the registry.';
}

const requestsOf = pod => {
  let cpu = 0; let memory = 0;
  for (const c of pod.spec?.containers || []) { cpu += parseCPU(c.resources?.requests?.cpu) || 0; memory += parseMemory(c.resources?.requests?.memory) || 0; }
  for (const c of pod.spec?.initContainers || []) { cpu = Math.max(cpu, parseCPU(c.resources?.requests?.cpu) || 0); memory = Math.max(memory, parseMemory(c.resources?.requests?.memory) || 0); }
  return { cpu, memory };
};

function schedulingFinding(pod, condition, nodes) {
  const message = condition?.message || '';
  const hints = [];
  const want = requestsOf(pod);
  const largest = (nodes || []).reduce((best, node) => ({ cpu: Math.max(best.cpu, parseCPU(node.status?.allocatable?.cpu) || 0), memory: Math.max(best.memory, parseMemory(node.status?.allocatable?.memory) || 0) }), { cpu: 0, memory: 0 });
  if (/Insufficient cpu/i.test(message)) hints.push(largest.cpu && want.cpu > largest.cpu ? `It requests ${formatCPU(want.cpu)} of CPU, but the largest node has only ${formatCPU(largest.cpu)} allocatable: no node can ever fit it. Lower the CPU request, or add a bigger node.` : `It requests ${formatCPU(want.cpu)} of CPU and no node has that much free. Lower the request, free capacity or add nodes.`);
  if (/Insufficient memory/i.test(message)) hints.push(largest.memory && want.memory > largest.memory ? `It requests ${formatBytes(want.memory)} of memory, but the largest node has only ${formatBytes(largest.memory)} allocatable. Lower the memory request, or add a bigger node.` : `It requests ${formatBytes(want.memory)} of memory and no node has that much free.`);
  if (/untolerated taint|had taint/i.test(message)) hints.push('Some nodes carry taints this pod does not tolerate: add a matching toleration, or schedule it elsewhere.');
  if (/didn't match Pod's node affinity|node selector|node\(s\) didn't match/i.test(message)) hints.push('Its nodeSelector or node affinity matches no available node: check the labels it asks for.');
  if (/unbound immediate PersistentVolumeClaims|persistentvolumeclaim .* not found|volume node affinity/i.test(message)) hints.push('It waits for a volume: the PersistentVolumeClaim is not bound (check its StorageClass) or the volume lives in another zone.');
  if (/didn't have free ports|port/i.test(message) && /free ports/i.test(message)) hints.push('It needs a host port that is already taken on every node.');
  if (/Too many pods/i.test(message)) hints.push('The nodes are at their pod limit: add nodes or raise maxPods.');
  if (!hints.length) hints.push('The scheduler could not place it yet. Its message above names the reason for each node.');
  return { tone: 'bad', code: 'unschedulable', title: 'Cannot be scheduled', text: message || 'No node can run this pod.', hints, actions: ['events'] };
}

// Findings for one pod, worst first. `events` are the pod's own events (any order).
export function diagnosePod(pod, { events = [], nodes = [], now = Date.now() } = {}) {
  if (!pod?.status) return [];
  const findings = [];
  const status = pod.status;
  const containers = pod.spec?.containers || [];
  const specOf = name => [...containers, ...(pod.spec?.initContainers || [])].find(c => c.name === name) || {};
  const statuses = [...(status.initContainerStatuses || []).map(s => ({ ...s, init: true })), ...(status.containerStatuses || [])];
  const recent = [...events].sort((a, b) => new Date(b.lastTimestamp || b.eventTime || b.metadata?.creationTimestamp || 0) - new Date(a.lastTimestamp || a.eventTime || a.metadata?.creationTimestamp || 0));
  if (status.reason === 'Evicted') findings.push({ tone: 'bad', code: 'evicted', title: 'Evicted from its node', text: status.message || 'The kubelet evicted this pod.', hints: ['Evictions usually mean the node ran short of memory or disk. The pod is not restarted; its controller creates a replacement elsewhere.'], actions: ['events'] });
  for (const cs of statuses) {
    const waiting = cs.state?.waiting; const terminated = cs.state?.terminated;
    // Between two restarts a crash-looping container shows as terminated: that run is the one to explain.
    const restarting = terminated && terminated.exitCode !== 0 && pod.spec?.restartPolicy !== 'Never' && pod.spec?.restartPolicy !== 'OnFailure';
    const last = restarting ? terminated : cs.lastState?.terminated;
    const spec = specOf(cs.name);
    const label = `${cs.init ? 'Init container' : 'Container'} ${cs.name}`;
    if (waiting && /ImagePullBackOff|ErrImagePull|InvalidImageName/.test(waiting.reason)) {
      findings.push({ tone: 'bad', code: 'image', container: cs.name, title: 'Image cannot be pulled', text: `${label} cannot pull \`${cs.image || spec.image}\`${waiting.message ? `: ${waiting.message.replace(/^Back-off pulling image "[^"]+": ?/, '')}` : '.'}`, hints: [imagePullHint(waiting.message, cs.image || spec.image || '')], actions: ['events', 'rollback'] });
    } else if (waiting && /CreateContainerConfigError|CreateContainerError/.test(waiting.reason)) {
      const msg = waiting.message || '';
      const missing = msg.match(/(secret|configmap) "([^"]+)" not found/i);
      const key = msg.match(/couldn't find key (\S+) in (Secret|ConfigMap) [^/]+\/(\S+)/i);
      findings.push({ tone: 'bad', code: 'config', container: cs.name, title: 'Configuration is missing', text: `${label} cannot start: ${msg || waiting.reason}.`, hints: [missing ? `Create the ${missing[1]} \`${missing[2]}\` in this namespace, or fix the reference to it.` : key ? `Add the key \`${key[1]}\` to ${key[2]} \`${key[3]}\`, or fix the reference.` : 'A referenced ConfigMap, Secret or key is missing, or the container command is invalid.'], actions: ['events', 'yaml'] });
    } else if (waiting?.reason === 'CrashLoopBackOff' || restarting) {
      const code = last?.exitCode;
      const finished = last?.finishedAt ? ago(last.finishedAt, now) : '';
      const limits = { memory: spec.resources?.limits?.memory };
      findings.push({ tone: 'bad', code: last?.reason === 'OOMKilled' ? 'oom' : 'crashloop', container: cs.name, title: last?.reason === 'OOMKilled' ? 'Out of memory, restarting' : 'Crash loop: the container keeps exiting',
        text: `${label}${last ? ` exited with code ${code}${last.reason ? ` (${last.reason})` : ''}${finished ? ` ${finished}` : ''}` : ' keeps failing'} and has restarted ${cs.restartCount} time${cs.restartCount === 1 ? '' : 's'}. Kubernetes waits longer before each restart.`,
        hints: [exitHint(code, last?.reason, limits)].filter(Boolean), actions: ['previous-logs', 'events'] });
    } else if (terminated && terminated.exitCode !== 0 && pod.spec?.restartPolicy !== 'Always') {
      findings.push({ tone: 'bad', code: 'failed', container: cs.name, title: 'Container failed', text: `${label} exited with code ${terminated.exitCode}${terminated.reason ? ` (${terminated.reason})` : ''}${terminated.message ? `: ${terminated.message}` : ''}.`, hints: [exitHint(terminated.exitCode, terminated.reason, { memory: spec.resources?.limits?.memory })].filter(Boolean), actions: ['logs', 'events'] });
    } else if (last?.reason === 'OOMKilled' && cs.restartCount > 0) {
      findings.push({ tone: 'warn', code: 'oom-past', container: cs.name, title: 'Was killed for using too much memory', text: `${label} was OOM-killed ${last.finishedAt ? ago(last.finishedAt, now) : 'earlier'} and restarted (${cs.restartCount} restarts so far).`, hints: [exitHint(137, 'OOMKilled', { memory: spec.resources?.limits?.memory })], actions: ['previous-logs'] });
    } else if (status.phase === 'Running' && !cs.init && cs.state?.running && !cs.ready) {
      const probe = recent.find(e => e.reason === 'Unhealthy' && /Readiness probe/i.test(e.message || ''));
      const hints = [];
      const readiness = spec.readinessProbe;
      const port = readiness?.tcpSocket?.port ?? readiness?.httpGet?.port ?? readiness?.grpc?.port;
      const ports = (spec.ports || []);
      if (port !== undefined && ports.length && !ports.some(p => p.containerPort === port || p.name === port)) hints.push(`The readiness probe checks port ${port}, but the container declares ${ports.map(p => `${p.containerPort}${p.name ? ` (${p.name})` : ''}`).join(', ')}. Point the probe at the port the app listens on.`);
      if (!hints.length) hints.push(readiness ? 'The app is running but its readiness probe fails, so the Service sends it no traffic. Check the probe path and port, and the app logs.' : 'The container is running but not ready yet.');
      findings.push({ tone: 'warn', code: 'not-ready', container: cs.name, title: 'Running, but not ready', text: probe ? `${label}: ${probe.message}` : `${label} is running but not ready.`, hints, actions: ['events', 'logs'] });
    }
    // Liveness probe failures that cause restarts.
    const liveness = recent.find(e => e.reason === 'Unhealthy' && /Liveness probe/i.test(e.message || '') && (e.message || '').length);
    if (liveness && cs.restartCount > 0 && !findings.some(f => f.container === cs.name && f.code === 'crashloop')) findings.push({ tone: 'warn', code: 'liveness', container: cs.name, title: 'Liveness probe restarts it', text: liveness.message, hints: ['The kubelet restarts the container when this probe fails. Give the app more time (initialDelaySeconds, failureThreshold) or fix the probe.'], actions: ['events', 'previous-logs'] });
  }
  if (status.phase === 'Pending') {
    const scheduled = (status.conditions || []).find(c => c.type === 'PodScheduled');
    if (scheduled?.status === 'False') findings.push(schedulingFinding(pod, scheduled, nodes));
    else if (!findings.length) {
      const pulling = recent.find(e => e.reason === 'Pulling');
      findings.push({ tone: 'warn', code: 'starting', title: 'Starting', text: pulling ? pulling.message : 'Containers are being created.', hints: ['If this takes long, look at the events: a large image, a slow registry or a volume that cannot attach are common causes.'], actions: ['events'] });
    }
  }
  const rank = { bad: 0, warn: 1 };
  return findings.sort((a, b) => (rank[a.tone] ?? 2) - (rank[b.tone] ?? 2));
}

// A workload's diagnosis: the distinct problems of its pods, with how many pods have each.
export function diagnosePods(pods, { eventsByPod = new Map(), nodes = [], now = Date.now() } = {}) {
  const groups = new Map();
  for (const pod of pods) {
    for (const finding of diagnosePod(pod, { events: eventsByPod.get(pod.metadata?.name) || [], nodes, now })) {
      const key = `${finding.code}|${finding.container || ''}|${finding.title}`;
      const group = groups.get(key) || { ...finding, pods: [] };
      group.pods.push(pod.metadata?.name);
      groups.set(key, group);
    }
  }
  return [...groups.values()].sort((a, b) => (a.tone === b.tone ? b.pods.length - a.pods.length : a.tone === 'bad' ? -1 : 1));
}
