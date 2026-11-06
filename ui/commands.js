// Ctrl+K commands: a forgiving grammar for doing things ("restart storefront", "scale cart to 3",
// "pods in shop on staging"). Pure: parse the text into an intent, rank the targets the search found,
// and describe what will run. The palette (commands-palette.js) draws the preview and runs it.

// Kinds the backend search looks through by default, in its order. ReplicaSets are searched only when asked.
export const SEARCH_KINDS = ['pods', 'deployments', 'statefulsets', 'daemonsets', 'jobs', 'cronjobs', 'services', 'ingresses', 'configmaps', 'secrets', 'persistentvolumeclaims', 'namespaces', 'nodes', 'applications.argoproj.io'];
const WORKLOADS = ['deployments', 'statefulsets', 'daemonsets'];

// verb: canonical name; words: what may be typed (first is shown); kinds: what it applies to (null: any).
export const VERBS = [
  { verb: 'restart', words: ['restart', 'bounce', 'redeploy'], kinds: WORKLOADS, title: 'Restart', summary: 'Rolling restart of a workload', example: 'restart storefront' },
  { verb: 'scale', words: ['scale', 'resize'], kinds: ['deployments', 'statefulsets', 'replicasets'], title: 'Scale', summary: 'Set the replica count', example: 'scale cart to 3' },
  { verb: 'logs', words: ['logs', 'log', 'tail'], kinds: ['pods', ...WORKLOADS, 'jobs'], title: 'Logs', summary: 'Tail logs of a pod or every pod of a workload', example: 'logs orders' },
  { verb: 'shell', words: ['shell', 'exec', 'ssh', 'sh'], kinds: ['pods', ...WORKLOADS], title: 'Shell', summary: 'Open a shell in a pod (a workload’s first ready pod)', example: 'shell cart' },
  { verb: 'forward', words: ['pf', 'forward', 'port-forward', 'portforward'], kinds: ['services', 'pods', 'deployments', 'statefulsets'], title: 'Port-forward', summary: 'Forward a local port to a service or pod', example: 'pf storefront 8080:80' },
  { verb: 'describe', words: ['describe', 'open', 'show', 'inspect', 'details'], kinds: null, title: 'Open', summary: 'Open the details of a resource', example: 'describe payments-api' },
  { verb: 'yaml', words: ['yaml', 'edit'], kinds: null, title: 'Edit YAML of', summary: 'Open a resource on its YAML tab', example: 'yaml storefront' },
  { verb: 'rollback', words: ['rollback', 'undo'], kinds: WORKLOADS, title: 'Roll back', summary: 'Roll a workload back to its previous revision', example: 'rollback storefront' },
  { verb: 'delete', words: ['delete', 'del', 'rm', 'remove'], kinds: null, title: 'Delete', summary: 'Delete a resource', example: 'delete pod cart-7d9f8-x2k4q' },
  { verb: 'cordon', words: ['cordon'], kinds: ['nodes'], title: 'Cordon', summary: 'Stop scheduling new pods on a node', example: 'cordon worker-2' },
  { verb: 'uncordon', words: ['uncordon'], kinds: ['nodes'], title: 'Uncordon', summary: 'Allow scheduling on a node again', example: 'uncordon worker-2' },
  { verb: 'drain', words: ['drain'], kinds: ['nodes'], title: 'Drain', summary: 'Cordon a node and evict its pods', example: 'drain worker-2' },
  { verb: 'trigger', words: ['trigger', 'run'], kinds: ['cronjobs'], title: 'Run now', summary: 'Create a Job from a CronJob now', example: 'trigger cronjob nightly-report' },
  { verb: 'compare', words: ['compare', 'diff'], kinds: SEARCH_KINDS.filter(kind => kind !== 'secrets'), title: 'Compare', summary: 'Compare a resource with the same one in another cluster', example: 'compare storefront with staging' },
  { verb: 'go', words: ['go', 'goto', 'list', 'get', 'ls'], title: 'Open view', summary: 'Open a view, optionally in a namespace and cluster', example: 'deployments in payments on staging' },
  { verb: 'namespace', words: ['ns', 'namespace', 'in'], title: 'Namespace', summary: 'Switch this tab’s namespace (“ns all” for every namespace)', example: 'ns shop' },
  { verb: 'context', words: ['ctx', 'context', 'use', 'switch', 'cluster'], title: 'Switch cluster', summary: 'Show another cluster in this tab', example: 'switch to staging' },
  { verb: 'newtab', words: ['newtab'], title: 'New tab', summary: 'Open a cluster in a new tab', example: 'new tab staging' },
  { verb: 'theme', words: ['theme'], title: 'Theme', summary: 'Dark, light or follow the system', example: 'theme dark' },
  { verb: 'problems', words: ['problems', 'issues'], title: 'Problems', summary: 'Open the problems inbox', example: 'problems' },
  { verb: 'help', words: ['help', '?'], title: 'Help', summary: 'List the commands', example: 'help' },
];
const VERB_BY_WORD = new Map(VERBS.flatMap(spec => spec.words.map(word => [word, spec])));
export const verbSpec = verb => VERBS.find(spec => spec.verb === verb) || null;
// Verbs that act on one resource found by name.
export const TARGET_VERBS = new Set(VERBS.filter(spec => spec.kinds !== undefined).map(spec => spec.verb));

// Kind words, kubectl short names included.
export const KIND_WORDS = {
  pods: ['pod', 'pods', 'po'], deployments: ['deployment', 'deployments', 'deploy', 'deploys'], statefulsets: ['statefulset', 'statefulsets', 'sts'],
  daemonsets: ['daemonset', 'daemonsets', 'ds'], replicasets: ['replicaset', 'replicasets', 'rs'], jobs: ['job', 'jobs'], cronjobs: ['cronjob', 'cronjobs', 'cj', 'cron'],
  services: ['service', 'services', 'svc'], ingresses: ['ingress', 'ingresses', 'ing'], configmaps: ['configmap', 'configmaps', 'cm'], secrets: ['secret', 'secrets'],
  persistentvolumeclaims: ['pvc', 'pvcs', 'persistentvolumeclaim', 'persistentvolumeclaims'], namespaces: ['namespace', 'namespaces', 'ns'], nodes: ['node', 'nodes'],
  'applications.argoproj.io': ['application', 'applications', 'argoapp'],
};
const KIND_BY_WORD = new Map(Object.entries(KIND_WORDS).flatMap(([resource, words]) => words.map(word => [word, resource])));
export const kindOfWord = word => KIND_BY_WORD.get(String(word || '').toLowerCase()) || '';
// Extra view words for "go …" that are not search kinds.
const VIEW_WORDS = {
  hpa: 'horizontalpodautoscalers', pv: 'persistentvolumes', pvs: 'persistentvolumes', sc: 'storageclasses', sa: 'serviceaccounts', crd: 'customresourcedefinitions', crds: 'customresourcedefinitions',
  ep: 'endpoints', netpol: 'networkpolicies', pdb: 'poddisruptionbudgets', rc: 'replicationcontrollers', quota: 'resourcequotas', limits: 'limitranges', ns: 'namespaces',
};
const KIND_LABELS = { pods: 'Pods', deployments: 'Deployments', statefulsets: 'StatefulSets', daemonsets: 'DaemonSets', replicasets: 'ReplicaSets', jobs: 'Jobs', cronjobs: 'CronJobs', services: 'Services', ingresses: 'Ingresses', configmaps: 'ConfigMaps', secrets: 'Secrets', persistentvolumeclaims: 'PVCs', namespaces: 'Namespaces', nodes: 'Nodes', 'applications.argoproj.io': 'Argo CD applications' };
export const kindsText = (kinds, conjunction = 'and') => {
  const names = (kinds || []).map(kind => KIND_LABELS[kind] || kind);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} ${conjunction} ${names.at(-1)}` : names[0] || 'resources';
};

const FILLER = new Set(['the', 'a', 'an', 'please', 'now', 'for', 'of', 'replicas', 'replica', 'mode']);
const NS_WORDS = new Set(['in', '-n', '--namespace']);
const CONTEXT_WORDS = new Set(['on', '--context']);
const COMPARE_SEPARATORS = new Set(['with', 'to', 'against', 'and', 'vs', 'versus']);
const NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const isNumber = token => /^\d+$/.test(token);
const PORT = /^(\d{1,5})?:(\d{1,5})$|^(\d{1,5})$/;

// Two-word verbs, kubectl's spelling and a leading "kubectl" are folded into one verb word first.
function normalise(text) {
  return text.trim().replace(/\s+/g, ' ')
    .replace(/^(kubectl|k) (?=\S)/i, '')
    .replace(/^(new|open) tab\b/i, 'newtab')
    .replace(/^port forward\b/i, 'port-forward')
    .replace(/^roll back\b/i, 'rollback')
    .replace(/^rollout (restart|undo)\b/i, (_, word) => (word.toLowerCase() === 'undo' ? 'rollback' : 'restart'))
    .replace(/^go to\b/i, 'go')
    .replace(/^switch to\b/i, 'switch')
    .trim();
}

const blank = verb => ({ verb, kindHint: '', nameQuery: '', args: {}, namespace: '', context: '', errors: [] });

// parseCommand turns text into an intent { verb, kindHint, nameQuery, args, namespace, context, errors },
// or null when the text is not a command (then the palette searches views and resources as before).
export function parseCommand(input) {
  const text = normalise(String(input ?? ''));
  if (!text) return null;
  // "cart=3" is "cart = 3"; "--context=x" stays one flag.
  const tokens = text.split(' ').flatMap(token => (!token.startsWith('-') && token.includes('=') ? token.split(/(=)/).filter(Boolean) : [token]));
  const first = tokens[0].toLowerCase();
  let spec = VERB_BY_WORD.get(first);
  // "pods in shop", "deployments in payments on staging": a view word with a place is a "go".
  if (!spec && (kindOfWord(first) || VIEW_WORDS[first]) && tokens.slice(1).some(token => NS_WORDS.has(token.toLowerCase()) || CONTEXT_WORDS.has(token.toLowerCase()) || token.startsWith('@'))) {
    spec = verbSpec('go'); tokens.unshift('go');
  }
  if (!spec) return null;
  const intent = blank(spec.verb);
  const rest = [];
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]; const low = token.toLowerCase();
    if (NS_WORDS.has(low) && spec.verb !== 'namespace') {
      if (tokens[i + 1]) intent.namespace = tokens[++i].toLowerCase(); else intent.errors.push('Which namespace? e.g. … in shop');
      continue;
    }
    if (low.startsWith('--namespace=') || low.startsWith('-n=')) { intent.namespace = low.slice(low.indexOf('=') + 1); continue; }
    if (CONTEXT_WORDS.has(low)) {
      if (tokens[i + 1]) intent.context = tokens[++i]; else intent.errors.push('Which cluster? e.g. … on staging');
      continue;
    }
    if (low.startsWith('--context=')) { intent.context = token.slice(10); continue; }
    if (low.startsWith('@') && low.length > 1) { intent.context = token.slice(1); continue; }
    if (FILLER.has(low)) continue;
    rest.push(token);
  }
  if (TARGET_VERBS.has(spec.verb)) target(intent, rest);
  else other(intent, rest);
  // "show pods", "open deployments in shop": a kind without a name is its view.
  if ((intent.verb === 'describe' || intent.verb === 'yaml') && intent.kindHint && !intent.nameQuery && !intent.errors.length) Object.assign(intent, { verb: 'go', nameQuery: intent.kindHint, kindHint: '' });
  if (intent.namespace === 'all' || intent.namespace === '*') intent.namespace = '*';
  return intent;
}

// The words after a verb that names a resource: [kind] name, kind/name or namespace/name, then arguments.
function target(intent, rest) {
  const words = rest.filter(token => !(intent.verb !== 'compare' && token.toLowerCase() === 'to') && token !== '=');
  let other = [];
  if (intent.verb === 'compare') {
    const at = words.findIndex(token => COMPARE_SEPARATORS.has(token.toLowerCase()));
    if (at >= 0) { other = words.splice(at).slice(1); } else if (words.length > 1 && !kindOfWord(words[0])) other = words.splice(1);
    else if (words.length > 2) other = words.splice(2);
  }
  if (words.length > 1 && kindOfWord(words[0])) intent.kindHint = kindOfWord(words.shift());
  else if (words.length === 1 && kindOfWord(words[0]) && !words[0].includes('/')) { intent.kindHint = kindOfWord(words.shift()); }
  const name = words.findIndex(token => !(isNumber(token) || (intent.verb === 'forward' && PORT.test(token))));
  if (name >= 0) {
    let value = words.splice(name, 1)[0].toLowerCase();
    const parts = value.split('/');
    if (parts.length === 2 && kindOfWord(parts[0])) { intent.kindHint = kindOfWord(parts[0]); value = parts[1]; }
    else if (parts.length === 2) { intent.namespace = parts[0]; value = parts[1]; }
    else if (parts.length === 3 && kindOfWord(parts[0])) { intent.kindHint = kindOfWord(parts[0]); intent.namespace = parts[1]; value = parts[2]; }
    intent.nameQuery = value;
    if (value && !NAME.test(value)) intent.errors.push(`“${value}” is not a Kubernetes name.`);
  }
  if (intent.verb === 'scale') {
    const count = words.findIndex(isNumber);
    if (count >= 0) {
      const replicas = Number(words.splice(count, 1)[0]);
      if (replicas > 100000) intent.errors.push('Replicas must be between 0 and 100000.'); else intent.args.replicas = replicas;
    }
  } else if (intent.verb === 'forward') {
    const ports = words.filter(token => PORT.test(token));
    words.splice(0, words.length, ...words.filter(token => !PORT.test(token)));
    const parsed = ports.map(token => token.split(':'));
    if (parsed.length === 1 && parsed[0].length === 2) { if (parsed[0][0]) intent.args.localPort = Number(parsed[0][0]); intent.args.remotePort = Number(parsed[0][1]); }
    else if (parsed.length === 1) intent.args.port = Number(parsed[0][0]);
    else if (parsed.length === 2) { intent.args.localPort = Number(parsed[0][0]); intent.args.remotePort = Number(parsed[1][0]); }
    else if (parsed.length > 2) intent.errors.push('Give one port, or local:remote, e.g. pf storefront 8080:80');
    for (const port of [intent.args.port, intent.args.localPort, intent.args.remotePort]) if (port !== undefined && (port < 1 || port > 65535)) intent.errors.push(`Port ${port} is out of range (1–65535).`);
  } else if (intent.verb === 'rollback') {
    const words2 = words.filter(token => token.toLowerCase() !== 'revision');
    words.splice(0, words.length, ...words2);
    const at = words.findIndex(isNumber);
    if (at >= 0) intent.args.revision = Number(words.splice(at, 1)[0]);
  }
  if (intent.verb === 'compare') {
    intent.args.with = other.filter(token => !FILLER.has(token.toLowerCase())).join(' ');
    if (intent.nameQuery && !intent.args.with) intent.errors.push('Compare with which cluster? e.g. compare storefront with staging');
  }
  if (words.length === 1 && !intent.kindHint && kindOfWord(words[0])) intent.kindHint = kindOfWord(words.shift());
  if (words.length) intent.errors.push(`Did not understand “${words.join(' ')}”.`);
}

const THEME_WORDS = { dark: 'dark', light: 'light', system: 'system', auto: 'system', os: 'system' };
function other(intent, rest) {
  const words = rest.filter(token => token.toLowerCase() !== 'to' && token !== '=');
  const joined = words.join(' ');
  switch (intent.verb) {
    case 'namespace': {
      if (/^all( namespaces)?$|^\*$/i.test(joined)) intent.namespace = '*';
      else if (words.length === 1) { intent.namespace = words[0].toLowerCase(); if (!NAME.test(intent.namespace)) intent.errors.push(`“${words[0]}” is not a namespace name.`); }
      else if (words.length > 1) intent.errors.push(`Did not understand “${joined}”.`);
      break;
    }
    case 'context': case 'newtab': if (joined) intent.context = joined; break;
    case 'theme': {
      if (!words.length) break;
      const theme = THEME_WORDS[words[0].toLowerCase()];
      if (theme && words.length === 1) intent.args.theme = theme; else intent.errors.push('Theme is dark, light or system.');
      break;
    }
    case 'go': intent.nameQuery = joined.toLowerCase(); break;
    case 'help': if (joined) intent.args.topic = joined.toLowerCase(); break;
    default: if (joined) intent.errors.push(`Did not understand “${joined}”.`);
  }
}

// Verb completion for a partly typed first word: the commands whose words start with it.
export function suggestVerbs(input, limit = 4) {
  const text = String(input ?? '').trimStart().toLowerCase();
  if (!text || /\s/.test(text)) return [];
  if (VERB_BY_WORD.has(text) && text !== '?') return [];
  const out = [];
  for (const spec of VERBS) {
    const word = spec.words.find(item => item.startsWith(text) && item !== '?');
    if (word) out.push({ verb: spec.verb, word, completion: `${word === 'newtab' ? 'new tab' : word} `, title: spec.title, summary: spec.summary, example: spec.example, canonical: spec.words[0] === word });
  }
  return out.sort((a, b) => Number(b.canonical) - Number(a.canonical) || a.word.length - b.word.length).slice(0, limit);
}

// The commands for help, all or those about one topic ("help scale").
export function helpFor(topic = '') {
  const needle = topic.trim().toLowerCase();
  return VERBS.filter(spec => !needle || spec.verb.startsWith(needle) || spec.words.some(word => word.startsWith(needle)) || spec.summary.toLowerCase().includes(needle))
    .map(spec => ({ verb: spec.verb, title: spec.title, summary: spec.summary, example: spec.example, words: spec.words.filter(word => word !== '?' && word !== 'newtab').concat(spec.verb === 'newtab' ? ['new tab'] : []) }));
}

// The kinds a verb looks through, narrowed by a kind word. An error when the kind does not fit the verb.
export function targetKinds(intent) {
  const spec = verbSpec(intent.verb);
  const kinds = spec?.kinds ?? null;
  if (!intent.kindHint) return { kinds };
  if (kinds && !kinds.includes(intent.kindHint)) return { kinds: [], error: `${spec.title} works on ${kindsText(kinds)}, not ${KIND_LABELS[intent.kindHint] || intent.kindHint}.` };
  return { kinds: [intent.kindHint] };
}

// rankTargets orders what the search found in each cluster: exact names first (the tab's cluster, then the
// tab's namespace, then the verb's preferred kind), then the other matches in search order.
// answers: [{ context, results }] in the order the clusters were asked.
export function rankTargets(intent, answers, { tabContext = '', tabNamespace = '*', limit = 6 } = {}) {
  const query = String(intent.nameQuery || '').toLowerCase();
  const { kinds } = targetKinds(intent);
  const found = [];
  (answers || []).forEach((answer, clusterIndex) => (answer?.results || []).forEach((result, index) => {
    if (kinds && !kinds.includes(result.resource)) return;
    if (intent.namespace && intent.namespace !== '*' && result.namespace !== intent.namespace) return;
    found.push({ ...result, context: answer.context, exact: String(result.name).toLowerCase() === query, clusterIndex, index });
  }));
  const kindIndex = result => (kinds ? kinds.indexOf(result.resource) : 0);
  found.sort((a, b) => Number(b.exact) - Number(a.exact)
    || Number(b.context === tabContext) - Number(a.context === tabContext)
    || (a.exact ? Number(b.namespace === tabNamespace) - Number(a.namespace === tabNamespace) || kindIndex(a) - kindIndex(b) : 0)
    || a.clusterIndex - b.clusterIndex || a.index - b.index);
  const exact = found.filter(result => result.exact);
  return { best: exact[0] || null, exact, targets: found.slice(0, Math.max(limit, Math.min(exact.length, limit * 2))).map(({ clusterIndex, index, ...rest }) => rest) };
}

const score = (text, query) => {
  const value = String(text || '').toLowerCase();
  if (!value) return -1;
  if (value === query) return 0;
  if (value.startsWith(query)) return 1;
  if (value.split(/[-_. /]/).some(part => part.startsWith(query))) return 2;
  return value.includes(query) ? 3 : -1;
};
// Small typos ("stagnig", "shpo"): Levenshtein distance, capped.
export function distance(a, b, cap = 3) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = row;
  }
  return previous[b.length];
}
function bestMatches(query, entries, texts) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return entries.slice();
  const near = text => { const value = String(text || '').toLowerCase(); return needle.length >= 4 && [value.slice(0, needle.length), ...value.split(/[-_. /]/)].some(part => distance(part, needle, 2) <= 2); };
  const scored = entries.map(entry => ({ entry, rank: Math.min(...texts(entry).map(text => { const s = score(text, needle); return s >= 0 ? s : near(text) ? 4 : 99; })) })).filter(item => item.rank < 99);
  return scored.sort((a, b) => a.rank - b.rank).map(item => item.entry);
}
// Clusters by kubeconfig name or display label. contexts: [{ name, label }].
export const matchContexts = (query, contexts) => bestMatches(query, contexts || [], context => [context.name, context.label]).map(context => context.name);
export const matchNamespaces = (query, names) => bestMatches(query, names || [], name => [name]);

// Views for "go …": a kind word picks its view; otherwise titles match. views: [{ title, tabTitle, section, resource }].
export function matchViews(query, views) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return [];
  const resource = kindOfWord(needle) || VIEW_WORDS[needle] || ((views || []).some(view => view.resource === needle) ? needle : '');
  const byResource = resource ? (views || []).filter(view => view.resource === resource) : [];
  const bySection = (views || []).filter(view => !view.resource && view.section === needle);
  const byTitle = bestMatches(needle, (views || []).filter(view => !byResource.includes(view) && !bySection.includes(view)), view => [view.title, view.tabTitle, view.resource]);
  return [...byResource, ...bySection, ...byTitle];
}

// Revisions: the newest one older than the current. revisions: numbers; current: number.
export function previousRevision(revisions, current) {
  const older = (revisions || []).map(Number).filter(revision => Number.isFinite(revision) && revision > 0 && revision < current);
  return older.length ? Math.max(...older) : null;
}

// Ports for the forward dialog. A single port the target exposes is used on both sides; otherwise it is
// the local port and the target's first port is the remote one. ports: [{ port }].
export function forwardPreset(args = {}, ports = []) {
  const known = ports.map(item => Number(item.port)).filter(Boolean);
  if (args.remotePort) return { port: args.remotePort, localPort: args.localPort || '' };
  if (args.port && known.includes(args.port)) return { port: args.port, localPort: args.port };
  if (args.port) return { port: known[0] || args.port, localPort: args.port };
  return { port: known[0] || undefined, localPort: '' };
}

// The pod a workload command uses: the first ready, running pod that is not being deleted.
export function pickPod(pods) {
  const ready = pod => (pod.status?.conditions || []).some(condition => condition.type === 'Ready' && condition.status === 'True');
  const live = (pods || []).filter(pod => pod.status?.phase === 'Running' && !pod.metadata?.deletionTimestamp);
  return live.find(ready) || null;
}
// The container a shell opens: the annotated default, else the first that is not a mesh sidecar.
export function defaultContainer(pod) {
  const names = (pod?.spec?.containers || []).map(container => container.name);
  const annotated = pod?.metadata?.annotations?.['kubectl.kubernetes.io/default-container'];
  return names.includes(annotated) ? annotated : names.find(name => !/^(istio-proxy|linkerd-proxy|vault-agent)/.test(name)) || names[0] || '';
}

export const isDestructive = intent => intent.verb === 'delete' || intent.verb === 'drain' || (intent.verb === 'scale' && intent.args.replicas === 0);

// What a target command will do, as the row says it: "Restart Deployment shop/storefront".
export function describeCommand(intent, target) {
  const where = `${target.kind || target.resource} ${target.namespace ? `${target.namespace}/` : ''}${target.name}`;
  const args = intent.args || {};
  switch (intent.verb) {
    case 'scale': return args.replicas === undefined ? `Scale ${where}…` : `Scale ${where} to ${args.replicas}`;
    case 'logs': return `Logs of ${where}`;
    case 'shell': return target.resource === 'pods' ? `Shell into ${where}` : `Shell into ${where} (first ready pod)`;
    case 'forward': {
      const ports = args.remotePort ? `${args.localPort || 'any'} → ${args.remotePort}` : args.port ? `port ${args.port}` : '';
      return `Port-forward ${where}${ports ? ` · ${ports}` : '…'}`;
    }
    case 'describe': return `Open ${where}`;
    case 'yaml': return `Edit YAML of ${where}`;
    case 'rollback': return `Roll back ${where} to ${args.revision ? `revision ${args.revision}` : 'the previous revision'}`;
    case 'delete': return `Delete ${where}`;
    case 'drain': return `Drain ${where}…`;
    case 'trigger': return `Run ${where} now`;
    case 'compare': return `Compare ${where}`;
    default: return `${verbSpec(intent.verb)?.title || intent.verb} ${where}`;
  }
}

// Recent commands, newest first, without repeats.
export const RECENT_MAX = 20;
export function remember(list, text, max = RECENT_MAX) {
  const value = String(text || '').trim();
  const items = Array.isArray(list) ? list.filter(item => typeof item === 'string' && item.trim()) : [];
  if (!value) return items.slice(0, max);
  return [value, ...items.filter(item => item !== value)].slice(0, max);
}
