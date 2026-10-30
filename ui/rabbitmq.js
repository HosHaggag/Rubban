// RabbitMQ: the management console of each RabbitMQ in the cluster, shown inside Rubban and
// signed in with the login the deployment was created with. The console runs on its own loopback
// origin (an embed proxy in front of a port forward), so it cannot reach Rubban's API token; the
// login is handed to it with postMessage, addressed to that origin only.
import { state, hooks, el, button, badge, info, loading, get, post, page, actions, empty, readStore, writeStore, toast, task } from './kit.js';

const STORE = 'rubban.rabbitmq.selected';
const describePods = pods => (pods.total ? `${pods.ready}/${pods.total} pods ready` : 'no pods behind the Service');

export function rabbitmqPage() {
  const signal = state.pageAbort.signal;
  const context = state.context;
  const scope = state.namespace === '*' ? 'all namespaces' : `namespace ${state.namespace}`;
  const refreshButton = button('↻ Refresh', () => hooks.render?.(), 'compact');
  const root = page('RabbitMQ', `Management console for RabbitMQ in ${scope}, signed in with the deployment's initial login.`, actions(refreshButton));
  const body = el('div', { class: 'rabbitmq-page' }, loading('Looking for RabbitMQ management Services…'));
  root.append(body);
  if (!context) { body.replaceChildren(empty('Choose a cluster', 'Select a kubeconfig context to find RabbitMQ in it.')); return root; }

  get('/api/rabbitmq', { context, namespace: state.namespace }, { signal }).then(({ items }) => {
    if (signal.aborted) return;
    if (!items.length) {
      body.replaceChildren(empty('No RabbitMQ found', `Rubban looks for Services that expose the RabbitMQ management port (15672, or a port named management or http-stats) in ${scope}. Install the management plugin, or pick another namespace or cluster.`, null, '✉'));
      return;
    }
    const remembered = readStore(STORE, {})[context];
    let current = items.find(item => item.id === remembered) || items[0];
    const picker = el('select', { class: 'compact-select', 'aria-label': 'RabbitMQ instance' }, items.map(item => el('option', { value: item.id, text: `${item.namespace} / ${item.service}` })));
    picker.value = current.id;
    const holder = el('div', { class: 'rabbitmq-instance' });
    picker.addEventListener('change', () => {
      current = items.find(item => item.id === picker.value);
      writeStore(STORE, { ...readStore(STORE, {}), [context]: current.id });
      showInstance(current, holder, signal);
    });
    body.replaceChildren(el('div', { class: 'rabbitmq-bar' }, items.length > 1 ? picker : el('strong', { class: 'mono', text: `${current.namespace} / ${current.service}` }), el('span', { class: 'muted', text: `${items.length} instance${items.length === 1 ? '' : 's'} found` })), holder);
    showInstance(current, holder, signal);
  }).catch(error => { if (!signal.aborted) body.replaceChildren(info(error.message, 'error')); });
  return root;
}

function showInstance(instance, holder, pageSignal) {
  // Each instance view gets its own abort, so switching instances drops the old message listener.
  holder.abort?.abort();
  const controller = new AbortController(); holder.abort = controller;
  pageSignal.addEventListener('abort', () => controller.abort(), { once: true });
  const signal = controller.signal;
  const context = state.context;
  let login = null; let loginError = ''; let opened = null; let sent = false; let ready = false; let revealed = false;

  const facts = el('div', { class: 'rabbitmq-facts' },
    badge(instance.kind, 'info'),
    instance.image ? el('span', { class: 'mono', text: instance.image }) : null,
    el('span', { text: describePods(instance.pods) }),
    el('span', { text: `management :${instance.port}${instance.scheme === 'https' ? ' (TLS)' : ''}` }),
    instance.amqpPort ? el('span', { text: `AMQP :${instance.amqpPort}` }) : null);
  const userValue = el('span', { class: 'mono', text: '…' });
  const passValue = el('span', { class: 'mono', text: '…' });
  const showPassword = () => { passValue.textContent = login ? (revealed ? login.password : '•'.repeat(Math.min(16, Math.max(8, login.password.length)))) : loginError ? '—' : '…'; };
  const revealButton = button('Reveal', () => { revealed = !revealed; revealButton.textContent = revealed ? 'Hide' : 'Reveal'; showPassword(); }, 'quiet compact');
  const copy = (label, pick) => button(label, task(async () => { if (!login) throw new Error(loginError || 'The login is not loaded yet.'); await navigator.clipboard.writeText(pick(login)); toast(`${label.replace('Copy ', '')} copied.`); }), 'quiet compact');
  const sameSecret = /^Secret (\S+) › /.exec(instance.login.username)?.[1];
  const loginText = sameSecret && instance.login.password.startsWith(`Secret ${sameSecret} › `)
    ? `Initial login from Secret ${sameSecret} (${instance.login.username.split(' › ')[1]}, ${instance.login.password.split(' › ')[1]})`
    : instance.login.username === instance.login.password ? `Initial login: ${instance.login.username}` : `Initial login · username: ${instance.login.username} · password: ${instance.login.password}`;
  const source = el('span', { class: 'muted', text: loginText });
  const status = el('span', { class: 'rabbitmq-status muted', text: 'Connecting…' });
  const openButton = button('↗ Open in browser', () => { if (opened) hooks.openExternal?.(`http://localhost:${opened.localPort}/`); }, 'compact');
  openButton.disabled = true;
  const reconnect = button('↻ Reconnect', () => showInstance(instance, holder, pageSignal), 'compact');
  const credentials = el('div', { class: 'rabbitmq-login' },
    el('span', { class: 'muted', text: 'Username' }), userValue, copy('Copy username', l => l.username),
    el('span', { class: 'muted', text: 'Password' }), passValue, revealButton, copy('Copy password', l => l.password),
    el('span', { class: 'spacer' }), status, openButton, reconnect);
  const frameBox = el('div', { class: 'rabbitmq-frame-box' }, loading('Starting a port forward to the management console…'));
  holder.replaceChildren(facts, credentials, source, frameBox);

  const setStatus = (text, level = '') => { status.textContent = text; status.className = `rabbitmq-status ${level === 'bad' ? 'bad-text' : level === 'good' ? 'good-text' : 'muted'}`; };
  // Send only after the console's bridge said it is listening; an earlier message would reach
  // the iframe's initial blank page and be dropped.
  const sendLogin = frame => {
    if (sent || !ready || !login || !opened || !frame?.contentWindow) return;
    sent = true;
    frame.contentWindow.postMessage({ type: 'rubban:login', username: login.username, password: login.password }, opened.origin);
    setStatus(`Signing in as ${login.username}…`);
  };

  const target = { context, namespace: instance.namespace, service: instance.service };
  post('/api/rabbitmq/credentials', target, { signal })
    .then(result => { login = result; userValue.textContent = result.username; showPassword(); if (opened) sendLogin(holder.querySelector('iframe')); })
    .catch(error => { if (signal.aborted) return; loginError = error.message; userValue.textContent = '—'; showPassword(); source.textContent = `The initial login could not be read: ${error.message}. Sign in with your own credentials.`; source.className = 'warn-text'; });
  post('/api/rabbitmq/open', target, { signal }).then(result => {
    if (signal.aborted) return;
    opened = result; openButton.disabled = false;
    const frame = el('iframe', { class: 'rabbitmq-frame', title: `RabbitMQ management · ${instance.namespace}/${instance.service}`, src: result.url, sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals', referrerpolicy: 'no-referrer' });
    window.addEventListener('message', event => {
      if (event.origin !== result.origin || event.source !== frame.contentWindow) return;
      const type = event.data?.type;
      if (type === 'rubban:ready') { ready = true; if (!sent) { if (login) sendLogin(frame); else if (!loginError) setStatus('Reading the initial login…'); else setStatus('Sign in with your credentials'); } }
      else if (type === 'rubban:login-sent') setStatus('Verifying RabbitMQ login…');
      else if (type === 'rubban:authenticated') setStatus(`Signed in as ${login?.username || ''}`, 'good');
      else if (type === 'rubban:login-failed') setStatus('RabbitMQ rejected the Secret credentials. Check the Secret or sign in manually.', 'bad');
      else if (type === 'rubban:login-timeout') setStatus('Automatic login timed out. Reconnect to retry or sign in manually.', 'bad');
      else if (type === 'rubban:credentials-unavailable') setStatus('The Kubernetes Secret could not be read. Check access or sign in manually.', 'bad');
    }, { signal });
    frame.addEventListener('load', () => {
      frame.contentWindow?.postMessage({ type: 'rubban:connect' }, result.origin);
      if (!sent) setStatus(loginError ? 'Sign in with your credentials' : 'Reading the Secret and signing in…');
    });
    frameBox.replaceChildren(frame);
  }).catch(error => {
    if (signal.aborted) return;
    setStatus('Not connected', 'bad');
    frameBox.replaceChildren(info(`Could not open the management console: ${error.message}`, 'error'), el('div', { class: 'form-actions start' }, button('Try again', () => showInstance(instance, holder, pageSignal), 'primary compact')));
  });
}
