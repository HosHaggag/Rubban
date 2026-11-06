// Incident snapshot dialog: collects everything about a pod, workload or namespace in parallel (each
// part with its own timeout, failures noted rather than fatal), shows the redacted Markdown report,
// and copies, saves or sends it to the configured AI CLI. The report itself is built in snapshot-core.js.
import { state, hooks, el, button, get, post, toast, modal, download } from './kit.js';
import { renderMarkdown } from './markdown.js';
import { labelFor, envFor } from './clusterui.js';
import { resourceForKind } from './kinds.js';
import { buildSnapshot, snapshotMarkdown, aiPrompt, splitDetails, snapshotFileName, logTargets, podsOf, redactionTotal, kindOf, SNAPSHOT_RESOURCES, MASK } from './snapshot-core.js';

const STEP_TIMEOUT = 20000;
const LOG_TIMEOUT = 25000;
const LOG_CONCURRENCY = 4;
const OPTIONS_KEY = 'rubban.snapshot.options';
const LOG_LINE_CHOICES = [50, 100, 200, 500];

export const canSnapshot = resource => SNAPSHOT_RESOURCES.has(resource);

function readOptions() {
  try {
    const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) || '{}');
    return { logLines: LOG_LINE_CHOICES.includes(saved.logLines) ? saved.logLines : 100, previous: saved.previous !== false, yaml: saved.yaml !== false };
  } catch { return { logLines: 100, previous: true, yaml: true }; }
}
function saveOptions(options) { try { localStorage.setItem(OPTIONS_KEY, JSON.stringify(options)); } catch { /* Per-viewer convenience only. */ } }

// ---- Entry points -------------------------------------------------------------------------------
export function snapshotButton(selected) {
  const node = button([el('span', { class: 'btn-icon', text: '▣' }), 'Snapshot'], () => openSnapshot({ context: selected.context, namespace: selected.namespace || selected.item?.metadata?.namespace || '', resource: selected.resource, name: selected.name || selected.item?.metadata?.name }), 'compact');
  node.title = 'Collect status, events, logs and diagnosis into one redacted report to share';
  return node;
}

const PROBLEM_TARGETS = new Set(['pods', 'deployments', 'statefulsets', 'daemonsets', 'jobs', 'persistentvolumeclaims']);
export const canSnapshotProblem = problem => PROBLEM_TARGETS.has(problem.resource) && Boolean(problem.namespace);
// A problem row: one pod, the workload behind a group of pods, a workload, or the namespace of a volume claim.
export function snapshotProblem(problem) {
  const base = { context: problem.context, namespace: problem.namespace };
  if (problem.resource === 'persistentvolumeclaims') return openSnapshot({ ...base, resource: 'namespaces', name: problem.namespace });
  if (problem.resource === 'pods' && (problem.members?.length || 1) > 1) return openSnapshot({ ...base, resource: 'pods', name: problem.members[0].name, preferOwner: true, label: problem.owner });
  return openSnapshot({ ...base, resource: problem.resource, name: problem.name });
}

// The Ctrl+K entry: "Snapshot namespace <current namespace>".
export function snapshotCommand(needle, { icon, close }) {
  // "sna…", "snapshot …", "inc…", "incident …": never on what someone types to reach another view.
  if (!needle || needle.length < 3 || !(/^(snapshot|incident)/.test(needle) || 'snapshot'.startsWith(needle) || 'incident'.startsWith(needle))) return null;
  if (!state.context) return null;
  const namespace = state.namespace && state.namespace !== '*' ? state.namespace : '';
  return button([icon('alert', 'command-svg'), el('span', { text: namespace ? `Snapshot namespace ${namespace}` : 'Snapshot a namespace…' }), el('small', { text: 'Incident report' })], () => { close(); openSnapshot({ context: state.context, namespace, resource: 'namespaces', name: namespace }); }, 'command-option');
}

// ---- Collection ---------------------------------------------------------------------------------
const signalFor = (signal, ms) => AbortSignal.any([signal, AbortSignal.timeout(ms)]);
const errorText = error => (error?.name === 'TimeoutError' ? 'timed out' : error?.status === 403 ? `not allowed (${error.message})` : error?.message || String(error));
const CONTROLLERS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'ReplicaSet']);

function createCollector(target, signal, onStep) {
  const steps = new Map();
  const notes = [];
  const fetchJSON = (path, query, ms = STEP_TIMEOUT) => get(path, { context: target.context, ...query }, { signal: signalFor(signal, ms) });
  async function step(id, label, fn, { optional = true } = {}) {
    const entry = { id, label, status: 'running', note: '', started: performance.now() };
    steps.set(id, entry); onStep([...steps.values()]);
    try {
      const note = await fn();
      entry.status = 'done'; entry.note = note || '';
    } catch (error) {
      if (signal.aborted) throw error;
      entry.status = 'failed'; entry.note = errorText(error);
      notes.push({ step: label, message: entry.note });
      if (!optional) { onStep([...steps.values()]); throw error; }
    }
    entry.ms = performance.now() - entry.started;
    onStep([...steps.values()]);
  }
  return { steps, notes, step, fetchJSON, signal };
}

async function ownerChain(object, fetchJSON) {
  const owners = [];
  let current = object;
  for (let depth = 0; depth < 4; depth++) {
    const ref = (current.metadata?.ownerReferences || []).find(item => item.controller) || current.metadata?.ownerReferences?.[0];
    if (!ref) break;
    try {
      const owner = await fetchJSON('/api/resource', { namespace: object.metadata?.namespace || '', resource: resourceForKind(ref.kind, ref.apiVersion), name: ref.name });
      owners.push({ kind: ref.kind, ...owner });
      current = owner;
    } catch (error) {
      owners.push({ kind: ref.kind, metadata: { name: ref.name, uid: ref.uid } });
      if (error?.status === 404) break;
      throw Object.assign(error, { partial: owners });
    }
  }
  return owners;
}

async function collectLogs(raw, options, collector) {
  const { targets, chosen, skipped } = logTargets(raw.pods || [], { maxPods: raw.target.resource === 'pods' ? 1 : raw.target.resource === 'namespaces' ? 6 : 4, previous: options.previous, onlyUnhealthy: raw.target.resource === 'namespaces' });
  raw.logPods = raw.target.resource === 'pods' ? null : { chosen, skipped };
  raw.logs = [];
  if (!targets.length) return raw.target.resource === 'namespaces' ? 'no unhealthy pods' : 'no containers';
  const queue = [...targets];
  let failed = 0;
  const worker = async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        const answer = await collector.fetchJSON('/api/logs/tail', { namespace: raw.target.namespace, pod: item.pod, container: item.container, tail: options.logLines, previous: item.previous ? 'true' : 'false' }, LOG_TIMEOUT);
        raw.logs.push({ ...item, text: answer.text || '', unavailable: answer.unavailable || '', truncated: answer.truncated });
      } catch (error) {
        if (collector.signal.aborted) throw error;
        failed++;
        raw.logs.push({ ...item, text: '', error: errorText(error) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOG_CONCURRENCY, targets.length) }, worker));
  const order = new Map(targets.map((item, index) => [`${item.pod}/${item.container}/${item.previous}`, index]));
  raw.logs.sort((a, b) => order.get(`${a.pod}/${a.container}/${a.previous}`) - order.get(`${b.pod}/${b.container}/${b.previous}`));
  const note = `${targets.length} log${targets.length === 1 ? '' : 's'} from ${chosen.length} pod${chosen.length === 1 ? '' : 's'}`;
  if (failed === targets.length) throw new Error(raw.logs[0]?.error || 'could not read logs');
  if (failed) collector.notes.push({ step: 'Logs', message: `${failed} of ${targets.length} could not be read` });
  return note;
}

async function collect(target, options, signal, onStep) {
  const collector = createCollector(target, signal, onStep);
  const { step, fetchJSON, notes } = collector;
  const ns = target.namespace;
  const raw = { target: { ...target }, cluster: { label: labelFor(target.context) || target.context, env: envFor(target.context) }, version: state.health?.version || '', options, notes };
  const resource = target.resource;

  // 1. The object itself (for a group of pods from the Problems page: the workload that owns them).
  await step('object', resource === 'namespaces' ? `Namespace ${target.name}` : `${kindOf(resource)} ${target.name}`, async () => {
    if (resource === 'namespaces') { raw.object = { kind: 'Namespace', metadata: { name: target.name } }; return ''; }
    raw.object = await fetchJSON('/api/resource', { namespace: ns, resource, name: target.name });
    raw.object.kind ||= kindOf(resource);
    return '';
  }, { optional: false });

  // 2. Owners, pods, events and related objects, in parallel.
  const owners = () => step('owners', 'Owner chain', async () => {
    if (resource === 'namespaces') return 'not applicable';
    try { raw.owners = await ownerChain(raw.object, fetchJSON); } catch (error) { raw.owners = error.partial || []; throw error; }
    if (target.preferOwner) {
      const top = [...raw.owners].reverse().find(owner => CONTROLLERS.has(owner.kind) && owner.kind !== 'ReplicaSet') || raw.owners.find(owner => CONTROLLERS.has(owner.kind));
      if (top?.metadata?.uid) {
        // The report is about the workload behind the pods.
        const chainBelow = raw.owners.slice(raw.owners.indexOf(top) + 1);
        raw.target = { ...raw.target, resource: resourceForKind(top.kind), name: top.metadata.name };
        raw.object = top; raw.owners = chainBelow;
      }
    }
    return raw.owners.length ? raw.owners.map(owner => owner.kind).reverse().join(' → ') : 'none';
  });
  const finalResource = () => raw.target.resource;
  // A group of pods is reported as its workload, so the owners decide what to collect next.
  if (target.preferOwner) await owners();

  await Promise.all([
    target.preferOwner ? null : owners(),
    step('pods', 'Pods', async () => {
      const kind = finalResource();
      if (kind === 'pods') { raw.pods = [raw.object]; return '1 pod'; }
      const all = (await fetchJSON('/api/resources', { resource: 'pods', namespace: ns })).items || [];
      raw.intermediates = [];
      if (kind === 'deployments' || kind === 'cronjobs') {
        const middle = kind === 'deployments' ? 'replicasets' : 'jobs';
        const items = (await fetchJSON('/api/resources', { resource: middle, namespace: ns })).items || [];
        raw.intermediates = items.filter(item => (item.metadata?.ownerReferences || []).some(ref => ref.uid === raw.object.metadata?.uid));
      }
      raw.pods = podsOf(raw.object, kind, all, raw.intermediates);
      return `${raw.pods.length} pod${raw.pods.length === 1 ? '' : 's'}`;
    }),
    step('events', 'Events', async () => {
      raw.events = (await fetchJSON('/api/events', { namespace: ns })).items || [];
      return `${raw.events.length} in the namespace`;
    }),
    step('related', 'Services, ConfigMaps, Secrets', async () => {
      const kinds = [['services', 'services'], ['configmaps', 'configmaps'], ['secrets', 'secrets'], ['ingresses', 'ingresses'], ['hpas', 'horizontalpodautoscalers']];
      const answers = await Promise.allSettled(kinds.map(([, name]) => fetchJSON('/api/resources', { resource: name, namespace: ns })));
      const failed = [];
      answers.forEach((answer, index) => {
        const [key, name] = kinds[index];
        if (answer.status === 'fulfilled') raw[key] = (answer.value.items || []).map(item => (key === 'secrets' ? { metadata: { name: item.metadata?.name } } : item));
        else failed.push(`${name}: ${errorText(answer.reason)}`);
      });
      if (failed.length === kinds.length) throw new Error(failed[0]);
      if (failed.length) notes.push({ step: 'Related objects', message: failed.join('; ') });
      return failed.length ? `${kinds.length - failed.length} of ${kinds.length} kinds` : '';
    }),
  ]);

  // 3. Nodes and logs need the pods.
  await Promise.all([
    step('nodes', 'Nodes', async () => {
      const pods = raw.pods || [];
      raw.allNodes = pods.some(pod => (pod.status?.conditions || []).some(c => c.type === 'PodScheduled' && c.status === 'False'));
      const names = new Set(pods.map(pod => pod.spec?.nodeName).filter(Boolean));
      if (!names.size && !raw.allNodes) { raw.nodes = []; return 'no pod is on a node'; }
      raw.nodes = (await fetchJSON('/api/resources', { resource: 'nodes' })).items || [];
      return raw.allNodes ? `all ${raw.nodes.length} (a pod is unschedulable)` : `${names.size} node${names.size === 1 ? '' : 's'}`;
    }),
    step('logs', 'Logs', () => collectLogs(raw, options, collector)),
  ]);

  await step('problems', 'Problems and diagnosis', async () => {
    raw.problems = hooks.problemsIn?.(target.context, ns) || [];
    return `${raw.problems.length} open problem${raw.problems.length === 1 ? '' : 's'} in ${ns}`;
  });
  raw.takenAt = Date.now();
  return { raw, collector };
}

// ---- Dialog -------------------------------------------------------------------------------------
const GLYPH = { pending: '○', running: '…', done: '✓', failed: '!' };
function progressList(steps) {
  return el('ol', { class: 'snapshot-steps', 'aria-live': 'polite' }, steps.map(item => el('li', { class: `snapshot-step ${item.status}` },
    el('span', { class: 'snapshot-glyph', 'aria-hidden': 'true', text: GLYPH[item.status] }),
    el('span', { class: 'snapshot-step-label', text: item.label }),
    el('span', { class: 'snapshot-step-note', text: item.status === 'running' ? 'collecting…' : item.status === 'failed' ? `could not collect: ${item.note}` : item.note }),
    item.ms !== undefined ? el('span', { class: 'snapshot-step-time', text: item.ms < 1000 ? `${Math.max(1, Math.round(item.ms))} ms` : `${(item.ms / 1000).toFixed(1)} s` }) : null)));
}

function previewNode(markdown) {
  const root = el('div', { class: 'snapshot-preview markdown' });
  for (const part of splitDetails(markdown)) {
    const body = renderMarkdown(part.text);
    if (part.type === 'details') root.append(el('details', { class: 'snapshot-details' }, el('summary', { text: part.summary }), ...body.childNodes));
    else root.append(...body.childNodes);
  }
  return root;
}

const aiCommandName = () => state.preferences.aiCommand || '';
const kb = text => `${(new Blob([text]).size / 1024).toFixed(1)} KB`;

export async function openSnapshot(target) {
  if (!target?.context) { toast('Open a cluster first.', true); return; }
  const options = readOptions();
  const controller = new AbortController();
  const dialog = document.getElementById('action-dialog');
  const root = el('div', { class: 'snapshot' });
  const what = () => (target.resource === 'namespaces' ? `Namespace ${target.namespace || '(choose one)'}` : target.preferOwner ? `Pods of ${target.namespace}/${target.label || target.name}` : `${kindOf(target.resource)} ${target.namespace ? `${target.namespace}/` : ''}${target.name}`);
  modal('Incident snapshot', `${what()} · ${labelFor(target.context) || target.context}. Status, events, logs and Rubban's diagnosis in one redacted report to share.`, root);
  const onClose = () => { controller.abort(); dialog.removeEventListener('close', onClose); };
  dialog.addEventListener('close', onClose);

  // No namespace chosen yet (Ctrl+K with "All namespaces"): ask for one.
  if (target.resource === 'namespaces' && !target.namespace) {
    const select = el('select', { 'aria-label': 'Namespace' }, el('option', { value: '', text: 'Loading namespaces…' }));
    const go = el('button', { type: 'submit', class: 'primary', disabled: true }, 'Take snapshot');
    const form = el('form', { class: 'snapshot-pick' }, el('div', { class: 'field' }, el('label', { text: 'Namespace' }), select), el('div', { class: 'form-actions' }, go));
    form.addEventListener('submit', event => { event.preventDefault(); if (!select.value) return; dialog.removeEventListener('close', onClose); openSnapshot({ ...target, namespace: select.value, name: select.value }); });
    root.replaceChildren(form);
    try {
      const names = ((await get('/api/namespaces', { context: target.context }, { signal: controller.signal })).items || []).map(item => item.metadata?.name).filter(Boolean).sort();
      select.replaceChildren(...names.map(name => el('option', { value: name, text: name })));
      go.disabled = !names.length; select.focus();
    } catch (error) { if (!controller.signal.aborted) root.append(el('div', { class: 'callout error', text: `Could not list namespaces: ${error.message}` })); }
    return;
  }

  let raw = null; let model = null; let aiAnswer = null; let aiSent = null; let view = 'preview'; let started = 0;
  const steps = el('div', { class: 'snapshot-progress' });

  async function run() {
    started = performance.now();
    aiAnswer = null; aiSent = null; view = 'preview';
    root.replaceChildren(el('p', { class: 'muted snapshot-lead', text: 'Collecting in parallel; each part has its own time limit, and a part that fails is noted in the report instead of stopping it.' }), steps);
    try {
      const result = await collect(target, { ...options }, controller.signal, list => steps.replaceChildren(progressList(list)));
      raw = result.raw;
      raw.collectedIn = performance.now() - started;
      rebuild();
      draw();
    } catch (error) {
      if (controller.signal.aborted) return;
      root.append(el('div', { class: 'callout error', role: 'alert', text: `Could not take the snapshot: ${errorText(error)}` }), el('div', { class: 'form-actions' }, button('Try again', run, 'primary')));
    }
  }
  const rebuild = () => { model = buildSnapshot({ ...raw, options: { ...options } }); };
  const reportMarkdown = () => {
    let text = snapshotMarkdown(model, { yaml: options.yaml });
    if (aiAnswer && includeAI.checked) text += `\n## AI root-cause draft (${aiSent.command})\n\n_Written by the ${aiSent.command} CLI from this snapshot. It can be wrong: check it against the evidence above before acting._\n\n${aiAnswer.trim()}\n`;
    return text;
  };

  // Options.
  const lines = el('select', { 'aria-label': 'Log lines per container' }, LOG_LINE_CHOICES.map(n => el('option', { value: String(n), text: `${n} lines` })));
  lines.value = String(options.logLines);
  const previous = el('input', { type: 'checkbox', checked: options.previous });
  const yaml = el('input', { type: 'checkbox', checked: options.yaml });
  const includeAI = el('input', { type: 'checkbox', checked: true });
  const aiToggle = el('label', { class: 'inline-label hidden' }, includeAI, 'Add the AI draft to the report');
  const relogStatus = el('span', { class: 'muted snapshot-relog', role: 'status' });
  async function relog() {
    saveOptions(options);
    relogStatus.textContent = 'Reading logs…';
    lines.disabled = true; previous.disabled = true;
    const collector = createCollector(raw.target, controller.signal, () => {});
    raw.notes = raw.notes.filter(note => note.step !== 'Logs');
    try { await collectLogs(raw, { ...options }, collector); raw.notes.push(...collector.notes); } catch (error) { if (controller.signal.aborted) return; raw.notes.push({ step: 'Logs', message: errorText(error) }); }
    lines.disabled = false; previous.disabled = false; relogStatus.textContent = '';
    rebuild(); draw();
  }
  lines.addEventListener('change', () => { options.logLines = Number(lines.value); relog(); });
  previous.addEventListener('change', () => { options.previous = previous.checked; relog(); });
  yaml.addEventListener('change', () => { options.yaml = yaml.checked; saveOptions(options); rebuild(); draw(); });
  includeAI.addEventListener('change', () => draw());
  const optionsBar = el('div', { class: 'snapshot-options' },
    el('label', { class: 'inline-label' }, 'Logs', lines),
    el('label', { class: 'inline-label' }, previous, 'Previous run of crashed containers'),
    target.resource === 'namespaces' ? null : el('label', { class: 'inline-label' }, yaml, 'Include YAML'),
    aiToggle, relogStatus,
    el('span', { class: 'spacer' }),
    button('Collect again', () => run(), 'compact quiet'));

  // Body: Preview, Markdown, AI.
  const tabs = el('div', { class: 'detail-tabs snapshot-tabs', role: 'tablist' });
  const body = el('div', { class: 'snapshot-body', role: 'tabpanel', tabindex: '0' });
  const meta = el('div', { class: 'snapshot-meta muted' });
  const failures = el('div');
  const aiButton = button('Ask AI', () => askAI(), 'primary');
  const actionsRow = el('div', { class: 'form-actions snapshot-actions' },
    el('span', { class: 'muted snapshot-hint', text: 'Secret values are never included.' }),
    button('Copy Markdown', async () => { try { await navigator.clipboard.writeText(reportMarkdown()); toast('Snapshot copied as Markdown.'); } catch (error) { toast(`Could not copy: ${error.message}`, true); } }),
    button('Save as file', () => download(snapshotFileName(model), reportMarkdown(), 'text/markdown')),
    aiButton);

  function tabButton(id, label) {
    const node = el('button', { type: 'button', role: 'tab', 'aria-selected': String(view === id), class: view === id ? 'active' : '' }, label);
    node.addEventListener('click', () => { view = id; draw(); });
    return node;
  }
  function draw() {
    if (!model) return;
    const text = reportMarkdown();
    const redacted = redactionTotal(model, { yaml: options.yaml });
    const failed = model.notes;
    meta.replaceChildren(
      el('span', { text: `Taken ${new Date(model.takenAt).toLocaleString()} in ${((raw.collectedIn || 0) / 1000).toFixed(1)} s` }),
      el('span', { text: `${model.summary.pods} pod${model.summary.pods === 1 ? '' : 's'} · ${model.logs.length} log${model.logs.length === 1 ? '' : 's'} · ${model.events.length} event${model.events.length === 1 ? '' : 's'}` }),
      el('span', { class: redacted ? 'snapshot-redacted' : '', text: redacted ? `${redacted} value${redacted === 1 ? '' : 's'} redacted as ${MASK}` : 'Nothing secret-looking found' }),
      el('span', { text: kb(text) }));
    failures.replaceChildren(failed.length ? el('div', { class: 'callout warn' }, `Partial snapshot: ${failed.map(note => `${note.step}: ${note.message}`).join(' · ')}. The report says what is missing.`) : '');
    aiToggle.classList.toggle('hidden', !aiAnswer);
    tabs.replaceChildren(...[tabButton('preview', 'Preview'), tabButton('markdown', 'Markdown'), aiSent || view === 'ai' ? tabButton('ai', 'AI root cause') : null].filter(Boolean));
    if (view === 'preview') body.replaceChildren(previewNode(text));
    else if (view === 'markdown') body.replaceChildren(el('pre', { class: 'output snapshot-raw', text }));
    else body.replaceChildren(aiView());
    if (root.firstChild !== optionsBar) root.replaceChildren(optionsBar, failures, meta, tabs, body, actionsRow);
  }

  // ---- Ask AI ----
  let aiState = { status: 'idle', error: '' };
  function aiView() {
    const command = aiCommandName();
    if (!command && !aiSent) {
      return el('div', { class: 'snapshot-ai' },
        el('div', { class: 'callout info' }, 'No AI CLI is set up. Rubban can send this redacted snapshot to Codex, Claude, Gemini or OpenCode installed on this computer, under your own account, and show a root-cause draft here. Choose one in Settings › Connected services › AI CLI.'),
        el('div', { class: 'form-actions start' }, button('Open Settings', () => { dialog.close(); hooks.openView?.('settings', undefined, 'Settings'); }, 'compact')));
    }
    const sentNote = el('details', { class: 'snapshot-sent' },
      el('summary', { text: `Sent to the ${aiSent.command} CLI on this computer: a root-cause instruction and this redacted snapshot (${kb(aiSent.prompt)}${aiSent.trimmed ? `, logs cut to the last ${aiSent.logLines} lines${aiSent.yaml ? '' : ' and YAML left out'} to fit` : ''}). Show exactly what was sent.` }),
      el('pre', { class: 'output snapshot-raw', text: aiSent.prompt }));
    const parts = [el('div', { class: 'callout info snapshot-ai-note' }, `Only what is shown below was sent: secret values were never part of the snapshot, and ${aiSent.redacted} secret-looking value${aiSent.redacted === 1 ? ' was' : 's were'} replaced with ${MASK}. The ${aiSent.command} CLI's own account and terms apply.`), sentNote];
    if (aiState.status === 'running') parts.push(el('div', { class: 'loading', text: `Waiting for ${aiSent.command}… this can take a minute.` }));
    if (aiState.status === 'error') parts.push(el('div', { class: 'callout error', role: 'alert' }, aiState.error, /not installed|not on PATH|supported/i.test(aiState.error) ? el('div', {}, button('Open Settings', () => { dialog.close(); hooks.openView?.('settings', undefined, 'Settings'); }, 'compact')) : null));
    if (aiAnswer) parts.push(el('div', { class: 'snapshot-answer' }, el('div', { class: 'snapshot-answer-head' }, el('strong', { text: `Root-cause draft from ${aiSent.command}` }), el('span', { class: 'muted', text: 'Check it against the evidence before acting.' }), el('span', { class: 'spacer' }), button('Copy answer', async () => { try { await navigator.clipboard.writeText(aiAnswer); toast('Answer copied.'); } catch (error) { toast(error.message, true); } }, 'compact quiet')), renderMarkdown(aiAnswer)));
    return el('div', { class: 'snapshot-ai' }, parts);
  }
  async function askAI() {
    view = 'ai';
    const command = aiCommandName();
    if (!command) { draw(); return; }
    const { prompt, trimmed, logLines, yaml: withYaml } = aiPrompt(model);
    aiSent = { command, prompt, trimmed, logLines, yaml: withYaml, redacted: redactionTotal(model, { yaml: withYaml }) };
    aiAnswer = null; aiState = { status: 'running', error: '' };
    aiButton.disabled = true; draw();
    try {
      const answer = await post('/api/ai', { command, prompt, context: target.context }, { signal: controller.signal });
      aiAnswer = String(answer.output || '').trim() || '_The CLI returned no text._';
      aiState = { status: 'done', error: '' };
    } catch (error) {
      if (controller.signal.aborted) return;
      aiState = { status: 'error', error: error.message };
    } finally { aiButton.disabled = false; }
    draw();
  }

  run();
}
