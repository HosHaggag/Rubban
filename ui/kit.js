// Shared UI kit: application state, DOM helpers, the local API client, tables, menus and
// small layout primitives. Feature modules import from here; app.js wires the hooks.
import { windowRange, covers } from './virtual.js';
export const $ = (selector, root = document) => root.querySelector(selector);
const TOKEN = document.querySelector('meta[name="rubban-token"]')?.content || '';

export const state = { context: '', namespace: '*', contexts: [], contextsError: '', health: null, preferences: {}, discovery: [], tabs: [{ id: 'overview', section: 'overview', title: 'Overview' }], active: 'overview', renderId: 0, selected: null, sessionGeneration: 0, pageAbort: null, contextAbort: null, extensions: [], pageLive: false, resync: false };
// Late-bound app functions (showResource, openView, render, startLogs, …) assigned by app.js.
export const hooks = {};

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'value') node.value = value;
    else if (key === 'checked' || key === 'disabled') node[key] = Boolean(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) if (child !== undefined && child !== null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
// Modifier key name for shortcut labels: ⌘ on macOS, Ctrl elsewhere (both keys work everywhere).
export const MOD = (globalThis.rubbanDesktop?.platform === 'darwin' || /Mac/i.test(globalThis.navigator?.platform || '')) ? '⌘' : 'Ctrl';
export const button = (label, action, className = '') => el('button', { type: 'button', class: className, onclick: action }, label);
export const badge = (text, type = '') => el('span', { class: `badge ${type}` }, text);
export const actions = (...children) => el('div', { class: 'actions' }, children);
export const output = value => el('pre', { class: 'output', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) });
export const info = (message, type = 'info') => el('div', { class: `callout ${type}`, text: message });
export const loading = (text = 'Loading from your cluster…') => el('div', { class: 'loading' }, text);
export const mini = (text, trailing) => el('h3', { class: 'mini-title' }, el('span', { text }), trailing);
export function toast(message, error = false) { const node = el('div', { class: `toast${error ? ' error' : ''}`, text: message }); $('#toast-region').append(node); setTimeout(() => node.remove(), error ? 10000 : 5500); }
export function task(fn) { return async (...args) => { try { await fn(...args); } catch (error) { if (error?.name !== 'AbortError') toast(error.message, true); } }; }

export async function api(path, options = {}) {
  const url = new URL(path, location.origin);
  for (const [key, value] of Object.entries(options.query || {})) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  const pageRead = (!options.method || options.method === 'GET') && !['/api/health', '/api/contexts', '/api/preferences', '/api/namespaces', '/api/discovery'].includes(path);
  const response = await fetch(url, { method: options.method || 'GET', headers: { 'X-Rubban-Token': TOKEN, ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}), signal: options.signal || (pageRead ? state.pageAbort?.signal : undefined) });
  const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) throw Object.assign(new Error(result.error || `Request failed (${response.status})`), { status: response.status });
  return result;
}
export const get = (path, query = {}, options = {}) => api(path, { query, ...options });
export const post = (path, body, options = {}) => api(path, { method: 'POST', body, ...options });
export const clusterQuery = (extra = {}) => ({ context: state.context, namespace: state.namespace, ...extra });
export const targetOf = selected => ({ context: selected.context, namespace: selected.namespace, resource: selected.resource, name: selected.name });
export function socketURL(path, query) {
  const url = new URL(path, location.origin);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  for (const [key, value] of Object.entries({ ...query, token: TOKEN })) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  return url;
}

// Per-viewer conveniences only (sorting, hidden columns, dock height); failures are ignored.
export function readStore(key, fallback) { try { const value = JSON.parse(localStorage.getItem(key)); return value ?? fallback; } catch { return fallback; } }
export function writeStore(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage may be unavailable. */ } }

export function age(timestamp) {
  if (!timestamp) return '—';
  const secs = Math.max(0, (Date.now() - new Date(timestamp).getTime()) / 1000);
  if (!Number.isFinite(secs)) return '—';
  if (secs < 60) return `${Math.floor(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) { const h = Math.floor(secs / 3600); const m = Math.floor((secs % 3600) / 60); return h < 10 && m ? `${h}h${m}m` : `${h}h`; }
  const d = Math.floor(secs / 86400); const h = Math.floor((secs % 86400) / 3600);
  return d < 10 && h ? `${d}d${h}h` : `${d}d`;
}
export const timeSeconds = timestamp => { const t = new Date(timestamp).getTime(); return Number.isFinite(t) ? t / 1000 : NaN; };
export const dateText = timestamp => { if (!timestamp) return ''; const date = new Date(timestamp); return Number.isFinite(date.getTime()) ? `${age(timestamp)} ago · ${date.toLocaleString()}` : String(timestamp); };

export function statusOf(item) {
  const ready = (item.status?.conditions || []).find(condition => condition.type === 'Ready' || condition.type === 'Available' || condition.type === 'Complete');
  if (item.metadata?.deletionTimestamp) return ['Terminating', 'warn'];
  const containers = [...(item.status?.initContainerStatuses || []), ...(item.status?.containerStatuses || [])];
  const problem = containers.map(c => c.state?.waiting?.reason || (c.state?.terminated && c.state.terminated.exitCode !== 0 ? c.state.terminated.reason || 'Error' : '')).find(reason => reason && !['ContainerCreating', 'PodInitializing'].includes(reason));
  if (problem) return [problem, /BackOff|Err|Error|OOMKilled|Invalid/.test(problem) ? 'bad' : 'warn'];
  if (item.status?.phase === 'Running' && containers.length && containers.some(c => !c.ready)) return ['Running · not ready', 'warn'];
  if (item.status?.phase) return [item.status.phase, ['Running', 'Active', 'Bound', 'Succeeded', 'Available'].includes(item.status.phase) ? 'good' : ['Failed', 'Lost'].includes(item.status.phase) ? 'bad' : 'warn'];
  if (ready) return [ready.status === 'True' ? 'Ready' : ready.reason || 'Not ready', ready.status === 'True' ? 'good' : 'warn'];
  if (item.spec?.suspend) return ['Suspended', 'warn'];
  if (item.status?.health?.status) return [item.status.health.status, item.status.health.status === 'Healthy' ? 'good' : 'warn'];
  return ['—', ''];
}

export const liveKey = item => item.metadata?.uid || `${item.metadata?.namespace || ''}/${item.metadata?.name || ''}`;
export const liveStamp = item => item.metadata?.resourceVersion || '';

// ---- Popup menus (row actions, column chooser) -----------------------------------------------
let openMenu = null;
export function closeMenus() { openMenu?.remove(); openMenu = null; }
export function popupMenu(anchor, items) {
  closeMenus();
  const menu = el('div', { class: 'popup-menu', role: 'menu' });
  for (const item of items.filter(Boolean)) {
    if (item === '-') { menu.append(el('div', { class: 'menu-sep' })); continue; }
    if (item.heading) { menu.append(el('div', { class: 'menu-heading', text: item.heading })); continue; }
    if (item.checkbox) { menu.append(el('label', { class: 'menu-item check' }, el('input', { type: 'checkbox', checked: item.checked, onchange: event => item.onChange(event.target.checked) }), item.label)); continue; }
    menu.append(el('button', { type: 'button', class: `menu-item${item.danger ? ' danger' : ''}`, role: 'menuitem', disabled: item.disabled, title: item.title || '', onclick: event => { event.stopPropagation(); closeMenus(); item.action(); } }, el('span', { class: 'menu-icon', text: item.icon || '' }), item.label));
  }
  menu.addEventListener('mousedown', event => event.stopPropagation());
  document.body.append(menu); openMenu = menu;
  const rect = anchor.getBoundingClientRect(); const size = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - size.width - 8, rect.right - size.width));
  const below = rect.bottom + 4 + size.height < window.innerHeight;
  menu.style.left = `${left}px`; menu.style.top = `${below ? rect.bottom + 4 : Math.max(8, rect.top - size.height - 4)}px`;
  menu.querySelector('button, input')?.focus();
  return menu;
}
document.addEventListener('mousedown', closeMenus);
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenus(); });
window.addEventListener('blur', closeMenus);

// ---- Tables: filter, sort, column chooser, multi-select, row menus, live row updates ---------
// Long lists are windowed: only the rows on screen (plus a margin) exist in the DOM, at a fixed
// row height, so a view with thousands of pods opens, scrolls and refreshes as fast as a short one.
const VIRTUAL_MIN = 120;
const OVERSCAN = 14;
const columnId = column => column.id || column.title;
function compareValues(a, b, descending) {
  const missingA = a === undefined || a === null || a === '' || Number.isNaN(a);
  const missingB = b === undefined || b === null || b === '' || Number.isNaN(b);
  if (missingA || missingB) return missingA === missingB ? 0 : missingA ? 1 : -1;
  const result = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  return descending ? -result : result;
}
// One scroll/resize listener serves every table on screen (windowing and column fitting).
const liveTables = new Set();
let windowFrame = 0;
function checkWindows() {
  windowFrame = 0;
  const now = Date.now();
  for (const entry of liveTables) {
    if (entry.root.isConnected) { entry.seen = true; entry.check(); }
    else if (entry.seen || now - entry.since > 15000) liveTables.delete(entry);
  }
}
const scheduleWindows = () => { if (!windowFrame) windowFrame = requestAnimationFrame(checkWindows); };
let measureContext = null;
function textWidth(text, font) {
  measureContext ||= document.createElement('canvas').getContext('2d');
  measureContext.font = font;
  return measureContext.measureText(text).width;
}
document.addEventListener('scroll', scheduleWindows, { capture: true, passive: true });
window.addEventListener('resize', scheduleWindows, { passive: true });

export function table(items, columns, onRow, options = {}) {
  const storeKey = options.id ? `rubban.table.${options.id}` : '';
  const saved = storeKey ? readStore(storeKey, {}) : {};
  let sortBy = saved.sortBy !== undefined ? saved.sortBy : options.sortBy || null;
  let sortDesc = saved.sortBy !== undefined ? Boolean(saved.sortDesc) : Boolean(options.sortDesc);
  if (sortBy && !columns.some(column => columnId(column) === sortBy && column.sort)) { sortBy = null; sortDesc = false; }
  const hidden = new Set(Array.isArray(saved.hidden) ? saved.hidden : columns.filter(column => column.hidden).map(columnId));
  const widthsById = Object.fromEntries(columns.map(column => [columnId(column), saved.widths?.[columnId(column)]])
    .filter(([, width]) => Number.isFinite(width) && width >= 48 && width <= 4096));
  let resizing = false;
  const keyed = Boolean(options.key);
  const keyOf = options.key || liveKey;
  const stampOf = options.stamp || liveStamp;
  const selectable = keyed && typeof options.bulk === 'function';
  const selection = new Map();
  let current = items; let pending = Boolean(options.pending);
  let rowCache = new Map(); let lastFiltered = [];
  let virtual = false; let rowHeight = 33; let rendered = [0, 0];
  const searchCache = new WeakMap();
  const persist = () => { if (storeKey) writeStore(storeKey, { sortBy, sortDesc, hidden: [...hidden], widths: widthsById }); };
  const visibleColumns = () => columns.filter(column => column.locked || !hidden.has(columnId(column)));
  const searchOf = item => {
    if (item && typeof item === 'object' && searchCache.has(item)) return searchCache.get(item);
    const text = (options.searchText ? options.searchText(item) : `${item.metadata?.name || ''} ${item.metadata?.namespace || ''} ${JSON.stringify(item.metadata?.labels || {})}`).toLowerCase();
    if (item && typeof item === 'object') searchCache.set(item, text);
    return text;
  };
  const thead = el('thead'); const body = el('tbody');
  const tableNode = el('table', {}, thead, body);
  const scroller = el('div', { class: 'table-scroll' }, tableNode);
  const count = el('span', { class: 'table-count' });
  const bulkBar = el('div', { class: 'bulk-bar hidden' });
  let headCheck = null;

  function renderRow(item, cols, id) {
    const cells = [];
    let check = null;
    if (selectable) {
      check = el('input', { type: 'checkbox', 'aria-label': 'Select row', checked: selection.has(id), onclick: event => event.stopPropagation(), onchange: event => { if (event.target.checked) selection.set(id, item); else selection.delete(id); syncSelection(); } });
      cells.push(el('td', { class: 'check' }, check));
    }
    for (const column of cols) {
      let content;
      try { content = column.render(item); } catch { content = '—'; }
      // Long values may be cut to fit the column: the full text is the cell's tooltip.
      let title = column.tooltip ? column.tooltip(item) || '' : '';
      if (!title) { const text = typeof content === 'string' ? content : content?.textContent || ''; if (text.length > 16) title = text; }
      cells.push(el('td', { class: column.class || '', title }, content));
    }
    if (options.menu) {
      const trigger = el('button', { type: 'button', class: 'row-menu', 'aria-label': 'Actions', title: 'Actions', text: '⋮' });
      trigger.addEventListener('click', event => { event.stopPropagation(); popupMenu(trigger, options.menu(item)); });
      cells.push(el('td', { class: 'menu-col' }, trigger));
    }
    const tr = el('tr', { class: onRow ? 'clickable' : '', ...(onRow ? { onclick: () => onRow(item), tabindex: '0', onkeydown: event => { if (event.key === 'Enter' && event.target === tr) onRow(item); } } : {}) }, cells);
    if (options.menu) tr.addEventListener('contextmenu', event => { event.preventDefault(); const trigger = tr.querySelector('.row-menu'); if (trigger) popupMenu(trigger, options.menu(item)); });
    tr._check = check;
    return tr;
  }
  function header() {
    const cells = [];
    if (selectable) {
      headCheck = el('input', { type: 'checkbox', 'aria-label': 'Select all rows', onchange: event => { for (const item of lastFiltered) { const id = keyOf(item); if (event.target.checked) selection.set(id, item); else selection.delete(id); } syncSelection(); } });
      cells.push(el('th', { class: 'check' }, headCheck));
    }
    for (const column of visibleColumns()) {
      const id = columnId(column);
      const sorted = sortBy === id;
      const th = el('th', { class: ['resizable', column.class === 'num' ? 'num' : '', column.sort ? 'sortable' : '', sorted ? 'sorted' : ''].filter(Boolean).join(' '), title: column.help || (column.sort ? 'Sort by this column' : '') }, column.title, sorted ? el('span', { class: 'sort-arrow', text: sortDesc ? ' ▾' : ' ▴' }) : null);
      if (column.sort) th.setAttribute('aria-sort', sorted ? (sortDesc ? 'descending' : 'ascending') : 'none');
      th.append(resizeHandle(th, id, column.title || id));
      if (column.sort) th.addEventListener('click', () => {
        if (!sorted) { sortBy = id; sortDesc = Boolean(column.sortDesc); } else if (sortDesc === Boolean(column.sortDesc)) sortDesc = !sortDesc; else { sortBy = null; sortDesc = false; }
        persist(); header(); rows();
      });
      cells.push(th);
    }
    if (options.menu) cells.push(el('th', { class: 'menu-col' }));
    thead.replaceChildren(el('tr', {}, cells));
    rowCache = new Map(); fitted = '';
  }
  // Checkbox state of the rendered rows and the select-all box.
  function syncRows() {
    for (const tr of body.children) if (tr._check) { const id = tr.dataset.key; tr._check.checked = selection.has(id); tr.classList.toggle('selected-row', selection.has(id)); }
    if (headCheck) { headCheck.checked = lastFiltered.length > 0 && selection.size >= lastFiltered.length && lastFiltered.every(item => selection.has(keyOf(item))); headCheck.indeterminate = !headCheck.checked && selection.size > 0 && lastFiltered.some(item => selection.has(keyOf(item))); }
  }
  function syncSelection() {
    syncRows();
    const size = selection.size;
    bulkBar.classList.toggle('hidden', !size);
    if (size) bulkBar.replaceChildren(el('span', { class: 'bulk-count', text: `${size} selected` }), options.bulk([...selection.values()], () => { selection.clear(); syncSelection(); }), button('Clear', () => { selection.clear(); syncSelection(); }, 'quiet compact'));
    else bulkBar.replaceChildren();
  }
  function sortItems(list) {
    if (!sortBy) return list;
    const column = columns.find(c => columnId(c) === sortBy);
    if (!column?.sort) return list;
    const pairs = list.map(item => { let value; try { value = column.sort(item); } catch { value = null; } return [value, item]; });
    pairs.sort((a, b) => compareValues(a[0], b[0], sortDesc));
    return pairs.map(pair => pair[1]);
  }
  // The part of the list on screen, in pixels from the top of the table body.
  function viewport() {
    if (!body.isConnected) return { offset: 0, height: window.innerHeight || 900 };
    let top = 0; let bottom = window.innerHeight;
    for (const box of [scroller, scroller.closest('main, #drawer-content, dialog, .dock')]) {
      if (!box) continue;
      const rect = box.getBoundingClientRect();
      top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom);
    }
    const bodyTop = body.getBoundingClientRect().top;
    return { offset: top - bodyTop, height: bottom - top };
  }
  const spacer = (height, colspan) => el('tr', { class: 'table-spacer', 'aria-hidden': 'true' }, el('td', { colspan, style: `height:${Math.max(0, Math.round(height))}px` }));
  function paint() {
    const filtered = lastFiltered;
    const cols = visibleColumns();
    const colspan = cols.length + (selectable ? 1 : 0) + (options.menu ? 1 : 0);
    let start = 0; let end = filtered.length;
    if (virtual) { const view = viewport(); [start, end] = windowRange({ count: filtered.length, rowHeight, offset: view.offset, height: view.height, overscan: OVERSCAN }); }
    rendered = [start, end];
    const trs = [];
    const nextCache = keyed ? new Map() : null;
    for (let index = start; index < end; index++) {
      const item = filtered[index];
      if (!keyed) { trs.push(renderRow(item, cols, '')); continue; }
      const id = keyOf(item); const stamp = stampOf(item);
      const cached = rowCache.get(id);
      const tr = cached && cached.stamp === stamp ? cached.tr : renderRow(item, cols, id);
      tr.dataset.key = id;
      nextCache.set(id, { stamp, tr });
      trs.push(tr);
    }
    if (keyed) rowCache = nextCache;
    if (virtual) body.replaceChildren(spacer(start * rowHeight, colspan), ...trs, spacer((filtered.length - end) * rowHeight, colspan));
    else body.replaceChildren(...trs);
    if (!filtered.length) {
      const needle = search.value.trim();
      body.append(el('tr', {}, el('td', { colspan }, el('div', { class: 'list-note', text: pending ? 'Loading from your cluster…' : needle ? 'No results match this search.' : options.empty || 'No resources found in this scope.' }))));
    }
    if (selectable) syncRows();
    if (trs.length && body.isConnected) { fit(); if (virtual && !calibrating) calibrate(trs); }
  }
  // Column widths: measured once from the rows on screen, then fixed, so scrolling a windowed list
  // never shifts columns; when the table is wider than its panel the long text columns are
  // narrowed (with an ellipsis) so every column stays visible.
  let fitted = '';
  function applyWidths(widths) {
    const cells = [...thead.rows[0].cells];
    widths.forEach((width, index) => {
      cells[index].style.width = `${width}px`;
      cells[index].querySelector('.column-resize-handle')?.setAttribute('aria-valuenow', String(Math.round(width)));
    });
    tableNode.style.tableLayout = 'fixed';
    tableNode.style.width = `${widths.reduce((sum, width) => sum + width, 0)}px`;
  }
  function resizeHandle(th, id, title) {
    const handle = el('span', { class: 'column-resize-handle', role: 'separator', tabindex: '0',
      'aria-orientation': 'vertical', 'aria-label': `Resize ${title}`, 'aria-valuemin': '48', 'aria-valuemax': '4096',
      title: 'Drag to resize. Double-click or press Home to reset. Arrow keys resize by 10px.' });
    const sizes = () => [...thead.rows[0].cells].map(cell => cell.getBoundingClientRect().width);
    const setWidth = (widths, width) => {
      widths[th.cellIndex] = Math.round(Math.max(48, Math.min(4096, width)));
      widthsById[id] = widths[th.cellIndex]; applyWidths(widths);
    };
    const reset = () => { delete widthsById[id]; persist(); fitted = ''; fit(); handle.setAttribute('aria-valuenow', String(Math.round(th.getBoundingClientRect().width))); };
    handle.addEventListener('click', event => event.stopPropagation());
    handle.addEventListener('dblclick', event => { event.preventDefault(); event.stopPropagation(); reset(); });
    handle.addEventListener('focus', () => handle.setAttribute('aria-valuenow', String(Math.round(th.getBoundingClientRect().width))));
    handle.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'Home') { reset(); return; }
      const widths = sizes();
      setWidth(widths, widths[th.cellIndex] + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 50 : 10));
      persist();
    });
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      fit(); const widths = sizes(); const startWidth = widths[th.cellIndex]; const startX = event.clientX;
      resizing = true; document.documentElement.classList.add('resizing-columns');
      handle.setPointerCapture(event.pointerId);
      const move = next => { if (next.pointerId === event.pointerId) setWidth(widths, startWidth + next.clientX - startX); };
      const finish = next => {
        if (next.pointerId !== event.pointerId) return;
        handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', finish);
        handle.removeEventListener('pointercancel', finish); handle.removeEventListener('lostpointercapture', finish);
        resizing = false; document.documentElement.classList.remove('resizing-columns'); persist();
      };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', finish);
      handle.addEventListener('pointercancel', finish); handle.addEventListener('lostpointercapture', finish);
    });
    return handle;
  }
  function fit() {
    if (resizing) return;
    const head = thead.rows[0];
    const available = scroller.clientWidth;
    if (!head || !available) return;
    const key = `${available}|${head.cells.length}|${virtual}`;
    if (key === fitted) return;
    fitted = key;
    // Natural (max-content) width of every column for the rows on screen.
    tableNode.style.tableLayout = ''; tableNode.style.width = 'max-content';
    for (const th of head.cells) th.style.width = '';
    const widths = [...head.cells].map(th => Math.ceil(th.getBoundingClientRect().width));
    tableNode.style.width = '';
    // A windowed list shows only some rows: widen the short columns (status, age, …) for longer
    // values elsewhere in the list, from the text of a sample of rows.
    if (virtual) widenForSample(widths);
    const total = widths.reduce((sum, width) => sum + width, 0);
    const cols = visibleColumns();
    const hasWidths = cols.some(column => widthsById[columnId(column)] !== undefined);
    if (total <= available && !virtual && !hasWidths) return;
    const nameAt = visibleColumns().findIndex(column => String(column.class || '').split(' ').includes('name'));
    const nameCell = nameAt >= 0 ? nameAt + (selectable ? 1 : 0) : -1;
    if (total <= available) {
      // Spare room goes to the name column.
      widths[nameCell >= 0 ? nameCell : 0] += available - total;
    } else {
      // The name column keeps up to a third of the width; other long columns give way first.
      const floor = index => (index === nameCell ? Math.min(widths[index], Math.max(140, available / 3)) : 96);
      const shrinkable = widths.map((width, index) => (width > 120 ? Math.max(0, width - floor(index)) : 0));
      const room = shrinkable.reduce((sum, width) => sum + width, 0);
      const ratio = room ? Math.min(1, (total - available) / room) : 0;
      shrinkable.forEach((amount, index) => { widths[index] -= amount * ratio; });
    }
    cols.forEach((column, index) => { const width = widthsById[columnId(column)]; if (width !== undefined) widths[index + (selectable ? 1 : 0)] = width; });
    applyWidths(widths.map(Math.floor));
  }
  function widenForSample(widths) {
    const cols = visibleColumns(); const offset = selectable ? 1 : 0;
    const font = getComputedStyle(body.querySelector('td:not(.check)') || tableNode).font;
    const step = Math.max(1, Math.floor(lastFiltered.length / 400));
    cols.forEach((column, index) => {
      const cell = index + offset;
      if (widths[cell] > 120 || /\b(usage|wrap)\b/.test(column.class || '')) return;
      let longest = '';
      for (let at = 0; at < lastFiltered.length; at += step) {
        let content; try { content = column.render(lastFiltered[at]); } catch { continue; }
        const text = typeof content === 'string' || typeof content === 'number' ? String(content) : content?.textContent || '';
        if (text.length > longest.length) longest = text;
      }
      if (longest) widths[cell] = Math.min(180, Math.max(widths[cell], Math.ceil(textWidth(longest, font)) + 24));
    });
  }
  // Real row height (fonts, zoom) for the spacer sizes.
  let calibrating = false;
  function calibrate(trs) {
    const height = (trs.at(-1).getBoundingClientRect().bottom - trs[0].getBoundingClientRect().top) / trs.length;
    if (height > 12 && Math.abs(height - rowHeight) > 0.25) { rowHeight = height; calibrating = true; try { paint(); } finally { calibrating = false; } }
  }
  const entry = { root: null, since: Date.now(), seen: false, check: () => {
    // First attach, or the panel was resized: measure the columns again.
    if (rendered[1] > rendered[0] && scroller.clientWidth && !fitted.startsWith(`${scroller.clientWidth}|`)) fit();
    if (!virtual) return;
    const view = viewport(); const visible = windowRange({ count: lastFiltered.length, rowHeight, offset: view.offset, height: view.height, overscan: 0 });
    if (!covers(rendered, visible)) paint();
  } };
  liveTables.add(entry);
  function rows(filter = search.value) {
    const needle = filter.toLowerCase().trim();
    const filtered = sortItems(needle ? current.filter(item => searchOf(item).includes(needle)) : current);
    lastFiltered = filtered;
    // Bulk actions apply only to rows the filter still shows.
    if (selectable && selection.size) { const shown = new Set(filtered.map(keyOf)); for (const id of [...selection.keys()]) if (!shown.has(id)) selection.delete(id); }
    virtual = filtered.length > VIRTUAL_MIN;
    tableNode.classList.toggle('virtual', virtual);
    paint();
    if (selectable) syncSelection();
    // Detached on first paint (the page is attached right after it is built): fix the window then.
    if (virtual && !body.isConnected) scheduleWindows();
    count.textContent = pending ? '' : `${filtered.length.toLocaleString()}${needle ? ` of ${current.length.toLocaleString()}` : ''} ${filtered.length === 1 ? 'item' : 'items'}`;
  }
  const search = el('input', { class: 'table-search', type: 'search', placeholder: options.placeholder || 'Filter resources…', 'aria-label': 'Filter table', oninput: event => { rows(event.target.value); if (virtual) scroller.scrollTop = 0; } });
  const toolbarExtra = [];
  if (options.id && columns.length > 3) {
    const chooser = el('button', { type: 'button', class: 'quiet compact column-chooser', title: 'Show or hide columns', text: 'Columns' });
    chooser.addEventListener('click', event => {
      event.stopPropagation();
      popupMenu(chooser, [{ heading: 'Columns' }, ...columns.filter(column => !column.locked).map(column => ({ checkbox: true, label: column.title || column.id, checked: !hidden.has(columnId(column)), onChange: on => { if (on) hidden.delete(columnId(column)); else hidden.add(columnId(column)); persist(); header(); rows(); } }))]);
    });
    toolbarExtra.push(chooser);
  }
  const root = el('section', { class: 'panel table-panel' },
    el('div', { class: 'table-toolbar' }, search, bulkBar, el('div', { class: 'actions' }, count, options.extra, toolbarExtra)),
    scroller);
  entry.root = root;
  // Live tables: replace the item set; only rows whose stamp changed are rendered again.
  root.update = next => {
    pending = false; current = next;
    if (selection.size) { const present = new Set(next.map(keyOf)); for (const id of [...selection.keys()]) if (!present.has(id)) selection.delete(id); }
    rows();
  };
  // Re-render the rows on screen (ages and other time-based text).
  root.refresh = () => { rowCache = new Map(); paint(); };
  root.items = () => current;
  header(); rows();
  return root;
}

// ---- Layout primitives ------------------------------------------------------------------------
export function page(title, description, controls) { const root = el('div'); root.append(el('div', { class: 'page-heading' }, el('div', {}, el('h1', { text: title }), el('p', { text: description })), controls)); return root; }
export function panel(title, content, trailing) { return el('section', { class: 'panel' }, title ? el('div', { class: 'panel-heading' }, title, trailing) : null, el('div', { class: 'panel-body' }, content)); }
export function empty(title, description, action, icon = '◈') { return el('div', { class: 'empty-state' }, el('div', { class: 'empty-icon', text: icon }), el('h2', { text: title }), el('p', { text: description }), action); }
export function displayError(error, title = 'Unable to load this view') { return empty(title, error.message, button('Try again', () => hooks.render?.(), 'primary compact'), '⚠'); }
// Definition list; rows with empty values are omitted, values may be nodes.
export function dl(pairs) {
  const node = el('dl', { class: 'definition' });
  for (const [label, value] of pairs) {
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) continue;
    node.append(el('dt', { text: label }), el('dd', {}, value instanceof Node || Array.isArray(value) ? value : String(value)));
  }
  return node;
}
export function link(text, onClick, title = '') { return el('a', { href: '#', class: 'link', title, onclick: event => { event.preventDefault(); event.stopPropagation(); onClick(); } }, text); }
export function chips(map, { empty: emptyText = '' } = {}) {
  const entries = Object.entries(map || {});
  if (!entries.length) return emptyText ? el('span', { class: 'muted', text: emptyText }) : '';
  return el('div', { class: 'tags' }, entries.map(([key, value]) => el('span', { class: 'chip', title: `${key}=${value}` }, `${key}${value !== '' && value !== undefined ? `=${value}` : ''}`)));
}
export function copyButton(text, label = 'Copy') { return button(label, task(async event => { event?.stopPropagation?.(); await navigator.clipboard.writeText(typeof text === 'function' ? text() : text); toast('Copied to clipboard.'); }), 'quiet compact'); }
export function download(filename, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const anchor = el('a', { href: url, download: filename }); document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
// Collapsible section used in detail drawers.
export function section(title, content, { open = true, trailing } = {}) {
  const details = el('details', { class: 'detail-section', ...(open ? { open: '' } : {}) }, el('summary', {}, el('span', { text: title }), trailing ? el('span', { class: 'summary-trailing' }, trailing) : null), el('div', { class: 'detail-section-body' }, content));
  return details;
}

// ---- Forms and dialogs ------------------------------------------------------------------------
export function field(spec) {
  const id = `field-${Math.random().toString(36).slice(2)}`;
  let input;
  if (spec.options) { input = el('select', { id, name: spec.name, required: spec.required }); for (const option of spec.options) input.append(el('option', { value: typeof option === 'string' ? option : option.value, text: typeof option === 'string' ? option : option.label })); if (spec.value !== undefined) input.value = spec.value; }
  else if (spec.type === 'textarea') input = el('textarea', { id, name: spec.name, required: spec.required, placeholder: spec.placeholder || '', rows: spec.rows || 5, value: spec.value || '', class: spec.editor ? 'editor' : '' });
  else input = el('input', { id, name: spec.name, type: spec.type || 'text', required: spec.required, placeholder: spec.placeholder || '', value: spec.value ?? '', ...(spec.min !== undefined ? { min: spec.min } : {}), ...(spec.max !== undefined ? { max: spec.max } : {}), autocomplete: spec.type === 'password' ? 'new-password' : 'off' });
  return el('div', { class: `field${spec.full ? ' full' : ''}` }, el('label', { for: id, text: spec.label }), input, spec.help ? el('small', { text: spec.help }) : null);
}
export function makeForm(specs, submitLabel, submit, extra = {}) {
  const form = el('form'); const result = output(''); const status = el('span', { class: 'form-status' }); const submitButton = el('button', { type: 'submit', class: extra.danger ? 'danger' : 'primary', text: submitLabel });
  form.append(el('div', { class: 'form-grid' }, specs.map(field)), el('div', { class: 'form-actions' }, status, submitButton), result);
  form.addEventListener('submit', async event => { event.preventDefault(); const values = Object.fromEntries(new FormData(form)); if (extra.confirm && !await confirmAction(extra.confirm, extra.target || values.name || submitLabel)) return; submitButton.disabled = true; status.textContent = 'Working…'; result.textContent = ''; try { const response = await submit(values); result.textContent = typeof response === 'string' ? response : response?.output || JSON.stringify(response, null, 2); status.textContent = 'Completed'; extra.after?.(response, values); } catch (error) { status.textContent = 'Request failed'; result.textContent = error.message; toast(error.message, true); } finally { submitButton.disabled = false; } });
  return form;
}
// Actions execute directly. Keep the shared async hook so existing action handlers and forms
// follow the same policy without creating a confirmation dialog.
export async function confirmAction() { return true; }
export function modal(title, description, content) {
  const dialog = $('#action-dialog');
  const close = button('×', () => dialog.close(), 'icon-button'); close.setAttribute('aria-label', 'Close dialog');
  $('#action-content').replaceChildren(el('div', { class: 'page-heading' }, el('div', {}, el('h2', { id: 'action-dialog-title', text: title }), el('p', { text: description })), close), content);
  dialog.setAttribute('aria-labelledby', 'action-dialog-title');
  if (!dialog.open) dialog.showModal();
  dialog.querySelector('input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled), button[type="submit"]')?.focus();
}
