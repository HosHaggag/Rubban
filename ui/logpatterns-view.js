// The Patterns view of a log dock session: the lines folded into templates by logpatterns.js, with level,
// count and share, pods, first and last seen and a sparkline per pattern; a banner for spiking patterns; a
// click filters the raw lines to one pattern, Hide drops a pattern from them. All of it runs in the renderer
// on the lines the dock already receives: nothing leaves the machine.
import { el, toast, readStore, writeStore } from './kit.js';
import { createMiner, summarize, streamNow, templateParts, templateText, WILDCARD } from './logpatterns.js';

const SORTS = [['count', 'Count'], ['newest', 'Newest'], ['severity', 'Severity']];
const LEVEL_LABEL = { error: 'ERROR', warn: 'WARN', info: 'INFO', debug: 'DEBUG' };
const MAX_ROWS = 300;
const REFRESH_MS = 1000;

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
function ago(ms) {
  if (!(ms >= 0)) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
// Pods of one workload differ only at the end: storefront-6f456b6bc8-5c978 is shown as …5c978.
const shortPod = pod => (pod.length > 16 && pod.lastIndexOf('-') > 0 ? `…${pod.slice(pod.lastIndexOf('-') + 1)}` : pod);
const clock = ms => new Date(ms).toLocaleString();
const span = ms => (ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${Math.round(ms / 1000)} s`);

// The template with its masked parts set apart.
function templateNode(template, className = 'lp-template') {
  return el('span', { class: className }, templateParts(template).map(part => (part.masked ? el('span', { class: 'lp-var', text: WILDCARD }) : part.text)));
}

const SVG = 'http://www.w3.org/2000/svg';
function sparkline(series, level, spiking) {
  const values = series.values; const width = 84; const height = 18;
  const max = Math.max(1, ...values);
  const step = width / Math.max(1, values.length - 1);
  const y = value => (height - 2 - (value / max) * (height - 4)).toFixed(1);
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', `lp-spark ${level || 'none'}${spiking ? ' spiking' : ''}`);
  svg.setAttribute('width', width); svg.setAttribute('height', height); svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Lines per ${span(series.bucketMs)}: ${values.join(', ')}`);
  const area = document.createElementNS(SVG, 'path');
  area.setAttribute('class', 'lp-spark-area');
  area.setAttribute('d', `M0 ${height} ${values.map((value, i) => `L${(i * step).toFixed(1)} ${y(value)}`).join(' ')} L${width} ${height} Z`);
  const line = document.createElementNS(SVG, 'polyline');
  line.setAttribute('class', 'lp-spark-line');
  line.setAttribute('points', values.map((value, i) => `${(i * step).toFixed(1)},${y(value)}`).join(' '));
  svg.append(area, line);
  const title = document.createElementNS(SVG, 'title');
  title.textContent = `${values.reduce((a, b) => a + b, 0).toLocaleString()} lines in the last ${span(series.bucketMs * values.length)} (one point per ${span(series.bucketMs)})`;
  svg.append(title);
  return svg;
}

// options: { colors (the dock's per-pod colour slots), output (the raw <pre>), refilter() (redraw the raw
// lines with the current filters), paused() (whether the dock is paused) }.
export function createLogPatterns({ colors, output, refilter, paused }) {
  const miner = createMiner();
  let view = 'lines';
  let sort = readStore('rubban.logpatterns.sort', 'count');
  if (!SORTS.some(([key]) => key === sort)) sort = 'count';
  // The pattern filter and the hidden patterns. Both survive a reconnect (new container, since, timestamps):
  // the miner starts over with new ids, so they are carried by template text (id 0 / `pending`) and bound to
  // the new pattern with the same template as soon as it shows up.
  let selected = null; // { id, template }
  const hidden = new Map(); // id -> template
  const pending = new Set(); // templates of hidden patterns not seen since the reconnect
  const templateOf = id => { const cluster = id && miner.get(id); return cluster ? templateText(cluster) : ''; };
  function isHidden(id) {
    if (!id) return false;
    if (hidden.has(id)) return true;
    if (!pending.size) return false;
    const template = templateOf(id);
    if (!pending.has(template)) return false;
    pending.delete(template); hidden.set(id, template);
    return true;
  }
  function isSelected(id) {
    if (!selected || !id) return false;
    if (selected.id) return selected.id === id;
    if (templateOf(id) !== selected.template) return false;
    selected.id = id;
    return true;
  }
  const hiddenCount = () => hidden.size + pending.size;
  const dismissed = new Set(); // spike ids the user closed; they come back once the spike is over
  let query = ''; let showHidden = false; let summary = null; let dirty = true; let focusId = 0;

  // ---- toolbar: Lines | Patterns, the pattern filter chip, hidden patterns, the spike banner
  const linesButton = el('button', { type: 'button', class: 'lp-seg-button', 'aria-pressed': 'true', title: 'The raw log lines' }, 'Lines');
  const patternsCount = el('span', { class: 'lp-seg-count' });
  const patternsButton = el('button', { type: 'button', class: 'lp-seg-button', 'aria-pressed': 'false', title: 'The lines folded into patterns, with new and spiking ones marked' }, 'Patterns', patternsCount);
  const toggle = el('span', { class: 'lp-seg', role: 'group', 'aria-label': 'Log view' }, linesButton, patternsButton);
  linesButton.addEventListener('click', () => setView('lines'));
  patternsButton.addEventListener('click', () => setView('patterns'));
  const chips = el('span', { class: 'lp-chips' });
  const banner = el('span', { class: 'lp-banner hidden', role: 'status' });
  const bar = el('span', { class: 'lp-bar' }, chips, banner);

  // ---- the panel
  const sortGroup = el('span', { class: 'lp-seg', role: 'group', 'aria-label': 'Sort patterns by' });
  const drawSort = () => sortGroup.replaceChildren(...SORTS.map(([key, label]) => {
    const node = el('button', { type: 'button', class: 'lp-seg-button', 'aria-pressed': String(sort === key) }, label);
    node.addEventListener('click', () => { sort = key; writeStore('rubban.logpatterns.sort', sort); drawSort(); refresh(true); });
    return node;
  }));
  drawSort();
  const summaryText = el('span', { class: 'lp-summary' });
  const search = el('input', { type: 'search', class: 'dock-search narrow lp-search', placeholder: 'Filter patterns', 'aria-label': 'Filter patterns' });
  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); refresh(true); });
  const hiddenToggle = el('label', { class: 'dock-toggle hidden', title: 'List the patterns hidden from the lines' }, el('input', { type: 'checkbox' }), el('span'));
  hiddenToggle.querySelector('input').addEventListener('change', event => { showHidden = event.target.checked; refresh(true); });
  const pausedNote = el('span', { class: 'lp-paused hidden', text: 'Paused · counts update on Resume' });
  const head = el('div', { class: 'lp-head' }, summaryText, el('span', { class: 'lp-label', text: 'Sort' }), sortGroup, search, pausedNote, el('span', { class: 'spacer' }), hiddenToggle);
  const tbody = el('tbody');
  const table = el('table', { class: 'lp-table' },
    el('thead', {}, el('tr', {},
      el('th', { class: 'lp-c-level', text: 'Level' }), el('th', { text: 'Pattern' }), el('th', { class: 'lp-c-count', text: 'Count' }),
      el('th', { class: 'lp-c-pods', text: 'Pods' }), el('th', { class: 'lp-c-seen', text: 'Seen' }), el('th', { class: 'lp-c-trend', text: 'Trend' }), el('th', { class: 'lp-c-actions' }))),
    tbody);
  const emptyNode = el('div', { class: 'lp-empty' });
  const scroller = el('div', { class: 'lp-scroll' }, table, emptyNode);
  const root = el('div', { class: 'lp-panel hidden' }, head, scroller);

  // A hidden <pre> cannot scroll, so following the newest lines is remembered across the switch.
  let linesAtBottom = true;
  function setView(next) {
    if (next === view) { if (next === 'patterns') refresh(true); return; }
    if (view === 'lines') linesAtBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 40;
    view = next;
    linesButton.setAttribute('aria-pressed', String(view === 'lines'));
    patternsButton.setAttribute('aria-pressed', String(view === 'patterns'));
    output.classList.toggle('hidden', view !== 'lines');
    root.classList.toggle('hidden', view !== 'patterns');
    if (view === 'patterns') { refresh(true); return; }
    if (linesAtBottom) output.scrollTop = output.scrollHeight;
  }

  function select(row) {
    selected = isSelected(row.id) ? null : { id: row.id, template: row.template };
    drawChips(); refilter();
    if (selected) setView('lines'); else refresh(true);
  }
  function hide(row) {
    hidden.set(row.id, row.template);
    if (isSelected(row.id)) selected = null;
    drawChips(); refilter(); refresh(true);
  }
  function unhide(id) { hidden.delete(id); drawChips(); refilter(); refresh(true); }
  async function copy(template) {
    try { await navigator.clipboard.writeText(template); toast('Pattern copied to clipboard.'); } catch (error) { toast(`Could not copy: ${error.message}`, true); }
  }

  function drawChips() {
    const nodes = [];
    if (selected) {
      const chip = el('span', { class: 'lp-chip', title: `Only lines of this pattern:\n${selected.template}` }, el('span', { class: 'lp-chip-key', text: 'pattern:' }), templateNode(selected.template, 'lp-chip-text'),
        el('button', { type: 'button', class: 'lp-chip-remove', 'aria-label': 'Remove the pattern filter', text: '×' }));
      chip.querySelector('button').addEventListener('click', () => { selected = null; drawChips(); refilter(); refresh(true); });
      nodes.push(chip);
    }
    if (hiddenCount()) {
      const chip = el('span', { class: 'lp-chip muted', title: [...hidden.values(), ...pending].join('\n') }, el('span', { class: 'lp-chip-key', text: `${plural(hiddenCount(), 'pattern')} hidden` }),
        el('button', { type: 'button', class: 'lp-chip-remove', 'aria-label': 'Show the hidden patterns again', text: '×' }));
      chip.querySelector('button').addEventListener('click', () => { hidden.clear(); pending.clear(); drawChips(); refilter(); refresh(true); });
      nodes.push(chip);
    }
    chips.replaceChildren(...nodes);
    hiddenToggle.classList.toggle('hidden', !hiddenCount());
    hiddenToggle.querySelector('span').textContent = `Show hidden (${hiddenCount()})`;
  }

  function drawBanner() {
    const spike = summary?.spikes.find(row => !dismissed.has(row.id) && !isHidden(row.id));
    for (const id of [...dismissed]) if (!summary?.spikes.some(row => row.id === id)) dismissed.delete(id);
    banner.classList.toggle('hidden', !spike);
    if (!spike) { banner.replaceChildren(); return; }
    const jump = el('button', { type: 'button', class: 'lp-banner-jump', title: `Show this pattern · ${spike.spike.baseline.toFixed(1)} a minute before` },
      el('span', { class: 'lp-banner-label', text: 'Spike:' }), templateNode(spike.template, 'lp-banner-text'),
      el('span', { class: 'lp-banner-count', text: `×${spike.spike.count.toLocaleString()} in the last minute` }));
    jump.addEventListener('click', () => { focusId = spike.id; query = ''; search.value = ''; if (isHidden(spike.id)) unhide(spike.id); setView('patterns'); });
    const close = el('button', { type: 'button', class: 'lp-banner-close', 'aria-label': 'Dismiss this spike', text: '×' });
    close.addEventListener('click', () => { dismissed.add(spike.id); drawBanner(); });
    banner.replaceChildren(jump, close);
  }

  function rowNode(row) {
    const rowHidden = isHidden(row.id); const rowSelected = isSelected(row.id);
    const tags = [];
    if (row.spike) tags.push(el('span', { class: 'lp-tag spike', title: `${row.spike.count} in the last minute, about ${row.spike.baseline.toFixed(1)} a minute before`, text: `Spike ×${row.spike.count}` }));
    if (row.isNew) tags.push(el('span', { class: 'lp-tag new', title: `First seen ${clock(row.firstSeen)}`, text: 'New' }));
    const pods = row.pods.slice(0, 3).map(([pod, count]) => el('span', { class: 'log-chip lp-pod', style: `color:var(--log-pod-${colors.indexOf(pod)})`, title: `${pod} · ${count.toLocaleString()} lines` }, shortPod(pod)));
    if (row.pods.length > 3) pods.push(el('span', { class: 'lp-more', title: row.pods.slice(3).map(([pod, count]) => `${pod} · ${count}`).join('\n'), text: `+${row.pods.length - 3}` }));
    const copyButton = el('button', { type: 'button', class: 'quiet compact lp-act', title: 'Copy the pattern', text: 'Copy' });
    copyButton.addEventListener('click', event => { event.stopPropagation(); copy(row.template); });
    const hideButton = el('button', { type: 'button', class: 'quiet compact lp-act', title: rowHidden ? 'Show this pattern in the lines again' : 'Hide this pattern from the lines', text: rowHidden ? 'Unhide' : 'Hide' });
    hideButton.addEventListener('click', event => { event.stopPropagation(); if (rowHidden) unhide(row.id); else hide(row); });
    const level = row.level || 'none';
    const tr = el('tr', { class: `lp-row clickable${rowHidden ? ' is-hidden' : ''}${rowSelected ? ' is-selected' : ''}${focusId === row.id ? ' is-focus' : ''}`, tabindex: '0', 'data-id': String(row.id), 'aria-selected': String(rowSelected), title: `Example: ${row.example}` },
      el('td', { class: 'lp-c-level' }, el('span', { class: `lp-level ${level}`, text: LEVEL_LABEL[row.level] || '—' })),
      el('td', { class: 'lp-c-pattern' }, el('div', { class: 'lp-pattern' }, tags, templateNode(row.template))),
      el('td', { class: 'lp-c-count' }, el('div', { class: 'lp-count' }, el('span', { class: 'lp-count-n', text: row.count.toLocaleString() }), el('span', { class: 'lp-share', text: `${(row.share * 100).toFixed(row.share < 0.01 ? 2 : 1)}%` })),
        el('div', { class: 'lp-bar-track' }, el('div', { class: `lp-bar-fill ${level}`, style: `width:${Math.max(1, Math.round(row.share * 100))}%` }))),
      el('td', { class: 'lp-c-pods' }, el('div', { class: 'lp-pods' }, pods)),
      el('td', { class: 'lp-c-seen' }, el('div', { class: 'lp-seen', title: `Last seen ${clock(row.lastSeen)}\nFirst seen ${clock(row.firstSeen)}` }, el('span', { text: ago(summary.now - row.lastSeen) }), el('span', { class: 'lp-first', text: `since ${ago(summary.now - row.firstSeen).replace(' ago', '')}` }))),
      el('td', { class: 'lp-c-trend' }, sparkline(row.series, row.level, Boolean(row.spike))),
      el('td', { class: 'lp-c-actions' }, el('div', { class: 'lp-actions' }, copyButton, hideButton)));
    tr.addEventListener('click', () => select(row));
    tr.addEventListener('keydown', event => {
      if (event.target !== tr) return;
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(row); }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); (event.key === 'ArrowDown' ? tr.nextElementSibling : tr.previousElementSibling)?.focus(); }
    });
    return tr;
  }

  function drawTable() {
    const focused = root.contains(document.activeElement) ? document.activeElement.closest?.('tr.lp-row')?.dataset.id : null;
    const rows = summary.rows.filter(row => (showHidden || !isHidden(row.id)) && (!query || row.template.toLowerCase().includes(query) || row.example.toLowerCase().includes(query)));
    const shown = rows.slice(0, MAX_ROWS);
    tbody.replaceChildren(...shown.map(rowNode));
    const visible = summary.rows.filter(row => !isHidden(row.id)).length;
    summaryText.textContent = summary.total ? `${plural(visible, 'pattern')} · ${plural(summary.total, 'line')}${summary.evicted ? ` · ${plural(summary.evicted, 'rare pattern')} dropped` : ''}` : '';
    let emptyText = '';
    if (!summary.total) emptyText = 'Waiting for log lines… Patterns appear as lines arrive.';
    else if (!shown.length) emptyText = query ? `No pattern matches “${search.value.trim()}”.` : 'Every pattern is hidden. Use Show hidden to bring them back.';
    else if (rows.length > shown.length) emptyText = `${plural(rows.length - shown.length, 'more pattern')} not listed; filter to narrow down.`;
    emptyNode.textContent = emptyText;
    emptyNode.classList.toggle('hidden', !emptyText);
    table.classList.toggle('hidden', !shown.length);
    const target = focusId ? tbody.querySelector(`tr[data-id="${focusId}"]`) : focused ? tbody.querySelector(`tr[data-id="${focused}"]`) : null;
    if (target) { target.focus({ preventScroll: Boolean(!focusId) }); if (focusId) target.scrollIntoView({ block: 'nearest' }); }
    focusId = 0;
  }

  // Summaries are recomputed at most once a second; the table is redrawn only while it is visible and the
  // dock is not paused (or when the user changed something).
  function refresh(force = false) {
    if (!force && !bar.isConnected) return;
    if (dirty || force || !summary) { summary = summarize(miner, { now: streamNow(miner), sort }); dirty = false; }
    patternsCount.textContent = summary.rows.length ? ` ${summary.rows.length.toLocaleString()}` : '';
    patternsButton.classList.toggle('alert', summary.spikes.some(row => !isHidden(row.id)));
    drawBanner();
    const isPaused = paused();
    pausedNote.classList.toggle('hidden', !isPaused);
    if (view === 'patterns' && (force || !isPaused)) drawTable();
  }
  // Time moves on even without lines (new patterns stop being new), so the tick recomputes regardless.
  // `bar` is display: contents (no box), so visibility is read from the toggle next to it.
  const timer = setInterval(() => { if (toggle.offsetParent !== null) { dirty = true; refresh(); } }, REFRESH_MS);

  return {
    toggle, bar, root,
    ingest(lines) {
      const now = Date.now();
      for (const line of lines) if (line.length > 1 && !line.startsWith('[rubban] ')) miner.add(line, now);
      dirty = true;
    },
    reset() {
      for (const template of hidden.values()) pending.add(template);
      hidden.clear(); dismissed.clear();
      if (selected) selected = { id: 0, template: selected.template };
      miner.reset(); summary = null; dirty = true; drawChips(); refresh(true);
    },
    // The dock's filter options with the pattern filter and the hidden patterns folded in.
    filters({ include, exclude, hidden: hiddenPods }) {
      const base = { include, exclude, hidden: hiddenPods };
      if (selected) {
        const inner = include?.test ? include : null;
        base.include = { test: line => (!inner || inner.test(line)) && isSelected(miner.match(line)) };
      }
      if (hiddenCount()) {
        const inner = exclude?.test ? exclude : null;
        base.exclude = { test: line => Boolean(inner?.test(line)) || isHidden(miner.match(line)) };
      }
      return base;
    },
    dispose() { clearInterval(timer); },
  };
}
