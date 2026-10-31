// Cluster switcher, hotbar, Clusters page and kubeconfig import.
import { $, state, hooks, el, button, badge, info, toast, task, api, get, post, page, panel, popup, closeMenus } from './kit.js';
import { clusterInfo, CLUSTER_COLORS, CLUSTER_ENVS } from './clusters.js';
import { clusterIcon, CLUSTER_ICON_IDS } from './cluster-icons.js';
import { isExpired, authOf, tooltip } from './credentials.js';

const clusters = () => state.preferences.clusters || {};
export const infoFor = name => clusterInfo(name, clusters());
export const labelFor = name => (name ? infoFor(name).label : '');
export const envFor = name => (name ? infoFor(name).env : '');
const favorites = () => (Array.isArray(state.preferences.favoriteContexts) ? state.preferences.favoriteContexts.filter(name => typeof name === 'string') : []);
const savePreferences = async patch => { state.preferences = await api('/api/preferences', { method: 'PUT', body: { ...state.preferences, ...patch } }); return state.preferences; };
const iconBox = (name, className = 'cluster-badge') => {
  const meta = infoFor(name); const expired = isExpired(name);
  const box = el('span', { class: `${className}${expired ? ' auth-expired' : ''}`, style: `color:${meta.color}`, title: expired ? tooltip(meta.label, authOf(name)) : meta.label });
  box.append(clusterIcon(meta.icon)); return box;
};
const envBadge = env => (env ? badge(env, env === 'production' ? 'bad' : env === 'staging' ? 'warn' : 'info') : null);

export async function saveCluster(name, patch) {
  const next = { ...clusters() };
  const merged = { ...(next[name] || {}), ...patch };
  for (const key of Object.keys(merged)) if (merged[key] === '' && key !== 'env') delete merged[key];
  next[name] = merged;
  await savePreferences({ clusters: next });
  renderCluster();
}
export async function toggleFavoriteName(name) {
  const list = favorites();
  await savePreferences({ favoriteContexts: list.includes(name) ? list.filter(item => item !== name) : [...list, name] });
  renderCluster();
}

// Sidebar button, status bar, hotbar. Called whenever the selection, contexts or preferences change.
export function renderCluster() {
  const name = state.context;
  const switcher = $('#context-switcher');
  if (switcher) {
    const meta = name ? infoFor(name) : null;
    switcher.replaceChildren(
      meta ? iconBox(name, 'cluster-badge') : el('span', { class: 'cluster-badge' }, clusterIcon('cluster')),
      el('span', { class: 'context-text' }, el('span', { class: 'context-label', text: 'Cluster' }), el('span', { class: 'context-name', text: meta ? meta.label : 'Select a cluster…' })),
      ...(meta && meta.env ? [envBadge(meta.env)] : []));
    switcher.title = name ? `${meta.label} · ${name}` : 'Choose a cluster (Ctrl+Shift+K)';
  }
  const status = $('#workspace-context');
  if (status) { status.textContent = name ? labelFor(name) : 'Local workspace'; status.title = name || ''; }
  const list = favorites();
  const hotbar = $('#context-favorites');
  if (hotbar) {
    hotbar.replaceChildren(...list.map(item => {
      const available = state.contexts.some(context => context.name === item);
      const node = el('button', { type: 'button', class: `favorite-context${item === name ? ' selected' : ''}${available ? '' : ' missing'}${isExpired(item) ? ' auth-expired' : ''}`, draggable: 'true', 'data-name': item, title: isExpired(item) ? tooltip(labelFor(item), authOf(item)) : available ? `${labelFor(item)} · ${item}` : `${item} · context is missing from kubeconfig`, 'aria-label': labelFor(item), onclick: () => hooks.selectContext(item) });
      node.append(clusterIcon(infoFor(item).icon));
      node.style.color = infoFor(item).color;
      node.addEventListener('dragstart', event => { event.dataTransfer.setData('text/plain', item); event.dataTransfer.effectAllowed = 'move'; });
      node.addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; });
      node.addEventListener('drop', task(async event => {
        event.preventDefault();
        const from = event.dataTransfer.getData('text/plain');
        if (!from || from === item) return;
        const order = favorites().filter(entry => entry !== from);
        order.splice(order.indexOf(item), 0, from);
        await savePreferences({ favoriteContexts: order });
        renderCluster();
      }));
      return node;
    }));
  }
  const pin = $('#pin-context');
  if (pin) {
    const pinned = list.includes(name);
    pin.textContent = pinned ? '★' : '☆'; pin.disabled = !name;
    pin.title = pinned ? 'Unpin selected cluster from hotbar' : 'Pin selected cluster to hotbar';
    pin.setAttribute('aria-label', pin.title);
  }
}

// ---- Switcher popover ----------------------------------------------------------------------------
export function openSwitcher({ newTab = false } = {}) {
  const dialog = $('#switcher-dialog'); const search = $('#switcher-search'); const listNode = $('#switcher-list');
  let active = 0; let rows = [];
  search.placeholder = newTab ? 'Open a cluster in a new tab…' : 'Switch cluster…';
  const choose = name => { dialog.close(); if (newTab) hooks.newClusterTab(name); else if (name !== state.context) hooks.selectContext(name); };
  const row = context => {
    const meta = infoFor(context.name);
    const pinned = favorites().includes(context.name);
    const main = el('button', { type: 'button', class: 'switcher-main', onclick: () => choose(context.name) }, iconBox(context.name), el('span', { class: 'switcher-text' }, el('strong', { text: meta.label }), el('small', { text: meta.label === context.name ? context.cluster || '' : context.name })), envBadge(meta.env), context.source && context.source !== 'default' ? badge('imported') : null);
    const pin = el('button', { type: 'button', class: 'switcher-pin', title: pinned ? 'Unpin' : 'Pin', 'aria-label': pinned ? `Unpin ${meta.label}` : `Pin ${meta.label}`, text: pinned ? '★' : '☆', onclick: task(async () => { await toggleFavoriteName(context.name); draw(); }) });
    return { node: el('div', { class: `switcher-row${context.name === state.context ? ' current' : ''}`, role: 'option' }, main, pin), main };
  };
  const draw = () => {
    const query = search.value.trim().toLowerCase();
    const matching = state.contexts.filter(context => !query || `${infoFor(context.name).label} ${context.name} ${context.cluster}`.toLowerCase().includes(query));
    const pinned = favorites().map(name => matching.find(context => context.name === name)).filter(Boolean);
    const others = matching.filter(context => !pinned.includes(context));
    rows = []; const nodes = [];
    for (const [title, group] of [['Pinned', pinned], ['All clusters', others]]) {
      if (!group.length) continue;
      nodes.push(el('div', { class: 'switcher-group', text: title }));
      for (const context of group) { const made = row(context); rows.push(made); nodes.push(made.node); }
    }
    if (!rows.length) nodes.push(el('p', { class: 'list-note', style: 'padding:12px', text: state.contexts.length ? 'No matching clusters.' : 'No clusters yet. Import a kubeconfig from Manage clusters.' }));
    listNode.replaceChildren(...nodes);
    active = Math.min(active, Math.max(rows.length - 1, 0));
    mark();
  };
  const mark = () => rows.forEach((made, index) => { made.node.classList.toggle('active', index === active); if (index === active) made.node.scrollIntoView({ block: 'nearest' }); });
  search.value = ''; active = Math.max(0, state.contexts.findIndex(context => context.name === state.context));
  search.oninput = () => { active = 0; draw(); };
  search.onkeydown = event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); active = Math.min(active + 1, rows.length - 1); mark(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); active = Math.max(active - 1, 0); mark(); }
    else if (event.key === 'Enter') { event.preventDefault(); rows[active]?.main.click(); }
  };
  $('#switcher-manage').onclick = () => { dialog.close(); hooks.openView('clusters'); };
  draw();
  if (!dialog.open) dialog.showModal();
  search.focus();
}

// ---- Import --------------------------------------------------------------------------------------
async function importKubeconfig({ name, content, source, fileName }) {
  const entry = await post('/api/kubeconfigs', { name, content, source, fileName });
  await hooks.reloadContexts();
  toast(`Imported ${entry.contexts.length} cluster${entry.contexts.length === 1 ? '' : 's'}.`);
  if (!state.context && entry.contexts[0]) await hooks.selectContext(entry.contexts[0]);
  return entry;
}
export function importPanels(onDone = () => {}) {
  const name = el('input', { placeholder: 'Name (optional)', 'aria-label': 'Name for the imported kubeconfig' });
  const text = el('textarea', { rows: 7, class: 'editor', placeholder: 'apiVersion: v1\nkind: Config\nclusters: …', 'aria-label': 'Kubeconfig YAML', spellcheck: 'false' });
  const paste = panel('Paste a kubeconfig', [info('Rubban keeps a private copy in its data folder. Your own kubeconfig is never changed.'), el('div', { class: 'field', style: 'margin:10px 0' }, name), text, el('div', { class: 'form-actions' }, button('Import', task(async () => { await importKubeconfig({ name: name.value, content: text.value, source: 'paste' }); text.value = ''; name.value = ''; onDone(); }), 'primary'))]);
  const file = el('input', { type: 'file', accept: '.yaml,.yml,.kubeconfig,.config,*/*', 'aria-label': 'Kubeconfig file' });
  const upload = panel('Import a kubeconfig file', [info('Choose a kubeconfig file. Its contents are copied into Rubban; the file itself is not read again.'), el('div', { class: 'form-actions start', style: 'margin-top:10px' }, file, button('Import file', task(async () => {
    const chosen = file.files?.[0];
    if (!chosen) throw new Error('Choose a file first.');
    if (chosen.size > 1024 * 1024) throw new Error('The kubeconfig is larger than 1 MB.');
    await importKubeconfig({ name: chosen.name.replace(/\.[^.]+$/, ''), content: await chosen.text(), source: 'file', fileName: chosen.name }); file.value = ''; onDone();
  }), 'primary'))]);
  return el('div', { class: 'import-grid' }, paste, upload);
}

// ---- Clusters page -------------------------------------------------------------------------------
export async function clustersPage() {
  const root = page('Clusters', 'Name, colour and tag your clusters. Tag production clusters to be asked to type a resource name before destructive actions.');
  const body = el('div');
  const imports = (await get('/api/kubeconfigs')).kubeconfigs || [];
  const draw = () => {
    const pinned = favorites();
    const rows = state.contexts.map(context => {
      const meta = infoFor(context.name); const saved = clusters()[context.name] || {};
      const label = el('input', { value: saved.label || '', placeholder: context.name, 'aria-label': `Label for ${context.name}`, onchange: task(event => saveCluster(context.name, { label: event.target.value.trim() })) });
      const pick = el('button', { type: 'button', class: 'icon-picker', title: 'Choose an icon', 'aria-label': `Icon for ${context.name}`, 'aria-haspopup': 'true' }, iconBox(context.name));
      pick.onclick = () => popup(pick, el('div', { class: 'icon-grid', role: 'group', 'aria-label': 'Icons' }, CLUSTER_ICON_IDS.map(id => el('button', { type: 'button', class: id === meta.icon ? 'selected' : '', title: id, 'aria-label': id, onclick: task(async () => { closeMenus(); await saveCluster(context.name, { icon: id }); draw(); }) }, clusterIcon(id)))));
      const colors = el('div', { class: 'color-swatches' }, CLUSTER_COLORS.map(color => el('button', { type: 'button', class: `swatch-button${color === meta.color ? ' selected' : ''}`, style: `background:${color}`, title: color, 'aria-label': `Colour ${color}`, onclick: task(async () => { await saveCluster(context.name, { color }); draw(); }) })),
        el('input', { type: 'color', value: meta.color, 'aria-label': `Custom colour for ${context.name}`, onchange: task(async event => { await saveCluster(context.name, { color: event.target.value }); draw(); }) }));
      const env = el('select', { 'aria-label': `Environment of ${context.name}`, onchange: task(async event => { await saveCluster(context.name, { env: event.target.value }); draw(); }) }, el('option', { value: '', text: meta.env && !saved.env ? `${meta.env} (guessed)` : 'Not set' }), CLUSTER_ENVS.map(value => el('option', { value, text: value, selected: saved.env === value ? 'selected' : undefined })));
      if (saved.env) env.value = saved.env;
      const pin = el('input', { type: 'checkbox', checked: pinned.includes(context.name), 'aria-label': `Pin ${context.name}`, onchange: task(async () => { await toggleFavoriteName(context.name); draw(); }) });
      const imported = imports.find(entry => entry.id === context.source);
      const remove = imported ? button('Remove import', task(async () => { await api(`/api/kubeconfigs/${imported.id}`, { method: 'DELETE' }); if (imported.contexts.includes(state.context)) await hooks.selectContext(''); await hooks.reloadContexts(); toast('Import removed.'); hooks.openView('clusters'); }), 'compact danger') : null;
      return el('tr', {}, el('td', {}, pick), el('td', {}, label, el('small', { class: 'muted', text: context.name })), el('td', {}, colors), el('td', {}, env), el('td', {}, pin), el('td', {}, imported ? badge(`imported · ${imported.name}`) : badge('kubeconfig')), el('td', {}, remove));
    });
    body.replaceChildren(...[el('table', { class: 'cluster-table' }, el('thead', {}, el('tr', {}, ['Icon', 'Label', 'Colour', 'Environment', 'Pinned', 'Source', ''].map(title => el('th', { text: title })))), el('tbody', {}, rows)), state.contexts.length ? null : info('No clusters found yet. Import a kubeconfig below.')].filter(Boolean));
  };
  draw();
  root.append(panel('Your clusters', body, button('↻ Reload', task(async () => { await hooks.reloadContexts(); hooks.openView('clusters'); }), 'compact')), el('div', { style: 'height:14px' }), importPanels(() => hooks.openView('clusters')));
  return root;
}
