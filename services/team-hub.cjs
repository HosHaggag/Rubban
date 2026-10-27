'use strict';
require('../server/env-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { validateQuery } = require('./kube-read.cjs');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
function passwordHash(password) { const salt = crypto.randomBytes(16).toString('hex'); return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`; }
function passwordMatches(password, encoded) { try { const [salt, hash] = encoded.split(':'); return equal(crypto.scryptSync(password, salt, 64).toString('hex'), hash); } catch { return false; } }
function passwordValid(password) { return typeof password === 'string' && password.length >= 12 && password.length <= 256; }
function usernameValid(name) { return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name); }
function bearer(req) { const value = req.headers.authorization; return typeof value === 'string' && /^Bearer [A-Za-z0-9_-]{32,128}$/.test(value) ? value.slice(7) : null; }
function fail(status, message) { return Object.assign(new Error(message), { status }); }
function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return reject(fail(415, 'Use application/json'));
    const chunks = []; let size = 0; let ended = false;
    req.on('data', chunk => { size += chunk.length; if (size > 16384) { ended = true; reject(fail(413, 'Request exceeds 16 KiB')); } else if (!ended) chunks.push(chunk); });
    req.on('end', () => { if (ended) return; try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); resolve(value); } catch { reject(fail(400, 'Invalid JSON object')); } });
    req.on('error', () => reject(fail(400, 'Request interrupted')));
  });
}

function createTeamHub(options = {}) {
  const host = options.host || process.env.RUBBAN_HUB_BIND || '127.0.0.1';
  const port = options.port ?? Number(process.env.RUBBAN_HUB_PORT || 4520);
  const dataDir = path.resolve(options.dataDir || process.env.RUBBAN_DATA_DIR || path.join(__dirname, 'data'));
  const tlsCert = options.tlsCert || process.env.RUBBAN_TLS_CERT; const tlsKey = options.tlsKey || process.env.RUBBAN_TLS_KEY;
  if ((tlsCert && !tlsKey) || (tlsKey && !tlsCert)) throw new Error('Set both RUBBAN_TLS_CERT and RUBBAN_TLS_KEY');
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !(tlsCert && tlsKey)) throw new Error('Non-loopback binding requires TLS certificate and key; a TLS reverse proxy may instead forward to the default loopback listener');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const stateFile = path.join(dataDir, 'state.json');
  let state;
  if (fs.existsSync(stateFile)) {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (state.version !== 1 || !Array.isArray(state.users) || !Array.isArray(state.clusters)) throw new Error('Invalid hub state');
  } else {
    const password = options.adminPassword || process.env.RUBBAN_ADMIN_PASSWORD;
    const username = options.adminUsername || process.env.RUBBAN_ADMIN_USER || 'admin';
    if (!passwordValid(password)) throw new Error('First run requires RUBBAN_ADMIN_PASSWORD with 12–256 characters');
    if (!usernameValid(username)) throw new Error('Invalid bootstrap administrator username');
    state = { version: 1, users: [{ id: crypto.randomUUID(), username, passwordHash: passwordHash(password), role: 'admin', clusterIds: [] }], clusters: [] };
    save();
  }
  function save() { const temporary = `${stateFile}.${crypto.randomBytes(8).toString('hex')}.tmp`; fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 }); fs.renameSync(temporary, stateFile); }
  function audit(event, fields = {}) { fs.appendFileSync(path.join(dataDir, 'audit.ndjson'), JSON.stringify({ time: new Date().toISOString(), event, ...fields }) + '\n', { mode: 0o600 }); }
  const sessions = new Map(); const agents = new Map(); const pending = new Map(); const attempts = new Map();
  function authenticate(req) {
    const token = bearer(req); const key = token && sha(token); const session = key && sessions.get(key);
    if (!session || session.expiresAt <= Date.now()) { if (key) sessions.delete(key); throw fail(401, 'Authentication required'); }
    const user = state.users.find(u => u.id === session.userId);
    if (!user) throw fail(401, 'Authentication required');
    return user;
  }
  function allowed(user, clusterId) { return user.role === 'admin' || user.clusterIds.includes(clusterId); }
  function administrator(user) { if (user.role !== 'admin') throw fail(403, 'Administrator role required'); }
  function reply(res, status, body) { if (res.headersSent) return; const text = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(text); }
  const requestHandler = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') return reply(res, 200, { ok: true, service: 'rubban-team-hub' });
      if (req.method === 'POST' && url.pathname === '/api/login') {
        const address = req.socket.remoteAddress || 'unknown'; const now = Date.now();
        const entry = attempts.get(address); if (entry && entry.until > now && entry.count >= 10) throw fail(429, 'Try login again later');
        const current = entry && entry.until > now ? entry : { count: 0, until: now + 60000 }; current.count++; attempts.set(address, current);
        const body = await readJson(req);
        if (!usernameValid(body.username) || !passwordValid(body.password)) throw fail(401, 'Invalid username or password');
        const user = state.users.find(u => u.username === body.username);
        if (!user || !passwordMatches(body.password, user.passwordHash)) { audit('login_failed', { address }); throw fail(401, 'Invalid username or password'); }
        const token = crypto.randomBytes(32).toString('base64url'); const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
        sessions.set(sha(token), { userId: user.id, expiresAt }); audit('login', { userId: user.id });
        return reply(res, 200, { token, expiresAt, user: { username: user.username, role: user.role } });
      }
      const user = authenticate(req);
      if (req.method === 'GET' && url.pathname === '/api/clusters') return reply(res, 200, { clusters: state.clusters.filter(c => allowed(user, c.id)).map(c => ({ id: c.id, name: c.name, connected: agents.has(c.id) })) });
      if (req.method === 'POST' && url.pathname === '/api/clusters') {
        administrator(user); const body = await readJson(req);
        if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 120 || /[\r\n\0]/.test(body.name)) throw fail(400, 'A cluster name of at most 120 characters is required');
        if (state.clusters.some(c => c.name.toLocaleLowerCase('en-US') === body.name.trim().toLocaleLowerCase('en-US'))) throw fail(409, 'Cluster name already exists');
        const id = crypto.randomUUID(); const agentToken = crypto.randomBytes(32).toString('base64url');
        state.clusters.push({ id, name: body.name.trim(), agentTokenHash: sha(agentToken), createdAt: new Date().toISOString() }); save(); audit('cluster_provisioned', { userId: user.id, clusterId: id });
        return reply(res, 201, { cluster: { id, name: body.name.trim(), connected: false }, agentToken });
      }
      if (req.method === 'POST' && url.pathname === '/api/users') {
        administrator(user); const body = await readJson(req);
        if (!usernameValid(body.username) || !passwordValid(body.password) || !['admin', 'viewer'].includes(body.role) || !Array.isArray(body.clusterIds) || body.clusterIds.some(id => typeof id !== 'string' || !state.clusters.some(c => c.id === id))) throw fail(400, 'Invalid username, password, role, or assigned clusters');
        if (state.users.some(u => u.username === body.username)) throw fail(409, 'Username already exists');
        const created = { id: crypto.randomUUID(), username: body.username, passwordHash: passwordHash(body.password), role: body.role, clusterIds: [...new Set(body.clusterIds)] };
        state.users.push(created); save(); audit('user_created', { userId: user.id, createdUserId: created.id, role: created.role });
        return reply(res, 201, { user: { id: created.id, username: created.username, role: created.role, clusterIds: created.clusterIds } });
      }
      const queryMatch = /^\/api\/clusters\/([a-f0-9-]{36})\/query$/.exec(url.pathname);
      if (req.method === 'POST' && queryMatch) {
        const clusterId = queryMatch[1]; if (!allowed(user, clusterId)) throw fail(403, 'Cluster access denied');
        if (!state.clusters.some(c => c.id === clusterId)) throw fail(404, 'Cluster not found');
        let query; try { query = validateQuery(await readJson(req)); } catch (error) { throw error.status ? error : fail(400, error.message); }
        const socket = agents.get(clusterId); if (!socket || socket.readyState !== WebSocket.OPEN) throw fail(503, 'Cluster agent is offline');
        if (pending.size >= 128 || [...pending.values()].filter(p => p.clusterId === clusterId).length >= 16) throw fail(429, 'Too many outstanding cluster queries');
        const id = crypto.randomUUID(); audit('cluster_query', { userId: user.id, clusterId, resource: query.resource, namespace: query.namespace, name: query.name });
        const data = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(id); reject(fail(504, 'Cluster agent query timed out')); }, options.queryTimeoutMs || 25000);
          pending.set(id, { clusterId, socket, timer, resolve, reject });
          socket.send(JSON.stringify({ type: 'query', id, query }), error => { if (error) finishPending(id, fail(503, 'Cluster agent disconnected')); });
        });
        return reply(res, 200, { data });
      }
      throw fail(404, 'Endpoint not found');
    } catch (error) { reply(res, error.status || 500, { error: error.status ? error.message : 'Internal hub error' }); }
  };
  const server = tlsCert ? https.createServer({ cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey) }, requestHandler) : http.createServer(requestHandler);
  server.requestTimeout = 30000; server.headersTimeout = 10000; server.maxHeadersCount = 40;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 + 8192, perMessageDeflate: false });
  function finishPending(id, error, data) { const p = pending.get(id); if (!p) return; pending.delete(id); clearTimeout(p.timer); error ? p.reject(error) : p.resolve(data); }
  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url, 'http://localhost'); const clusterId = url.searchParams.get('clusterId'); const cluster = state.clusters.find(c => c.id === clusterId); const token = bearer(req);
      if (url.pathname !== '/agent' || [...url.searchParams.keys()].some(k => k !== 'clusterId') || !cluster || !token || !equal(sha(token), cluster.agentTokenHash)) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, ws => {
        const previous = agents.get(clusterId); if (previous) previous.close(4000, 'Replaced by new agent');
        agents.set(clusterId, ws); ws.alive = true; ws.on('pong', () => { ws.alive = true; }); audit('agent_connected', { clusterId });
        ws.on('message', raw => {
          try { const result = JSON.parse(raw.toString('utf8')); const p = pending.get(result.id); if (result.type !== 'result' || !p || p.socket !== ws || p.clusterId !== clusterId || typeof result.ok !== 'boolean') return; if (result.ok) finishPending(result.id, null, result.data); else finishPending(result.id, fail(502, typeof result.error === 'string' ? result.error.slice(0, 512) : 'Cluster query failed')); }
          catch { ws.close(1008, 'Invalid agent message'); }
        });
        ws.on('error', () => {});
        ws.on('close', () => { if (agents.get(clusterId) === ws) agents.delete(clusterId); for (const [id, p] of pending) if (p.socket === ws) finishPending(id, fail(503, 'Cluster agent disconnected')); audit('agent_disconnected', { clusterId }); });
      });
    } catch { socket.destroy(); }
  });
  const heartbeat = setInterval(() => { for (const ws of wss.clients) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } } for (const [key, s] of sessions) if (s.expiresAt <= Date.now()) sessions.delete(key); for (const [key, a] of attempts) if (a.until <= Date.now()) attempts.delete(key); }, 30000); heartbeat.unref();
  return {
    server,
    start: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(server.address()); }); }),
    close: async () => { clearInterval(heartbeat); for (const [id] of pending) finishPending(id, fail(503, 'Hub is shutting down')); for (const ws of wss.clients) ws.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve)); },
  };
}

if (require.main === module) {
  try { const hub = createTeamHub(); hub.start().then(address => { console.error(`Rubban team hub listening on ${address.address}:${address.port}`); }).catch(error => { console.error(error.message); process.exitCode = 1; }); for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => hub.close().then(() => process.exit(0))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { createTeamHub };
