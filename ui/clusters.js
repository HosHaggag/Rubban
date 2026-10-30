// Display metadata for kubeconfig contexts: label, icon, colour and environment, with guesses from the context name.
export const CLUSTER_COLORS = ['#3d90ce', '#2f8f4e', '#d19a3a', '#b4403a', '#8a4d8a', '#2a7c70', '#6b7380', '#c9743d'];
export const CLUSTER_ENVS = ['production', 'staging', 'development', 'other'];

export function guessIcon(name = '') {
  const text = String(name).toLowerCase();
  if (text.startsWith('gke_')) return 'gcp';
  if (text.startsWith('arn:aws:eks') || /(^|[-_/:])eks([-_/:]|$)/.test(text)) return 'aws';
  if (/(^|[-_/:])(aks|azure)([-_/:]|$)/.test(text)) return 'azure';
  if (/^(docker-desktop|minikube|rancher-desktop|colima)$|^(kind|k3d)-|^k3s/.test(text)) return 'local';
  return 'cluster';
}
export function guessEnv(name = '') {
  const text = String(name).toLowerCase();
  if (/prod|prd/.test(text)) return 'production';
  if (/stag|stg|uat/.test(text)) return 'staging';
  if (/(^|[^a-z])dev([^a-z]|$)|development/.test(text)) return 'development';
  return '';
}
export function hashColor(name = '') {
  let hash = 0;
  for (const char of String(name)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return CLUSTER_COLORS[hash % CLUSTER_COLORS.length];
}
// Saved settings win; every missing field falls back to a guess so unconfigured clusters still look distinct.
export function clusterInfo(name, clusters = {}) {
  const saved = (clusters && typeof clusters === 'object' && clusters[name]) || {};
  return {
    name,
    label: saved.label || name,
    icon: saved.icon || guessIcon(name),
    color: saved.color || hashColor(name),
    env: saved.env !== undefined && saved.env !== '' ? saved.env : guessEnv(name),
  };
}
export const isProduction = (name, clusters) => clusterInfo(name, clusters).env === 'production';
