'use strict';
const fs = require('node:fs');
const path = require('node:path');

const GROUPS = [
  ['flux-kustomizations', 'Flux Kustomizations', 'kustomizations.kustomize.toolkit.fluxcd.io'],
  ['flux-helmreleases', 'Flux Helm releases', 'helmreleases.helm.toolkit.fluxcd.io'],
  ['argo-applications', 'Argo CD applications', 'applications.argoproj.io'],
  ['vulnerabilities', 'Image vulnerabilities', 'vulnerabilityreports.aquasecurity.github.io'],
  ['configuration-audits', 'Configuration audits', 'configauditreports.aquasecurity.github.io'],
  ['rbac-audits', 'RBAC audits', 'rbacassessmentreports.aquasecurity.github.io'],
];

function shortText(value, label, pattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:@/+ -]{0,253}$/) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}
function identifier(value, label) { return shortText(value, label, /^[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]{0,253}$/); }
function queryArgs(context, namespace) {
  const args = [];
  if (context) args.push('--context', shortText(context, 'context'));
  if (namespace && namespace !== '*') args.push('--namespace', identifier(namespace, 'namespace'));
  else args.push('--all-namespaces');
  return args;
}
function resolveCommand(name) {
  const names = process.platform === 'win32' ? [name + '.exe', name + '.cmd', name + '.bat', name] : [name];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const file of names) {
      const candidate = path.join(dir.replace(/^"|"$/g, ''), file);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
    }
  }
  return null;
}
async function external(run, name, args, options = {}) {
  const command = resolveCommand(name);
  if (!command) throw new Error(`${name} CLI is not installed or is not on PATH. Install it and authenticate with your own account.`);
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    for (const arg of [command, ...args]) {
      if (/[\r\n%!&|<>^]/.test(arg) || arg.includes('"')) throw new Error('This value cannot be passed to a Windows command wrapper.');
    }
    const line = [command, ...args].map(s => `"${s}"`).join(' ');
    return run(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', `"${line}"`], options);
  }
  return run(command, args, options);
}
function validateServiceURL(input) {
  const u = new URL(input);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash) throw new Error('Use an HTTP(S) service URL without embedded credentials.');
  return u;
}
async function jsonFetch(url, options = {}) {
  const { signal, ...rest } = options;
  const timeout = AbortSignal.timeout(15000);
  const response = await fetch(url, { redirect: 'error', ...rest, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  const parts = []; let total = 0;
  if (response.body) {
    for await (const part of response.body) {
      total += part.byteLength;
      if (total > 12 * 1024 * 1024) throw new Error('Service response exceeds 12 MiB.');
      parts.push(Buffer.from(part));
    }
  }
  const text = Buffer.concat(parts, total).toString('utf8');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Service returned non-JSON response (HTTP ${response.status}).`); }
  if (!response.ok) throw new Error(data.error || data.message || `Service returned HTTP ${response.status}`);
  return data;
}

function createExtras({ fetchJSON: fetchImpl = jsonFetch } = {}) {
  let teamSession = null;
  return async function extras({ req, res, url, body, run: unboundRun, signal, config, readJSON, sendJSON }) {
    const run = (command, args, options = {}) => unboundRun(command, args, { ...options, signal });
    const fetchJSON = (target, options = {}) => fetchImpl(target, { ...options, signal });
    const method = req.method;
    const route = url.pathname;
    const send = (data, status = 200) => sendJSON(res, status, data);
    const read = async () => body || await readJSON(req);
    const preferences = () => config.readPreferences();
    const tools = () => config.kubectlPath || 'kubectl';
    const list = async (resource, context, namespace) => {
      const result = await run(tools(), ['get', resource, ...queryArgs(context, namespace), '-o', 'json'], { timeoutMs: 18000 });
      return JSON.parse(result.stdout);
    };

    if (route === '/api/integrations' && method === 'GET') {
      const context = url.searchParams.get('context');
      if (!context) throw new Error('Choose a cluster context first.');
      const namespace = url.searchParams.get('namespace');
      const groups = await Promise.all(GROUPS.map(async ([id, title, resource]) => {
        try { const result = await list(resource, context, namespace); return { id, title, resource, available: true, items: result.items || [] }; }
        catch (e) { return { id, title, resource, available: false, items: [], error: e.message }; }
      }));
      send({ groups }); return true;
    }

    if (route === '/api/gitops' && method === 'POST') {
      const b = await read();
      const kind = identifier(b.kind, 'GitOps kind');
      if (!GROUPS.slice(0, 3).some(x => x[2] === kind)) throw new Error('Unsupported GitOps kind.');
      const name = identifier(b.name, 'resource name');
      const args = queryArgs(shortText(b.context, 'context'), identifier(b.namespace, 'namespace'));
      if (kind === 'applications.argoproj.io') {
        if (b.action === 'refresh') {
          const result = await run(tools(), ['annotate', kind, name, ...args, 'argocd.argoproj.io/refresh=hard', '--overwrite']);
          send({ output: result.stdout }); return true;
        }
        if (b.action !== 'sync') throw new Error('Argo supports sync and refresh.');
        const patch = JSON.stringify({ operation: { initiatedBy: { username: 'rubban' }, sync: {} } });
        const result = await run(tools(), ['patch', kind, name, ...args, '--type=merge', '-p', patch]);
        send({ output: result.stdout }); return true;
      }
      if (b.action === 'reconcile') {
        const result = await run(tools(), ['annotate', kind, name, ...args, `reconcile.fluxcd.io/requestedAt=${new Date().toISOString()}`, '--overwrite']);
        send({ output: result.stdout }); return true;
      }
      if (!['suspend', 'resume'].includes(b.action)) throw new Error('Flux supports reconcile, suspend, and resume.');
      const patch = JSON.stringify({ spec: { suspend: b.action === 'suspend' } });
      const result = await run(tools(), ['patch', kind, name, ...args, '--type=merge', '-p', patch]);
      send({ output: result.stdout }); return true;
    }

    if (route === '/api/cost' && method === 'GET') {
      const prefs = await preferences();
      if (!prefs.opencostUrl) { send({ available: false, source: 'OpenCost', reason: 'Configure your own OpenCost or Kubecost allocation endpoint in Settings. No costs have been estimated or invented.' }); return true; }
      const u = validateServiceURL(prefs.opencostUrl);
      const period = url.searchParams.get('period') || '24h';
      if (!['24h', '7d', '30d'].includes(period)) throw new Error('Unsupported cost period.');
      if (!u.pathname.endsWith('/allocation')) u.pathname = u.pathname.replace(/\/$/, '') + '/allocation';
      u.searchParams.set('window', period); u.searchParams.set('aggregate', 'namespace'); u.searchParams.set('accumulate', 'true');
      send({ available: true, source: 'OpenCost/Kubecost', period, data: await fetchJSON(u) }); return true;
    }

    if (route === '/api/prometheus' && method === 'POST') {
      const b = await read(); const prefs = await preferences();
      if (!prefs.prometheusUrl) throw new Error('Configure your Prometheus endpoint in Settings first.');
      const u = validateServiceURL(prefs.prometheusUrl);
      const query = String(b.query || '');
      if (!query || query.length > 16000) throw new Error('A PromQL query of at most 16,000 characters is required.');
      u.pathname = u.pathname.replace(/\/$/, '') + (b.start ? '/api/v1/query_range' : '/api/v1/query');
      u.searchParams.set('query', query);
      if (b.start) { u.searchParams.set('start', String(b.start)); u.searchParams.set('end', String(b.end)); u.searchParams.set('step', String(b.step || 60)); }
      send(await fetchJSON(u)); return true;
    }

    if (route === '/api/cloud' && method === 'GET') {
      send({ providers: [ ['aws', 'Amazon EKS', 'aws'], ['azure', 'Azure AKS', 'az'], ['gcp', 'Google GKE', 'gcloud'] ].map(([id, label, cli]) => ({ id, label, cli, available: !!resolveCommand(cli) })) });
      return true;
    }
    if (route === '/api/cloud/discover' && method === 'POST') {
      const b = await read();
      if (b.provider === 'aws') {
        const region = identifier(b.region, 'AWS region');
        const result = await external(run, 'aws', ['eks', 'list-clusters', '--region', region, '--output', 'json']);
        const data = JSON.parse(result.stdout);
        send({ provider: 'aws', clusters: (data.clusters || []).map(name => ({ name, region })) }); return true;
      }
      if (b.provider === 'azure') {
        const args = ['aks', 'list', '--output', 'json'];
        if (b.subscription) args.push('--subscription', identifier(b.subscription, 'subscription'));
        const data = JSON.parse((await external(run, 'az', args)).stdout);
        send({ provider: 'azure', clusters: data.map(c => ({ name: c.name, resourceGroup: c.resourceGroup, location: c.location, subscription: b.subscription || '' })) }); return true;
      }
      if (b.provider === 'gcp') {
        const project = identifier(b.project, 'GCP project');
        const data = JSON.parse((await external(run, 'gcloud', ['container', 'clusters', 'list', '--project', project, '--format=json'])).stdout);
        send({ provider: 'gcp', clusters: data.map(c => ({ name: c.name, location: c.location || c.zone, project })) }); return true;
      }
      throw new Error('Choose AWS, Azure, or GCP.');
    }
    if (route === '/api/cloud/import' && method === 'POST') {
      const b = await read(); const name = identifier(b.name, 'cluster name');
      let result;
      if (b.provider === 'aws') result = await external(run, 'aws', ['eks', 'update-kubeconfig', '--name', name, '--region', identifier(b.region, 'region'), '--alias', `rubban-${name}`]);
      else if (b.provider === 'azure') {
        const args = ['aks', 'get-credentials', '--name', name, '--resource-group', identifier(b.resourceGroup, 'resource group'), '--context', `rubban-${name}`];
        if (b.subscription) args.push('--subscription', identifier(b.subscription, 'subscription'));
        result = await external(run, 'az', args);
      } else if (b.provider === 'gcp') result = await external(run, 'gcloud', ['container', 'clusters', 'get-credentials', name, '--location', identifier(b.location, 'location'), '--project', identifier(b.project, 'project')]);
      else throw new Error('Unsupported provider.');
      send({ output: result.stdout || result.stderr || 'Cluster credentials imported into your kubeconfig.' }); return true;
    }

    if (route === '/api/ai' && method === 'POST') {
      const b = await read(); const prefs = await preferences();
      const command = b.command || prefs.aiCommand || 'codex';
      const argsByCommand = { codex: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-'], claude: ['-p'], gemini: [], opencode: ['run'] };
      if (!Object.hasOwn(argsByCommand, command)) throw new Error('Select a supported installed AI CLI.');
      const prompt = String(b.prompt || '').trim();
      if (!prompt || prompt.length > 32000) throw new Error('Enter a prompt of at most 32,000 characters.');
      const context = b.context ? `Selected Kubernetes context: ${shortText(b.context, 'context')}.\n` : '';
      const input = `You are helping with Kubernetes. This request comes from Rubban. Do not change any resource or execute mutations without asking the user. Do not read or print credentials or secret values.\n${context}\n${prompt}\n`;
      const result = await external(run, command, argsByCommand[command], { input, timeoutMs: 180000, maxBytes: 2 * 1024 * 1024 });
      send({ output: result.stdout || result.stderr }); return true;
    }

    if (route === '/api/extensions') {
      const directory = path.join(config.dataDir, 'extensions');
      if (method === 'GET') {
        let names = []; try { names = fs.readdirSync(directory); } catch {}
        const extensions = [];
        for (const name of names.filter(x => x.endsWith('.json'))) {
          try { extensions.push(JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))); } catch {}
        }
        send({ extensions, contract: 'rubban.declarative-resources.v1', executesCode: false }); return true;
      }
      if (method === 'POST') {
        const b = await read(); const m = b.manifest;
        if (!m || typeof m !== 'object') throw new Error('Provide a manifest object.');
        const manifest = { id: identifier(m.id, 'extension id'), name: shortText(m.name, 'extension name'), version: identifier(m.version || '1.0.0', 'version'), description: String(m.description || '').slice(0, 1000), resources: [] };
        if (!Array.isArray(m.resources) || m.resources.length > 30) throw new Error('resources must be an array with at most 30 views.');
        manifest.resources = m.resources.map(r => ({ resource: identifier(r.resource, 'resource'), title: shortText(r.title || r.resource, 'view title') }));
        fs.mkdirSync(directory, { recursive: true });
        const file = path.join(directory, manifest.id.replace(/[^a-zA-Z0-9_.-]/g, '_') + '.json');
        fs.writeFileSync(file, JSON.stringify(manifest, null, 2), { mode: 0o600 });
        send({ manifest }); return true;
      }
    }

    if (route === '/api/team' && method === 'GET') {
      send({ configured: !!teamSession, url: teamSession?.url || '', username: teamSession?.username || '' }); return true;
    }
    if (route === '/api/team/login' && method === 'POST') {
      const b = await read(); const hub = validateServiceURL(b.url);
      if (hub.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(hub.hostname)) throw new Error('Remote team hubs require HTTPS.');
      hub.pathname = '/'; hub.search = '';
      const data = await fetchJSON(new URL('api/login', hub), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: b.username, password: b.password }) });
      if (typeof data.token !== 'string' || data.token.length > 1024) throw new Error('Team hub returned an invalid session.');
      teamSession = { url: hub.href, token: data.token, username: String(b.username || '').slice(0, 128) };
      const clusters = await fetchJSON(new URL('api/clusters', hub), { headers: { Authorization: `Bearer ${data.token}` } });
      send(clusters); return true;
    }
    if (route === '/api/team/clusters' && method === 'GET') {
      if (!teamSession) { send({ clusters: [], reason: 'Sign in to your own Rubban team hub.' }); return true; }
      send(await fetchJSON(new URL('api/clusters', teamSession.url), { headers: { Authorization: `Bearer ${teamSession.token}` } })); return true;
    }
    if (route === '/api/team/query' && method === 'POST') {
      if (!teamSession) throw new Error('Sign in to your own Rubban team hub first.');
      const b = await read(); const clusterId = identifier(b.clusterId, 'cluster id');
      const query = { resource: identifier(b.resource, 'resource'), namespace: b.namespace || undefined, name: b.name || undefined };
      send(await fetchJSON(new URL(`api/clusters/${encodeURIComponent(clusterId)}/query`, teamSession.url), { method: 'POST', headers: { Authorization: `Bearer ${teamSession.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(query) })); return true;
    }
    return false;
  };
}
module.exports = { createExtras, validateServiceURL, identifier, queryArgs, resolveCommand, jsonFetch, GROUPS };
