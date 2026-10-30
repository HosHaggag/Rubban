// Bottom dock with tabbed sessions: pod/workload logs and terminals (pod exec, attach, node
// shell, local shell). Each tab keeps its own socket; the dock is resizable and remembers height.
import { $, el, button, toast, task, socketURL, readStore, writeStore, download, state } from './kit.js';

const sessions = [];
let active = null;
let counter = 0;
let highlightOwner = null;
const XTERM_THEME = { background: '#181a1c', foreground: '#d4d6d8', cursor: '#f1f3f5', cursorAccent: '#181a1c', selectionBackground: '#3d90ce66', black: '#282a2d', red: '#ce3933', green: '#4caf50', yellow: '#ff9800', blue: '#3d90ce', magenta: '#c93dce', cyan: '#26a69a', white: '#aaacae', brightBlack: '#787b7c', brightRed: '#e85555', brightGreen: '#66bb6a', brightYellow: '#ffb74d', brightBlue: '#64a9e0', brightMagenta: '#d670da', brightCyan: '#4db6ac', brightWhite: '#f1f3f5' };

const dock = () => $('#dock');
function show() {
  dock().classList.remove('hidden');
  const height = readStore('rubban.dock.height', 300);
  if (!dock().classList.contains('maximized')) dock().style.height = `${Math.max(150, Math.min(window.innerHeight - 160, height))}px`;
}
function renderTabs() {
  $('#dock-tabs').replaceChildren(...sessions.map(session => {
    const tab = el('div', { class: `dock-tab${session === active ? ' active' : ''}`, role: 'tab', title: session.title, tabindex: '0' },
      el('span', { class: `dock-tab-icon ${session.kind}`, text: session.kind === 'logs' ? '≋' : '›_' }),
      el('span', { class: 'dock-tab-title', text: session.title }),
      el('span', { class: `dock-tab-state ${session.status || ''}` }),
      el('button', { type: 'button', class: 'dock-tab-close', 'aria-label': `Close ${session.title}`, text: '×', onclick: event => { event.stopPropagation(); close(session); } }));
    tab.addEventListener('click', () => activate(session));
    tab.addEventListener('auxclick', event => { if (event.button === 1) close(session); });
    return tab;
  }));
}
function setStatus(session, text, level = '') {
  session.statusText = text; session.status = level;
  if (session === active) $('#dock-status').textContent = text;
  renderTabs();
}
export function activate(session) {
  active = session;
  for (const s of sessions) s.root.classList.toggle('hidden', s !== session);
  $('#dock-status').textContent = session.statusText || '';
  renderTabs(); show();
  session.onShow?.();
}
function add(session) {
  session.id = ++counter;
  sessions.push(session);
  $('#dock-body').append(session.root);
  activate(session);
  return session;
}
export function close(session) {
  const index = sessions.indexOf(session);
  if (index < 0) return;
  sessions.splice(index, 1);
  try { session.dispose(); } catch { /* Already closed. */ }
  session.root.remove();
  if (active === session) active = sessions[Math.min(index, sessions.length - 1)] || null;
  if (active) activate(active); else { dock().classList.add('hidden'); renderTabs(); }
}
export function closeAll() { for (const session of [...sessions]) close(session); }
export function closeForContext(context) { for (const session of [...sessions]) if (session.context && session.context !== context) close(session); }

// ---- Logs ---------------------------------------------------------------------------------------
const SINCE = [['', 'All time'], ['300', '5 minutes'], ['900', '15 minutes'], ['3600', '1 hour'], ['21600', '6 hours'], ['86400', '24 hours']];
const TAIL = [['100', '100 lines'], ['500', '500 lines'], ['1000', '1,000 lines'], ['5000', '5,000 lines'], ['-1', 'All lines']];
export function openLogs(target) {
  const prefs = readStore('rubban.logs.options', {});
  const options = { container: target.container || '', previous: Boolean(target.previous), timestamps: Boolean(prefs.timestamps), wrap: prefs.wrap !== false, follow: true, since: target.since || '', tail: prefs.tail || '500' };
  const containers = [...new Set(target.containers || [])];
  if (!options.container && target.pod && containers.length === 1) options.container = containers[0];
  if (!options.container && target.pod && containers.length > 1) options.container = target.defaultContainer || containers[0];
  const output = el('pre', { class: `log-output${options.wrap ? ' wrap' : ''}`, tabindex: '0' });
  const containerSelect = el('select', { class: 'dock-select', 'aria-label': 'Container' },
    target.pod ? null : el('option', { value: '', text: 'All containers' }),
    containers.length > 1 && target.pod ? el('option', { value: '*', text: 'All containers' }) : null,
    containers.map(name => el('option', { value: name, text: name })));
  containerSelect.value = options.container || (target.pod ? containers[0] || '' : '');
  const sinceSelect = el('select', { class: 'dock-select', 'aria-label': 'Since' }, SINCE.map(([value, label]) => el('option', { value, text: label })));
  sinceSelect.value = options.since;
  const tailSelect = el('select', { class: 'dock-select', 'aria-label': 'Lines' }, TAIL.map(([value, label]) => el('option', { value, text: label })));
  tailSelect.value = options.tail;
  const toggle = (label, key, title) => { const node = el('label', { class: 'dock-toggle', title }, el('input', { type: 'checkbox', checked: options[key] }), label); node.querySelector('input').addEventListener('change', event => { options[key] = event.target.checked; if (key === 'wrap') { output.classList.toggle('wrap', options.wrap); savePrefs(); } else if (key === 'follow') { if (options.follow) output.scrollTop = output.scrollHeight; } else { savePrefs(); connect(); } }); return node; };
  const savePrefs = () => writeStore('rubban.logs.options', { timestamps: options.timestamps, wrap: options.wrap, tail: options.tail });
  const searchInput = el('input', { type: 'search', class: 'dock-search', placeholder: 'Search logs', 'aria-label': 'Search logs' });
  const searchCount = el('span', { class: 'dock-search-count' });
  let matches = []; let matchIndex = -1;
  const highlightSupported = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';
  function search(step = 0) {
    const needle = searchInput.value;
    if (highlightSupported) { if (highlightOwner === session) { CSS.highlights.delete('rubban-log-match'); CSS.highlights.delete('rubban-log-current'); } }
    if (!needle) { matches = []; matchIndex = -1; searchCount.textContent = ''; return; }
    output.normalize();
    const textNode = output.firstChild;
    const text = textNode?.textContent || '';
    const lower = text.toLowerCase(); const query = needle.toLowerCase();
    const found = []; let at = lower.indexOf(query);
    while (at >= 0 && found.length < 5000) { found.push(at); at = lower.indexOf(query, at + query.length); }
    matches = found;
    if (!found.length) { searchCount.textContent = 'No matches'; matchIndex = -1; return; }
    matchIndex = step === 0 && matchIndex < 0 ? found.length - 1 : (matchIndex + step + found.length) % found.length;
    if (highlightSupported && textNode) {
      const ranges = found.map(start => { const range = new Range(); range.setStart(textNode, start); range.setEnd(textNode, start + query.length); return range; });
      highlightOwner = session; CSS.highlights.set('rubban-log-match', new Highlight(...ranges));
      CSS.highlights.set('rubban-log-current', new Highlight(ranges[matchIndex]));
      const rect = ranges[matchIndex].getBoundingClientRect(); const box = output.getBoundingClientRect();
      if (rect.top < box.top || rect.bottom > box.bottom) { options.follow = false; followToggle.querySelector('input').checked = false; output.scrollTop += rect.top - box.top - box.height / 2; }
    }
    searchCount.textContent = `${matchIndex + 1} / ${found.length}${found.length >= 5000 ? '+' : ''}`;
  }
  searchInput.addEventListener('input', () => { matchIndex = -1; search(0); });
  searchInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); search(event.shiftKey ? -1 : 1); } });
  const followToggle = toggle('Follow', 'follow', 'Keep scrolling to the newest lines');
  const toolbar = el('div', { class: 'dock-toolbar' },
    target.pod ? el('span', { class: 'dock-target', text: target.pod }) : el('span', { class: 'dock-target', text: `selector ${target.selector}` }),
    containers.length ? containerSelect : null, sinceSelect, tailSelect,
    toggle('Timestamps', 'timestamps', 'Prefix each line with its timestamp'),
    target.pod ? toggle('Previous', 'previous', 'Logs of the previous terminated container') : null,
    toggle('Wrap', 'wrap', 'Wrap long lines'), followToggle,
    el('span', { class: 'spacer' }),
    searchInput, searchCount,
    button('▴', () => search(-1), 'quiet compact icon-text'), button('▾', () => search(1), 'quiet compact icon-text'),
    button('Download', () => download(`${(target.pod || target.title || 'logs').replace(/[^\w.-]+/g, '_')}${options.container && options.container !== '*' ? `-${options.container}` : ''}.log`, output.textContent), 'quiet compact'),
    button('Clear', () => { output.replaceChildren(); search(0); }, 'quiet compact'));
  const root = el('div', { class: 'dock-session logs' }, toolbar, output);
  let socket = null; let bytes = 0; let researchTimer = null;
  output.addEventListener('scroll', () => { const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 40; if (!atBottom && options.follow && document.activeElement === output) { options.follow = false; followToggle.querySelector('input').checked = false; } });
  function append(text) {
    output.append(document.createTextNode(text)); bytes += text.length;
    if (bytes > 4000000) { output.normalize(); const content = output.textContent; output.textContent = content.slice(content.indexOf('\n', content.length - 3000000) + 1); bytes = output.textContent.length; }
    if (options.follow) output.scrollTop = output.scrollHeight;
  }
  function connect() {
    socket?.close(); output.replaceChildren(); bytes = 0;
    options.container = containerSelect.value; options.since = sinceSelect.value; options.tail = tailSelect.value;
    const query = { context: target.context, namespace: target.namespace, tail: options.tail, timestamps: options.timestamps ? 'true' : undefined, since: options.since || undefined, follow: 'true' };
    if (target.pod) Object.assign(query, { pod: target.pod, container: options.container || undefined, previous: options.previous ? 'true' : undefined });
    else Object.assign(query, { selector: target.selector, container: options.container || '*' });
    if (options.previous) query.follow = 'false';
    setStatus(session, 'Connecting…', 'pending');
    const ws = new WebSocket(socketURL('/api/logs', query)); socket = ws;
    ws.addEventListener('open', () => { if (socket === ws) setStatus(session, options.previous ? 'Previous container logs' : 'Streaming', 'good'); });
    ws.addEventListener('message', event => { if (socket !== ws) return; append(event.data); if (searchInput.value && !researchTimer) researchTimer = setTimeout(() => { researchTimer = null; const keep = matchIndex; search(0); if (keep >= 0 && keep < matches.length) matchIndex = keep; }, 400); });
    ws.addEventListener('close', event => { if (socket === ws) setStatus(session, `Stream ended${event.reason ? ` · ${event.reason}` : ''}`, 'done'); });
    ws.addEventListener('error', () => { if (socket === ws) setStatus(session, 'Log connection failed', 'bad'); });
  }
  containerSelect.addEventListener('change', connect); sinceSelect.addEventListener('change', connect); tailSelect.addEventListener('change', () => { options.tail = tailSelect.value; savePrefs(); connect(); });
  const session = { kind: 'logs', context: target.context, title: target.title || `${target.pod}${options.container && options.container !== '*' ? ` · ${options.container}` : ''}`, root, dispose: () => { socket?.close(); socket = null; if (highlightSupported) { if (highlightOwner === session) { CSS.highlights.delete('rubban-log-match'); CSS.highlights.delete('rubban-log-current'); } } }, copy: () => window.getSelection()?.toString() || output.textContent, onShow: () => { if (options.follow) output.scrollTop = output.scrollHeight; } };
  add(session);
  options.tail = tailSelect.value;
  connect();
  return session;
}

// ---- Terminals ----------------------------------------------------------------------------------
export async function openTerminal(target = {}) {
  const host = el('div', { class: 'terminal-host' });
  const root = el('div', { class: 'dock-session terminal' }, host);
  let socket = null; let terminal = null; let fit = null;
  const session = {
    kind: 'terminal', context: target.context, title: target.title || 'Local shell', root,
    dispose: () => { socket?.close(); socket = null; terminal?.dispose(); terminal = null; },
    copy: () => terminal?.getSelection() || '',
    onShow: () => { requestAnimationFrame(() => { try { fit?.fit(); terminal?.focus(); } catch { /* Not visible yet. */ } }); },
    fit: () => { try { fit?.fit(); } catch { /* Hidden. */ } },
  };
  add(session);
  setStatus(session, 'Connecting…', 'pending');
  try {
    const { Terminal, FitAddon } = await import('/vendor.js');
    if (!sessions.includes(session)) return session;
    terminal = new Terminal({ cursorBlink: false, fontSize: 12, scrollback: 10000, fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace", theme: XTERM_THEME });
    fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host); fit.fit();
    const query = target.node ? { context: target.context, node: target.node, image: target.image } : target.pod ? { context: target.context, namespace: target.namespace, pod: target.pod, container: target.container, attach: target.attach ? 'true' : undefined } : target.context ? { context: target.context, namespace: target.namespace } : {};
    const ws = new WebSocket(socketURL('/api/terminal', query)); socket = ws;
    ws.addEventListener('open', () => { if (socket !== ws) return; setStatus(session, target.node ? 'Starting node shell pod…' : 'Connected', 'good'); ws.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows })); terminal.focus(); });
    ws.addEventListener('message', event => {
      if (socket !== ws) return;
      let data; try { data = JSON.parse(event.data); } catch { terminal.write(event.data); return; }
      if (data.type === 'data') { terminal.write(data.data); if (session.status === 'good' && target.node && session.statusText !== 'Connected') setStatus(session, 'Connected', 'good'); }
      else if (data.type === 'error' || data.type === 'status') { const text = data.message || data.error || data.data || data.status || 'Terminal status changed'; setStatus(session, text, data.type === 'error' ? 'bad' : 'good'); terminal.writeln(`\r\n${text}`); }
      else if (data.type === 'exit') setStatus(session, `Exited${data.code !== undefined ? ` (${data.code})` : ''}`, 'done');
    });
    terminal.onData(data => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data })); });
    terminal.onResize(size => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', ...size })); });
    ws.addEventListener('close', () => { if (socket === ws) setStatus(session, 'Session closed', 'done'); });
    ws.addEventListener('error', () => { if (socket === ws) setStatus(session, 'Terminal connection failed', 'bad'); });
  } catch (error) {
    setStatus(session, 'Terminal unavailable', 'bad');
    host.replaceChildren(el('div', { class: 'callout error', text: `Terminal could not start: ${error.message}` }));
  }
  return session;
}

// ---- Dock chrome --------------------------------------------------------------------------------
export function setupDock() {
  $('#dock-close').addEventListener('click', () => { if (active) close(active); });
  $('#dock-new').addEventListener('click', () => openTerminal(localShellTarget()));
  $('#dock-max').addEventListener('click', () => { const maximized = dock().classList.toggle('maximized'); if (!maximized) show(); else dock().style.height = ''; active?.onShow?.(); });
  $('#dock-min').addEventListener('click', () => { dock().classList.add('hidden'); });
  $('#dock-copy').addEventListener('click', task(async () => { const text = active?.copy?.(); if (!text) { toast('Select text to copy.'); return; } await navigator.clipboard.writeText(text); toast('Copied to clipboard.'); }));
  const handle = $('#dock-resize');
  handle.addEventListener('pointerdown', event => {
    event.preventDefault(); handle.setPointerCapture(event.pointerId);
    const startY = event.clientY; const startHeight = dock().getBoundingClientRect().height;
    dock().classList.remove('maximized');
    const move = moveEvent => { const height = Math.max(150, Math.min(window.innerHeight - 160, startHeight + startY - moveEvent.clientY)); dock().style.height = `${height}px`; active?.fit?.(); };
    const up = () => { handle.removeEventListener('pointermove', move); writeStore('rubban.dock.height', Math.round(dock().getBoundingClientRect().height)); active?.onShow?.(); };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
  });
  window.addEventListener('resize', () => active?.fit?.());
  window.addEventListener('beforeunload', closeAll);
}
export const hasSessions = () => sessions.length > 0;
// Local shells opened while a cluster is selected get a kubeconfig scoped to it.
export const localShellTarget = () => (state.context ? { title: `Shell · ${state.context}`, context: state.context, namespace: state.namespace === '*' ? '' : state.namespace } : { title: 'Local shell' });
export function toggleDock() { if (!sessions.length) { openTerminal(localShellTarget()); return; } if (dock().classList.contains('hidden')) activate(active || sessions[0]); else dock().classList.add('hidden'); }
export { state as dockState };
