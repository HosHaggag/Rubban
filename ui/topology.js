// Live topology map: an interactive graph of how a namespace's Ingresses, Services, workloads,
// config and storage connect, with health on every node. The graph and its layout come from
// topology-core.js; this module draws them as SVG (pan, zoom, keyboard focus, blast-radius
// highlighting) and keeps them live from the shared watch feeds.
import { $, state, hooks, el, button, badge, actions, info, loading, empty, page, readStore, writeStore } from './kit.js';
import { resourceForKind } from './kinds.js';
import { TOPOLOGY_RESOURCES, CHOOSER_RESOURCES, LAYER_TITLES, KIND_LABEL, RESOURCE_OF, WORKLOAD_KINDS, buildGraph, layoutGraph, connectedPath, neighbourhood, matchNodes, summarizeNamespaces, nodeId } from './topology-core.js';

const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) if (value !== undefined && value !== null && value !== false) node.setAttribute(key, String(value));
  for (const child of children.flat()) if (child !== undefined && child !== null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
// 16px stroke glyphs, one per kind (same drawing style as the sidebar icons).
const GLYPHS = {
  Ingress: 'M2 8h7.5 M6.5 5l3 3-3 3 M12.5 2.5v11',
  Service: 'M13.5 8a5.5 5.5 0 1 1-11 0a5.5 5.5 0 1 1 11 0z M2.5 8h11 M8 2.5c1.5 1.6 2.2 3.4 2.2 5.5S9.5 11.9 8 13.5 M8 2.5C6.5 4.1 5.8 5.9 5.8 8s.7 3.9 2.2 5.5',
  workload: 'M8 1.8l5.5 3.1v6.2L8 14.2l-5.5-3.1V4.9z M2.5 4.9 8 8l5.5-3.1 M8 8v6.2',
  CronJob: 'M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0z M8 4.5V8l2.5 1.5',
  Job: 'M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0z M5.5 8.2l1.8 1.8 3.4-3.6',
  Pod: 'M3 3h10v10H3z M6 6h4v4H6z',
  ConfigMap: 'M2 4h4 M9 4h5 M2 12h7 M12 12h2 M2 8h1 M6 8h8 M9 4a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0z M12 12a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0z M6 8a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0z',
  Secret: 'M3.5 7.5h9v6h-9z M5.5 7.5V5.25a2.5 2.5 0 0 1 5 0V7.5 M8 10v1.2',
  PersistentVolumeClaim: 'M3 4c0-1.1 2.2-2 5-2s5 .9 5 2-2.2 2-5 2-5-.9-5-2z M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4 M3 8c0 1.1 2.2 2 5 2s5-.9 5-2',
  HorizontalPodAutoscaler: 'M8 2v12 M5 5l3-3 3 3 M5 11l3 3 3-3 M2 8h2 M12 8h2',
  PodDisruptionBudget: 'M8 1.8 13.5 4v4c0 3.2-2.3 5.5-5.5 6.4C4.8 13.5 2.5 11.2 2.5 8V4z',
  missing: 'M8 2l6.5 11.5h-13z M8 6.5v3 M8 11.6h.01',
};
const glyphOf = node => (node.missing ? GLYPHS.missing : GLYPHS[node.kind] || GLYPHS.workload);
const kindClass = kind => (kind === 'Ingress' ? 'ingress' : kind === 'Service' ? 'service' : ['ConfigMap', 'Secret', 'PersistentVolumeClaim'].includes(kind) ? 'config' : ['HorizontalPodAutoscaler', 'PodDisruptionBudget'].includes(kind) ? 'policy' : 'workload');
const kindText = node => (KIND_LABEL[node.kind] || node.kind.replace(/([a-z])([A-Z])/g, '$1 $2'));
const HEALTH_WORDS = { good: 'healthy', warn: 'degraded', bad: 'failing', missing: 'missing', idle: 'idle', none: '' };
const resourceOf = node => node.resource || resourceForKind(node.kind, node.apiVersion || '');

// Text that fits a width, measured with the page's own font.
let measure = null;
function fit(text, font, width) {
  const value = String(text || '');
  measure ||= document.createElement('canvas').getContext('2d');
  measure.font = font;
  if (measure.measureText(value).width <= width) return value;
  let low = 0; let high = value.length;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (measure.measureText(`${value.slice(0, mid)}…`).width <= width) low = mid; else high = mid - 1; }
  return `${value.slice(0, low)}…`;
}
const FONT = getComputedStyle(document.documentElement).getPropertyValue('--font') || 'Inter, sans-serif';
const MONO = getComputedStyle(document.documentElement).getPropertyValue('--mono') || 'monospace';

function tooltipOf(node) {
  if (node.missing) return `${node.kind} ${node.name} does not exist.\nReferenced by ${node.referrers.map(id => id.split('/')[0] + ' ' + id.split('/').slice(2).join('/')).join(', ')}.`;
  const lines = [`${node.kind} ${node.name}`];
  if (node.status) lines.push(node.status);
  if (node.detail) lines.push(node.detail);
  if (node.kind === 'Ingress') lines.push(...node.lines);
  if (node.pods?.dots?.length) lines.push('', ...node.pods.dots.slice(0, 12).map(dot => `${dot.health === 'good' ? '●' : dot.health === 'warn' ? '◐' : '✕'} ${dot.name}${dot.health !== 'good' && dot.reason ? ` · ${dot.reason}` : ''}`), node.pods.dots.length > 12 ? `… ${node.pods.dots.length - 12} more` : '');
  if (node.unverified) lines.push('', `Rubban cannot list ${node.kind}s here, so this reference is not checked.`);
  return lines.filter((line, i) => line !== '' || i).join('\n');
}
function edgePath(points) {
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1]; const [bx, by] = points[i];
    if (ay === by) { d += ` L${bx},${by}`; continue; }
    const dx = (bx - ax) / 2;
    d += ` C${ax + dx},${ay} ${bx - dx},${by} ${bx},${by}`;
  }
  return d;
}
function edgeTitle(edge, nodes) {
  const from = nodes.get(edge.from); const to = nodes.get(edge.to);
  const verb = { route: 'routes to', select: 'selects the pods of', scale: 'scales', budget: 'limits disruption of', tls: 'serves TLS with', config: 'uses' }[edge.type] || '→';
  return `${from.kind} ${from.name} ${verb} ${to.kind} ${to.name}${edge.missing ? ' (missing)' : ''}${edge.labels.length ? `\n${edge.labels.join('\n')}` : ''}`;
}

// ---- Canvas: SVG with pan, zoom, keyboard and highlighting ---------------------------------------
let canvasSeq = 0;
function createCanvas({ onOpen, signal, compact = false, label = 'Topology map' }) {
  const prefix = `topo${++canvasSeq}`;
  const root = el('div', { class: `topo-canvas${compact ? ' compact' : ''}`, tabindex: '-1' });
  const grid = svg('pattern', { id: `${prefix}-grid`, width: 24, height: 24, patternUnits: 'userSpaceOnUse' }, svg('circle', { class: 'topo-grid-dot', cx: 1, cy: 1, r: 1 }));
  const markers = ['none', 'warn', 'bad', 'lit'].map(tone => svg('marker', { id: `${prefix}-arrow-${tone}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse', markerUnits: 'userSpaceOnUse' }, svg('path', { class: `topo-arrow topo-arrow-${tone}`, d: 'M1,1.5 L9,5 L1,8.5 z' })));
  const view = svg('g', { class: 'topo-view' });
  const headers = svg('g', { class: 'topo-headers' });
  const edgeLayer = svg('g', { class: 'topo-edges' });
  const nodeLayer = svg('g', { class: 'topo-nodes' });
  view.append(headers, edgeLayer, nodeLayer);
  const surface = svg('svg', { class: 'topo-svg', role: 'group', 'aria-label': label }, svg('defs', {}, grid, markers), svg('rect', { class: 'topo-backdrop', width: '100%', height: '100%', fill: `url(#${prefix}-grid)` }), view);
  const zoomText = el('span', { class: 'topo-zoom-level', text: '100%' });
  const zoomIn = button('+', () => zoomBy(1.25), 'compact topo-zoom-button'); zoomIn.title = 'Zoom in (+)'; zoomIn.setAttribute('aria-label', 'Zoom in');
  const zoomOut = button('−', () => zoomBy(0.8), 'compact topo-zoom-button'); zoomOut.title = 'Zoom out (−)'; zoomOut.setAttribute('aria-label', 'Zoom out');
  const fitButton = button('Fit', () => { fitMode = 'all'; fitView(); }, 'compact topo-zoom-button'); fitButton.title = 'Fit the whole map (0)';
  root.append(surface, el('div', { class: 'topo-zoom', role: 'toolbar', 'aria-label': 'Zoom' }, zoomOut, zoomText, zoomIn, fitButton));
  if (!compact) root.append(legend());

  let t = { x: 24, y: 40, k: 1 }; let fitMode = 'readable';
  let layout = null; let nodesById = new Map(); let graph = { nodes: [], edges: [] };
  let signature = ''; let hoverId = null; let focusId = null; let selectedId = null; let matches = new Set(); let query = '';
  const nodeEls = new Map(); const edgeEls = new Map();
  const apply = () => {
    view.setAttribute('transform', `translate(${t.x.toFixed(1)} ${t.y.toFixed(1)}) scale(${t.k.toFixed(4)})`);
    grid.setAttribute('patternTransform', `translate(${t.x.toFixed(1)} ${t.y.toFixed(1)}) scale(${t.k.toFixed(4)})`);
    zoomText.textContent = `${Math.round(t.k * 100)}%`;
  };
  const size = () => ({ w: root.clientWidth || 800, h: root.clientHeight || 500 });
  const top = compact ? 0 : -34;
  // Fit shows everything; the first view of a tall map keeps the text readable (at least
  // READABLE) and starts at the top, as wide as the window allows.
  const READABLE = 0.75;
  function fitView(readable = false) {
    if (!layout) return;
    const { w, h } = size(); const pad = compact ? 16 : 28; const chrome = compact ? 34 : 40;
    const width = Math.max(layout.width, 1); const height = Math.max(layout.height - top, 1);
    const widthFit = (w - pad * 2) / width; const all = Math.min(compact ? 1 : 1.15, widthFit, (h - pad * 2 - chrome) / height);
    const k = Math.max(0.15, readable && !compact && all < READABLE ? Math.min(widthFit, READABLE) : all);
    t = { k, x: (w - width * k) / 2, y: pad + (compact ? chrome : 0) - top * k + Math.max(0, (h - pad * 2 - chrome - height * k) / 2) };
    apply();
  }
  function zoomAt(k, cx, cy) {
    const next = Math.max(0.15, Math.min(2.5, k));
    t = { k: next, x: cx - ((cx - t.x) * next) / t.k, y: cy - ((cy - t.y) * next) / t.k };
    fitMode = ''; apply();
  }
  function zoomBy(factor) { const { w, h } = size(); zoomAt(t.k * factor, w / 2, h / 2); }
  function panBy(dx, dy) { t = { ...t, x: t.x + dx, y: t.y + dy }; fitMode = ''; apply(); }
  function reveal(id, center = false) {
    const node = nodesById.get(id); if (!node) return;
    const { w, h } = size();
    const left = t.x + node.x * t.k; const right = left + node.w * t.k; const upper = t.y + node.y * t.k; const lower = upper + node.h * t.k;
    if (center) { t = { ...t, x: w / 2 - (node.x + node.w / 2) * t.k, y: h / 2 - (node.y + node.h / 2) * t.k }; fitMode = ''; apply(); return; }
    let dx = 0; let dy = 0;
    if (left < 12) dx = 12 - left; else if (right > w - 12) dx = w - 12 - right;
    if (upper < 48) dy = 48 - upper; else if (lower > h - 12) dy = h - 12 - lower;
    if (dx || dy) panBy(dx, dy);
  }

  // Pan with a drag anywhere (a click without movement still opens a node).
  let drag = null; let dragged = false;
  surface.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    dragged = false;
    drag = { x: event.clientX, y: event.clientY, tx: t.x, ty: t.y, id: event.pointerId, active: false };
  });
  surface.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x; const dy = event.clientY - drag.y;
    if (!drag.active && Math.hypot(dx, dy) < 4) return;
    if (!drag.active) { drag.active = true; surface.setPointerCapture(event.pointerId); root.classList.add('panning'); }
    t = { ...t, x: drag.tx + dx, y: drag.ty + dy }; fitMode = ''; apply();
  });
  const endDrag = event => { if (!drag || event.pointerId !== drag.id) return; if (drag.active) { dragged = true; root.classList.remove('panning'); surface.releasePointerCapture?.(event.pointerId); } drag = null; };
  surface.addEventListener('pointerup', endDrag); surface.addEventListener('pointercancel', endDrag);
  surface.addEventListener('wheel', event => {
    event.preventDefault();
    const box = surface.getBoundingClientRect();
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    zoomAt(t.k * Math.exp(-delta * 0.0018), event.clientX - box.left, event.clientY - box.top);
  }, { passive: false });
  surface.addEventListener('click', event => { if (dragged) { dragged = false; return; } if (!event.target.closest?.('.topo-node')) { selectedId = null; paint(); } });
  root.addEventListener('keydown', event => {
    if (event.target.closest?.('input, button')) return;
    const step = event.shiftKey ? 160 : 60;
    const keys = { ArrowLeft: () => panBy(step, 0), ArrowRight: () => panBy(-step, 0), ArrowUp: () => panBy(0, step), ArrowDown: () => panBy(0, -step), '+': () => zoomBy(1.25), '=': () => zoomBy(1.25), '-': () => zoomBy(0.8), _: () => zoomBy(0.8), 0: () => { fitMode = 'all'; fitView(); } };
    const action = keys[event.key];
    if (action && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); action(); }
    if (event.key === 'Escape' && (focusId || hoverId)) { hoverId = null; focusId = null; document.activeElement?.blur?.(); root.focus({ preventScroll: true }); paint(); }
  });
  const resize = new ResizeObserver(() => { if (fitMode) fitView(fitMode === 'readable'); });
  resize.observe(root);
  signal?.addEventListener('abort', () => resize.disconnect(), { once: true });

  // Highlight: the hovered or focused node's whole path; filter matches; the selected node.
  function paint() {
    const active = hoverId || focusId;
    const path = active && nodesById.has(active) ? connectedPath(graph, active) : null;
    root.classList.toggle('tracing', Boolean(path));
    root.classList.toggle('filtering', Boolean(query));
    for (const [id, node] of nodeEls) {
      node.classList.toggle('lit', Boolean(path?.nodes.has(id)));
      node.classList.toggle('match', matches.has(id));
      node.classList.toggle('selected', id === selectedId);
    }
    for (const [id, { group, line, edge }] of edgeEls) {
      const lit = Boolean(path?.edges.has(id));
      group.classList.toggle('lit', lit);
      line.setAttribute('marker-end', `url(#${prefix}-arrow-${lit && !edge.tone ? 'lit' : edge.tone || 'none'})`);
    }
  }
  function drawNode(node) {
    const w = node.w; const h = node.h;
    const classes = ['topo-node', `health-${node.health}`, `kind-${kindClass(node.kind)}`, node.missing ? 'missing' : '', node.unverified ? 'unverified' : '', node.unused ? 'unused' : ''].filter(Boolean).join(' ');
    const words = [node.missing ? `Missing ${node.kind}` : kindText(node), node.name, node.status, HEALTH_WORDS[node.health]].filter(Boolean).join(', ');
    const group = svg('g', { class: classes, transform: `translate(${node.x} ${node.y})`, tabindex: '0', role: 'button', 'aria-label': words, 'data-id': node.id },
      svg('title', {}, tooltipOf(node)),
      svg('rect', { class: 'topo-card', width: w, height: h, rx: 6 }),
      svg('rect', { class: 'topo-bar', x: 0, y: 0, width: 3.5, height: h, rx: 1.75 }),
      svg('svg', { class: 'topo-glyph', x: 12, y: 8, width: 14, height: 14, viewBox: '0 0 16 16' }, svg('path', { d: glyphOf(node) })));
    const statusText = node.missing ? 'not found' : node.status;
    const status = statusText ? fit(statusText, `500 10.5px ${FONT}`, w * 0.46) : '';
    const kindWidth = w - 44 - (status ? Math.min(w * 0.46, statusText.length * 6.2) + 8 : 0);
    group.append(svg('text', { class: 'topo-kind', x: 31, y: 19 }, fit((node.missing ? `Missing ${kindText(node)}` : kindText(node)).toUpperCase(), `600 9.5px ${FONT}`, kindWidth)));
    if (status) group.append(svg('text', { class: 'topo-status', x: w - 11, y: 19 }, status));
    group.append(svg('text', { class: 'topo-name', x: 12, y: 38 }, fit(node.name, `600 12.5px ${FONT}`, w - 24)));
    let y = 53;
    if (node.kind === 'Ingress') {
      const hosts = node.lines.length > 3 ? [...node.lines.slice(0, 2), `+${node.lines.length - 2} more hosts`] : node.lines;
      for (const host of hosts) { group.append(svg('text', { class: 'topo-hostname', x: 12, y }, fit(host, `400 10.5px ${MONO}`, w - 24))); y += 14; }
    } else {
      const detail = node.missing ? `referenced by ${node.referrers.length === 1 ? node.referrers[0].split('/')[0] + ' ' + node.referrers[0].split('/').slice(2).join('/') : `${node.referrers.length} resources`}` : node.detail;
      if (detail) group.append(svg('text', { class: 'topo-detail', x: 12, y }, fit(detail, `400 11px ${FONT}`, w - 24)));
      y += 14;
    }
    if (node.pods?.total) {
      const dots = node.pods.dots; const max = Math.floor((w - 60) / 10);
      const shown = dots.length > max ? [...dots].sort((a, b) => ({ bad: 0, warn: 1, good: 2 }[a.health] - { bad: 0, warn: 1, good: 2 }[b.health])).slice(0, max) : dots;
      shown.forEach((dot, i) => group.append(svg('circle', { class: `topo-pod pod-${dot.health}`, cx: 15.5 + i * 10, cy: h - 12, r: 3.5 })));
      const tail = `${dots.length > max ? `+${dots.length - max} · ` : ''}${node.pods.ready}/${node.pods.total}`;
      group.append(svg('text', { class: 'topo-pods-text', x: w - 11, y: h - 8.5 }, tail));
    }
    group.addEventListener('pointerenter', () => { hoverId = node.id; paint(); });
    group.addEventListener('pointerleave', () => { if (hoverId === node.id) { hoverId = null; paint(); } });
    group.addEventListener('focus', () => { focusId = node.id; reveal(node.id); paint(); });
    group.addEventListener('blur', () => { if (focusId === node.id) { focusId = null; paint(); } });
    group.addEventListener('click', () => { selectedId = node.id; paint(); onOpen(node); });
    group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectedId = node.id; paint(); onOpen(node); } });
    return group;
  }
  function update(nextLayout, nextGraph, { selected } = {}) {
    if (selected !== undefined) selectedId = selected;
    const sig = JSON.stringify([nextLayout.nodes.map(n => [n.id, n.x, n.y, n.h, n.health, n.status, n.detail, n.lines, n.pods?.dots.map(d => d.health + d.name)]), nextLayout.edges.map(e => [e.id, e.tone, e.points])]);
    layout = nextLayout; graph = nextGraph; nodesById = new Map(nextLayout.nodes.map(n => [n.id, n]));
    if (sig === signature) { paint(); return; }
    signature = sig;
    const focused = document.activeElement?.closest?.('.topo-node')?.dataset.id;
    const columns = new Map();
    for (const node of nextLayout.nodes) columns.set(node.layer, (columns.get(node.layer) || 0) + 1);
    headers.replaceChildren(...(compact ? [] : LAYER_TITLES.map((title, layer) => svg('text', { class: 'topo-col', x: nextLayout.columnX(layer), y: -16 }, `${title.toUpperCase()}${columns.get(layer) ? `  ·  ${columns.get(layer)}` : ''}`))));
    edgeEls.clear(); nodeEls.clear();
    edgeLayer.replaceChildren(...nextLayout.edges.filter(edge => edge.points.length > 1).map(edge => {
      const d = edgePath(edge.points);
      const line = svg('path', { class: 'topo-edge-line', d });
      const group = svg('g', { class: `topo-edge type-${edge.type} tone-${edge.tone || 'none'}${edge.missing ? ' missing' : ''}` }, svg('title', {}, edgeTitle(edge, nodesById)), svg('path', { class: 'topo-edge-hit', d }), line);
      edgeEls.set(edge.id, { group, line, edge });
      return group;
    }));
    // Tab order follows the columns, top to bottom.
    const ordered = [...nextLayout.nodes].sort((a, b) => a.layer - b.layer || a.y - b.y);
    nodeLayer.replaceChildren(...ordered.map(node => { const group = drawNode(node); nodeEls.set(node.id, group); return group; }));
    if (hoverId && !nodesById.has(hoverId)) hoverId = null;
    if (focused && nodeEls.has(focused)) nodeEls.get(focused).focus({ preventScroll: true }); else if (focusId && !nodesById.has(focusId)) focusId = null;
    matches = matchNodes(graph, query);
    if (fitMode) fitView(fitMode === 'readable'); else apply();
    paint();
  }
  root.update = update;
  root.fit = () => { fitMode = 'all'; fitView(); };
  root.setFilter = value => { query = value; matches = matchNodes(graph, query); paint(); return matches.size; };
  root.focusNode = id => { const node = nodeEls.get(id); if (!node) return; reveal(id, true); node.focus({ preventScroll: true }); };
  root.firstMatch = () => [...nodeEls.keys()].find(id => matches.has(id));
  return root;
}
function legend() {
  const row = (swatch, text) => el('span', { class: 'topo-key' }, swatch, text);
  const box = cls => el('i', { class: `topo-key-box ${cls}` });
  const line = cls => el('i', { class: `topo-key-line ${cls}` });
  const body = el('div', { class: 'topo-legend-body' },
    row(box('good'), 'Healthy'), row(box('warn'), 'Degraded'), row(box('bad'), 'Failing'), row(box('missing'), 'Missing reference'),
    row(line('solid'), 'Routes, selects, uses'), row(line('dotted'), 'Scales or protects'), row(line('bad'), 'Leads to a problem'),
    row(el('span', { class: 'topo-key-dots' }, el('i', { class: 'good' }), el('i', { class: 'warn' }), el('i', { class: 'bad' })), 'Pods'));
  const open = readStore('rubban.topology.legend', window.innerWidth > 1280);
  const toggle = button('Legend', () => { const now = body.classList.toggle('hidden'); writeStore('rubban.topology.legend', !now); toggle.setAttribute('aria-expanded', String(!now)); }, 'quiet compact topo-legend-toggle');
  toggle.setAttribute('aria-expanded', String(open));
  if (!open) body.classList.add('hidden');
  return el('div', { class: 'topo-legend' }, toggle, body);
}

// ---- Data: every list the map needs, for one cluster and namespace -------------------------------
function subscribe({ liveList, context, namespace, signal, resync, status, resources, onChange }) {
  const data = {}; const errors = new Map(); const loaded = new Set();
  let timer = null; let first = true;
  const ready = () => loaded.size >= resources.length;
  const schedule = () => {
    if (signal.aborted) return;
    if (first && ready()) { first = false; clearTimeout(timer); timer = null; onChange(data, errors, true); return; }
    if (!timer) timer = setTimeout(() => { timer = null; if (!signal.aborted && (ready() || !first)) { first = false; onChange(data, errors, true); } }, first ? 4000 : 250);
  };
  signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  for (const resource of resources) {
    liveList({ resource, context, namespace, signal, resync,
      onStatus: value => status?.track(resource, value),
      onData: items => { data[resource] = items; errors.delete(resource); loaded.add(resource); schedule(); },
      onError: error => { if (!data[resource]) errors.set(resource, error); loaded.add(resource); schedule(); } });
  }
}
const RESOURCE_TITLES = { ingresses: 'Ingresses', services: 'Services', deployments: 'Deployments', statefulsets: 'StatefulSets', daemonsets: 'DaemonSets', cronjobs: 'CronJobs', jobs: 'Jobs', replicasets: 'ReplicaSets', pods: 'Pods', configmaps: 'ConfigMaps', secrets: 'Secrets', persistentvolumeclaims: 'PersistentVolumeClaims', horizontalpodautoscalers: 'HPAs', poddisruptionbudgets: 'PDBs' };
function errorNote(errors) {
  if (!errors.size) return null;
  const forbidden = [...errors].filter(([, error]) => error.status === 403 || /forbidden/i.test(error.message)).map(([resource]) => RESOURCE_TITLES[resource] || resource);
  const other = [...errors].filter(([resource]) => !forbidden.includes(RESOURCE_TITLES[resource] || resource));
  const parts = [];
  if (forbidden.length) parts.push(`Your credentials cannot list ${forbidden.join(', ')} here; references to them are drawn but not checked.`);
  for (const [resource, error] of other) parts.push(`${RESOURCE_TITLES[resource] || resource}: ${error.message}`);
  return info(parts.join(' '), forbidden.length && !other.length ? 'info' : 'warn');
}
function chooseNamespace(namespace) {
  const select = $('#namespace');
  if (![...select.options].some(option => option.value === namespace)) select.append(el('option', { value: namespace, text: namespace }));
  select.value = namespace;
  select.dispatchEvent(new Event('change'));
}
const openNode = node => {
  if (node.missing) { const referrer = node.referrers[0]; if (referrer) { const [kind, namespace, ...rest] = referrer.split('/'); hooks.showResource({ kind, metadata: { name: rest.join('/'), namespace } }, RESOURCE_OF[kind] || resourceForKind(kind)); } return; }
  hooks.showResource(node.item, resourceOf(node));
};

// ---- The Topology page ------------------------------------------------------------------------------
export function topologyPage({ liveList, liveBadge, consumeResync, refreshView }) {
  if (state.namespace === '*') return chooserPage({ liveList, liveBadge, consumeResync, refreshView });
  const signal = state.pageAbort.signal;
  const namespace = state.namespace; const context = state.context;
  const status = liveBadge();
  const root = page('Topology', `${namespace} · how Ingresses, Services, workloads, config and storage connect, with live health. Hover or Tab to a resource to trace its path, click or Enter to open; drag to pan, scroll to zoom.`,
    actions(status, button('All namespaces', () => chooseNamespace('*'), 'quiet compact'), button('↻ Refresh', refreshView, 'compact')));
  root.classList.add('fill-page', 'topo-page');
  let showUnused = readStore('rubban.topology.unused', false);
  const search = el('input', { class: 'table-search topo-search', type: 'search', placeholder: 'Highlight resources…', 'aria-label': 'Highlight resources by name, kind or host' });
  const matchCount = el('span', { class: 'topo-match-count muted' });
  const unusedBox = el('input', { type: 'checkbox', checked: showUnused, 'aria-label': 'Show unused ConfigMaps and Secrets' });
  const unusedText = el('span', { text: 'Unused config' });
  const unused = el('label', { class: 'topo-toggle', title: 'Show ConfigMaps and Secrets nothing in this namespace references' }, unusedBox, unusedText);
  const stats = el('span', { class: 'topo-stats' });
  const issues = el('div', { class: 'topo-issues', role: 'list', 'aria-label': 'Wiring problems' });
  const notes = el('div', { class: 'topo-notes' });
  const host = el('div', { class: 'topo-host' }, loading('Mapping the namespace…'));
  root.append(el('div', { class: 'topo-toolbar' }, search, matchCount, unused, el('span', { class: 'spacer' }), stats), issues, notes, host);
  const canvas = createCanvas({ onOpen: openNode, signal, label: `Topology of namespace ${namespace}` });
  let graph = null; let data = {}; let errors = new Map(); let expanded = false;
  const filter = () => { const count = canvas.setFilter(search.value); matchCount.textContent = search.value.trim() ? `${count} ${count === 1 ? 'match' : 'matches'}` : ''; };
  search.addEventListener('input', filter);
  search.addEventListener('keydown', event => {
    if (event.key === 'Enter') { const first = canvas.firstMatch(); if (first) canvas.focusNode(first); }
    if (event.key === 'Escape') { search.value = ''; filter(); }
  });
  unusedBox.addEventListener('change', () => { showUnused = unusedBox.checked; writeStore('rubban.topology.unused', showUnused); draw(); });
  function draw() {
    graph = buildGraph(data, { showUnreferenced: showUnused });
    notes.replaceChildren(...[errorNote(errors)].filter(Boolean));
    const unusedCount = showUnused ? graph.nodes.filter(node => node.unused && node.kind !== 'PersistentVolumeClaim').length : graph.hiddenUnreferenced;
    unusedText.textContent = `Unused config${unusedCount ? ` (${unusedCount})` : ''}`;
    if (!graph.nodes.length) {
      host.replaceChildren(empty('Nothing to map here', `No Ingresses, Services, workloads, volume claims or autoscalers in ${namespace}${graph.hiddenUnreferenced ? `, only ${graph.hiddenUnreferenced} unused ConfigMaps or Secrets (turn on Unused config to see them)` : ''}.`, button('Choose another namespace', () => chooseNamespace('*'), 'compact'), '◈'));
      stats.textContent = ''; issues.replaceChildren();
      return;
    }
    if (!canvas.isConnected) host.replaceChildren(canvas);
    canvas.update(layoutGraph(graph), graph);
    filter();
    const workloads = graph.nodes.filter(node => node.layer === 2 && !node.missing);
    const pods = workloads.reduce((sum, node) => sum + (node.pods?.total || 0), 0);
    const failing = workloads.filter(node => node.health === 'bad').length;
    const degraded = workloads.filter(node => node.health === 'warn').length;
    stats.replaceChildren(...[
      el('span', { class: 'muted', text: `${workloads.length} workload${workloads.length === 1 ? '' : 's'} · ${pods} pod${pods === 1 ? '' : 's'} · ${graph.nodes.filter(node => node.kind === 'Service' && !node.missing).length} services` }),
      failing ? badge(`${failing} failing`, 'bad') : null, degraded ? badge(`${degraded} degraded`, 'warn') : null, !failing && !degraded && workloads.length ? badge('all healthy', 'good') : null].filter(Boolean));
    const list = graph.issues;
    const shown = expanded ? list : list.slice(0, 4);
    issues.replaceChildren(...[...shown.map(issue => {
      const chip = button([el('i', { class: `topo-issue-dot ${issue.level}` }), el('span', { text: issue.text })], () => canvas.focusNode(issue.id), `quiet compact topo-issue ${issue.level}`);
      chip.setAttribute('role', 'listitem'); chip.title = 'Show it on the map';
      return chip;
    }), list.length > shown.length ? button(`+${list.length - shown.length} more`, () => { expanded = true; draw(); }, 'quiet compact topo-issue-more') : null].filter(Boolean));
  }
  subscribe({ liveList, context, namespace, signal, resync: consumeResync(), status, resources: TOPOLOGY_RESOURCES, onChange: (next, nextErrors) => {
    data = next; errors = nextErrors;
    if (nextErrors.size >= TOPOLOGY_RESOURCES.length) { host.replaceChildren(info([...nextErrors.values()][0].message, 'error')); return; }
    draw();
  } });
  return root;
}

// With All namespaces: a card per namespace with its workloads and their health.
function chooserPage({ liveList, liveBadge, consumeResync, refreshView }) {
  const signal = state.pageAbort.signal;
  const status = liveBadge();
  const root = page('Topology', 'Pick a namespace to map how its Ingresses, Services, workloads, config and storage connect.', actions(status, button('↻ Refresh', refreshView, 'compact')));
  root.classList.add('topo-page');
  const search = el('input', { class: 'table-search', type: 'search', placeholder: 'Filter namespaces…', 'aria-label': 'Filter namespaces' });
  const body = el('div', {}, loading('Counting workloads…'));
  root.append(el('div', { class: 'topo-toolbar' }, search), body);
  let rows = []; let names = [];
  const card = row => {
    const total = row.health.good + row.health.warn + row.health.bad;
    const words = row.worst === 'bad' ? `${row.health.bad} failing` : row.worst === 'warn' ? `${row.health.warn} degraded` : row.workloads ? 'all healthy' : 'no workloads';
    const node = button([
      el('span', { class: 'card-label' }, el('span', { class: 'topo-ns-name' }, el('i', { class: `topo-ns-dot ${row.worst}` }), el('span', { text: row.namespace })), el('span', { class: 'card-icon', text: '→' })),
      el('span', { class: 'card-value', text: String(row.workloads) }),
      el('span', { class: 'health-bar' }, total ? ['good', 'warn', 'bad'].filter(key => row.health[key]).map(key => el('span', { class: `segment ${key}`, style: `flex:${row.health[key]}` })) : null),
      el('span', { class: 'card-detail', text: `${row.workloads === 1 ? 'workload' : 'workloads'} · ${row.pods} pod${row.pods === 1 ? '' : 's'} · ${words}` }),
    ], () => chooseNamespace(row.namespace), `card workload-card topo-ns-card health-${row.worst}`);
    node.title = `Map namespace ${row.namespace}`;
    return node;
  };
  const paint = () => {
    const needle = search.value.trim().toLowerCase();
    const visible = rows.filter(row => !needle || row.namespace.toLowerCase().includes(needle));
    const apps = visible.filter(row => !row.system); const system = visible.filter(row => row.system);
    body.replaceChildren(...[
      visible.length ? null : empty('No namespaces', needle ? 'No namespace matches this filter.' : 'No namespaces are visible with your credentials.', null, '◈'),
      apps.length ? el('div', { class: 'topo-ns-grid' }, apps.map(card)) : null,
      system.length ? el('div', { class: 'section-label' }, el('h2', { text: 'System namespaces' })) : null,
      system.length ? el('div', { class: 'topo-ns-grid' }, system.map(card)) : null].filter(Boolean));
  };
  search.addEventListener('input', paint);
  let data = {};
  const recompute = () => { rows = summarizeNamespaces(data, names); paint(); };
  liveList({ resource: 'namespaces', namespace: '*', signal, onData: items => { names = items.map(item => item.metadata.name); if (data.pods) recompute(); }, onError: () => {} });
  subscribe({ liveList, context: state.context, namespace: '*', signal, resync: consumeResync(), status, resources: CHOOSER_RESOURCES, onChange: (next, errors) => {
    data = next;
    if (errors.size >= CHOOSER_RESOURCES.length) { body.replaceChildren(info([...errors.values()][0].message, 'error')); return; }
    recompute();
  } });
  return root;
}

// ---- Map tab in the details drawer ------------------------------------------------------------------
const MAP_RESOURCES = new Set(['deployments', 'statefulsets', 'daemonsets', 'cronjobs', 'jobs', 'services', 'ingresses', 'configmaps', 'secrets', 'persistentvolumeclaims', 'horizontalpodautoscalers', 'poddisruptionbudgets']);
export const mapSupported = selected => MAP_RESOURCES.has(selected.resource) && Boolean(selected.namespace);
const KIND_OF_RESOURCE = Object.fromEntries(Object.entries(RESOURCE_OF).map(([kind, resource]) => [resource, kind]));
export function topologyMap(selected, { liveList }) {
  const kind = KIND_OF_RESOURCE[selected.resource] || selected.item?.kind;
  const id = nodeId(kind, selected.namespace, selected.name);
  const caption = el('p', { class: 'topo-map-caption muted' });
  const host = el('div', { class: 'topo-map-host' }, loading('Mapping what this connects to…'));
  const note = el('div', { class: 'topo-notes' });
  const root = el('div', { class: 'topo-map' }, caption, note, host);
  const abort = new AbortController();
  // Stop listening once the tab or the drawer shows something else.
  const alive = () => { if (abort.signal.aborted) return false; if (state.selected !== selected || selected.detailTab !== 'map' || (seen && !root.isConnected)) { abort.abort(); return false; } return true; };
  let seen = false;
  const timer = setInterval(() => { if (root.isConnected) seen = true; alive(); }, 1500);
  abort.signal.addEventListener('abort', () => clearInterval(timer), { once: true });
  const canvas = createCanvas({ compact: true, signal: abort.signal, label: `Map around ${kind} ${selected.name}`, onOpen: node => { if (node.id !== id) openNode(node); } });
  subscribe({ liveList, context: selected.context, namespace: selected.namespace, signal: abort.signal, resources: TOPOLOGY_RESOURCES, onChange: (data, errors) => {
    if (!alive()) return;
    const graph = neighbourhood(buildGraph(data, { include: id, showUnreferenced: true }), id);
    if (!graph.nodes.length) { host.replaceChildren(empty('Not on the map', `${kind} ${selected.name} was not found in the lists of ${selected.namespace}.`, null, '◈')); return; }
    const others = graph.nodes.length - 1;
    const config = ['ConfigMap', 'Secret', 'PersistentVolumeClaim'].includes(kind);
    const where = `in ${selected.namespace}`;
    const what = config ? `${others} resource${others === 1 ? '' : 's'} ${where} ${others === 1 ? 'depends' : 'depend'} on this ${KIND_LABEL[kind] || kind}.`
      : WORKLOAD_KINDS.has(kind) ? `${others} connected resource${others === 1 ? '' : 's'} ${where}: what routes to this ${kind}, what it uses, and what scales or protects it.` : `${others} connected resource${others === 1 ? '' : 's'} ${where}.`;
    caption.textContent = others ? `${what} Hover to trace a path, click to open.` : `Nothing else ${where} references this ${KIND_LABEL[kind] || kind}, and it references nothing.`;
    if (!canvas.isConnected) host.replaceChildren(canvas);
    note.replaceChildren(...[errorNote(errors)].filter(Boolean));
    canvas.update(layoutGraph(graph, { width: 184, layerGap: 56 }), graph, { selected: id });
  } });
  return root;
}
