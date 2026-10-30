// Update button, status bar hint and the Settings › Updates panel. The main process does the work;
// the page only shows state and sends commands over window.rubbanDesktop.updates.
import { $, state, el, button, badge, info, toast, task, api, panel } from './kit.js';
import { renderMarkdown } from './markdown.js';

const bridge = () => globalThis.rubbanDesktop?.updates;
let current = null;
let listeners = [];
let reportedResult = false;
const RING = 2 * Math.PI * 7;

export const updateLabel = value => !value ? '' : value.status === 'available' ? `${value.latest} available` : value.status === 'downloading' ? `Downloading ${Math.round(value.progress * 100)}%` : value.status === 'ready' ? `${value.latest} ready to install` : value.status === 'installing' ? 'Installing…' : value.status === 'error' && value.latest ? 'Update problem' : '';

function ring(progress) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('class', 'update-ring'); svg.setAttribute('aria-hidden', 'true');
  for (const [cls, dash] of [['track', `${RING} 0`], ['fill', `${RING * progress} ${RING}`]]) {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '10'); circle.setAttribute('cy', '10'); circle.setAttribute('r', '7'); circle.setAttribute('class', cls); circle.setAttribute('stroke-dasharray', dash);
    circle.setAttribute('transform', 'rotate(-90 10 10)');
    svg.append(circle);
  }
  return svg;
}

function paint() {
  const node = $('#update-button');
  const value = current;
  const visible = Boolean(bridge() && value && !value.disabled && ['available', 'downloading', 'ready', 'installing', 'error'].includes(value.status) && (value.status !== 'error' || value.latest));
  node?.classList.toggle('hidden', !visible);
  if (node && visible) {
    node.dataset.status = value.status;
    node.replaceChildren(value.status === 'downloading' ? ring(value.progress) : el('span', { class: 'update-arrow', text: '⇩' }), el('i', { class: `update-dot ${value.status}` }));
    node.title = value.status === 'error' ? `Update problem: ${value.error}` : updateLabel(value);
    node.setAttribute('aria-label', node.title);
  }
  const version = $('#app-version');
  if (version) { const base = `Rubban ${state.health?.version || 'Desktop'}`; version.textContent = visible && updateLabel(value) ? `${base} · ${updateLabel(value)}` : base; }
  if (value?.result && !reportedResult) { reportedResult = true; toast(value.result.ok ? `Updated to ${value.result.version}.` : `The update could not be installed: ${value.result.error}`, !value.result.ok); }
  for (const listener of listeners) listener(value);
}

export async function setupUpdates({ openSettings }) {
  const updates = bridge();
  if (!updates) return;
  const act = task(async () => {
    if (!current) return;
    if (current.status === 'available') await updates.download();
    else if (current.status === 'ready') await updates.install();
    else openSettings();
  });
  $('#update-button')?.addEventListener('click', act);
  updates.onState(value => { current = value; paint(); });
  current = await updates.getState().catch(() => null);
  paint();
}
export const updateState = () => current;

export function updatesPanel() {
  const updates = bridge();
  if (!updates) return panel('Updates', info('Updates are managed by the desktop app. In the browser version, update by pulling a new release.'));
  const body = el('div');
  const draw = value => {
    if (!value) { body.replaceChildren(info('Update information is not available.')); return; }
    const auto = el('input', { type: 'checkbox', checked: state.preferences.updates?.auto !== false, 'aria-label': 'Check for updates automatically', onchange: task(async event => { state.preferences = await api('/api/preferences', { method: 'PUT', body: { ...state.preferences, updates: { ...(state.preferences.updates || {}), auto: event.target.checked } } }); toast('Preferences saved.'); }) });
    const rows = [
      el('p', {}, `Current version ${value.current}`, value.lastCheck ? ` · last checked ${new Date(value.lastCheck).toLocaleString()}` : ' · not checked yet'),
      value.disabled ? info('Updates are turned off for this run (source checkout or RUBBAN_DISABLE_UPDATES=1).') : null,
      value.status === 'up-to-date' ? badge('You have the latest version', 'good') : null,
      value.status === 'error' ? info(value.error || 'The update failed.', 'error') : null,
      value.latest && value.status !== 'up-to-date' && value.status !== 'idle' ? el('p', {}, el('strong', { text: `Version ${value.latest}` }), ` · ${updateLabel(value) || value.status}`) : null,
      el('div', { class: 'actions' },
        button('Check now', task(() => updates.check()), 'compact'),
        value.status === 'available' ? button('Download', task(() => updates.download()), 'primary compact') : null,
        value.status === 'downloading' ? button(`Downloading ${Math.round(value.progress * 100)}%`, () => {}, 'compact') : null,
        value.status === 'ready' ? button('Install and restart', task(() => updates.install()), 'primary compact') : null,
        el('label', { class: 'inline-check' }, auto, ' Check automatically')),
      value.notes && value.status !== 'up-to-date' ? el('div', {}, el('h3', { class: 'mini-title', text: 'Release notes' }), renderMarkdown(value.notes)) : null,
    ].filter(Boolean);
    body.replaceChildren(...rows);
  };
  draw(current);
  const listener = value => { if (body.isConnected) draw(value); };
  listeners = listeners.filter(item => item.__live !== false); listener.__live = true; listeners.push(listener);
  updates.getState().then(value => { current = value; draw(value); }).catch(() => {});
  return panel('Updates', body);
}
