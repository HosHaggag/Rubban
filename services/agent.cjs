'use strict';
require('../server/env-compat.cjs');
const { WebSocket } = require('ws');
const { validateQuery, runReadQuery } = require('./kube-read.cjs');

function agentUrl(value, clusterId) {
  const url = new URL(value);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash || url.search || !['', '/', '/agent'].includes(url.pathname)) throw new Error('Use a WebSocket hub URL without credentials or query parameters');
  if (url.protocol === 'ws:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Remote agent connections require wss:// TLS');
  if (!/^[a-f0-9-]{36}$/.test(clusterId || '')) throw new Error('Invalid RUBBAN_CLUSTER_ID');
  url.pathname = '/agent'; url.searchParams.set('clusterId', clusterId); return url;
}

function connectAgent(options = {}) {
  const token = options.token || process.env.RUBBAN_AGENT_TOKEN;
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error('RUBBAN_AGENT_TOKEN is required');
  const url = agentUrl(options.url || process.env.RUBBAN_HUB_URL || 'ws://127.0.0.1:4520/agent', options.clusterId || process.env.RUBBAN_CLUSTER_ID);
  const runner = options.runner || (query => runReadQuery(query, { context: process.env.RUBBAN_KUBE_CONTEXT }));
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` }, maxPayload: 16384, perMessageDeflate: false, handshakeTimeout: 10000 });
  let active = 0;
  socket.on('message', async raw => {
    let message;
    try { message = JSON.parse(raw.toString('utf8')); } catch { socket.close(1008, 'Invalid request'); return; }
    if (message.type !== 'query' || typeof message.id !== 'string' || !/^[a-f0-9-]{36}$/.test(message.id)) { socket.close(1008, 'Invalid request'); return; }
    const respond = result => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'result', id: message.id, ...result })); };
    if (active >= 8) return respond({ ok: false, error: 'Agent is busy' });
    let query; try { query = validateQuery(message.query); } catch (error) { return respond({ ok: false, error: error.message }); }
    active++;
    try { const data = await runner(query); const text = JSON.stringify(data); if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('Kubernetes response exceeded 4 MiB'); respond({ ok: true, data }); }
    catch (error) { respond({ ok: false, error: typeof error.message === 'string' ? error.message.slice(0, 512) : 'Kubernetes query failed' }); }
    finally { active--; }
  });
  return socket;
}

if (require.main === module) {
  let stopped = false; let current; let timer; let delay = 1000;
  function connect() {
    try { current = connectAgent(); }
    catch (error) { console.error(error.message); process.exitCode = 1; return; }
    current.on('open', () => { delay = 1000; console.error('Rubban agent connected'); });
    current.on('error', () => { console.error('Rubban agent connection failed; verify hub URL, TLS and agent token'); });
    current.on('close', () => { if (!stopped) { timer = setTimeout(connect, delay); delay = Math.min(delay * 2, 30000); } });
  }
  connect();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopped = true; clearTimeout(timer); current?.close(); });
}
module.exports = { agentUrl, connectAgent };
