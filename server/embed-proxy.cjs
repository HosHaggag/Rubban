'use strict';

// A loopback reverse proxy in front of a port forward, so a web console (the RabbitMQ management
// UI) can be shown inside Rubban:
//  - it runs on its own port, so the console is a different origin from Rubban and cannot reach
//    Rubban's API token or DOM;
//  - only Rubban's window may frame it (frame-ancestors), and X-Frame-Options is dropped;
//  - a small bridge script is added to the console's HTML page. It accepts one message from the
//    Rubban window (checked by origin) carrying the login, and fills the console's own login form,
//    so credentials never appear in a URL;
//  - request paths are forwarded byte for byte (RabbitMQ encodes the default vhost as %2F);
//  - the Host header must name this proxy, which blocks DNS-rebinding pages.

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

const BRIDGE_PATH = '/__rubban/bridge.js';

function bridgeScript(parentOrigins, loginToken = '') {
  return `(() => {
  const PARENTS = ${JSON.stringify(parentOrigins)};
  const LOGIN_TOKEN = ${JSON.stringify(loginToken)};
  if (window.parent === window) return;
  let used = false;
  let parent = null;
  const tell = type => { for (const origin of parent ? [parent] : PARENTS) window.parent.postMessage({ type }, origin); };
  const signIn = data => {
    if (used) return;
    used = true;
    const until = Date.now() + 20000;

    const attempt = () => {
      const user = document.querySelector('input[name="username"]');
      const pass = document.querySelector('input[name="password"]');
      if (user && pass && user.form) {
        user.value = String(data.username ?? '');
        pass.value = String(data.password ?? '');
        const submit = user.form.querySelector('input[type="submit"], button[type="submit"], button:not([type])');
        if (submit) submit.click(); else if (user.form.requestSubmit) user.form.requestSubmit();
        tell('rubban:login-sent');
        const verify = () => {
          const failure = document.querySelector('#login-status');
          if (failure && /failed|not authorized|invalid/i.test(failure.textContent)) { tell('rubban:login-failed'); return; }
          if (!document.querySelector('input[name="password"]') && document.querySelector('#logout, a[href="#/logout"]')) { tell('rubban:authenticated'); return; }
          if (Date.now() < until) setTimeout(verify, 150); else tell('rubban:login-timeout');
        };
        setTimeout(verify, 150);
        return;
      }
      // Loading text is not evidence of an authenticated session. RabbitMQ may take
      // several seconds to load its templates, especially over a cluster tunnel.
      if (document.querySelector('#logout, a[href="#/logout"]')) { tell('rubban:authenticated'); return; }
      if (Date.now() < until) setTimeout(attempt, 150);
      else tell('rubban:login-timeout');
    };
    attempt();
  };
  window.addEventListener('message', event => {
    if (event.source !== window.parent || !PARENTS.includes(event.origin)) return;
    parent = event.origin;
    const data = event.data || {};
    if (data.type === 'rubban:connect') { tell('rubban:ready'); return; }
    if (!LOGIN_TOKEN && data.type === 'rubban:login') signIn(data);
  });
  if (LOGIN_TOKEN) fetch('/__rubban/login', { headers: { 'X-Rubban-Embed-Token': LOGIN_TOKEN }, cache: 'no-store' })
    .then(response => { if (!response.ok) throw new Error('Secret could not be read'); return response.json(); })
    .then(signIn).catch(() => tell('rubban:credentials-unavailable'));
  tell('rubban:ready');
})();
`;
}

// Replace any frame-ancestors directive with one that admits only the Rubban window.
function frameHeaders(headers, parentOrigins) {
  const result = { ...headers };
  delete result['x-frame-options'];
  const csp = result['content-security-policy'];
  const policies = (Array.isArray(csp) ? csp : csp ? [csp] : []).map(value => value.split(';').map(part => part.trim()).filter(part => part && !/^frame-ancestors\b/i.test(part)).join('; '));
  if (!policies.length) policies.push('');
  result['content-security-policy'] = policies.map(value => `${value ? `${value}; ` : ''}frame-ancestors ${parentOrigins.join(' ')}`);
  return result;
}

function injectBridge(html) {
  const tag = `<script src="${BRIDGE_PATH}"></script>`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${tag}</head>`);
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, match => `${match}${tag}`);
  return `${tag}${html}`;
}

function createEmbedProxy({ targetPort, parentOrigins, upstreamTLS = false, maxHTMLBytes = 2 * 1024 * 1024, credentials }) {
  let port = 0;
  const loginToken = credentials ? crypto.randomBytes(32).toString('hex') : '';
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    const host = String(req.headers.host || '').toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Invalid Host header'); return;
    }
    if (req.url === '/__rubban/login') {
      const supplied = req.headers['x-rubban-embed-token'];
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Type', 'application/json');
      if (req.method !== 'GET' || !loginToken || typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(loginToken))) {
        res.writeHead(403); res.end('{"error":"Unauthorized"}'); return;
      }
      const origin = req.headers.origin;
      if (origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)) {
        res.writeHead(403); res.end('{"error":"Invalid origin"}'); return;
      }
      try { res.end(JSON.stringify(await credentials())); }
      catch { res.writeHead(502); res.end('{"error":"The Kubernetes Secret could not be read"}'); }
      return;
    }
    if (req.url === BRIDGE_PATH) {
      const body = bridgeScript(parentOrigins, loginToken);
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
      res.end(body); return;
    }
    const headers = { ...req.headers, 'accept-encoding': 'identity' };
    // An HTTPS console is reached through the kubectl tunnel; its certificate names the cluster
    // service, not 127.0.0.1, so it is not verified here.
    const upstream = (upstreamTLS ? https : http).request({ host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers, ...(upstreamTLS ? { rejectUnauthorized: false } : {}) }, response => {
      const type = String(response.headers['content-type'] || '');
      const outHeaders = frameHeaders(response.headers, parentOrigins);
      if (!/^text\/html/i.test(type) || req.method === 'HEAD' || response.statusCode === 304) {
        res.writeHead(response.statusCode, outHeaders);
        response.pipe(res);
        return;
      }
      const chunks = []; let size = 0; let tooLarge = false;
      response.on('data', chunk => { size += chunk.length; if (size > maxHTMLBytes) tooLarge = true; else chunks.push(chunk); });
      response.on('end', () => {
        if (tooLarge) { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('Console page is too large to embed'); return; }
        const body = injectBridge(Buffer.concat(chunks).toString('utf8'));
        delete outHeaders['content-length']; delete outHeaders['transfer-encoding']; delete outHeaders.etag;
        outHeaders['content-length'] = Buffer.byteLength(body);
        outHeaders['cache-control'] = 'no-store';
        res.writeHead(response.statusCode, outHeaders);
        res.end(body);
      });
      response.on('error', () => res.destroy());
    });
    upstream.on('error', error => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end(`The port forward is not answering: ${error.message}`);
    });
    req.pipe(upstream);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve({
        port,
        close: () => new Promise(done => { for (const socket of sockets) socket.destroy(); server.close(() => done()); }),
      });
    });
  });
}

module.exports = { createEmbedProxy, bridgeScript, frameHeaders, injectBridge, BRIDGE_PATH };
