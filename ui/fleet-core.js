// Fleet matrix: the pure part. Turns the workloads, Helm releases and Argo CD applications listed
// in several clusters into rows keyed by kind/namespace/name, one cell per cluster, and classifies
// each row: the same everywhere ("sync"), running different images ("drift"), absent from some
// clusters ("missing") or only scaled differently ("scale"). No DOM here; fleet.js draws it.

export const WORKLOAD_KINDS = [
  { resource: 'deployments', kind: 'Deployment' },
  { resource: 'statefulsets', kind: 'StatefulSet' },
  { resource: 'daemonsets', kind: 'DaemonSet' },
  { resource: 'cronjobs', kind: 'CronJob' },
];
export const ARGO_RESOURCE = 'applications.argoproj.io';
export const STATUS_ORDER = { drift: 0, missing: 1, scale: 2, sync: 3 };
export const STATUS_LABEL = { drift: 'drift', missing: 'missing', scale: 'scale differs', sync: 'in sync' };

export const rowKey = (kind, namespace, name) => `${kind}/${namespace || ''}/${name}`;

// ---- Image references ---------------------------------------------------------------------------
// [registry[:port]/]path[:tag][@algorithm:digest]. The first path component is a registry only when
// more components follow and it looks like a host (has a dot or a port, or is localhost), the same
// rule the container runtimes use, so "registry:5000/app:1" and "localhost/app" parse right.
export function parseImage(reference) {
  const raw = String(reference || '').trim();
  let rest = raw; let digest = '';
  const at = rest.indexOf('@');
  if (at >= 0) { digest = rest.slice(at + 1); rest = rest.slice(0, at); }
  let tag = '';
  const colon = rest.lastIndexOf(':');
  if (colon > rest.lastIndexOf('/')) { tag = rest.slice(colon + 1); rest = rest.slice(0, colon); }
  let registry = '';
  const slash = rest.indexOf('/');
  if (slash > 0) {
    const first = rest.slice(0, slash);
    if (first.includes('.') || first.includes(':') || first === 'localhost') { registry = first; rest = rest.slice(slash + 1); }
  }
  const path = rest;
  // Docker Hub is the default registry and "library/" its default organisation.
  const canonical = `${!registry || registry === 'docker.io' || registry === 'index.docker.io' || registry === 'registry-1.docker.io' ? (path.includes('/') ? path : `library/${path}`) : path}`;
  return { raw, registry, path, name: path.split('/').pop() || path, tag, digest, canonical };
}

const shortDigest = digest => { const hex = digest.includes(':') ? digest.slice(digest.indexOf(':') + 1) : digest; return hex.slice(0, 7); };
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
// What a cell shows for an image: the tag, a short digest, or both; "latest" when neither is set.
export function shortImage(reference) {
  const image = typeof reference === 'string' ? parseImage(reference) : reference;
  if (image.tag && image.digest) return `${clip(image.tag, 20)}@${shortDigest(image.digest)}`;
  if (image.digest) return `@${shortDigest(image.digest)}`;
  return clip(image.tag || 'latest', 24);
}
// What two clusters must agree on to run "the same image": the repository (without the registry
// host, so regional mirrors match), the tag and the digest. An unset tag means latest.
export const imageIdentity = image => `${image.canonical}:${image.tag || (image.digest ? '' : 'latest')}${image.digest ? `@${image.digest}` : ''}`;

// ---- Cells ----------------------------------------------------------------------------------------
const podSpecOf = (kind, item) => (kind === 'CronJob' ? item?.spec?.jobTemplate?.spec?.template?.spec : item?.spec?.template?.spec) || {};
const num = value => (Number.isFinite(Number(value)) ? Number(value) : 0);
function replicaHealth(desired, ready, updated, stalled) {
  if (stalled) return 'bad';
  if (desired === 0) return 'idle';
  if (ready >= desired) return updated !== undefined && updated < desired ? 'warn' : 'good';
  return ready === 0 ? 'bad' : 'warn';
}
export function workloadCell(kind, item) {
  const meta = item?.metadata || {};
  const images = (podSpecOf(kind, item).containers || []).map(container => ({ container: container.name || '', ...parseImage(container.image) }));
  const status = item?.status || {};
  const cell = { kind, namespace: meta.namespace || '', name: meta.name || '', images, versionKey: images.map(image => `${image.container}=${imageIdentity(image)}`).sort().join(' ') };
  if (kind === 'CronJob') {
    const suspended = Boolean(item?.spec?.suspend);
    const active = (status.active || []).length;
    const lastScheduled = Date.parse(status.lastScheduleTime || '');
    const lastSucceeded = Date.parse(status.lastSuccessfulTime || '');
    const failing = !active && Number.isFinite(lastScheduled) && (!Number.isFinite(lastSucceeded) || lastSucceeded < lastScheduled);
    return { ...cell, desired: null, ready: null, replicas: suspended ? 'suspended' : active ? `${active} running` : item?.spec?.schedule || '', health: suspended ? 'idle' : failing ? 'warn' : 'good', scaleKey: `${item?.spec?.schedule || ''}|${suspended}` };
  }
  let desired; let ready; let updated; let stalled = false;
  if (kind === 'DaemonSet') { desired = num(status.desiredNumberScheduled); ready = num(status.numberReady); updated = status.updatedNumberScheduled === undefined ? undefined : num(status.updatedNumberScheduled); }
  else {
    desired = item?.spec?.replicas === undefined ? 1 : num(item.spec.replicas);
    ready = num(status.readyReplicas); updated = status.updatedReplicas === undefined ? undefined : num(status.updatedReplicas);
    stalled = (status.conditions || []).some(condition => condition.type === 'Progressing' && condition.reason === 'ProgressDeadlineExceeded');
  }
  return { ...cell, desired, ready, replicas: `${ready}/${desired}`, health: replicaHealth(desired, ready, updated, stalled), scaleKey: String(desired) };
}

// "shop-search-1.3.0" → shop-search, 1.3.0. The version is the shortest semver-like suffix, so
// chart names with digits or dashes ("my-chart-2-1.0.0", "app-1.0.0-rc-1") split right.
export function splitChart(chart) {
  const match = /^(.+?)-(v?\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.+-]*)?)$/.exec(String(chart || ''));
  return match ? { chart: match[1], version: match[2] } : { chart: String(chart || ''), version: '' };
}
const HELM_HEALTH = { deployed: 'good', failed: 'bad', superseded: 'idle', uninstalled: 'idle', uninstalling: 'warn' };
export function helmCell(release) {
  const { chart, version } = splitChart(release?.chart);
  const appVersion = release?.app_version || release?.appVersion || '';
  const status = String(release?.status || '');
  return {
    kind: 'HelmRelease', namespace: release?.namespace || '', name: release?.name || '', release,
    chart, chartVersion: version, appVersion, revision: String(release?.revision ?? ''), status,
    health: HELM_HEALTH[status] || (status.startsWith('pending') ? 'warn' : 'idle'),
    versionKey: `${chart}@${version}|${appVersion}`, scaleKey: String(release?.revision ?? ''),
  };
}
const ARGO_HEALTH = { Healthy: 'good', Progressing: 'warn', Degraded: 'bad', Missing: 'bad', Suspended: 'idle', Unknown: 'idle' };
export function argoCell(app) {
  const meta = app?.metadata || {};
  const sync = app?.status?.sync?.status || 'Unknown';
  const health = app?.status?.health?.status || 'Unknown';
  const revision = String(app?.status?.sync?.revision || app?.status?.sync?.revisions?.[0] || '');
  const source = app?.spec?.source || app?.spec?.sources?.[0] || {};
  return {
    kind: 'Application', namespace: meta.namespace || '', name: meta.name || '',
    sync, healthStatus: health, revision, shortRevision: /^[0-9a-f]{12,}$/i.test(revision) ? revision.slice(0, 7) : clip(revision, 16), targetRevision: source.targetRevision || '',
    health: sync === 'OutOfSync' && health === 'Healthy' ? 'warn' : ARGO_HEALTH[health] || 'idle',
    // OutOfSync means the cluster is not running what git says, so it counts as running something else.
    versionKey: `${revision}|${sync}`, scaleKey: health,
  };
}

// ---- Rows and classification ----------------------------------------------------------------------
// Groups cell keys and returns the indexes that disagree with the majority; on a tie every present
// cell is marked, since there is no majority to be "right".
function outliers(cells, keyOf) {
  const groups = new Map();
  cells.forEach((cell, index) => { if (cell) { const key = keyOf(cell); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(index); } });
  if (groups.size < 2) return [];
  const sizes = [...groups.values()].map(list => list.length).sort((a, b) => b - a);
  if (sizes[0] === sizes[1]) return [...groups.values()].flat().sort((a, b) => a - b);
  const majority = [...groups.values()].find(list => list.length === sizes[0]);
  return [...groups.values()].filter(list => list !== majority).flat().sort((a, b) => a - b);
}
// cells: one entry per column — a cell, null when the object is absent there, undefined when that
// cluster could not be read (unknown is neither the same nor missing).
export function classify(cells) {
  const present = cells.filter(Boolean);
  const drifted = outliers(cells, cell => cell.versionKey);
  const scaled = outliers(cells, cell => cell.scaleKey ?? '');
  const missing = present.length > 0 && cells.some(cell => cell === null);
  const status = drifted.length ? 'drift' : missing ? 'missing' : scaled.length ? 'scale' : 'sync';
  return { status, drift: drifted.length > 0, missing, scale: scaled.length > 0, drifted, scaled };
}

// sources: { [context]: { cells: [cell], unknown: Set(kind) | true } } — `unknown: true` when the
// whole cluster failed, or the kinds that could not be listed there.
export function buildRows(contexts, sources) {
  const rows = new Map();
  contexts.forEach(context => {
    for (const cell of sources[context]?.cells || []) {
      const key = rowKey(cell.kind, cell.namespace, cell.name);
      if (!rows.has(key)) rows.set(key, { key, kind: cell.kind, namespace: cell.namespace, name: cell.name });
    }
  });
  const index = new Map(contexts.map(context => [context, new Map((sources[context]?.cells || []).map(cell => [rowKey(cell.kind, cell.namespace, cell.name), cell]))]));
  return [...rows.values()].map(row => {
    const cells = contexts.map(context => {
      const source = sources[context];
      const found = index.get(context).get(row.key);
      if (found) return found;
      if (!source || source.unknown === true || source.unknown?.has?.(row.kind)) return undefined;
      return null;
    });
    return { ...row, cells, ...classify(cells), text: `${row.kind} ${row.namespace}/${row.name} ${cells.filter(Boolean).flatMap(cell => (cell.images || []).map(image => image.raw).concat(cell.chart ? [`${cell.chart} ${cell.chartVersion} ${cell.appVersion}`] : [], cell.revision ? [cell.revision] : [])).join(' ')}`.toLowerCase() };
  });
}

export function summarize(rows, contexts) {
  const count = status => rows.filter(row => row.status === status).length;
  const pairs = [];
  for (let a = 0; a < contexts.length; a++) {
    for (let b = a + 1; b < contexts.length; b++) {
      const pair = { left: contexts[a], right: contexts[b], same: 0, drift: 0, scale: 0, onlyLeft: 0, onlyRight: 0 };
      for (const row of rows) {
        const left = row.cells[a]; const right = row.cells[b];
        if (left === undefined || right === undefined) continue;
        if (left && right) {
          if (left.versionKey !== right.versionKey) pair.drift++;
          else if ((left.scaleKey ?? '') !== (right.scaleKey ?? '')) pair.scale++;
          else pair.same++;
        } else if (left) pair.onlyLeft++;
        else if (right) pair.onlyRight++;
      }
      pairs.push(pair);
    }
  }
  return { total: rows.length, sync: count('sync'), drift: count('drift'), missing: count('missing'), scale: count('scale'), pairs };
}

export function filterRows(rows, { text = '', namespace = '', kind = '', onlyDiff = false, status = '' } = {}) {
  const words = String(text).toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter(row => (!namespace || row.namespace === namespace)
    && (!kind || row.kind === kind)
    && (!onlyDiff || row.status !== 'sync')
    && (!status || row.status === status)
    && words.every(word => row.text.includes(word)));
}
const byName = (a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind);
export function sortRows(rows, mode = 'name') {
  return [...rows].sort(mode === 'drift' ? (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || byName(a, b) : byName);
}

// The two clusters "Compare…" opens: the first present cell and the first one that runs something
// else (else is scaled differently); for a row that is the same everywhere, the first two present.
export function comparePair(row) {
  const present = row.cells.map((cell, index) => (cell ? index : -1)).filter(index => index >= 0);
  if (present.length < 2) return null;
  const first = row.cells[present[0]];
  const other = present.find(index => row.cells[index].versionKey !== first.versionKey)
    ?? present.find(index => (row.cells[index].scaleKey ?? '') !== (first.scaleKey ?? ''))
    ?? present[1];
  return [present[0], other];
}

// Columns: the clusters the user picked, else every cluster with a tab open, in tab order; only
// contexts that still exist in the kubeconfig.
export function fleetColumns(picked, tabContexts, available) {
  const known = new Set(available);
  const list = Array.isArray(picked) ? picked : tabContexts;
  return [...new Set(list.filter(name => typeof name === 'string' && name && known.has(name)))];
}
