'use strict';

// Live cluster data layer.
//
// One `kubectl proxy` per kubeconfig context keeps a single authenticated
// connection to the API server, so exec credential plugins (gke-gcloud-auth-plugin,
// kubelogin, aws eks get-token) run once per token lifetime instead of once per
// request. The proxy listens on an OS-chosen loopback port under an unguessable
// path prefix. Reads go straight through it; resource views use shared
// LIST + WATCH streams with bookmarks, 410 relists, idle-stream recovery and
// exponential backoff. Writes stay on kubectl (apply/diff/delete semantics).

const http = require('node:http');
const crypto = require('node:crypto');

const DISCOVERY_TTL_MS = 5 * 60 * 1000;
const LIST_PAGE_SIZE = 500;
const WATCH_TIMEOUT_SECONDS = 290;
const STREAM_IDLE_MS = 150 * 1000;
// Kept after the last viewer leaves so going back to a view (or reloading the window) reuses the
// list and watch instead of listing again from the API server.
const WATCH_LINGER_MS = 2 * 60 * 1000;
const PROXY_IDLE_MS = 10 * 60 * 1000;
const PROXY_START_MS = 30 * 1000;
const POLL_INTERVAL_MS = 15 * 1000;
const FLUSH_MS = 150;
const MAX_BACKOFF_MS = 30 * 1000;
const RESPONSE_LIMIT = 96 * 1024 * 1024;
const EVENT_LINE_LIMIT = 16 * 1024 * 1024;
const AGGREGATED_ACCEPT = 'application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList,application/json';
const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration';

function liveError(message, status = 502, extra = {}) {
  return Object.assign(new Error(message), { status }, extra);
}

function sanitize(object, { secret = false } = {}) {
  if (!object || typeof object !== 'object') return object;
  const copy = { ...object };
  if (copy.metadata && typeof copy.metadata === 'object') {
    const metadata = { ...copy.metadata };
    delete metadata.managedFields;
    if (secret && metadata.annotations?.[LAST_APPLIED]) {
      const annotations = { ...metadata.annotations };
      delete annotations[LAST_APPLIED];
      metadata.annotations = annotations;
    }
    copy.metadata = metadata;
  }
  if (secret) {
    // Key names (never values) let the UI list a secret's keys without revealing it.
    const keys = [...new Set([...Object.keys(copy.data || {}), ...Object.keys(copy.stringData || {})])];
    delete copy.data; delete copy.stringData;
    if (keys.length) copy.dataKeys = keys;
  }
  return copy;
}

function itemKey(item) {
  const metadata = item?.metadata || {};
  return metadata.uid || `${metadata.namespace || ''}/${metadata.name || ''}`;
}

function backoff(attempt) {
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

function isSecretTarget(target) { return target.group === '' && target.name === 'secrets'; }

function collectionPath(target, namespace) {
  const root = target.group ? `/apis/${target.group}/${target.version}` : `/api/${target.version}`;
  const scoped = target.namespaced && namespace ? `/namespaces/${encodeURIComponent(namespace)}` : '';
  return `${root}${scoped}/${target.name}`;
}

function statusError(status, body, text) {
  const message = (body && typeof body.message === 'string' && body.message) ||
    (text || '').trim().slice(0, 2000) || `Kubernetes API returned HTTP ${status}`;
  const mapped = [400, 401, 403, 404, 409, 410, 422, 429].includes(status) ? status : 502;
  return liveError(message, mapped, { kubeStatus: status, reason: body?.reason });
}

function connectionFailure(error) {
  if (error && error.status) return error;
  const code = error?.code || '';
  const lost = ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(code) || /socket hang up/i.test(error?.message || '');
  return liveError(`Cluster connection lost: ${error?.message || 'unknown error'}`, 502, { connectionLost: lost });
}

function openRequest(connection, apiPath, { method = 'GET', headers = {}, signal, body } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(liveError('Request canceled', 499, { canceled: true })); return; }
    let target;
    try { target = new URL(connection.baseUrl + apiPath); }
    catch { reject(liveError('Invalid Kubernetes API path', 400)); return; }
    const req = http.request(target, { method, headers: { Accept: 'application/json', ...headers } }, response => {
      signal?.removeEventListener('abort', onAbort);
      if (signal) {
        const abortResponse = () => response.destroy(liveError('Request canceled', 499, { canceled: true }));
        signal.addEventListener('abort', abortResponse, { once: true });
        response.once('close', () => signal.removeEventListener('abort', abortResponse));
      }
      resolve(response);
    });
    const onAbort = () => req.destroy(liveError('Request canceled', 499, { canceled: true }));
    signal?.addEventListener('abort', onAbort, { once: true });
    req.once('error', error => { signal?.removeEventListener('abort', onAbort); reject(connectionFailure(error)); });
    req.end(body);
  });
}

function readBody(response, limit = RESPONSE_LIMIT) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let length = 0;
    response.on('data', chunk => {
      length += chunk.length;
      if (length > limit) { response.destroy(liveError('Kubernetes API response exceeded the size limit', 502)); return; }
      parts.push(chunk);
    });
    response.once('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    response.once('error', error => reject(connectionFailure(error)));
    response.once('aborted', () => reject(liveError('Kubernetes API response was interrupted', 502, { connectionLost: true })));
  });
}

async function requestJSON(connection, apiPath, { signal, timeoutMs = 60000, headers, method, body } = {}) {
  const abort = new AbortController();
  const onExternal = () => abort.abort();
  signal?.addEventListener('abort', onExternal, { once: true });
  if (signal?.aborted) abort.abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abort.abort(); }, timeoutMs);
  timer.unref?.();
  try {
    const response = await openRequest(connection, apiPath, { signal: abort.signal, headers, method, body });
    const text = await readBody(response);
    let parsed;
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = undefined; }
    if (response.statusCode >= 400) throw statusError(response.statusCode, parsed, text);
    if (parsed === undefined) throw liveError('Kubernetes API returned invalid JSON', 502);
    return parsed;
  } catch (error) {
    if (timedOut) throw liveError(`Kubernetes API request timed out after ${timeoutMs} ms`, 504);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternal);
  }
}

function abortableSleep(ms, signal) {
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Per-context kubectl proxy processes

function createProxyPool({ kubectlPath, spawnCommand, killProcess, proxyFactory, idleMs = PROXY_IDLE_MS, startTimeoutMs = PROXY_START_MS }) {
  const entries = new Map();
  let closed = false;
  const sweeper = setInterval(sweep, Math.min(30000, idleMs));
  sweeper.unref?.();

  function launch(context, onExit) {
    if (proxyFactory) {
      return Promise.resolve(proxyFactory(context)).then(result => ({
        baseUrl: String(result.baseUrl).replace(/\/$/, ''),
        stop: () => { try { result.close?.(); } catch { /* Test transports may already be closed. */ } },
      }));
    }
    const prefix = `/rubban-${crypto.randomBytes(16).toString('hex')}`;
    const args = [`--context=${context}`, 'proxy', '--address=127.0.0.1', '--port=0', `--api-prefix=${prefix}/`, '--accept-hosts=^127\\.0\\.0\\.1$'];
    let child;
    try { child = spawnCommand(kubectlPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { return Promise.reject(Object.assign(error, { proxyUnavailable: true })); }
    return new Promise((resolve, reject) => {
      let out = '';
      let err = '';
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        killProcess(child);
        reject(Object.assign(error, { proxyUnavailable: true }));
      };
      const timer = setTimeout(() => fail(liveError('Timed out starting the cluster connection', 504)), startTimeoutMs);
      timer.unref?.();
      child.stdout?.setEncoding?.('utf8');
      child.stderr?.setEncoding?.('utf8');
      child.stdout?.on('data', data => {
        out = (out + data).slice(-4000);
        const match = /Starting to serve on 127\.0\.0\.1:(\d+)/.exec(out);
        if (match && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ baseUrl: `http://127.0.0.1:${match[1]}${prefix}`, stop: () => killProcess(child) });
        }
      });
      child.stderr?.on('data', data => { err = (err + data).slice(-4000); });
      child.once('error', error => fail(liveError(`Unable to start kubectl proxy: ${error.message}`, 503)));
      child.once('close', code => {
        if (!settled) fail(liveError(`Cluster connection failed: ${(err.trim() || out.trim() || `kubectl proxy exited with code ${code}`).slice(0, 2000)}`, 502));
        else onExit();
      });
    });
  }

  function invalidate(entry) {
    if (entries.get(entry.context) === entry) entries.delete(entry.context);
    entry.connection?.stop();
  }

  function acquire(context) {
    if (closed) return Promise.reject(liveError('Backend is closed', 503));
    let entry = entries.get(context);
    if (!entry) {
      entry = { context, users: 0, lastUsed: Date.now(), connection: null };
      const current = entry;
      entry.promise = launch(context, () => { if (entries.get(context) === current) entries.delete(context); })
        .then(connection => { current.connection = connection; if (closed) connection.stop(); return connection; },
          error => { if (entries.get(context) === current) entries.delete(context); throw error; });
      entries.set(context, entry);
    }
    const current = entry;
    current.users++;
    current.lastUsed = Date.now();
    let released = false;
    const release = () => { if (released) return; released = true; current.users--; current.lastUsed = Date.now(); };
    return current.promise.then(
      connection => ({ baseUrl: connection.baseUrl, release, invalidate: () => invalidate(current) }),
      error => { release(); throw error; });
  }

  function sweep() {
    const now = Date.now();
    for (const entry of [...entries.values()]) {
      if (entry.users <= 0 && entry.connection && now - entry.lastUsed > idleMs) invalidate(entry);
    }
  }

  function close() {
    closed = true;
    clearInterval(sweeper);
    for (const entry of entries.values()) entry.promise.then(connection => connection.stop(), () => {});
    entries.clear();
  }

  function stats() { return [...entries.values()].map(entry => ({ context: entry.context, users: entry.users, ready: Boolean(entry.connection) })); }

  return { acquire, close, stats };
}

// ---------------------------------------------------------------------------
// Discovery

function discoveryFromAggregated(list, resources, nextPriority) {
  for (const group of list.items || []) {
    const name = group.metadata?.name || '';
    const version = (group.versions || [])[0];
    if (!version) continue;
    const priority = nextPriority();
    for (const resource of version.resources || []) {
      if (!resource.resource || resource.resource.includes('/')) continue;
      resources.push({
        name: resource.resource, kind: resource.responseKind?.kind || '', namespaced: resource.scope === 'Namespaced',
        group: name, version: version.version, verbs: resource.verbs || [], shortNames: resource.shortNames || [],
        singular: resource.singularResource || '', priority,
      });
    }
  }
}

function discoveryFromLegacy(document, group, version, priority, resources) {
  for (const resource of document.resources || []) {
    if (!resource.name || resource.name.includes('/')) continue;
    resources.push({
      name: resource.name, kind: resource.kind || '', namespaced: Boolean(resource.namespaced), group, version,
      verbs: resource.verbs || [], shortNames: resource.shortNames || [], singular: resource.singularName || '', priority,
    });
  }
}

async function fetchDiscovery(connection, { signal } = {}) {
  const resources = [];
  const warnings = [];
  let priority = 0;
  const nextPriority = () => priority++;
  const headers = { Accept: AGGREGATED_ACCEPT };
  const [core, groups] = await Promise.allSettled([
    requestJSON(connection, '/api', { signal, headers }),
    requestJSON(connection, '/apis', { signal, headers }),
  ]);
  if (core.status === 'fulfilled' && core.value.kind === 'APIGroupDiscoveryList') discoveryFromAggregated(core.value, resources, nextPriority);
  else if (core.status === 'fulfilled') {
    try { discoveryFromLegacy(await requestJSON(connection, '/api/v1', { signal }), '', 'v1', nextPriority(), resources); }
    catch (error) { warnings.push(`Core discovery: ${error.message}`); }
  } else warnings.push(`Core discovery: ${core.reason.message}`);

  if (groups.status === 'fulfilled' && groups.value.kind === 'APIGroupDiscoveryList') discoveryFromAggregated(groups.value, resources, nextPriority);
  else if (groups.status === 'fulfilled') {
    const versions = (groups.value.groups || []).map(group => group.preferredVersion?.groupVersion).filter(Boolean)
      .map(groupVersion => ({ groupVersion, priority: nextPriority() }));
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(8, versions.length) }, async () => {
      while (index < versions.length && !signal?.aborted) {
        const { groupVersion, priority: groupPriority } = versions[index++];
        if (!/^[a-z0-9.-]+\/v[a-z0-9]+$/.test(groupVersion)) { warnings.push('Skipped malformed API group version'); continue; }
        try {
          const [group, version] = groupVersion.split('/');
          discoveryFromLegacy(await requestJSON(connection, `/apis/${groupVersion}`, { signal }), group, version, groupPriority, resources);
        } catch (error) { warnings.push(`${groupVersion}: ${error.message}`); }
      }
    }));
  } else warnings.push(`API group discovery: ${groups.reason.message}`);

  if (!resources.length && warnings.length) throw liveError(`Kubernetes discovery unavailable: ${warnings.join('; ')}`, 502);
  return { resources, warnings };
}

function resolveResource(resources, value) {
  const id = String(value).toLowerCase();
  let best = null;
  let bestScore = Infinity;
  for (const resource of resources) {
    const names = [resource.name, resource.singular, resource.kind.toLowerCase(), ...(resource.shortNames || [])].filter(Boolean);
    let score = Infinity;
    if (resource.group && (id === `${resource.name}.${resource.group}` || id === `${resource.name}.${resource.version}.${resource.group}`)) score = 0;
    else if (!resource.group && id === `${resource.name}.${resource.version}`) score = 0;
    else if (id === resource.name) score = 1000 + resource.priority;
    else if (names.includes(id)) score = 100000 + resource.priority;
    if (score < bestScore) { best = resource; bestScore = score; }
  }
  return best;
}

function createDiscoveryCache(pool, ttl = DISCOVERY_TTL_MS) {
  const cache = new Map();
  function get(context, { refresh = false } = {}) {
    const cached = cache.get(context);
    if (cached && !refresh && Date.now() - cached.at < ttl) return cached.promise;
    const entry = { at: Date.now() };
    entry.promise = (async () => {
      const lease = await pool.acquire(context);
      try { return await fetchDiscovery(lease); }
      catch (error) { if (error.connectionLost) lease.invalidate(); throw error; }
      finally { lease.release(); }
    })();
    entry.promise.catch(() => { if (cache.get(context) === entry) cache.delete(context); });
    cache.set(context, entry);
    return entry.promise;
  }
  async function resolve(context, resource) {
    let discovery = await get(context);
    let target = resolveResource(discovery.resources, resource);
    if (!target) {
      discovery = await get(context, { refresh: true });
      target = resolveResource(discovery.resources, resource);
    }
    if (!target) throw liveError(`This cluster does not serve the resource type "${resource}"`, 404);
    return target;
  }
  return { get, resolve, clear: () => cache.clear() };
}

// ---------------------------------------------------------------------------
// Shared LIST + WATCH streams

class ResourceWatch {
  constructor({ key, context, target, namespace, pool, onStopped, selectors = {} }) {
    Object.assign(this, { key, context, target, namespace, pool, onStopped, selectors });
    this.secret = isSecretTarget(target);
    this.path = collectionPath(target, namespace);
    this.listeners = new Set();
    this.items = new Map();
    this.resourceVersion = '';
    this.synced = false;
    this.mode = 'watch';
    this.status = { state: 'connecting', message: 'Connecting to the cluster…' };
    this.stopped = false;
    this.running = false;
    this.attempt = 0;
    this.abort = null;
    this.resyncRequested = false;
    this.pendingUpserts = new Map();
    this.pendingDeletes = new Set();
    this.flushTimer = null;
    this.lingerTimer = null;
  }

  subscribe(listener) {
    clearTimeout(this.lingerTimer);
    this.listeners.add(listener);
    this.call(listener, 'status', this.status);
    if (this.synced) this.call(listener, 'reset', [...this.items.values()], this.resourceVersion);
    if (!this.running && !this.stopped) this.start();
    return () => {
      if (!this.listeners.delete(listener) || this.listeners.size || this.stopped) return;
      this.lingerTimer = setTimeout(() => this.stop(), WATCH_LINGER_MS);
      this.lingerTimer.unref?.();
    };
  }

  call(listener, method, ...args) { try { listener[method]?.(...args); } catch { /* A failing subscriber must not stop the stream. */ } }
  emit(method, ...args) { for (const listener of [...this.listeners]) this.call(listener, method, ...args); }
  setStatus(state, message, extra = {}) {
    if (this.status.state === state && this.status.message === message) return;
    this.status = { state, message, ...extra };
    this.emit('status', this.status);
  }

  resync() {
    if (this.stopped) return;
    this.resyncRequested = true;
    this.resourceVersion = '';
    this.abort?.abort();
  }

  start() {
    this.running = true;
    this.loop().catch(() => {}).finally(() => { this.running = false; });
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.lingerTimer);
    clearTimeout(this.flushTimer);
    this.abort?.abort();
    this.listeners.clear();
    this.onStopped?.(this);
  }

  async loop() {
    while (!this.stopped) {
      let lease;
      try {
        lease = await this.pool.acquire(this.context);
        if (this.stopped) break;
        if (!this.resourceVersion || this.mode === 'poll') await this.list(lease);
        if (this.stopped) break;
        if (this.mode === 'poll') {
          this.abort = new AbortController();
          await abortableSleep(POLL_INTERVAL_MS, this.abort.signal);
        } else await this.watch(lease);
        this.attempt = 0;
      } catch (error) {
        if (this.stopped) break;
        if (this.resyncRequested) { this.resyncRequested = false; continue; }
        if (error.gone) { this.resourceVersion = ''; continue; }
        if (error.connectionLost) lease?.invalidate();
        if (error.watchForbidden && this.mode !== 'poll') { this.mode = 'poll'; continue; }
        if (error.fatal) {
          this.setStatus('error', error.message);
          this.emit('fatal', error);
          this.stop();
          break;
        }
        this.attempt++;
        if (this.attempt >= 3) this.resourceVersion = '';
        // A dropped proxy is usually replaced within milliseconds; retry the first time quickly.
        const delay = error.connectionLost && this.attempt === 1 ? 250 : backoff(this.attempt);
        this.setStatus('reconnecting', `${error.message} Retrying in ${Math.max(1, Math.round(delay / 1000))}s.`, { attempt: this.attempt });
        this.abort = new AbortController();
        await abortableSleep(delay, this.abort.signal);
        this.resyncRequested = false;
      } finally {
        lease?.release();
      }
    }
  }

  async list(lease) {
    this.abort = new AbortController();
    const items = new Map();
    let continueToken = '';
    let resourceVersion = '';
    do {
      const query = new URLSearchParams({ limit: String(LIST_PAGE_SIZE), ...this.selectors });
      if (continueToken) query.set('continue', continueToken);
      let page;
      try { page = await requestJSON(lease, `${this.path}?${query}`, { signal: this.abort.signal, timeoutMs: 120000 }); }
      catch (error) {
        if ([401, 403, 404].includes(error.kubeStatus)) error.fatal = true;
        if (error.kubeStatus === 410) error.gone = true;
        throw error;
      }
      if (!resourceVersion) resourceVersion = page.metadata?.resourceVersion || '';
      const kind = (page.kind || '').replace(/List$/, '') || this.target.kind;
      for (const raw of page.items || []) {
        const item = sanitize({ apiVersion: page.apiVersion, kind, ...raw }, { secret: this.secret });
        items.set(itemKey(item), item);
      }
      continueToken = page.metadata?.continue || '';
    } while (continueToken && !this.stopped);
    if (this.stopped) return;
    this.resourceVersion = resourceVersion;
    if (!this.synced) {
      this.items = items;
      this.synced = true;
      this.emit('reset', [...items.values()], resourceVersion);
    } else {
      const upserts = [];
      const deletes = [];
      for (const [key, item] of items) {
        if (this.items.get(key)?.metadata?.resourceVersion !== item.metadata?.resourceVersion) upserts.push(item);
      }
      for (const key of this.items.keys()) if (!items.has(key)) deletes.push(key);
      this.items = items;
      this.pendingUpserts.clear();
      this.pendingDeletes.clear();
      if (upserts.length || deletes.length) this.emit('changes', upserts, deletes);
    }
    this.setStatus(this.mode === 'poll' ? 'polling' : 'live',
      this.mode === 'poll' ? `Watching is not permitted for this resource; refreshing every ${POLL_INTERVAL_MS / 1000}s.` : 'Receiving live updates');
  }

  async watch(lease) {
    this.abort = new AbortController();
    const query = new URLSearchParams({ watch: '1', resourceVersion: this.resourceVersion, allowWatchBookmarks: 'true', timeoutSeconds: String(WATCH_TIMEOUT_SECONDS), ...this.selectors });
    const response = await openRequest(lease, `${this.path}?${query}`, { signal: this.abort.signal });
    if (response.statusCode !== 200) {
      const text = await readBody(response, 1024 * 1024);
      let body;
      try { body = JSON.parse(text); } catch { body = undefined; }
      const error = statusError(response.statusCode, body, text);
      if (response.statusCode === 410) error.gone = true;
      else if (response.statusCode === 403) error.watchForbidden = true;
      else if ([401, 404].includes(response.statusCode)) error.fatal = true;
      throw error;
    }
    this.setStatus('live', 'Receiving live updates');
    await new Promise((resolve, reject) => {
      let buffer = '';
      let idle;
      let finished = false;
      const finish = (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(idle);
        this.flush();
        if (error) reject(error); else resolve();
      };
      const resetIdle = () => {
        clearTimeout(idle);
        idle = setTimeout(() => { finish(); response.destroy(); }, STREAM_IDLE_MS);
        idle.unref?.();
      };
      resetIdle();
      response.setEncoding('utf8');
      response.on('data', chunk => {
        if (finished) return;
        resetIdle();
        buffer += chunk;
        if (buffer.length > EVENT_LINE_LIMIT) { finish(liveError('A watch event exceeded the size limit', 502)); response.destroy(); return; }
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          try { this.handleEvent(JSON.parse(line)); }
          catch (error) { finish(error.status ? error : liveError(`Invalid watch event: ${error.message}`, 502)); response.destroy(); return; }
        }
      });
      response.once('end', () => finish());
      response.once('error', error => finish(connectionFailure(error)));
      response.once('aborted', () => finish(liveError('Watch stream interrupted', 502, { connectionLost: true })));
      response.once('close', () => finish());
    });
  }

  handleEvent(event) {
    const { type, object } = event || {};
    if (type === 'BOOKMARK') {
      if (object?.metadata?.resourceVersion) this.resourceVersion = object.metadata.resourceVersion;
      return;
    }
    if (type === 'ERROR') {
      const error = statusError(object?.code || 500, object);
      if (object?.code === 410) error.gone = true;
      throw error;
    }
    if (!object?.metadata) return;
    const item = sanitize(object, { secret: this.secret || object.kind === 'Secret' });
    const key = itemKey(item);
    if (type === 'ADDED' || type === 'MODIFIED') {
      this.items.set(key, item);
      this.pendingDeletes.delete(key);
      this.pendingUpserts.set(key, item);
    } else if (type === 'DELETED') {
      this.items.delete(key);
      this.pendingUpserts.delete(key);
      this.pendingDeletes.add(key);
    } else return;
    if (item.metadata.resourceVersion) this.resourceVersion = item.metadata.resourceVersion;
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.pendingUpserts.size && !this.pendingDeletes.size) return;
    const upserts = [...this.pendingUpserts.values()];
    const deletes = [...this.pendingDeletes];
    this.pendingUpserts.clear();
    this.pendingDeletes.clear();
    this.emit('changes', upserts, deletes);
  }
}

// ---------------------------------------------------------------------------
// Facade used by the backend

function createLive({ kubectlPath, spawnCommand, killProcess, proxyFactory, idleMs }) {
  const pool = createProxyPool({ kubectlPath, spawnCommand, killProcess, proxyFactory, idleMs });
  const discovery = createDiscoveryCache(pool);
  const watches = new Map();
  let closed = false;

  async function withConnection(context, fn) {
    const lease = await pool.acquire(context);
    try { return await fn(lease); }
    catch (error) { if (error.connectionLost) lease.invalidate(); throw error; }
    finally { lease.release(); }
  }

  async function listAll(lease, path, { signal, secret, kind: fallbackKind, selectors = {} }) {
    const items = [];
    let continueToken = '';
    let resourceVersion = '';
    let apiVersion = 'v1';
    do {
      const query = new URLSearchParams({ limit: String(LIST_PAGE_SIZE), ...selectors });
      if (continueToken) query.set('continue', continueToken);
      const page = await requestJSON(lease, `${path}?${query}`, { signal, timeoutMs: 120000 });
      if (!resourceVersion) resourceVersion = page.metadata?.resourceVersion || '';
      apiVersion = page.apiVersion || apiVersion;
      const kind = (page.kind || '').replace(/List$/, '') || fallbackKind;
      for (const raw of page.items || []) items.push(sanitize({ apiVersion: page.apiVersion, kind, ...raw }, { secret }));
      continueToken = page.metadata?.continue || '';
    } while (continueToken && !signal?.aborted);
    return { apiVersion: 'v1', kind: 'List', metadata: { resourceVersion }, items };
  }

  const selectorParams = ({ labelSelector, fieldSelector } = {}) => ({ ...(labelSelector ? { labelSelector } : {}), ...(fieldSelector ? { fieldSelector } : {}) });

  async function list(context, resource, namespace, { signal, labelSelector, fieldSelector } = {}) {
    const target = await discovery.resolve(context, resource);
    const scoped = target.namespaced && namespace && namespace !== '*' ? namespace : '';
    return withConnection(context, lease => listAll(lease, collectionPath(target, scoped), { signal, secret: isSecretTarget(target), kind: target.kind, selectors: selectorParams({ labelSelector, fieldSelector }) }));
  }

  async function get(context, resource, namespace, name, { signal } = {}) {
    const target = await discovery.resolve(context, resource);
    const scoped = target.namespaced ? (namespace && namespace !== '*' ? namespace : 'default') : '';
    const object = await withConnection(context, lease => requestJSON(lease, `${collectionPath(target, scoped)}/${encodeURIComponent(name)}`, { signal }));
    return sanitize(object);
  }

  function raw(context, apiPath, { signal, headers, timeoutMs } = {}) {
    return withConnection(context, lease => requestJSON(lease, apiPath, { signal, headers, timeoutMs }));
  }

  function post(context, apiPath, body, { signal } = {}) {
    const payload = JSON.stringify(body);
    return withConnection(context, lease => requestJSON(lease, apiPath, { signal, method: 'POST', body: payload, headers: { 'Content-Type': 'application/json' } }));
  }

  async function discover(context, { refresh = false } = {}) {
    const result = await discovery.get(context, { refresh });
    const resources = [...result.resources].sort((a, b) => `${a.group}/${a.name}`.localeCompare(`${b.group}/${b.name}`));
    return { resources, warnings: result.warnings };
  }

  async function watch(context, resource, namespace, listener, { resync = false, labelSelector, fieldSelector } = {}) {
    if (closed) throw liveError('Backend is closed', 503);
    const target = await discovery.resolve(context, resource);
    if (!target.verbs.includes('list')) throw liveError(`The resource type "${resource}" cannot be listed`, 405);
    const scoped = target.namespaced && namespace && namespace !== '*' ? namespace : '';
    const selectors = selectorParams({ labelSelector, fieldSelector });
    const key = JSON.stringify([context, target.group, target.version, target.name, scoped, selectors]);
    let entry = watches.get(key);
    if (!entry || entry.stopped) {
      entry = new ResourceWatch({ key, context, target, namespace: scoped, pool, selectors, onStopped: stopped => { if (watches.get(key) === stopped) watches.delete(key); } });
      if (!target.verbs.includes('watch')) entry.mode = 'poll';
      watches.set(key, entry);
    } else if (resync) entry.resync();
    return entry.subscribe(listener);
  }

  function close() {
    closed = true;
    for (const entry of [...watches.values()]) entry.stop();
    watches.clear();
    pool.close();
  }

  function stats() { return { proxies: pool.stats(), watches: [...watches.values()].map(entry => ({ context: entry.context, path: entry.path, state: entry.status.state, listeners: entry.listeners.size, items: entry.items.size })) }; }

  return { list, get, raw, post, discover, watch, close, stats };
}

module.exports = { createLive, resolveResource, sanitize, collectionPath, itemKey };
