// Capacity: one card per node with its requests, usage and pods as tiles, the pods still waiting
// for a node, and a drain simulator that answers "what if I drain this node?" before you do.
// The placement logic lives in capacity-core.js; this module only draws it.
import { state, hooks, el, button, badge, info, page, actions, table, section, readStore, writeStore } from './kit.js';
import { formatCPU, formatBytes, formatPercent } from './format.js';
import { buildModel, simulateDrain, fragmentation, explainPlacement, squarify, tileValues, namespaceColors, taintText } from './capacity-core.js';
import { drainDialog, selectionFor } from './ops.js';

const PALETTE_SIZE = 10;
const BASIS_STORE = 'rubban.capacity.basis';
// Nodes picked for the simulator, per cluster, kept while the tab is closed and reopened.
const picks = new Map();
const picksOf = context => { if (!picks.has(context)) picks.set(context, { nodes: new Set(), simulated: false }); return picks.get(context); };
const fmtOf = kind => (kind === 'cpu' ? formatCPU : formatBytes);
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

// ---- Bars -------------------------------------------------------------------------------------
// One bar: requested (solid), simulated incoming requests (hatched) and live usage (thin line).
function bar({ allocatable, requested, incoming = 0, used, label, kind }) {
  const pct = value => (allocatable > 0 ? Math.max(0, Math.min(100, (value / allocatable) * 100)) : 0);
  const over = requested + incoming > allocatable + 1e-9;
  const fmt = kind === 'pods' ? String : fmtOf(kind);
  const node = el('div', { class: `cap-bar${over ? ' over' : ''}`, role: 'img' },
    el('i', { class: 'cap-bar-req', style: `width:${pct(requested)}%` }),
    incoming ? el('i', { class: 'cap-bar-add', style: `left:${pct(requested)}%;width:${Math.max(0.8, pct(requested + incoming) - pct(requested))}%` }) : null,
    Number.isFinite(used) ? el('i', { class: 'cap-bar-used', style: `width:${pct(used)}%` }) : null);
  const total = requested + incoming;
  const text = incoming
    ? `${fmt(requested)} → ${fmt(total)} of ${fmt(allocatable)}`
    : `${fmt(requested)} of ${fmt(allocatable)}${kind === 'pods' ? '' : ` · ${formatPercent(requested, allocatable) || '0%'}`}`;
  const usedText = Number.isFinite(used) ? ` · ${fmt(used)} used` : '';
  node.setAttribute('aria-label', `${label}: ${kind === 'pods' ? `${total} of ${allocatable} pods` : `${fmt(total)} requested of ${fmt(allocatable)} allocatable${usedText}`}`);
  return el('div', { class: 'cap-meter' }, el('div', { class: 'cap-meter-head' }, el('span', { text: label }), el('span', { class: `cap-meter-value${over ? ' over' : ''}`, text: `${text}${kind === 'pods' ? '' : usedText}` })), node);
}

// ---- Tooltip ----------------------------------------------------------------------------------
function createTip(signal) {
  const tip = el('div', { class: 'cap-tip hidden', role: 'tooltip' });
  document.body.append(tip);
  signal.addEventListener('abort', () => tip.remove(), { once: true });
  return {
    show(anchor, lines) {
      tip.replaceChildren(...lines.filter(Boolean).map((line, index) => el('div', { class: index ? 'cap-tip-line' : 'cap-tip-title' }, line)));
      tip.classList.remove('hidden');
      const rect = anchor.getBoundingClientRect(); const size = tip.getBoundingClientRect();
      const left = Math.max(8, Math.min(window.innerWidth - size.width - 8, rect.left + rect.width / 2 - size.width / 2));
      const top = rect.top - size.height - 6 > 8 ? rect.top - size.height - 6 : Math.min(window.innerHeight - size.height - 8, rect.bottom + 6);
      tip.style.left = `${left}px`; tip.style.top = `${top}px`;
    },
    hide() { tip.classList.add('hidden'); },
  };
}

// ---- The page ---------------------------------------------------------------------------------
export function capacityPage({ liveList, liveBadge, consumeResync, refreshView }) {
  const signal = state.pageAbort.signal;
  const context = state.context;
  const usage = hooks.usage;
  const status = liveBadge();
  const pick = picksOf(context);
  const view = { basis: readStore(BASIS_STORE, 'cpu') === 'memory' ? 'memory' : 'cpu', highlight: state.namespace === '*' ? '' : state.namespace };
  const data = { nodes: null, pods: null, pdbs: [] };
  const errors = new Map();
  const tip = createTip(signal);

  const basisButtons = ['cpu', 'memory'].map(kind => {
    const node = button(kind === 'cpu' ? 'CPU' : 'Memory', () => { view.basis = kind; writeStore(BASIS_STORE, kind); syncBasis(); draw(); }, 'cap-seg-button');
    node.dataset.kind = kind; return node;
  });
  const syncBasis = () => basisButtons.forEach(node => { const on = node.dataset.kind === view.basis; node.classList.toggle('on', on); node.setAttribute('aria-pressed', String(on)); });
  syncBasis();
  const basisControl = el('div', { class: 'cap-seg', role: 'group', 'aria-label': 'Tile size by request' }, el('span', { class: 'cap-seg-label', text: 'Tiles by' }), basisButtons);
  const controls = actions(status, basisControl, button('↻ Refresh', refreshView, 'compact'));
  controls.classList.add('cap-head-actions');
  const root = page('Capacity', `${context} · how full every node is, where each pod sits, and what draining a node would do. Cluster-wide; the namespace selector only highlights.`, controls);

  const cards = el('div', { class: 'cards cap-cards' });
  const hint = el('div');
  const notes = el('div');
  const simHost = el('section', { class: 'panel cap-sim', 'aria-label': 'Drain simulator' });
  const legend = el('div', { class: 'cap-legend', role: 'group', 'aria-label': 'Namespaces' });
  const grid = el('div', { class: 'cap-grid' });
  const waitingHost = el('div');
  root.append(cards, hint, notes, simHost,
    el('div', { class: 'section-label' }, el('h2', { text: 'Nodes' }), el('span', { text: 'Bars: requested of allocatable, the thin line is live usage. Tiles: pods sized by their request.' })),
    legend, grid, waitingHost);
  grid.append(el('div', { class: 'loading', text: 'Loading nodes and pods…' }));

  let colors = new Map();
  const colorOf = ns => `var(--cap-ns-${colors.get(ns) ?? 0})`;
  let model = null; let result = null;

  // ---- Summary cards and the fragmentation hint -------------------------------------------------
  function summary() {
    const t = model.totals;
    let usedCPU = 0; let usedMemory = 0; let measured = 0;
    for (const node of model.nodes) { const sample = usage.node(node.name); if (sample) { usedCPU += sample.cpu; usedMemory += sample.memory; measured++; } }
    const usedText = (value, fmt, total) => (measured ? `${fmt(value)} used (${formatPercent(value, total) || '0%'})${measured < model.nodes.length ? ` on ${measured} of ${model.nodes.length} nodes` : ''}` : usage.available === false ? 'usage unavailable (metrics-server)' : 'waiting for usage…');
    const frag = fragmentation(model);
    const card = (label, value, detail, accent) => el('div', { class: 'card', style: `--card-accent:var(--${accent})` }, el('div', { class: 'card-label', text: label }), el('div', { class: 'card-value', text: value }), el('div', { class: 'card-detail', text: detail }));
    const largest = frag.largest;
    cards.replaceChildren(
      card('CPU requested', `${formatPercent(t.requested.cpu, t.allocatable.cpu) || '0%'}`, `${formatCPU(t.requested.cpu)} of ${formatCPU(t.allocatable.cpu)} allocatable · ${usedText(usedCPU, formatCPU, t.allocatable.cpu)}`, 'info'),
      card('Memory requested', `${formatPercent(t.requested.memory, t.allocatable.memory) || '0%'}`, `${formatBytes(t.requested.memory)} of ${formatBytes(t.allocatable.memory)} allocatable · ${usedText(usedMemory, formatBytes, t.allocatable.memory)}`, 'teal'),
      card('Pods', `${t.requested.pods} / ${t.allocatable.pods}`, `${plural(model.nodes.length, 'node')} · ${model.waiting.length ? `${model.waiting.length} waiting for a node` : 'none waiting for a node'}`, 'good'),
      card('Largest free block', largest.nodes ? `${formatCPU(largest.cpu.value)} · ${formatBytes(largest.memory.value)}` : '—', largest.nodes ? `CPU on ${largest.cpu.node || '—'}, memory on ${largest.memory.node || '—'} · ${largest.untaintedOnly ? 'nodes without taints' : 'schedulable nodes'}` : 'No schedulable node', 'magenta'));
    hint.replaceChildren(...(frag.hint ? [info(frag.hint, 'warn')] : []));
  }

  // ---- Node cards -------------------------------------------------------------------------------
  function tileLines(facts, node) {
    const sample = usage.pod(facts.pod);
    const where = result ? result.placed.find(p => p.key === facts.key) : null;
    const stuck = result ? result.unplaced.find(p => p.key === facts.key) : null;
    return [
      `${facts.namespace}/${facts.name}`,
      `${facts.owner ? `${facts.owner.kind} ${facts.owner.name}` : 'No controller'}${facts.problem ? ` · ${facts.problem}` : ''}`,
      `Requests: ${formatCPU(facts.requests.cpu)} CPU · ${formatBytes(facts.requests.memory)} memory${facts.requests.cpu || facts.requests.memory ? '' : ' (none set)'}`,
      sample ? `Usage: ${formatCPU(sample.cpu)} CPU · ${formatBytes(sample.memory)} memory` : 'Usage: not reported',
      node && result?.drained.includes(node) ? (where ? `Drain: would move to ${where.to}` : stuck ? `Drain: would not fit (${stuck.message})` : facts.kind === 'daemonset' ? 'Drain: DaemonSet pod, stays' : facts.kind === 'mirror' ? 'Drain: static pod, stays' : facts.kind === 'unmanaged' ? 'Drain: no controller, deleted for good' : '') : '',
    ];
  }
  function tiles(entry) {
    const pods = entry.pods;
    const height = Math.round(Math.max(56, Math.min(220, 26 * Math.sqrt(pods.length || 1))));
    const box = el('div', { class: 'cap-tiles', style: `height:${height}px` });
    if (!pods.length) { box.append(el('div', { class: 'cap-tiles-empty', text: 'No running pods' })); return box; }
    const values = tileValues(pods, view.basis);
    const nodes = pods.map((facts, index) => {
      const dim = view.highlight && facts.namespace !== view.highlight;
      const moving = result?.drained.includes(entry.name);
      const fate = moving ? (result.unplaced.some(p => p.key === facts.key) ? 'stuck' : result.placed.some(p => p.key === facts.key) ? 'moves' : '') : '';
      const tile = el('button', { type: 'button', class: `cap-tile${facts.problem ? ' problem' : ''}${dim ? ' dim' : ''}${fate ? ` ${fate}` : ''}`, style: `--ns:${colorOf(facts.namespace)}`, 'data-key': facts.key, 'aria-label': `${facts.namespace}/${facts.name}${facts.problem ? `, ${facts.problem}` : ''}, requests ${formatCPU(facts.requests.cpu)} CPU and ${formatBytes(facts.requests.memory)} memory` },
        el('span', { class: 'cap-tile-name', text: facts.name }));
      const show = () => tip.show(tile, tileLines(facts, entry.name));
      tile.addEventListener('mouseenter', show); tile.addEventListener('focus', show);
      tile.addEventListener('mouseleave', tip.hide); tile.addEventListener('blur', tip.hide);
      tile.addEventListener('click', () => { tip.hide(); hooks.showResource(facts.pod, 'pods'); });
      tile.dataset.index = String(index);
      return tile;
    });
    box.append(...nodes);
    // Laid out at the box's real size, again whenever the card is resized.
    let laid = '';
    const layout = () => {
      const width = box.clientWidth || 320; const key = `${width}x${height}`;
      if (key === laid) return; laid = key;
      for (const rect of squarify(values, width, height)) {
        const tile = nodes[rect.index];
        tile.style.left = `${(rect.x / width) * 100}%`; tile.style.top = `${(rect.y / height) * 100}%`;
        tile.style.width = `${(rect.w / width) * 100}%`; tile.style.height = `${(rect.h / height) * 100}%`;
        tile.classList.toggle('tiny', rect.w < 46 || rect.h < 16);
      }
    };
    layout();
    if (typeof ResizeObserver !== 'undefined') { const observer = new ResizeObserver(layout); observer.observe(box); signal.addEventListener('abort', () => observer.disconnect(), { once: true }); }
    return box;
  }
  function stateBadges(entry) {
    const out = [];
    out.push(badge(entry.ready ? 'Ready' : 'Not ready', entry.ready ? 'good' : 'bad'));
    if (entry.cordoned) out.push(badge('Cordoned', 'warn'));
    for (const pressure of entry.pressures) out.push(badge(pressure, 'warn'));
    if (entry.taints.length) { const node = badge(plural(entry.taints.length, 'taint'), 'info'); node.title = entry.taints.map(taintText).join('\n'); out.push(node); }
    return out;
  }
  function nodeCard(entry) {
    const sample = usage.node(entry.name);
    const drained = result?.drained.includes(entry.name);
    const destination = result?.destinations.find(d => d.name === entry.name && d.incoming.length);
    const incoming = destination ? { cpu: destination.after.cpu - destination.before.cpu, memory: destination.after.memory - destination.before.memory, pods: destination.after.pods - destination.before.pods } : null;
    const check = el('input', { type: 'checkbox', checked: pick.nodes.has(entry.name), 'aria-label': `Pick ${entry.name} for the drain simulation` });
    check.addEventListener('change', () => { if (check.checked) pick.nodes.add(entry.name); else pick.nodes.delete(entry.name); pick.simulated = false; result = null; draw(); });
    const meta = [entry.roles.length ? entry.roles.join(', ') : 'worker', entry.zone, entry.instanceType].filter(Boolean).join(' · ');
    return el('article', { class: `cap-node${drained ? ' draining' : ''}${destination ? ' destination' : ''}${pick.nodes.has(entry.name) ? ' picked' : ''}`, 'aria-label': `Node ${entry.name}` },
      el('header', { class: 'cap-node-head' },
        el('button', { type: 'button', class: 'cap-node-name', title: 'Open node details', onclick: () => hooks.showResource(entry.node, 'nodes') }, entry.name),
        el('span', { class: 'cap-node-badges' }, drained ? badge('Draining (simulated)', 'warn') : destination ? badge(`+${plural(destination.incoming.length, 'pod')} (simulated)`, 'info') : null, stateBadges(entry))),
      el('div', { class: 'cap-node-meta', text: meta }),
      bar({ label: 'CPU', kind: 'cpu', allocatable: entry.allocatable.cpu, requested: entry.requested.cpu, incoming: incoming?.cpu || 0, used: sample ? sample.cpu : NaN }),
      bar({ label: 'Memory', kind: 'memory', allocatable: entry.allocatable.memory, requested: entry.requested.memory, incoming: incoming?.memory || 0, used: sample ? sample.memory : NaN }),
      bar({ label: 'Pods', kind: 'pods', allocatable: entry.allocatable.pods, requested: entry.requested.pods, incoming: incoming?.pods || 0 }),
      tiles(entry),
      el('footer', { class: 'cap-node-foot' },
        el('label', { class: 'inline-label' }, check, 'Pick for drain simulation'),
        el('span', { class: 'muted', text: entry.finished ? `${plural(entry.finished, 'finished pod')} not counted` : '' })));
  }

  // ---- Legend -----------------------------------------------------------------------------------
  function drawLegend() {
    const counts = new Map();
    for (const node of model.nodes) for (const pod of node.pods) counts.set(pod.namespace, (counts.get(pod.namespace) || 0) + 1);
    for (const pod of model.waiting) counts.set(pod.namespace, (counts.get(pod.namespace) || 0) + 1);
    const names = [...counts.keys()].sort();
    legend.replaceChildren(...names.map(ns => {
      const on = view.highlight === ns;
      const node = el('button', { type: 'button', class: `cap-legend-item${on ? ' on' : ''}${view.highlight && !on ? ' dim' : ''}`, 'aria-pressed': String(on), title: on ? 'Show every namespace' : `Highlight ${ns}` }, el('i', { class: 'cap-swatch', style: `--ns:${colorOf(ns)}` }), ns, el('small', { text: String(counts.get(ns)) }));
      node.addEventListener('click', () => { view.highlight = on ? '' : ns; draw(); });
      return node;
    }), el('span', { class: 'cap-legend-key' }, el('i', { class: 'cap-swatch problem' }), 'problem pod'));
  }

  // ---- Waiting lane -----------------------------------------------------------------------------
  function drawWaiting() {
    if (!model.waiting.length) { waitingHost.replaceChildren(); return; }
    const rows = model.waiting.map(facts => {
      const check = explainPlacement(facts, model);
      const node = el('button', { type: 'button', class: `cap-wait${view.highlight && facts.namespace !== view.highlight ? ' dim' : ''}`, onclick: () => hooks.showResource(facts.pod, 'pods') },
        el('i', { class: 'cap-swatch', style: `--ns:${colorOf(facts.namespace)}` }),
        el('span', { class: 'cap-wait-name' }, el('strong', { text: facts.name }), el('small', { class: 'muted', text: ` ${facts.namespace}` })),
        el('span', { class: 'cap-wait-req', text: `${formatCPU(facts.requests.cpu)} · ${formatBytes(facts.requests.memory)}` }),
        el('span', { class: 'cap-wait-why' }, el('span', { text: facts.reason }), el('small', { class: 'muted', text: check.fits.length ? `Rubban's check: it would fit on ${check.fits.join(', ')} now (something this view does not model holds it, or the scheduler has not retried yet).` : `Rubban's check: ${check.rejections.map(r => `${r.node}: ${r.reason.text}`).join(' · ')}` })));
      return node;
    });
    waitingHost.replaceChildren(el('div', { class: 'section-label' }, el('h2', { text: `Waiting for a node (${model.waiting.length})` }), el('span', { text: 'Pods the scheduler has not placed, with its reason' })), el('div', { class: 'panel cap-waiting' }, rows));
  }

  // ---- Drain simulator --------------------------------------------------------------------------
  const nodeItem = name => model?.byName.get(name)?.node;
  function simulate() {
    result = pick.simulated && pick.nodes.size ? simulateDrain(model, [...pick.nodes].filter(name => model.byName.has(name)), { pdbs: data.pdbs, podItems: data.pods }) : null;
  }
  function drawSimulator() {
    const chosen = [...pick.nodes].filter(name => model.byName.has(name));
    const run = button(chosen.length ? `Simulate drain of ${chosen.length === 1 ? chosen[0] : plural(chosen.length, 'node')}` : 'Simulate drain', () => { pick.simulated = true; simulate(); draw(); simHost.scrollIntoView({ block: 'nearest' }); }, 'primary compact');
    run.disabled = !chosen.length;
    const clear = button('Clear', () => { pick.nodes.clear(); pick.simulated = false; result = null; draw(); }, 'quiet compact');
    clear.disabled = !chosen.length;
    const picker = el('select', { class: 'compact-select', 'aria-label': 'Add a node to the simulation' }, el('option', { value: '', text: 'Add a node…' }), model.nodes.filter(n => !pick.nodes.has(n.name)).map(n => el('option', { value: n.name, text: n.name })));
    picker.addEventListener('change', () => { if (picker.value) { pick.nodes.add(picker.value); pick.simulated = false; result = null; draw(); } });
    const chips = chosen.map(name => el('span', { class: 'chip cap-pick' }, name, el('button', { type: 'button', class: 'cap-pick-remove', 'aria-label': `Remove ${name} from the simulation`, onclick: () => { pick.nodes.delete(name); pick.simulated = false; result = null; draw(); } }, '×')));
    const head = el('div', { class: 'panel-heading' }, el('span', { text: 'What if I drain…' }), el('span', { class: 'cap-sim-controls' }, chips, picker, run, clear));
    const body = el('div', { class: 'panel-body' });
    simHost.replaceChildren(head, body);
    if (!result) {
      body.append(el('p', { class: 'muted cap-sim-intro', text: chosen.length ? 'Press Simulate to see whether the other nodes can take these pods. Nothing is changed in the cluster.' : 'Pick one or more nodes (the checkbox on a node card, or Add a node…) and simulate draining them: Rubban places each evicted pod on the remaining nodes the way the scheduler would, and tells you what would not fit and why. Nothing is changed in the cluster.' }));
      return;
    }
    const verdict = result.verdict;
    body.append(el('div', { class: `cap-verdict ${verdict.level}`, role: 'status' },
      el('strong', { class: 'cap-verdict-head', text: verdict.headline }),
      verdict.lines.length ? el('ul', {}, verdict.lines.map(line => el('li', { text: line }))) : null));
    body.append(el('div', { class: 'form-actions start cap-sim-actions' }, result.drained.map(name => button(`Drain ${name}…`, () => { const item = nodeItem(name); if (item) drainDialog(selectionFor(item, 'nodes')); }, verdict.level === 'unsafe' ? 'danger compact' : 'compact')),
      el('span', { class: 'muted', text: verdict.level === 'unsafe' ? 'Opens the real drain. The simulation says it would not go well.' : 'Opens the real drain (cordon, then evict).' })));
    // Before and after on the nodes that would receive pods.
    const targets = result.destinations.filter(d => d.incoming.length);
    if (targets.length) {
      body.append(el('h3', { class: 'mini-title', text: 'Destination nodes, before → after' }), el('div', { class: 'cap-after' }, targets.map(d => el('div', { class: 'cap-after-row' },
        el('strong', { class: 'cap-after-name', text: d.name }), el('span', { class: 'muted', text: `+${plural(d.incoming.length, 'pod')}` }),
        bar({ label: 'CPU', kind: 'cpu', allocatable: d.allocatable.cpu, requested: d.before.cpu, incoming: d.after.cpu - d.before.cpu }),
        bar({ label: 'Memory', kind: 'memory', allocatable: d.allocatable.memory, requested: d.before.memory, incoming: d.after.memory - d.before.memory }),
        bar({ label: 'Pods', kind: 'pods', allocatable: d.allocatable.pods, requested: d.before.pods, incoming: d.after.pods - d.before.pods })))));
    }
    // Where every pod would go.
    const rows = [...result.unplaced.map(p => ({ ...p, outcome: 'stuck' })), ...result.placed.map(p => ({ ...p, outcome: 'moves' })), ...result.lost.map(p => ({ ...p, outcome: 'lost' })), ...result.ignored.map(p => ({ ...p, outcome: 'stays' }))];
    const outcomeText = row => (row.outcome === 'moves' ? `→ ${row.to}` : row.outcome === 'stuck' ? 'Would not fit' : row.outcome === 'lost' ? 'Deleted, not recreated' : 'Stays on the node');
    const view2 = table(rows, [
      { id: 'pod', title: 'Pod', class: 'name', locked: true, render: row => el('span', { class: 'cap-pod-cell' }, el('i', { class: 'cap-swatch', style: `--ns:${colorOf(row.namespace)}` }), row.name), sort: row => row.name },
      { id: 'namespace', title: 'Namespace', render: row => row.namespace, sort: row => row.namespace },
      { id: 'cpu', title: 'CPU request', class: 'num', render: row => formatCPU(row.requests.cpu), sort: row => row.requests.cpu },
      { id: 'memory', title: 'Memory request', class: 'num', render: row => formatBytes(row.requests.memory), sort: row => row.requests.memory },
      { id: 'from', title: 'From', render: row => row.node, sort: row => row.node },
      { id: 'outcome', title: 'Outcome', render: row => badge(outcomeText(row), row.outcome === 'moves' ? 'good' : row.outcome === 'stuck' || row.outcome === 'lost' ? 'bad' : ''), sort: row => ['stuck', 'lost', 'moves', 'stays'].indexOf(row.outcome) },
      { id: 'why', title: 'Why / notes', class: 'wrap', render: row => [row.outcome === 'stuck' ? row.message : row.why || '', row.emptyDir ? 'emptyDir data is lost' : '', row.claims?.length ? `uses PVC ${row.claims.join(', ')}: a volume tied to this node or zone may not move` : ''].filter(Boolean).join(' · ') || '—' },
    ], row => hooks.showResource(row.pod, 'pods'), { key: row => row.key, stamp: row => `${row.outcome}|${row.to || ''}|${row.message || ''}`, placeholder: 'Filter pods…', searchText: row => `${row.name} ${row.namespace} ${row.to || ''} ${row.outcome}` });
    body.append(el('h3', { class: 'mini-title', text: `Where each pod would go (${rows.length})` }), view2);
    if (result.pdbs.length) body.append(el('h3', { class: 'mini-title', text: 'Pod disruption budgets' }), el('ul', { class: 'cap-pdbs' }, result.pdbs.map(p => el('li', {}, badge(p.level === 'ok' ? 'OK' : p.level === 'waits' ? 'Slows the drain' : 'Blocks the drain', p.level === 'ok' ? 'good' : p.level === 'waits' ? 'warn' : 'bad'), ' ', p.text))));
    body.append(section('How the simulation works', el('div', { class: 'cap-explain' },
      el('p', { text: 'Each pod on the drained nodes is put back on another node the way the Kubernetes scheduler filters nodes: CPU and memory requests (with init containers, sidecars and pod overhead) against what is left of allocatable, the allocatable pod count, the pod\'s node selector and required node affinity (In, NotIn, Exists, DoesNotExist, Gt, Lt, matchFields), and taints against its tolerations (NoSchedule and NoExecute). Cordoned and not-ready nodes take nothing. Higher-priority and bigger pods are placed first, each on the node with the most room left.' }),
      el('p', { text: 'DaemonSet and static pods stay where they are; pods without a controller are deleted and never return; disruption budgets are checked against how many healthy pods they allow to go right now.' }),
      el('p', { text: 'It is an approximation. Not modelled: inter-pod affinity and anti-affinity, topology spread constraints, volumes bound to a node or zone (local volumes, zonal disks), host ports, extended resources such as GPUs, preemption, and the order in which the real scheduler sees replacement pods. A tight result may still fail; an unsafe one will.' })), { open: false }));
  }

  // ---- Drawing ----------------------------------------------------------------------------------
  function draw() {
    if (!data.nodes || !data.pods) return;
    model = buildModel(data.nodes, data.pods);
    colors = namespaceColors([...model.nodes.flatMap(n => n.pods.map(p => p.namespace)), ...model.waiting.map(p => p.namespace)], PALETTE_SIZE);
    for (const name of [...pick.nodes]) if (!model.byName.has(name)) pick.nodes.delete(name);
    simulate();
    const focused = document.activeElement?.closest?.('.cap-tile')?.dataset.key;
    tip.hide();
    summary();
    drawSimulator();
    drawLegend();
    grid.replaceChildren(...(model.nodes.length ? model.nodes.map(nodeCard) : [el('div', { class: 'list-note', text: 'This cluster reports no nodes.' })]));
    drawWaiting();
    if (focused) grid.querySelector(`.cap-tile[data-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
    notes.replaceChildren(...[...errors.values()].map(message => info(message, 'error')));
  }
  let pending = null;
  const schedule = () => { if (!pending) pending = setTimeout(() => { pending = null; draw(); }, 300); };
  signal.addEventListener('abort', () => clearTimeout(pending), { once: true });
  const resync = consumeResync();
  const subscribe = (resource, onItems, optional = false) => liveList({ resource, context, namespace: '*', signal, resync,
    onStatus: value => status.track(resource, value),
    onError: error => { if (optional) { data.pdbs = []; errors.set(resource, `Disruption budgets could not be read (${error.message}); the simulation ignores them.`); } else errors.set(resource, `${resource}: ${error.message}`); if (!optional && !data[resource]) grid.replaceChildren(info(`Could not read ${resource}: ${error.message}`, 'error')); schedule(); },
    onData: items => { errors.delete(resource); onItems(items); schedule(); } });
  subscribe('nodes', items => { data.nodes = items; });
  subscribe('pods', items => { data.pods = items; });
  subscribe('poddisruptionbudgets', items => { data.pdbs = items; }, true);
  usage.onChange(schedule, signal);
  // Cached feeds deliver before the page is attached: draw at once instead of after the debounce.
  queueMicrotask(() => { if (pending && data.nodes && data.pods) { clearTimeout(pending); pending = null; draw(); } });
  return root;
}
