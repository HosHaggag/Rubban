'use strict';
const { spawn } = require('node:child_process');

const RESOURCES = new Set(('pods nodes namespaces deployments daemonsets statefulsets replicasets jobs cronjobs services endpoints endpointslices ingresses networkpolicies configmaps persistentvolumeclaims persistentvolumes storageclasses events serviceaccounts roles rolebindings clusterroles clusterrolebindings horizontalpodautoscalers customresourcedefinitions leases resourcequotas limitranges poddisruptionbudgets').split(' '));
const SPECIAL = new Set(['api-resources', 'metrics:nodes', 'metrics:pods', 'logs']);
const KUBE_NAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

function validateQuery(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A query object is required');
  if (Object.keys(value).some(k => !['resource', 'namespace', 'name'].includes(k))) throw new Error('Unsupported query field');
  if (typeof value.resource !== 'string' || !(RESOURCES.has(value.resource) || SPECIAL.has(value.resource))) throw new Error('Resource is not permitted');
  const query = { resource: value.resource };
  for (const key of ['namespace', 'name']) {
    if (value[key] !== undefined && value[key] !== '' && !(key === 'namespace' && value[key] === '*')) {
      if (typeof value[key] !== 'string' || !KUBE_NAME.test(value[key])) throw new Error(`Invalid ${key}`);
      query[key] = value[key];
    }
  }
  if (query.resource === 'logs' && (!query.name || !query.namespace)) throw new Error('Log snapshots require pod name and namespace');
  if (query.resource === 'api-resources' && (query.name || query.namespace)) throw new Error('Discovery takes no name or namespace');
  if (query.resource.startsWith('metrics:') && query.name) throw new Error('Metrics takes no resource name');
  if (query.resource === 'metrics:nodes' && query.namespace) throw new Error('Node metrics takes no namespace');
  return query;
}

function kubectlPlan(value, context) {
  const query = validateQuery(value);
  if (context !== undefined && (typeof context !== 'string' || !context || context.startsWith('-') || context.length > 512 || /[\r\n\0]/.test(context))) throw new Error('Invalid configured Kubernetes context');
  const args = context ? ['--context', context] : [];
  args.push('--request-timeout=15s');
  if (query.resource === 'api-resources') args.push('api-resources', '-o', 'wide');
  else if (query.resource === 'logs') args.push('logs', query.name, '--namespace', query.namespace, '--tail=200', '--limit-bytes=65536', '--timestamps=true');
  else if (query.resource.startsWith('metrics:')) {
    args.push('top', query.resource === 'metrics:nodes' ? 'nodes' : 'pods', '--no-headers');
    if (query.resource === 'metrics:pods') args.push(...(query.namespace ? ['--namespace', query.namespace] : ['--all-namespaces']));
  } else {
    args.push('get', query.resource);
    if (query.name) args.push(query.name);
    if (query.namespace) args.push('--namespace', query.namespace);
    else if (!query.name) args.push('--all-namespaces');
    args.push('-o', 'json');
  }
  return { query, args, json: RESOURCES.has(query.resource) };
}

function runReadQuery(value, options = {}) {
  const plan = kubectlPlan(value, options.context);
  const executable = options.kubectl || process.env.RUBBAN_KUBECTL || 'kubectl';
  const spawnFn = options.spawn || spawn;
  return new Promise((resolve, reject) => {
    const child = spawnFn(executable, plan.args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let bytes = 0; let stderr = ''; let settled = false;
    const finish = (error, data) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(data); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Kubernetes query timed out')); }, options.timeoutMs || 20000);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) { child.kill(); finish(new Error('Kubernetes response exceeded 4 MiB')); }
      else chunks.push(chunk);
    });
    child.stderr.on('data', chunk => { if (stderr.length < 8192) stderr += chunk.toString('utf8').slice(0, 8192 - stderr.length); });
    child.on('error', () => finish(new Error('Could not start kubectl; verify installation and agent context')));
    child.on('close', code => {
      if (code !== 0) return finish(new Error(`kubectl failed (${code ?? 'signal'}); check cluster permissions, context and API availability`));
      const text = Buffer.concat(chunks).toString('utf8');
      try { finish(null, plan.json ? JSON.parse(text) : { text }); }
      catch { finish(new Error('kubectl returned invalid JSON')); }
    });
  });
}

module.exports = { RESOURCES, validateQuery, kubectlPlan, runReadQuery };
