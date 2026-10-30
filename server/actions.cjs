'use strict';

// Cluster actions and read endpoints that back Rubban's resource panels:
// node cordon/drain, eviction, CronJob trigger/suspend, rollout undo, generic patch,
// ingress-class default, service-account kubeconfig, Helm chart/release details,
// and Prometheus queries through the API server's service proxy.

const crypto = require('node:crypto');
const YAML = require('yaml');

// Runs thunks concurrently; synchronous throws (for example a missing CLI) become rejections.
const settle = thunks => Promise.allSettled(thunks.map(thunk => Promise.resolve().then(thunk)));
const PROMETHEUS_CACHE_MS = 5 * 60 * 1000;
const PROMETHEUS_CANDIDATES = [
  { pattern: /thanos.*(query|querier)(-frontend)?$/i, score: 100 },
  { pattern: /^prometheus-operated$/i, score: 90 },
  { pattern: /prometheus(-kube)?-prometheus$/i, score: 85 },
  { pattern: /^(kube-)?prometheus(-stack)?-prometheus$/i, score: 84 },
  { pattern: /^prometheus-server$/i, score: 80 },
  { pattern: /^prometheus(-k8s)?$/i, score: 78 },
  { pattern: /vmselect|victoria-metrics-single|vmsingle/i, score: 60 },
  { pattern: /prometheus/i, score: 40 },
];
const PROMETHEUS_PORTS = [9090, 10902, 9091, 8481, 8428, 80, 443];

function createActions(helpers) {
  const { problem, validateText, validateName, validateNamespace, validateResource, integer, contextArgs, namespaceArgs, parseJSONOutput, shortError } = helpers;
  const prometheusCache = new Map();

  const nameOf = (value, label) => validateName(value, label);
  const json = value => JSON.stringify(value);

  async function prometheusProvider({ live, context, preferences, refresh }) {
    const configured = preferences?.prometheusByContext?.[context];
    if (configured && configured.mode === 'off') throw problem('Prometheus is turned off for this cluster in Settings', 404);
    if (configured && configured.mode === 'service') {
      const namespace = validateNamespace(configured.namespace);
      const service = nameOf(configured.service, 'Prometheus service');
      const port = integer(configured.port, 'Prometheus port', 1, 65535);
      const prefix = String(configured.prefix || '').replace(/\/+$/, '');
      if (prefix && !/^\/[A-Za-z0-9._~\-/]*$/.test(prefix)) throw problem('Invalid Prometheus path prefix');
      return { namespace, service, port, prefix, scheme: configured.scheme === 'https' ? 'https' : 'http', source: 'settings' };
    }
    const cached = prometheusCache.get(context);
    if (!refresh && cached && Date.now() - cached.at < PROMETHEUS_CACHE_MS) {
      if (cached.error) throw cached.error;
      return cached.provider;
    }
    let provider = null;
    try {
      const services = await live.list(context, 'services', '*');
      const candidates = [];
      for (const service of services.items || []) {
        const name = service.metadata?.name || '';
        const match = PROMETHEUS_CANDIDATES.find(candidate => candidate.pattern.test(name));
        if (!match) continue;
        const ports = service.spec?.ports || [];
        const port = ports.find(p => PROMETHEUS_PORTS.includes(p.port) && /http|web|query|^$/i.test(p.name || '')) || ports.find(p => PROMETHEUS_PORTS.includes(p.port)) || ports[0];
        if (!port) continue;
        candidates.push({ score: match.score + (/monitoring|observability|prometheus|thanos/.test(service.metadata.namespace) ? 5 : 0), namespace: service.metadata.namespace, service: name, port: port.port, prefix: '', scheme: port.port === 443 ? 'https' : 'http', source: 'auto-detected' });
      }
      candidates.sort((a, b) => b.score - a.score);
      for (const candidate of candidates.slice(0, 4)) {
        try {
          const probe = await live.raw(context, `${proxyBase(candidate)}/api/v1/query?query=${encodeURIComponent('vector(1)')}`);
          if (probe?.status === 'success') { provider = candidate; break; }
        } catch { /* Try the next candidate. */ }
      }
      if (!provider) throw problem('No Prometheus or Thanos query service was found in this cluster. Set one in Settings › Metrics.', 404);
      delete provider.score;
      prometheusCache.set(context, { at: Date.now(), provider });
      return provider;
    } catch (error) {
      prometheusCache.set(context, { at: Date.now(), error });
      throw error;
    }
  }

  function proxyBase(provider) {
    return `/api/v1/namespaces/${encodeURIComponent(provider.namespace)}/services/${provider.scheme}:${encodeURIComponent(provider.service)}:${provider.port}/proxy${provider.prefix || ''}`;
  }

  async function prometheusRange({ live, body, preferences, signal }) {
    const context = validateText(body.context, 'context');
    if (!live) throw problem('Prometheus queries need the live cluster connection', 503);
    const queries = body.queries && typeof body.queries === 'object' && !Array.isArray(body.queries) ? body.queries : null;
    if (!queries || !Object.keys(queries).length || Object.keys(queries).length > 16) throw problem('Provide between 1 and 16 named queries');
    const end = body.end === undefined ? Math.floor(Date.now() / 1000) : integer(body.end, 'end', 0, 4e9);
    const start = body.start === undefined ? end - 3600 : integer(body.start, 'start', 0, 4e9);
    const step = integer(body.step, 'step', 5, 86400, 60);
    if (end <= start || (end - start) / step > 11000) throw problem('Invalid time range');
    const provider = await prometheusProvider({ live, context, preferences, refresh: body.refresh === true });
    const series = {};
    const errors = {};
    await Promise.all(Object.entries(queries).map(async ([key, query]) => {
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(key) || typeof query !== 'string' || !query.trim() || query.length > 4000) { errors[key] = 'Invalid query'; return; }
      const search = new URLSearchParams({ query, start: String(start), end: String(end), step: String(step) });
      try {
        const response = await live.raw(context, `${proxyBase(provider)}/api/v1/query_range?${search}`, { signal });
        if (response?.status !== 'success') throw new Error(response?.error || 'Prometheus query failed');
        series[key] = (response.data?.result || []).slice(0, 50).map(result => ({ metric: result.metric || {}, values: (result.values || []).map(([t, v]) => [Number(t), Number(v)]) }));
      } catch (error) { errors[key] = shortError(error); }
    }));
    return { provider, start, end, step, series, errors };
  }

  async function helmChart(query, { helm, signal }) {
    const chart = validateText(query.chart, 'chart', { max: 300 });
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(chart)) throw problem('Use a repository/chart reference');
    const version = query.version ? validateText(query.version, 'chart version', { max: 128 }) : '';
    const versionArgs = version ? [`--version=${version}`] : [];
    const [readme, values, versions] = await settle([
      () => helm(['show', 'readme', chart, ...versionArgs], { signal, maxBytes: 4 * 1024 * 1024 }),
      () => helm(['show', 'values', chart, ...versionArgs], { signal, maxBytes: 4 * 1024 * 1024 }),
      () => helm(['search', 'repo', chart, '--versions', '--output=json'], { signal }),
    ]);
    const list = versions.status === 'fulfilled' ? (parseJSONOutput(versions.value, 'Helm') || []).filter(item => item.name === chart) : [];
    return {
      chart, version: version || list[0]?.version || '',
      readme: readme.status === 'fulfilled' ? readme.value.stdout : '',
      values: values.status === 'fulfilled' ? values.value.stdout : '',
      versions: list.slice(0, 200).map(item => ({ version: item.version, appVersion: item.app_version, description: item.description })),
      warnings: [readme, values, versions].filter(r => r.status === 'rejected').map(r => shortError(r.reason)),
    };
  }

  async function helmRelease(query, { helm, signal }) {
    const context = validateText(query.context, 'context');
    const namespace = validateNamespace(query.namespace);
    const name = nameOf(query.name, 'release name');
    const base = [`--kube-context=${context}`, `--namespace=${namespace}`];
    const [values, allValues, notes, manifest, history] = await settle([
      () => helm(['get', 'values', name, ...base, '--output=yaml'], { signal }),
      () => helm(['get', 'values', name, ...base, '--all', '--output=yaml'], { signal }),
      () => helm(['get', 'notes', name, ...base], { signal, allowExitCodes: [0, 1] }),
      () => helm(['get', 'manifest', name, ...base], { signal, maxBytes: 16 * 1024 * 1024 }),
      () => helm(['history', name, ...base, '--max=50', '--output=json'], { signal }),
    ]);
    const resources = [];
    if (manifest.status === 'fulfilled') {
      for (const document of YAML.parseAllDocuments(manifest.value.stdout)) {
        try {
          const object = document.toJS({ maxAliasCount: 50 });
          if (object?.kind && object?.metadata?.name) resources.push({ apiVersion: object.apiVersion, kind: object.kind, name: object.metadata.name, namespace: object.metadata.namespace || '' });
        } catch { /* Skip unparsable documents. */ }
      }
    }
    if (history.status === 'rejected') throw history.reason;
    return {
      name, namespace,
      values: values.status === 'fulfilled' ? values.value.stdout : '',
      allValues: allValues.status === 'fulfilled' ? allValues.value.stdout : '',
      notes: notes.status === 'fulfilled' ? notes.value.stdout : '',
      resources,
      history: parseJSONOutput(history.value, 'Helm'),
    };
  }

  async function serviceAccountKubeconfig(body, { kube, signal }) {
    const context = validateText(body.context, 'context');
    const namespace = validateNamespace(body.namespace);
    const name = nameOf(body.name, 'service account');
    const hours = integer(body.hours, 'token lifetime (hours)', 1, 8760, 24);
    const [tokenResult, configResult] = await Promise.all([
      kube([...contextArgs(context), ...namespaceArgs(namespace), 'create', 'token', name, `--duration=${hours}h`], { signal }),
      kube(['config', 'view', '--raw', '--minify', '--flatten', `--context=${context}`, '--output=json'], { signal }),
    ]);
    const config = parseJSONOutput(configResult, 'kubectl');
    const cluster = config.clusters?.[0];
    if (!cluster?.cluster?.server) throw problem('Could not read the cluster endpoint for this context', 502);
    const clusterEntry = { server: cluster.cluster.server };
    if (cluster.cluster['certificate-authority-data']) clusterEntry['certificate-authority-data'] = cluster.cluster['certificate-authority-data'];
    if (cluster.cluster['insecure-skip-tls-verify']) clusterEntry['insecure-skip-tls-verify'] = true;
    if (cluster.cluster['tls-server-name']) clusterEntry['tls-server-name'] = cluster.cluster['tls-server-name'];
    const user = `${name}@${namespace}`;
    const kubeconfig = YAML.stringify({
      apiVersion: 'v1', kind: 'Config', preferences: {},
      clusters: [{ name: cluster.name, cluster: clusterEntry }],
      users: [{ name: user, user: { token: tokenResult.stdout.trim() } }],
      contexts: [{ name: `${user}-${cluster.name}`, context: { cluster: cluster.name, user, namespace } }],
      'current-context': `${user}-${cluster.name}`,
    });
    return { kubeconfig, expiresInHours: hours };
  }

  // Returns true when the request was handled.
  return async function handle({ method, route, query, body, kube, helm, live, signal, sendJSON, res, readPreferences }) {
    if (method === 'POST' && route === '/api/node') {
      const context = validateText(body.context, 'context');
      const name = nameOf(body.name, 'node');
      const action = body.action;
      let args;
      let timeoutMs = 60000;
      if (action === 'cordon' || action === 'uncordon') args = [...contextArgs(context), action, name];
      else if (action === 'drain') {
        const timeout = integer(body.timeoutSeconds, 'drain timeout', 10, 3600, 300);
        args = [...contextArgs(context), 'drain', name, `--timeout=${timeout}s`, `--ignore-daemonsets=${body.ignoreDaemonsets !== false}`, `--delete-emptydir-data=${body.deleteEmptyDirData !== false}`, `--force=${body.force === true}`];
        if (body.gracePeriodSeconds !== undefined && body.gracePeriodSeconds !== '') args.push(`--grace-period=${integer(body.gracePeriodSeconds, 'grace period', -1, 3600)}`);
        timeoutMs = (timeout + 30) * 1000;
      } else throw problem('Node actions are cordon, uncordon and drain');
      const output = await kube(args, { signal, timeoutMs });
      sendJSON(res, { output: (output.stdout + output.stderr).trim() });
      return true;
    }
    if (method === 'POST' && route === '/api/evict') {
      const context = validateText(body.context, 'context');
      const namespace = validateNamespace(body.namespace);
      const name = nameOf(body.name, 'pod');
      if (!live) throw problem('Eviction needs the live cluster connection', 503);
      await live.post(context, `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(name)}/eviction`, { apiVersion: 'policy/v1', kind: 'Eviction', metadata: { name, namespace } }, { signal });
      sendJSON(res, { output: `pod/${name} evicted` });
      return true;
    }
    if (method === 'POST' && route === '/api/cronjob') {
      const context = validateText(body.context, 'context');
      const namespace = validateNamespace(body.namespace);
      const name = nameOf(body.name, 'CronJob');
      let args;
      if (body.action === 'trigger') {
        const job = `${name.slice(0, 44)}-manual-${crypto.randomBytes(3).toString('hex')}`.replace(/\.+/g, '-');
        args = [...contextArgs(context), ...namespaceArgs(namespace), 'create', 'job', job, `--from=cronjob/${name}`];
      } else if (body.action === 'suspend' || body.action === 'resume') {
        args = [...contextArgs(context), ...namespaceArgs(namespace), 'patch', 'cronjob', name, '--type=merge', `--patch=${json({ spec: { suspend: body.action === 'suspend' } })}`];
      } else throw problem('CronJob actions are trigger, suspend and resume');
      const output = await kube(args, { signal });
      sendJSON(res, { output: (output.stdout + output.stderr).trim() });
      return true;
    }
    if (method === 'POST' && route === '/api/rollout-undo') {
      const context = validateText(body.context, 'context');
      const namespace = validateNamespace(body.namespace);
      const resource = validateResource(body.resource);
      if (!/^(deployments?|daemonsets?|statefulsets?)(\.apps)?$/.test(resource)) throw problem('Rollback supports Deployments, DaemonSets and StatefulSets');
      const name = nameOf(body.name);
      const revision = integer(body.revision, 'revision', 1, 1e9);
      const output = await kube([...contextArgs(context), ...namespaceArgs(namespace), 'rollout', 'undo', `${resource}/${name}`, `--to-revision=${revision}`], { signal });
      sendJSON(res, { output: (output.stdout + output.stderr).trim() });
      return true;
    }
    if (method === 'POST' && route === '/api/patch') {
      const context = validateText(body.context, 'context');
      const namespace = validateNamespace(body.namespace);
      const resource = validateResource(body.resource);
      const name = nameOf(body.name);
      const type = ['merge', 'strategic', 'json'].includes(body.type) ? body.type : 'merge';
      if (!body.patch || typeof body.patch !== 'object') throw problem('Patch must be a JSON object or array');
      const patch = json(body.patch);
      if (Buffer.byteLength(patch) > 1024 * 1024) throw problem('Patch is too large', 413);
      const output = await kube([...contextArgs(context), ...namespaceArgs(namespace), 'patch', resource, name, `--type=${type}`, `--patch=${patch}`], { signal });
      sendJSON(res, { output: (output.stdout + output.stderr).trim() });
      return true;
    }
    if (method === 'POST' && (route === '/api/default-class' || route === '/api/ingressclass-default')) {
      // Marks one IngressClass or StorageClass as the cluster default and clears the flag on the others.
      const context = validateText(body.context, 'context');
      const kind = route === '/api/ingressclass-default' ? 'ingressclasses' : body.kind;
      if (!['ingressclasses', 'storageclasses'].includes(kind)) throw problem('Default class applies to ingressclasses or storageclasses');
      const name = nameOf(body.name, kind === 'ingressclasses' ? 'IngressClass' : 'StorageClass');
      if (!live) throw problem('This action needs the live cluster connection', 503);
      const classes = await live.list(context, kind, '*', { signal });
      const selected = (classes.items || []).find(item => item.metadata?.name === name);
      if (!selected) throw problem(`${name} was not found`, 404);
      const key = kind === 'ingressclasses' ? 'ingressclass.kubernetes.io/is-default-class' : 'storageclass.kubernetes.io/is-default-class';
      const outputs = [];
      // Set the new default first. If that write is forbidden or fails, keep the existing default.
      // Kubernetes allows multiple defaults while the remaining annotations are cleared.
      for (const item of [selected, ...(classes.items || []).filter(item => item !== selected)]) {
        const annotations = item.metadata?.annotations || {};
        const current = annotations[key] === 'true' || (kind === 'storageclasses' && annotations['storageclass.beta.kubernetes.io/is-default-class'] === 'true');
        const wanted = item.metadata.name === name;
        if (current === wanted) continue;
        const args = [...contextArgs(context), 'annotate', kind, item.metadata.name, `${key}=${wanted}`, '--overwrite'];
        if (!wanted && annotations['storageclass.beta.kubernetes.io/is-default-class']) args.push('storageclass.beta.kubernetes.io/is-default-class-');
        const result = await kube(args, { signal });
        outputs.push(result.stdout.trim());
      }
      sendJSON(res, { output: outputs.join('\n') || `${name} is already the default` });
      return true;
    }
    if (method === 'GET' && route === '/api/secret-data') {
      // Explicit, per-request reveal of one Secret's data (lists and watches never carry values).
      const context = validateText(query.context, 'context');
      const namespace = validateNamespace(query.namespace);
      const name = nameOf(query.name, 'secret');
      const secret = live
        ? await live.raw(context, `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${encodeURIComponent(name)}`, { signal })
        : parseJSONOutput(await kube([...contextArgs(context), ...namespaceArgs(namespace), 'get', 'secret', name, '--output=json'], { signal }), 'kubectl');
      sendJSON(res, { type: secret.type || 'Opaque', data: secret.data || {}, resourceVersion: secret.metadata?.resourceVersion || '' });
      return true;
    }
    if (method === 'POST' && route === '/api/serviceaccount-kubeconfig') {
      sendJSON(res, await serviceAccountKubeconfig(body, { kube, signal }));
      return true;
    }
    if (method === 'GET' && route === '/api/helm/chart') {
      sendJSON(res, await helmChart(query, { helm, signal }));
      return true;
    }
    if (method === 'GET' && route === '/api/helm/release') {
      sendJSON(res, await helmRelease(query, { helm, signal }));
      return true;
    }
    if (method === 'POST' && route === '/api/prometheus/range') {
      sendJSON(res, await prometheusRange({ live, body, preferences: await readPreferences(), signal }));
      return true;
    }
    if (method === 'GET' && route === '/api/prometheus/provider') {
      const context = validateText(query.context, 'context');
      if (!live) { sendJSON(res, { provider: null, error: 'Prometheus history needs the live cluster connection, which is not available in this session' }); return true; }
      try { sendJSON(res, { provider: await prometheusProvider({ live, context, preferences: await readPreferences(), refresh: query.refresh === '1' }) }); }
      catch (error) { sendJSON(res, { provider: null, error: shortError(error) }); }
      return true;
    }
    return false;
  };
}

module.exports = { createActions };
