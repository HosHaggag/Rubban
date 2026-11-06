// Advisor page: a reliability, security, efficiency and hygiene scorecard for the tab's cluster and
// namespace, built from the shared live feeds and judged by advisor-rules.js. Fixes go through the
// Review → Apply flow (review.js), so nothing changes before the diff has been seen.
import { $, state, hooks, el, button, badge, info, loading, empty, page, section, task, get, readStore, writeStore, modal, copyButton, link } from './kit.js';
import { reviewBar } from './review.js';
import { labelFor, envFor } from './clusterui.js';
import { RESOURCES, CLUSTER_SCOPED, CATEGORIES, SEVERITIES, SCORE_FORMULA, PSS_LEVELS, analyze, scoreOf, objectSummary, pssCounts, filterFindings, groupFindings, fixDocument, patchText, managedBy, toYAML } from './advisor-rules.js';

const SUPPRESS_KEY = 'rubban.advisor.suppressed';
const VIEW_KEY = 'rubban.advisor.view';
const SETTLE_MS = 6000;
const ROWS_PER_GROUP = 50;
const SVG_NS = 'http://www.w3.org/2000/svg';

// ---- Suppressions: per cluster, in this window's storage ------------------------------------------
export function suppressedFor(context) {
  const map = readStore(SUPPRESS_KEY, {});
  return new Set(map && Array.isArray(map[context]) ? map[context] : []);
}
function setSuppressed(context, id, on) {
  const map = readStore(SUPPRESS_KEY, {}) || {};
  const ids = new Set(Array.isArray(map[context]) ? map[context] : []);
  if (on) ids.add(id); else ids.delete(id);
  if (ids.size) map[context] = [...ids]; else delete map[context];
  writeStore(SUPPRESS_KEY, map);
}

// The full analysis of an open Advisor page per cluster, so the details drawer shows the complete picture.
const lastResults = new Map();
const isProduction = context => envFor(context) === 'production';
const gradeLevel = grade => (grade === 'A' || grade === 'B' ? 'good' : grade === 'C' || grade === 'D' ? 'warn' : grade === 'F' ? 'bad' : '');
const severityLabel = { critical: 'Critical', warning: 'Warning', info: 'Info' };
const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;

// ---- Small pieces ---------------------------------------------------------------------------------
function ring(score, grade, size = 92) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 36 36'); svg.setAttribute('width', String(size)); svg.setAttribute('height', String(size)); svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `advisor-ring ${gradeLevel(grade)}`);
  const circle = (cls, dash) => {
    const node = document.createElementNS(SVG_NS, 'circle');
    node.setAttribute('cx', '18'); node.setAttribute('cy', '18'); node.setAttribute('r', '15.915'); node.setAttribute('class', cls);
    if (dash !== undefined) { node.setAttribute('stroke-dasharray', `${dash} ${100 - dash}`); node.setAttribute('stroke-dashoffset', '25'); }
    return node;
  };
  svg.append(circle('ring-track'), score ? circle('ring-fill', score) : '');
  return svg;
}
const gradeChip = (grade, extra = '') => el('span', { class: `advisor-grade ${gradeLevel(grade)} ${extra}`, text: grade });
const pssBadge = level => badge(level, level === 'restricted' ? 'good' : level === 'baseline' ? 'warn' : 'bad');
function chip(label, on, className, toggle, title = '') {
  const node = el('button', { type: 'button', class: `chip-button ${className}${on ? ' on' : ''}`, 'aria-pressed': String(on), title }, label);
  node.addEventListener('click', toggle);
  return node;
}

function openObject(finding, showResource) {
  showResource({ metadata: { name: finding.name, namespace: finding.resource === 'namespaces' ? undefined : finding.namespace } }, finding.resource);
}

// ---- Fix…: the patched object (or the new one) in an editor with Review → Apply --------------------
async function openFix(finding, context) {
  let live = null;
  if (!finding.manifest) live = await get('/api/resource', { context, namespace: finding.namespace, resource: finding.resource, name: finding.name });
  const doc = fixDocument(finding, live);
  if (!doc) throw new Error('This finding has no automatic fix.');
  const editor = el('textarea', { class: 'editor advisor-editor', value: toYAML(doc), spellcheck: 'false', 'aria-label': 'Manifest to apply' });
  const managed = live ? managedBy(live) : '';
  const bar = reviewBar({ editor, target: { context, namespace: finding.namespace }, destructive: true,
    confirmText: `Apply the fix "${finding.title}" to ${finding.manifest ? `a new ${finding.manifest.kind}` : `${finding.kind} ${finding.name}`} on this production cluster.`,
    confirmName: finding.manifest ? finding.manifest.metadata?.name : finding.name,
    onApplied: () => hooks.afterMutation?.() });
  const change = finding.manifest ? el('p', { text: `Creates ${finding.manifest.kind} ${finding.manifest.metadata?.namespace ? `${finding.manifest.metadata.namespace}/` : ''}${finding.manifest.metadata?.name}.` }) : el('pre', { class: 'output advisor-patch', text: toYAML(finding.patch) });
  modal(`Fix · ${finding.title}`, `${finding.kind} ${finding.namespace && finding.resource !== 'namespaces' ? `${finding.namespace}/` : ''}${finding.name} on ${labelFor(context)}. Review shows exactly what changes; nothing is applied before you press Apply.`,
    el('div', { class: 'advisor-fix' },
      managed ? info(`Managed by ${managed}: change the source as well, or the next sync puts the old value back.`, 'warn') : null,
      el('p', { class: 'advisor-fix-how', text: finding.fix }),
      el('div', { class: 'mini-title', text: finding.manifest ? 'New object' : 'Strategic-merge patch' }), change,
      finding.manifest ? null : el('p', { class: 'muted advisor-fix-note', text: 'kubectl also rewrites its last-applied-configuration annotation, so the diff shows that annotation too.' }),
      el('details', { class: 'advisor-fix-edit' }, el('summary', { text: finding.manifest ? 'Edit the manifest before reviewing' : 'Edit the patched object before reviewing' }), editor), bar));
  // Ask the cluster at once: the dialog opens on the diff.
  bar.querySelector('.form-actions button')?.click();
}

// ---- Drawer summary (Deployments, StatefulSets, DaemonSets) ----------------------------------------
hooks.advisorSummary = selected => {
  const { context, resource, item } = selected;
  const namespace = item.metadata?.namespace || '';
  const name = item.metadata?.name;
  const suppressed = suppressedFor(context);
  const cached = lastResults.get(context);
  const suffix = `|${resource}|${namespace}|${name}`;
  const result = cached && cached.checks.some(check => check.id.endsWith(suffix)) ? cached : analyze({ [resource]: [item] }, { namespace, production: isProduction(context), includeSystem: true });
  const summary = objectSummary(result, resource, namespace, name, suppressed);
  const top = summary.findings.slice(0, 3);
  const content = el('div', { class: 'advisor-summary' },
    el('div', { class: 'advisor-summary-head' },
      gradeChip(summary.grade, 'small'),
      el('span', { text: summary.score === null ? 'No checks apply' : `Score ${summary.score}` }),
      summary.pss ? pssBadge(summary.pss.level) : null,
      el('span', { class: 'muted', text: summary.findings.length ? plural(summary.findings.length, 'finding') : 'no findings' }),
      el('span', { class: 'spacer' }),
      link('Open Advisor', () => hooks.openView?.('advisor'))),
    top.length ? el('ul', { class: 'advisor-summary-list' }, top.map(finding => el('li', {}, el('i', { class: `severity-dot ${finding.severity}`, title: finding.severity }), el('span', { text: finding.title }), finding.detail ? el('small', { class: 'muted', text: finding.detail }) : null))) : null);
  return section('Advisor', content);
};

// ---- The page -------------------------------------------------------------------------------------
const view = Object.assign({ by: 'rule', includeSystem: false }, readStore(VIEW_KEY, {}) || {});
const filters = { severities: new Set(SEVERITIES), categories: new Set(CATEGORIES), text: '', showSuppressed: false };
const openGroups = new Set();
const closedGroups = new Set();
const expanded = new Set();

export function advisorPage({ liveList, showResource }) {
  const signal = state.pageAbort.signal;
  const context = state.context;
  const namespace = state.namespace;
  const production = isProduction(context);
  const scopeText = namespace === '*' ? 'all namespaces' : `namespace ${namespace}`;

  const includeSystem = el('input', { type: 'checkbox', checked: view.includeSystem });
  const controls = namespace === '*' ? el('label', { class: 'inline-label', title: 'kube-system, kube-public and kube-node-lease run Kubernetes itself; their findings are expected.' }, includeSystem, ' Include kube-* namespaces') : null;
  const root = page('Advisor', `Reliability, security, efficiency and hygiene checks for ${labelFor(context)} · ${scopeText}, with the Pod Security Standards level of every workload. Fixes open a review; nothing changes until you apply it.`, controls);
  const header = el('div', { class: 'advisor-header' }, loading('Reading workloads, services and policies…'));
  const notes = el('div', { class: 'advisor-notes' });
  const namespacesHost = el('div');
  const toolbar = el('div', { class: 'advisor-toolbar' });
  const list = el('div', { class: 'advisor-list' });
  root.append(header, notes, namespacesHost, toolbar, list);

  const data = {}; const errors = {}; const answered = new Set();
  let result = null; let settled = false; let timer = null;
  let headerSignature = ''; let listSignature = '';

  const recompute = () => {
    timer = null;
    if (signal.aborted) return;
    const objects = {};
    for (const resource of RESOURCES) if (Array.isArray(data[resource])) objects[resource] = data[resource];
    result = analyze(objects, { namespace, production, includeSystem: view.includeSystem });
    lastResults.set(context, result);
    draw();
  };
  const schedule = () => { if (!settled) return; if (!timer) timer = setTimeout(recompute, 250); };
  const settle = () => { if (settled || signal.aborted) return; settled = true; recompute(); };
  const settleTimer = setTimeout(settle, SETTLE_MS);
  // The cached analysis is only trusted while this page keeps it up to date.
  signal.addEventListener('abort', () => { clearTimeout(settleTimer); clearTimeout(timer); if (lastResults.get(context) === result) lastResults.delete(context); }, { once: true });

  for (const resource of RESOURCES) {
    liveList({ resource, context, namespace: CLUSTER_SCOPED.has(resource) ? '*' : namespace, signal,
      onData: items => { data[resource] = items; delete errors[resource]; answered.add(resource); if (answered.size === RESOURCES.length) settle(); schedule(); },
      onError: error => { delete data[resource]; errors[resource] = error?.message || 'unavailable'; answered.add(resource); if (answered.size === RESOURCES.length) settle(); schedule(); } });
  }
  includeSystem.addEventListener('change', () => { view.includeSystem = includeSystem.checked; writeStore(VIEW_KEY, view); headerSignature = listSignature = ''; recompute(); });

  function drawHeader(score, suppressed) {
    const counts = pssCounts(result.pss);
    const total = result.pss.length;
    const categoryRows = CATEGORIES.map(category => {
      const value = score.categories[category];
      const failed = value.critical + value.warning + value.info;
      return el('div', { class: 'advisor-category' },
        el('span', { class: 'advisor-category-name', text: category }),
        el('span', { class: 'meter-bar' }, el('span', { class: 'meter-fill', 'data-level': gradeLevel(value.grade) === 'good' ? '' : gradeLevel(value.grade), style: `width:${value.score ?? 0}%` })),
        el('span', { class: 'advisor-category-score', text: value.score === null ? '—' : `${value.score} · ${value.grade}` }),
        el('span', { class: 'advisor-category-count muted', text: value.score === null ? 'no checks' : failed ? plural(failed, 'finding') : 'all passed' }));
    });
    const formula = el('span', { class: 'advisor-help', tabindex: '0', role: 'note', title: SCORE_FORMULA, 'aria-label': SCORE_FORMULA, text: '?' });
    const scoreBox = el('div', { class: 'advisor-score', title: SCORE_FORMULA },
      el('div', { class: 'advisor-ring-wrap' }, ring(score.score, score.grade), el('div', { class: 'advisor-ring-text' }, el('strong', { text: score.grade }), el('small', { text: score.score === null ? 'no checks' : `${score.score} / 100` }))),
      el('div', { class: 'advisor-score-facts' },
        el('div', { class: 'advisor-score-title' }, el('span', { text: namespace === '*' ? 'Cluster score' : 'Namespace score' }), formula),
        el('div', { class: 'advisor-severity-counts' }, SEVERITIES.map(severity => el('span', {}, el('i', { class: `severity-dot ${severity}` }), `${score[severity]} ${severity}`))),
        el('div', { class: 'muted', text: `${plural(score.checks, 'check')} on ${plural(total, 'workload')}${suppressed.size ? ` · ${suppressed.size} suppressed` : ''}` }),
        production ? badge('production rules on', 'bad') : null));
    const pssBar = el('div', { class: 'health-bar advisor-pss-bar', role: 'img', 'aria-label': `Pod Security Standards: ${counts.restricted} restricted, ${counts.baseline} baseline, ${counts.privileged} privileged` },
      [['restricted', 'good'], ['baseline', 'warn'], ['privileged', 'bad']].filter(([level]) => counts[level]).map(([level, cls]) => el('span', { class: `segment ${cls}`, style: `width:${(100 * counts[level]) / total}%`, title: `${counts[level]} ${level}` })));
    const pss = el('div', { class: 'advisor-pss' },
      el('div', { class: 'advisor-score-title' }, el('span', { text: 'Pod Security Standards' }), el('span', { class: 'advisor-help', tabindex: '0', role: 'note', title: 'The level each workload\'s pod template meets, per the upstream definitions: privileged (no restrictions), baseline (prevents known privilege escalations), restricted (hardened best practice).', text: '?' })),
      total ? pssBar : el('div', { class: 'muted', text: 'No workloads in scope' }),
      el('div', { class: 'advisor-pss-legend' }, [...PSS_LEVELS].reverse().map(level => el('button', { type: 'button', class: 'advisor-pss-item', title: `Show the ${level} workloads`, onclick: () => { view.by = 'workload'; writeStore(VIEW_KEY, view); filters.text = `pss:${level}`; listSignature = ''; drawToolbar(); drawList(); } }, pssBadge(level), el('strong', { text: String(counts[level]) })))));
    header.replaceChildren(scoreBox, el('div', { class: 'advisor-categories' }, categoryRows), pss);

    const failedFeeds = Object.entries(errors);
    const pending = RESOURCES.filter(resource => !answered.has(resource));
    notes.replaceChildren(...[
      failedFeeds.length ? info(`Some checks were skipped because these could not be listed: ${failedFeeds.map(([resource, message]) => `${resource} (${message})`).join('; ')}.`, 'info') : null,
      pending.length ? info(`Still waiting for ${pending.join(', ')}; the checks that need them are skipped for now.`, 'info') : null].filter(Boolean));

    if (namespace === '*' && score.namespaces.length > 1) {
      const rows = score.namespaces.map(entry => {
        const row = el('button', { type: 'button', class: 'advisor-ns-row', title: `Show only ${entry.namespace}` },
          el('span', { class: 'advisor-ns-name', text: entry.namespace }),
          gradeChip(entry.grade, 'small'),
          el('span', { class: 'meter-bar' }, el('span', { class: 'meter-fill', 'data-level': gradeLevel(entry.grade) === 'good' ? '' : gradeLevel(entry.grade), style: `width:${entry.score ?? 0}%` })),
          el('span', { class: 'advisor-ns-score', text: entry.score === null ? '—' : String(entry.score) }),
          el('span', { class: 'advisor-ns-counts' }, SEVERITIES.map(severity => (entry[severity] ? el('span', {}, el('i', { class: `severity-dot ${severity}` }), String(entry[severity])) : null))));
        row.addEventListener('click', () => {
          const select = $('#namespace');
          if (![...select.options].some(option => option.value === entry.namespace)) select.append(el('option', { value: entry.namespace, text: entry.namespace }));
          select.value = entry.namespace; select.dispatchEvent(new Event('change'));
        });
        return row;
      });
      namespacesHost.replaceChildren(el('details', { class: 'advisor-namespaces panel', ...(score.namespaces.length <= 12 ? { open: '' } : {}) },
        el('summary', { class: 'panel-heading' }, el('span', { text: `Namespaces (${score.namespaces.length})` }), el('span', { class: 'muted', text: 'Lowest score first · click to focus one' })),
        el('div', { class: 'advisor-ns-grid' }, rows)));
    } else namespacesHost.replaceChildren();
  }

  function drawToolbar() {
    const all = result.findings;
    const suppressed = suppressedFor(context);
    const visible = all.filter(finding => !suppressed.has(finding.id));
    const by = el('div', { class: 'tab-buttons advisor-by', role: 'group', 'aria-label': 'Group findings' }, [['rule', 'By rule'], ['workload', 'By workload']].map(([id, label]) => {
      const node = button(label, () => { view.by = id; writeStore(VIEW_KEY, view); listSignature = ''; drawToolbar(); drawList(); }, `compact${view.by === id ? ' active' : ''}`);
      node.setAttribute('aria-pressed', String(view.by === id));
      return node;
    }));
    const toggle = (set, value) => () => { if (set.has(value)) set.delete(value); else set.add(value); listSignature = ''; drawToolbar(); drawList(); };
    const severityChips = SEVERITIES.map(severity => chip(`${severityLabel[severity]} ${visible.filter(f => f.severity === severity).length}`, filters.severities.has(severity), severity, toggle(filters.severities, severity)));
    const categoryChips = CATEGORIES.map(category => chip(`${category} ${visible.filter(f => f.category === category).length}`, filters.categories.has(category), 'category', toggle(filters.categories, category)));
    const search = el('input', { type: 'search', class: 'advisor-search', placeholder: 'Filter findings (name, rule, pss:baseline)', 'aria-label': 'Filter findings', value: filters.text });
    search.addEventListener('input', () => { filters.text = search.value; listSignature = ''; drawList(); });
    const showSuppressed = el('input', { type: 'checkbox', checked: filters.showSuppressed });
    showSuppressed.addEventListener('change', () => { filters.showSuppressed = showSuppressed.checked; listSignature = ''; drawList(); });
    const hadFocus = toolbar.contains(document.activeElement) && document.activeElement?.classList.contains('advisor-search');
    toolbar.replaceChildren(by,
      el('div', { class: 'chips filter-chips advisor-chips', role: 'group', 'aria-label': 'Severity' }, severityChips),
      el('div', { class: 'chips filter-chips advisor-chips', role: 'group', 'aria-label': 'Category' }, categoryChips),
      search,
      el('label', { class: 'inline-label' }, showSuppressed, ` Show suppressed (${all.length - visible.length})`));
    if (hadFocus) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
  }

  function actions(finding, suppressed) {
    const isSuppressed = suppressed.has(finding.id);
    const copy = finding.patch || finding.manifest ? copyButton(() => patchText(finding, context), finding.manifest ? 'Copy manifest' : 'Copy patch') : null;
    if (copy) copy.title = finding.manifest ? 'Copy the manifest that creates the missing object' : 'Copy a kubectl patch command';
    const fix = finding.patch || finding.manifest ? button('Fix…', task(() => openFix(finding, context)), 'compact') : null;
    if (fix) fix.title = 'Open the change in a review; nothing is applied until you press Apply';
    const suppress = button(isSuppressed ? 'Unsuppress' : 'Suppress', () => { setSuppressed(context, finding.id, !isSuppressed); headerSignature = listSignature = ''; draw(); }, 'compact quiet');
    suppress.title = isSuppressed ? 'Count this finding again' : 'Hide this finding on this cluster and count it as accepted';
    return el('span', { class: 'advisor-actions' }, copy, fix, suppress);
  }
  const objectLink = finding => link(finding.name, () => openObject(finding, showResource), `Open ${finding.kind} ${finding.name}`);

  function ruleGroup(group, suppressed) {
    const rule = group.rule;
    const rows = group.findings.map(finding => el('div', { class: `advisor-row${suppressed.has(finding.id) ? ' suppressed' : ''}` },
      el('span', { class: 'advisor-what' }, el('span', { class: 'problem-kind', text: finding.kind }), objectLink(finding)),
      el('span', { class: 'advisor-ns muted', text: finding.resource === 'namespaces' ? '' : finding.namespace }),
      el('span', { class: 'advisor-detail', text: finding.detail, title: finding.detail }),
      suppressed.has(finding.id) ? badge('suppressed') : el('span'),
      actions(finding, suppressed)));
    return groupNode(`rule:${rule.id}`, rule.severity !== 'info',
      [el('i', { class: `severity-dot ${rule.severity}`, title: rule.severity }), el('strong', { class: 'advisor-group-title', text: rule.title }), badge(rule.category), el('span', { class: 'advisor-count', text: String(group.findings.length) })],
      [el('div', { class: 'advisor-explain' }, el('p', {}, el('strong', { text: 'Why it matters. ' }), rule.why), el('p', {}, el('strong', { text: 'How to fix. ' }), rule.fix)), ...rows]);
  }
  function workloadGroup(group, suppressed, pssByKey) {
    const pss = pssByKey.get(`${group.resource}|${group.namespace}|${group.name}`);
    const worst = group.findings.reduce((best, finding) => (SEVERITIES.indexOf(finding.severity) < SEVERITIES.indexOf(best) ? finding.severity : best), 'info');
    const rows = group.findings.map(finding => el('div', { class: `advisor-row by-workload${suppressed.has(finding.id) ? ' suppressed' : ''}` },
      el('i', { class: `severity-dot ${finding.severity}`, title: finding.severity }),
      el('div', { class: 'advisor-finding' },
        el('div', {}, el('strong', { text: finding.title }), ' ', badge(finding.category), suppressed.has(finding.id) ? badge('suppressed') : null),
        finding.detail ? el('div', { class: 'advisor-detail-line', text: finding.detail }) : null,
        el('div', { class: 'advisor-explain-line muted' }, el('span', { text: finding.why }), ' ', el('span', { class: 'advisor-how', text: finding.fix }))),
      actions(finding, suppressed)));
    const link = el('a', { href: '#', class: 'link', onclick: event => { event.preventDefault(); event.stopPropagation(); openObject(group.findings[0], showResource); } }, group.name);
    return groupNode(`workload:${group.key}`, false,
      [el('i', { class: `severity-dot ${worst}` }), el('span', { class: 'problem-kind', text: group.kind }), el('strong', { class: 'advisor-group-title' }, link), group.resource === 'namespaces' ? null : el('span', { class: 'muted', text: group.namespace }), pss ? pssBadge(pss.level) : null, el('span', { class: 'advisor-count', text: String(group.findings.length) })],
      rows);
  }
  function groupNode(key, defaultOpen, summaryParts, bodyParts) {
    const open = openGroups.has(key) || (defaultOpen && !closedGroups.has(key));
    const node = el('details', { class: 'advisor-group', ...(open ? { open: '' } : {}) }, el('summary', {}, summaryParts));
    // Rows are built only when the group is open: large clusters stay quick.
    const fill = () => {
      if (node.dataset.filled) return;
      node.dataset.filled = '1';
      const rows = bodyParts.filter(part => part.classList?.contains('advisor-row'));
      const others = bodyParts.filter(part => !part.classList?.contains('advisor-row'));
      const shown = expanded.has(key) ? rows : rows.slice(0, ROWS_PER_GROUP);
      const more = rows.length > shown.length ? button(`Show ${rows.length - shown.length} more`, () => { expanded.add(key); delete node.dataset.filled; node.lastChild.remove(); fill(); }, 'compact quiet advisor-more') : null;
      node.append(el('div', { class: 'advisor-group-body' }, others, shown, more));
    };
    if (open) fill();
    node.addEventListener('toggle', () => {
      if (node.open) { openGroups.add(key); closedGroups.delete(key); fill(); } else { openGroups.delete(key); closedGroups.add(key); }
    });
    return node;
  }

  function drawList() {
    const suppressed = suppressedFor(context);
    const pssMatch = /(?:^|\s)pss:(privileged|baseline|restricted)(?=\s|$)/.exec(filters.text);
    const text = filters.text.replace(/(?:^|\s)pss:\S*/g, ' ');
    const pssByKey = new Map(result.pss.map(entry => [`${entry.resource}|${entry.namespace}|${entry.name}`, entry]));
    let shown = filterFindings(result.findings, { ...filters, text, suppressed });
    if (pssMatch) shown = shown.filter(finding => pssByKey.get(`${finding.resource}|${finding.namespace}|${finding.name}`)?.level === pssMatch[1]);
    const signature = `${view.by}|${filters.text}|${[...suppressed].join(',')}|${shown.map(finding => `${finding.id}:${finding.detail}`).join(';')}`;
    if (signature === listSignature) return;
    listSignature = signature;
    if (!result.findings.length) {
      list.replaceChildren(empty(result.checks.length ? 'Nothing to improve' : 'Nothing to check here', result.checks.length ? `All ${plural(result.checks.length, 'check')} passed in ${scopeText}.` : `No workloads, services or policies in ${scopeText}.`, undefined, result.checks.length ? '✓' : '◈'));
      return;
    }
    if (!shown.length) { list.replaceChildren(empty('No findings match these filters', 'Change the severity, category or text filter, or show suppressed findings.', undefined, '⌕')); return; }
    const groups = groupFindings(shown, view.by);
    list.replaceChildren(el('div', { class: 'advisor-list-head muted', text: `${plural(shown.length, 'finding')} in ${plural(groups.length, view.by === 'rule' ? 'rule' : 'object')}` }),
      ...groups.map(group => (view.by === 'rule' ? ruleGroup(group, suppressed) : workloadGroup(group, suppressed, pssByKey))));
  }

  function draw() {
    if (!result) return;
    const suppressed = suppressedFor(context);
    const score = scoreOf(result.checks, suppressed);
    const signature = JSON.stringify([score, pssCounts(result.pss), Object.keys(errors), RESOURCES.filter(resource => !answered.has(resource)), view.includeSystem]);
    if (signature !== headerSignature) { headerSignature = signature; drawHeader(score, suppressed); drawToolbar(); }
    drawList();
  }

  return root;
}
