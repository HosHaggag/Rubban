// PromQL for Rubban's metrics tabs. Uses the standard cAdvisor, kubelet, kube-state-metrics and
// node-exporter series that kube-prometheus-stack and most Prometheus setups scrape.
const quote = value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const regexEscape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const anyOf = values => quote(values.length ? values.map(regexEscape).join('|') : '^$');
const rate = '5m';

export function podQueries(namespace, pods, container) {
  const ns = quote(namespace); const pod = pods?.regex ? quote(pods.regex) : Array.isArray(pods) ? anyOf(pods) : quote(regexEscape(pods));
  const scope = `namespace=${ns},pod=~${pod}${container ? `,container=${quote(container)}` : ',container!="",container!="POD"'}`;
  const net = `namespace=${ns},pod=~${pod}`;
  return {
    cpu: `sum(rate(container_cpu_usage_seconds_total{${scope}}[${rate}]))`,
    memory: `sum(container_memory_working_set_bytes{${scope}})`,
    cpuThrottled: `sum(rate(container_cpu_cfs_throttled_seconds_total{${scope}}[${rate}]))`,
    networkReceive: `sum(rate(container_network_receive_bytes_total{${net}}[${rate}]))`,
    networkTransmit: `sum(rate(container_network_transmit_bytes_total{${net}}[${rate}]))`,
    fsReads: `sum(rate(container_fs_reads_bytes_total{${scope}}[${rate}]))`,
    fsWrites: `sum(rate(container_fs_writes_bytes_total{${scope}}[${rate}]))`,
    restarts: `sum(increase(kube_pod_container_status_restarts_total{${net}}[1h]))`,
  };
}
export function namespaceQueries(namespace) {
  const ns = quote(namespace);
  return {
    cpu: `sum(rate(container_cpu_usage_seconds_total{namespace=${ns},container!="",container!="POD"}[${rate}]))`,
    memory: `sum(container_memory_working_set_bytes{namespace=${ns},container!="",container!="POD"})`,
    cpuRequests: `sum(kube_pod_container_resource_requests{namespace=${ns},resource="cpu"})`,
    memoryRequests: `sum(kube_pod_container_resource_requests{namespace=${ns},resource="memory"})`,
    networkReceive: `sum(rate(container_network_receive_bytes_total{namespace=${ns}}[${rate}]))`,
    networkTransmit: `sum(rate(container_network_transmit_bytes_total{namespace=${ns}}[${rate}]))`,
  };
}
export function nodeQueries(node, address) {
  const n = quote(node);
  const instance = quote(`(${regexEscape(node)}${address ? `|${regexEscape(address)}` : ''})(:[0-9]+)?`);
  return {
    cpu: `sum(rate(container_cpu_usage_seconds_total{id="/",node=${n}}[${rate}])) or sum(rate(container_cpu_usage_seconds_total{id="/",instance=~${instance}}[${rate}])) or sum(rate(node_cpu_seconds_total{mode!="idle",instance=~${instance}}[${rate}]))`,
    memory: `sum(container_memory_working_set_bytes{id="/",node=${n}}) or sum(container_memory_working_set_bytes{id="/",instance=~${instance}}) or sum(node_memory_MemTotal_bytes{instance=~${instance}} - node_memory_MemAvailable_bytes{instance=~${instance}})`,
    diskUsed: `sum((node_filesystem_size_bytes{mountpoint="/",fstype!~"tmpfs|overlay"} - node_filesystem_avail_bytes{mountpoint="/",fstype!~"tmpfs|overlay"}) * on(instance) group_left(nodename) node_uname_info{nodename=${n}}) or sum(node_filesystem_size_bytes{mountpoint="/",instance=~${instance}} - node_filesystem_avail_bytes{mountpoint="/",instance=~${instance}})`,
    diskSize: `sum(node_filesystem_size_bytes{mountpoint="/",fstype!~"tmpfs|overlay"} * on(instance) group_left(nodename) node_uname_info{nodename=${n}}) or sum(node_filesystem_size_bytes{mountpoint="/",instance=~${instance}})`,
    pods: `count(kube_pod_info{node=${n}})`,
    networkReceive: `sum(rate(container_network_receive_bytes_total{id="/",node=${n}}[${rate}])) or sum(rate(node_network_receive_bytes_total{instance=~${instance},device!~"lo|veth.*|cali.*|flannel.*|cni.*|docker.*"}[${rate}]))`,
    networkTransmit: `sum(rate(container_network_transmit_bytes_total{id="/",node=${n}}[${rate}])) or sum(rate(node_network_transmit_bytes_total{instance=~${instance},device!~"lo|veth.*|cali.*|flannel.*|cni.*|docker.*"}[${rate}]))`,
  };
}
export function clusterQueries(nodes = null) {
  const nodeFilter = nodes ? `,node=~${anyOf(nodes)}` : '';
  return {
    cpu: `sum(rate(container_cpu_usage_seconds_total{id="/"${nodeFilter}}[${rate}]))`,
    memory: `sum(container_memory_working_set_bytes{id="/"${nodeFilter}})`,
    cpuRequests: `sum(kube_pod_container_resource_requests{resource="cpu"${nodeFilter}})`,
    cpuLimits: `sum(kube_pod_container_resource_limits{resource="cpu"${nodeFilter}})`,
    cpuAllocatable: `sum(kube_node_status_allocatable{resource="cpu"${nodeFilter}})`,
    memoryRequests: `sum(kube_pod_container_resource_requests{resource="memory"${nodeFilter}})`,
    memoryLimits: `sum(kube_pod_container_resource_limits{resource="memory"${nodeFilter}})`,
    memoryAllocatable: `sum(kube_node_status_allocatable{resource="memory"${nodeFilter}})`,
    pods: `count(kube_pod_info${nodes ? `{node=~${anyOf(nodes)}}` : ''})`,
    podsAllocatable: `sum(kube_node_status_allocatable{resource="pods"${nodeFilter}})`,
  };
}
export function pvcQueries(namespace, claim) {
  const scope = `namespace=${quote(namespace)},persistentvolumeclaim=${quote(claim)}`;
  return { used: `sum(kubelet_volume_stats_used_bytes{${scope}})`, capacity: `sum(kubelet_volume_stats_capacity_bytes{${scope}})`, inodesUsed: `sum(kubelet_volume_stats_inodes_used{${scope}})` };
}
export function ingressQueries(namespace, name) {
  const scope = `exported_namespace=${quote(namespace)},ingress=${quote(name)}`;
  return {
    requests: `sum(rate(nginx_ingress_controller_requests{${scope}}[${rate}]))`,
    errors: `sum(rate(nginx_ingress_controller_requests{${scope},status=~"5.."}[${rate}]))`,
    latency: `histogram_quantile(0.95, sum by (le) (rate(nginx_ingress_controller_request_duration_seconds_bucket{${scope}}[${rate}])))`,
  };
}
export const RANGES = [{ id: '1h', label: '1 hour', seconds: 3600 }, { id: '6h', label: '6 hours', seconds: 6 * 3600 }, { id: '24h', label: '24 hours', seconds: 86400 }, { id: '7d', label: '7 days', seconds: 7 * 86400 }];
export const stepFor = seconds => Math.max(15, Math.round(seconds / 240));
// Pod-name patterns for controller-owned pods (used when the pod list is not at hand).
export function podPattern(kind, name) {
  const base = regexEscape(name);
  if (kind === 'Deployment') return { regex: `${base}-[a-z0-9]+-[a-z0-9]+` };
  if (kind === 'StatefulSet') return { regex: `${base}-[0-9]+` };
  if (['DaemonSet', 'ReplicaSet', 'Job', 'ReplicationController'].includes(kind)) return { regex: `${base}-[a-z0-9]+` };
  if (kind === 'CronJob') return { regex: `${base}-[0-9]+-[a-z0-9]+` };
  return { regex: base };
}
