'use strict';
const fs = require('node:fs');
const path = require('node:path');

function shortText(value, label, pattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:@/+ -]{0,253}$/) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}
function identifier(value, label) { return shortText(value, label, /^[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]{0,253}$/); }
function queryArgs(context, namespace) {
  const args = [];
  if (context) args.push('--context', shortText(context, 'context'));
  if (namespace && namespace !== '*') args.push('--namespace', identifier(namespace, 'namespace'));
  else args.push('--all-namespaces');
  return args;
}
function resolveCommand(name) {
  const names = process.platform === 'win32' ? [name + '.exe', name + '.cmd', name + '.bat', name] : [name];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const file of names) {
      const candidate = path.join(dir.replace(/^"|"$/g, ''), file);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
    }
  }
  return null;
}
async function external(run, name, args, options = {}) {
  const command = resolveCommand(name);
  if (!command) throw new Error(`${name} CLI is not installed or is not on PATH. Install it and authenticate with your own account.`);
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    for (const arg of [command, ...args]) {
      if (/[\r\n%!&|<>^]/.test(arg) || arg.includes('"')) throw new Error('This value cannot be passed to a Windows command wrapper.');
    }
    const line = [command, ...args].map(s => `"${s}"`).join(' ');
    return run(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', `"${line}"`], options);
  }
  return run(command, args, options);
}
function validateServiceURL(input) {
  const u = new URL(input);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash) throw new Error('Use an HTTP(S) service URL without embedded credentials.');
  return u;
}
async function jsonFetch(url, options = {}) {
  const { signal, ...rest } = options;
  const timeout = AbortSignal.timeout(15000);
  const response = await fetch(url, { redirect: 'error', ...rest, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  const parts = []; let total = 0;
  if (response.body) {
    for await (const part of response.body) {
      total += part.byteLength;
      if (total > 12 * 1024 * 1024) throw new Error('Service response exceeds 12 MiB.');
      parts.push(Buffer.from(part));
    }
  }
  const text = Buffer.concat(parts, total).toString('utf8');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Service returned non-JSON response (HTTP ${response.status}).`); }
  if (!response.ok) throw new Error(data.error || data.message || `Service returned HTTP ${response.status}`);
  return data;
}

function createExtras({ fetchJSON: fetchImpl = jsonFetch } = {}) {
  return async function extras({ req, res, url, body, run: unboundRun, signal, config, readJSON, sendJSON }) {
    const run = (command, args, options = {}) => unboundRun(command, args, { ...options, signal });
    const fetchJSON = (target, options = {}) => fetchImpl(target, { ...options, signal });
    const method = req.method;
    const route = url.pathname;
    const send = (data, status = 200) => sendJSON(res, status, data);
    const read = async () => body || await readJSON(req);
    const preferences = () => config.readPreferences();

    if (route === '/api/prometheus' && method === 'POST') {
      const b = await read(); const prefs = await preferences();
      if (!prefs.prometheusUrl) throw new Error('Configure your Prometheus endpoint in Settings first.');
      const u = validateServiceURL(prefs.prometheusUrl);
      const query = String(b.query || '');
      if (!query || query.length > 16000) throw new Error('A PromQL query of at most 16,000 characters is required.');
      u.pathname = u.pathname.replace(/\/$/, '') + (b.start ? '/api/v1/query_range' : '/api/v1/query');
      u.searchParams.set('query', query);
      if (b.start) { u.searchParams.set('start', String(b.start)); u.searchParams.set('end', String(b.end)); u.searchParams.set('step', String(b.step || 60)); }
      send(await fetchJSON(u)); return true;
    }

    if (route === '/api/ai' && method === 'POST') {
      const b = await read(); const prefs = await preferences();
      const command = b.command || prefs.aiCommand || 'codex';
      const argsByCommand = { codex: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-'], claude: ['-p'], gemini: [], opencode: ['run'] };
      if (!Object.hasOwn(argsByCommand, command)) throw new Error('Select a supported installed AI CLI.');
      const prompt = String(b.prompt || '').trim();
      if (!prompt || prompt.length > 32000) throw new Error('Enter a prompt of at most 32,000 characters.');
      const context = b.context ? `Selected Kubernetes context: ${shortText(b.context, 'context')}.\n` : '';
      const input = `You are helping with Kubernetes. This request comes from Rubban. Do not change any resource or execute mutations without asking the user. Do not read or print credentials or secret values.\n${context}\n${prompt}\n`;
      const result = await external(run, command, argsByCommand[command], { input, timeoutMs: 180000, maxBytes: 2 * 1024 * 1024 });
      send({ output: result.stdout || result.stderr }); return true;
    }

    return false;
  };
}
module.exports = { createExtras, validateServiceURL, identifier, queryArgs, resolveCommand, jsonFetch };
