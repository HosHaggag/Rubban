// Ctrl+K commands in the palette: a preview row of what the typed command will do, above the view and
// resource results, and the palette's keys (arrows move, Enter runs, Tab completes, ↑ recalls). The
// grammar and ranking are in commands.js; the work itself is done by the existing operations in ops.js.
import { $, state, hooks, el, toast, get, post, api, targetOf, confirmAction, readStore, writeStore } from './kit.js';
import { infoFor, labelFor } from './clusterui.js';
import { clusterIcon } from './cluster-icons.js';
import { applyTheme } from './theme.js';
import { searchContexts } from './search.js';
import { restart, scaleDialog, forwardDialog, forwardablePorts, logsFor, shell, cordon, drainDialog, cronJobAction, deleteResource, rollback, workloadSelector } from './ops.js';
import { parseCommand, suggestVerbs, helpFor, verbSpec, targetKinds, kindsText, rankTargets, matchContexts, matchNamespaces, matchViews, previousRevision, forwardPreset, pickPod, defaultContainer, isDestructive, describeCommand, remember } from './commands.js';

const RECENT_STORE = 'rubban.commands.recent';
// Verbs that change something: a name that only resembles the target is never run by Enter alone.
const MUTATING = new Set(['restart', 'scale', 'rollback', 'delete', 'cordon', 'uncordon', 'drain', 'trigger']);
const quick = () => ({ signal: AbortSignal.timeout(20000) });
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The input with its last mention of a name replaced, for Tab completion of a resource or cluster name.
const replaceLast = (text, query, name) => {
  if (!query) return `${text.trimEnd()} ${name}`;
  const pattern = new RegExp(`${escape(query)}(?!.*${escape(query)})`, 'i');
  return pattern.test(text) ? text.replace(pattern, name) : text;
};

// host: what the shell in app.js knows: { allNav, namespacesOf(context), setNamespace(namespace, { quiet }) }.
export function createCommandBar(host) {
  const node = el('div', { class: 'command-actions', role: 'group', 'aria-label': 'Command' });
  let timer = null; let abort = null;
  let active = null; let explicit = false;
  let recall = -1; let recalling = false;
  const box = () => $('#command-search');
  const results = () => $('#command-results');
  const rows = () => [...results().querySelectorAll('button.command-option')];

  // ---- Rows -------------------------------------------------------------------------------------
  function chip(context) {
    const meta = infoFor(context);
    return el('span', { class: 'command-chip', title: context }, el('span', { class: 'tab-cluster', style: `color:${meta.color}` }, clusterIcon(meta.icon)), el('span', { text: meta.label }),
      meta.env === 'production' ? el('span', { class: 'command-prod', text: 'production' }) : null);
  }
  // A runnable row. choice: runs only when picked with the arrows or the mouse, never as Enter's default.
  // fill: clicking puts this text in the box instead of running anything.
  function row({ label, context, extra, detail, run, fill, completion, danger = false, choice = false, glyph = '▶', title = '' }) {
    const button = el('button', { type: 'button', class: `command-option command-run${danger ? ' danger' : ''}${choice ? ' choice-only' : ''}${fill !== undefined ? ' command-fill' : ''}`, title },
      el('span', { class: 'command-glyph', 'aria-hidden': 'true', text: glyph }), el('span', { class: 'command-text', text: label }), context ? chip(context) : null, extra || null, detail ? el('small', { text: detail }) : null);
    if (completion) button.dataset.completion = completion;
    button.addEventListener('click', event => { if (fill !== undefined) setInput(fill); else execute(run, event); });
    return button;
  }
  const note = (text, level = '') => el('div', { class: `command-note command-line${level ? ` ${level}` : ''}`, text });
  const group = text => el('div', { class: 'command-group command-title', text });
  // block: the command is understood but nothing is ready to run by Enter yet.
  function show(nodes, { block = false } = {}) {
    node.replaceChildren(...nodes.filter(Boolean));
    if (block) node.dataset.block = 'true'; else delete node.dataset.block;
    explicit = false; mark(defaultRow());
  }

  // ---- Highlight and keys -----------------------------------------------------------------------
  function defaultRow() {
    if (node.dataset.block && node.isConnected && node.childElementCount) return null;
    return rows().find(item => !item.classList.contains('choice-only')) || null;
  }
  function mark(target, scroll = false) {
    active = target;
    for (const item of rows()) { const on = item === target; item.classList.toggle('command-active', on); item.setAttribute('aria-selected', String(on)); }
    if (scroll) target?.scrollIntoView({ block: 'nearest' });
  }
  // Async results (resource search, resolution) keep the highlight on the default row until the user moves it.
  new MutationObserver(() => { if (!explicit || !active?.isConnected) { explicit = false; mark(defaultRow()); } }).observe(results(), { childList: true, subtree: true });

  function setInput(value, { fromRecall = false } = {}) {
    const input = box();
    recalling = fromRecall;
    input.value = value; input.focus();
    input.setSelectionRange(value.length, value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    recalling = false;
  }
  function recallStep(step) {
    const recent = readStore(RECENT_STORE, []);
    if (!Array.isArray(recent) || !recent.length) return false;
    const next = recall + step;
    if (next < -1 || next >= recent.length) return true;
    recall = next;
    setInput(recall < 0 ? '' : recent[recall], { fromRecall: true });
    return true;
  }
  function keydown(event) {
    const input = box();
    if (event.key === 'ArrowUp' && !explicit && (!input.value.trim() || recall >= 0)) { if (recallStep(1)) { event.preventDefault(); return; } }
    if (event.key === 'ArrowDown' && !explicit && recall >= 0) { event.preventDefault(); recallStep(-1); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const list = rows(); if (!list.length) return;
      const at = list.indexOf(active);
      const next = event.key === 'ArrowDown' ? (at < 0 ? 0 : Math.min(at + 1, list.length - 1)) : Math.max(at - 1, 0);
      explicit = true; mark(list[next], true);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const target = explicit && active?.isConnected ? active : defaultRow();
      if (!target) { if (node.dataset.block) node.querySelector('.command-line')?.classList.add('attention'); return; }
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: event.ctrlKey, metaKey: event.metaKey }));
    } else if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.altKey) {
      const source = explicit && active?.dataset.completion ? active : node.querySelector('[data-completion]');
      const completion = source?.dataset.completion;
      if (completion && completion !== input.value) { event.preventDefault(); setInput(completion); }
      else if (input.value) event.preventDefault();
    }
  }

  // ---- Running ------------------------------------------------------------------------------------
  async function execute(run, event) {
    const text = box().value.trim();
    $('#command-dialog').close();
    if (text) writeStore(RECENT_STORE, remember(readStore(RECENT_STORE, []), text));
    try { await run(event || {}); } catch (error) { if (error?.name !== 'AbortError') toast(error.message, true); }
  }
  // Commands that open a resource or may meet the production guard run in the target's cluster tab, so
  // the guard, the drawer and the page all see that cluster.
  async function toCluster(context) {
    if (!context || context === state.context) return;
    const tab = state.tabs.find(item => item.context === context);
    if (tab) await hooks.activateTab(tab.id); else await hooks.newClusterTab(context);
  }
  const fetchItem = selected => get('/api/resource', targetOf(selected), quick());
  // The target as it is now: the search can lag up to 20 seconds behind (a pod replaced by a restart).
  async function current(selected, kind) {
    try { return await fetchItem(selected); } catch (error) {
      if (error.status === 404) throw new Error(`${kind} ${selected.namespace ? `${selected.namespace}/` : ''}${selected.name} no longer exists in ${labelFor(selected.context)}. Search results can be up to 20 seconds old; type the command again.`);
      throw error;
    }
  }

  async function scaleTo(selected, kind, replicas) {
    if (!await confirmAction(`Scale ${kind} ${selected.name} to ${replicas} ${replicas === 1 ? 'replica' : 'replicas'}.`, selected.name, { destructive: replicas === 0 })) return;
    const result = await post('/api/scale', { ...targetOf(selected), replicas });
    toast((result?.output || '').split('\n').filter(Boolean).at(-1) || `Scaled ${selected.name} to ${replicas}.`);
    hooks.afterMutation?.();
  }
  async function shellInto(selected, kind, item) {
    if (selected.resource === 'pods') {
      const pod = item;
      if (pod.status?.phase !== 'Running') throw new Error(`${selected.name} is ${pod.status?.phase || 'not running'}; a shell needs a running pod.`);
      return shell(selected, defaultContainer(pod));
    }
    const selector = workloadSelector(item);
    if (!selector) throw new Error(`${kind} ${selected.name} has no label selector to find its pods.`);
    const pods = await get('/api/resources', { context: selected.context, namespace: selected.namespace, resource: 'pods', labelSelector: selector }, quick());
    const pod = pickPod(pods.items);
    if (!pod) throw new Error(`${kind} ${selected.name} has no ready pod to open a shell in.`);
    return shell({ context: selected.context, namespace: selected.namespace, resource: 'pods', name: pod.metadata.name }, defaultContainer(pod));
  }
  async function rollbackTo(selected, kind, wanted, item) {
    const owned = list => (list.items || []).filter(entry => (entry.metadata?.ownerReferences || []).some(ref => ref.uid === item.metadata?.uid));
    let revisions; let current;
    if (selected.resource === 'deployments') {
      const sets = owned(await get('/api/resources', { context: selected.context, namespace: selected.namespace, resource: 'replicasets' }, quick()));
      revisions = sets.map(rs => Number(rs.metadata?.annotations?.['deployment.kubernetes.io/revision'] || 0));
      current = Number(item.metadata?.annotations?.['deployment.kubernetes.io/revision'] || Math.max(0, ...revisions));
    } else {
      const history = owned(await get('/api/resources', { context: selected.context, namespace: selected.namespace, resource: 'controllerrevisions' }, quick()));
      revisions = history.map(rev => Number(rev.revision || 0));
      const currentName = item.status?.updateRevision || item.status?.currentRevision;
      current = Number(history.find(rev => rev.metadata?.name === currentName)?.revision || Math.max(0, ...revisions));
    }
    if (wanted !== undefined && !revisions.includes(wanted)) throw new Error(`${kind} ${selected.name} has no revision ${wanted}${revisions.length ? ` (it has ${[...new Set(revisions)].sort((a, b) => a - b).join(', ')})` : ''}.`);
    if (wanted !== undefined && wanted === current) throw new Error(`Revision ${wanted} is already the current one.`);
    const revision = wanted ?? previousRevision(revisions, current);
    if (!revision) throw new Error(`${kind} ${selected.name} has no earlier revision to roll back to.`);
    return rollback(selected, revision);
  }
  async function runTarget(intent, target, other) {
    const selected = { context: target.context, namespace: target.namespace || '', resource: target.resource, name: target.name };
    const kind = target.kind || target.resource;
    const item = intent.verb === 'compare' ? null : await current(selected, kind);
    switch (intent.verb) {
      case 'restart': return restart(selected);
      case 'scale':
        await toCluster(target.context);
        if (intent.args.replicas === undefined) return scaleDialog({ ...selected, item });
        return scaleTo(selected, kind, intent.args.replicas);
      case 'logs': return logsFor({ ...selected, item });
      case 'shell': return shellInto(selected, kind, item);
      case 'forward': {
        const ports = forwardablePorts(item).length ? forwardablePorts(item) : forwardablePorts({ spec: item.spec?.template?.spec || {} });
        return forwardDialog({ ...selected, item }, forwardPreset(intent.args, ports));
      }
      case 'describe': case 'yaml':
        await toCluster(target.context);
        return hooks.showResource({ kind: target.kind, metadata: { name: target.name, namespace: target.namespace || '' } }, target.resource, intent.verb === 'yaml' ? { tab: 'yaml' } : {});
      case 'rollback': return rollbackTo(selected, kind, intent.args.revision, item);
      case 'delete': await toCluster(target.context); return deleteResource(selected);
      case 'cordon': case 'uncordon': return cordon(selected, intent.verb === 'cordon');
      case 'drain': await toCluster(target.context); return drainDialog(selected);
      case 'trigger': return cronJobAction(selected, 'trigger');
      case 'compare':
        hooks.openCompare({ context: target.context, namespace: target.namespace || '', resource: target.resource, name: target.name }, { context: other, namespace: target.namespace || '', resource: target.resource, name: target.name });
        return undefined;
      default: return undefined;
    }
  }

  // ---- Previews -----------------------------------------------------------------------------------
  const contextChoices = () => state.contexts.map(context => ({ name: context.name, label: labelFor(context.name) }));
  // The clusters a command looks in: the one it names, else every open cluster with this tab's first.
  function clustersFor(intent) {
    if (intent.context) {
      const named = matchContexts(intent.context, contextChoices())[0];
      return named ? { list: [named] } : { error: `No cluster matches “${intent.context}”.` };
    }
    const open = searchContexts(state.tabs);
    const list = state.context ? [state.context, ...open.filter(name => name !== state.context)] : open;
    return list.length ? { list } : { error: 'Open a cluster first.' };
  }
  const errorsOf = (intent, extra = []) => {
    const spec = verbSpec(intent.verb);
    return [...[...intent.errors, ...extra].map(text => note(text, 'error')), spec?.example ? note(`For example: ${spec.example}`) : null];
  };

  function previewTarget(intent, input) {
    const spec = verbSpec(intent.verb);
    const { kinds, error } = targetKinds(intent);
    if (error) return show(errorsOf(intent, [error]), { block: true });
    if (intent.nameQuery.length < 2) return show([note(`${spec.title}: type a name${kinds ? ` (${kindsText(kinds, 'or')})` : ''}${intent.nameQuery ? ', two letters or more' : ''} · e.g. ${spec.example}`, 'hint')], { block: true });
    const clusters = clustersFor(intent);
    if (clusters.error) return show(errorsOf(intent, [clusters.error]), { block: true });
    let other = '';
    if (intent.verb === 'compare') {
      other = matchContexts(intent.args.with, contextChoices())[0] || '';
      if (!other) return show(errorsOf(intent, [`No cluster matches “${intent.args.with}”.`]), { block: true });
    }
    show([note(`${spec.title} “${intent.nameQuery}” · looking in ${clusters.list.map(labelFor).join(', ')}…`, 'hint')], { block: true });
    timer = setTimeout(() => resolve(intent, input, clusters.list, kinds, other), 160);
  }
  async function resolve(intent, input, clusters, kinds, other) {
    const controller = new AbortController(); abort = controller;
    const answers = await Promise.all(clusters.map(context => get('/api/search', { context, q: intent.nameQuery, limit: 50, kinds: kinds ? kinds.join(',') : undefined }, { signal: controller.signal })
      .then(answer => ({ context, results: answer.results || [] }), failure => ({ context, results: [], error: failure }))));
    if (controller.signal.aborted) return;
    const ranked = rankTargets(intent, answers, { tabContext: state.context, tabNamespace: state.namespace });
    const destructive = isDestructive(intent);
    const failures = answers.filter(answer => answer.error && answer.error.name !== 'AbortError').map(answer => note(`${labelFor(answer.context)}: ${answer.error.code === 'credentials' ? 'credentials expired' : answer.error.message}`, 'error'));
    const targetRow = (target, choice) => {
      if (intent.verb === 'compare' && target.context === other) return null;
      return row({
        label: describeCommand(intent, target), context: target.context, detail: target.status || '', danger: destructive, choice,
        extra: intent.verb === 'compare' ? el('span', { class: 'command-with' }, el('span', { text: 'with' }), chip(other)) : null,
        completion: replaceLast(input, intent.nameQuery, target.name), run: () => runTarget(intent, target, other),
        title: `${target.kind} ${target.namespace ? `${target.namespace}/` : ''}${target.name} · ${target.context}`,
      });
    };
    const nodes = [];
    if (ranked.best) {
      nodes.push(...ranked.exact.map(target => targetRow(target, false)));
      const near = ranked.targets.filter(target => !target.exact);
      if (near.length) nodes.push(group('Similar names'), ...near.map(target => targetRow(target, true)));
    } else if (ranked.targets.length) {
      const pickOnly = MUTATING.has(intent.verb);
      nodes.push(note(`No exact match for “${intent.nameQuery}”${pickOnly ? ' · pick one with ↓ and press Enter' : ''}`, 'hint'), ...ranked.targets.map(target => targetRow(target, pickOnly)));
    } else {
      nodes.push(note(`Nothing named like “${intent.nameQuery}”${kinds ? ` among ${kindsText(kinds, 'or')}` : ''} in ${clusters.map(labelFor).join(', ')}${intent.namespace && intent.namespace !== '*' ? `, namespace ${intent.namespace}` : ''}.`, 'error'));
    }
    // "open settings": a view by that name is offered too.
    if (intent.verb === 'describe') {
      const views = matchViews(intent.nameQuery, host.allNav()).slice(0, 2);
      if (views.length) nodes.push(...views.map(view => viewRow(view, state.context, '', !ranked.best && !ranked.targets.length ? false : true)));
    }
    const runnable = nodes.some(item => item?.classList?.contains('command-run') && !item.classList.contains('choice-only'));
    show([...nodes, ...failures], { block: !runnable });
  }

  function viewRow(view, context, namespace, choice = false, closest = '') {
    return row({
      label: `Open ${view.tabTitle || view.title}${namespace ? ` in ${namespace === '*' ? 'all namespaces' : namespace}` : ''}`, context: view.section === 'resource' || namespace || context !== state.context ? context || '' : '', choice,
      detail: closest || (view.trail || []).map(item => item.title).join(' › '),
      run: async event => {
        await toCluster(context);
        if (namespace) host.setNamespace(namespace, { quiet: true });
        hooks.openView(view.section, view.resource, view.tabTitle || view.title, { newTab: Boolean(event.ctrlKey || event.metaKey) });
      },
    });
  }
  function previewGo(intent) {
    const spec = verbSpec('go');
    if (!intent.nameQuery) return show([note(`Open which view? · e.g. go pods, ${spec.example}`, 'hint')], { block: true });
    const views = matchViews(intent.nameQuery, host.allNav()).slice(0, 4);
    if (!views.length) return show(errorsOf(intent, [`No view matches “${intent.nameQuery}”.`]), { block: true });
    let context = state.context;
    if (intent.context) {
      context = matchContexts(intent.context, contextChoices())[0];
      if (!context) return show(errorsOf(intent, [`No cluster matches “${intent.context}”.`]), { block: true });
    }
    let namespace = intent.namespace; let closest = '';
    const known = host.namespacesOf(context);
    if (namespace && namespace !== '*' && Array.isArray(known) && !known.includes(namespace)) {
      const near = matchNamespaces(namespace, known)[0];
      if (!near) return show(errorsOf(intent, [`No namespace “${namespace}” in ${labelFor(context)}.`]), { block: true });
      closest = `closest to “${namespace}”`; namespace = near;
    }
    show(views.map((view, index) => viewRow(view, context, namespace, index > 0 && Boolean(closest), closest)));
  }
  function previewNamespace(intent) {
    let context = state.context;
    if (intent.context) {
      context = matchContexts(intent.context, contextChoices())[0];
      if (!context) return show(errorsOf(intent, [`No cluster matches “${intent.context}”.`]), { block: true });
    }
    if (!context) return show(errorsOf(intent, ['Open a cluster first.']), { block: true });
    const nsRow = (namespace, choice) => row({
      label: namespace === '*' ? 'Show all namespaces' : `Switch namespace to ${namespace}`, context, choice,
      detail: namespace === state.namespace && context === state.context ? 'current' : '', completion: `ns ${namespace === '*' ? 'all' : namespace}${intent.context ? ` on ${intent.context}` : ''}`,
      run: async () => { await toCluster(context); host.setNamespace(namespace); toast(namespace === '*' ? `Showing all namespaces in ${labelFor(context)}.` : `Showing namespace ${namespace} in ${labelFor(context)}.`); },
    });
    const known = host.namespacesOf(context);
    if (!intent.namespace) return show([note('Which namespace? · e.g. ns shop, or ns all', 'hint'), nsRow('*', true), ...(known || []).slice(0, 8).map(name => nsRow(name, true))], { block: true });
    if (intent.namespace === '*' || !Array.isArray(known)) return show([nsRow(intent.namespace, false)]);
    const matches = matchNamespaces(intent.namespace, known).slice(0, 6);
    if (!matches.length) return show(errorsOf(intent, [`No namespace “${intent.namespace}” in ${labelFor(context)}.`]), { block: true });
    show(matches.map(name => nsRow(name, false)));
  }
  function previewContext(intent) {
    const newTab = intent.verb === 'newtab';
    const matches = matchContexts(intent.context, contextChoices()).slice(0, 6);
    if (!state.contexts.length) return show(errorsOf(intent, ['No clusters in your kubeconfig yet.']), { block: true });
    if (!matches.length) return show(errorsOf(intent, [`No cluster matches “${intent.context}”.`]), { block: true });
    const word = newTab ? 'new tab' : 'use';
    show([intent.context ? null : note(newTab ? 'Open which cluster in a new tab?' : 'Switch this tab to which cluster?', 'hint'), ...matches.map(name => row({
      label: newTab ? 'Open in a new tab' : 'Switch to', context: name, choice: !intent.context,
      detail: name === state.context ? 'current' : labelFor(name) === name ? '' : name, completion: `${word} ${name}`,
      run: async () => {
        if (newTab) await hooks.newClusterTab(name);
        else if (name !== state.context) await hooks.selectContext(name);
        toast(newTab ? `Opened ${labelFor(name)} in a new tab.` : `Now showing ${labelFor(name)}.`);
      },
    }))], { block: !intent.context });
  }
  function previewTheme(intent) {
    const themeRow = (theme, choice) => row({
      label: theme === 'system' ? 'Follow the system theme' : `Use the ${theme} theme`, choice, completion: `theme ${theme}`,
      run: async () => {
        applyTheme(theme);
        state.preferences = await api('/api/preferences', { method: 'PUT', body: { ...state.preferences, theme } });
        toast(theme === 'system' ? 'Theme follows the system.' : `Theme: ${theme}.`);
      },
    });
    if (intent.args.theme) return show([themeRow(intent.args.theme, false)]);
    show([note('Which theme?', 'hint'), ...['dark', 'light', 'system'].map(theme => themeRow(theme, true))], { block: true });
  }
  function previewHelp(intent) {
    const items = helpFor(intent.args.topic || '');
    if (!items.length) return show([note(`No command about “${intent.args.topic}”. Type ? for all of them.`, 'error')], { block: true });
    show([group('Commands · click one to start typing it'), ...items.map(item => row({
      label: item.words.slice(0, 3).join(' · '), extra: el('span', { class: 'command-summary', text: item.summary }), detail: item.example, glyph: '›', choice: true, fill: `${item.words[0]} `, completion: `${item.words[0]} `,
      title: `${item.summary}. Also: ${item.words.join(', ')}`,
    })), intent.args.topic ? null : row({ label: 'Take the tour', detail: 'Help', glyph: '›', choice: true, run: () => hooks.takeTour() }), note('Add “in <namespace>” or “on <cluster>” to any command. Destructive commands ask for the name on production clusters.', 'hint')], { block: true });
  }
  function previewRecent() {
    const recent = readStore(RECENT_STORE, []);
    if (!Array.isArray(recent) || !recent.length) { show([]); return; }
    show([group('Recent commands · ↑ to recall'), ...recent.slice(0, 5).map(text => row({ label: text, glyph: '↺', choice: true, fill: text }))]);
  }
  function previewSuggestions(text) {
    const suggestions = text.length >= 2 ? suggestVerbs(text, 3) : [];
    show(suggestions.map(item => row({ label: `${item.completion.trim()} …`, detail: `${item.summary} · Tab`, glyph: '›', choice: true, fill: item.completion, completion: item.completion })));
  }

  // update draws the command preview for the palette text and returns what the view and resource
  // results below should search for: the text itself, the name in a command, or '' for none.
  function update(input) {
    clearTimeout(timer); abort?.abort(); abort = null;
    if (!recalling) recall = -1;
    const text = String(input || '').trim();
    if (!text) { previewRecent(); return ''; }
    const intent = parseCommand(text);
    if (!intent) { previewSuggestions(text); return input; }
    if (intent.errors.length) { show(errorsOf(intent), { block: true }); return intent.nameQuery || ''; }
    switch (intent.verb) {
      case 'go': previewGo(intent); return '';
      case 'namespace': previewNamespace(intent); return '';
      case 'context': case 'newtab': previewContext(intent); return '';
      case 'theme': previewTheme(intent); return '';
      case 'help': previewHelp(intent); return '';
      case 'problems': show([row({ label: 'Open Problems', detail: 'every open cluster', run: () => hooks.openView('problems') })]); return '';
      default: previewTarget(intent, text); return intent.nameQuery.length >= 2 ? intent.nameQuery : '';
    }
  }
  return { node, update, keydown };
}
