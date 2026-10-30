'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { WebSocketServer, WebSocket } = require('ws');
const YAML = require('yaml');
const { createLive } = require('./live.cjs');
const { createActions } = require('./actions.cjs');
const { createArgoCD } = require('./argocd.cjs');
const { createRabbitMQ } = require('./rabbitmq.cjs');
const { createEmbedProxy } = require('./embed-proxy.cjs');

const BODY_LIMIT = 2 * 1024 * 1024;
const OUTPUT_LIMIT = 12 * 1024 * 1024;
const APP_VERSION = require('../package.json').version;
// Lists of large namespaces (thousands of pods) are bigger than other command output.
const LIST_OUTPUT_LIMIT = 64 * 1024 * 1024;
const STREAM_BUFFER_LIMIT = 4 * 1024 * 1024;

function problem(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function validateText(value, label = 'value', { required = true, max = 512 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw problem(`${label} is required`);
    return '';
  }
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw problem(`Invalid ${label}`);
  }
  return value;
}

function validateName(value, label = 'name') {
  const name = validateText(value, label, { max: 253 });
  // DNS-style names plus the ':' and '@' that RBAC object names use (system:controller:…).
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(name)) throw problem(`Invalid ${label}`);
  return name;
}

function validateResource(value) {
  const resource = validateText(value, 'resource', { max: 253 });
  if (!/^[a-z][a-z0-9.-]*$/.test(resource)) throw problem('Invalid resource');
  return resource;
}

function validateNamespace(value, { all = false } = {}) {
  const namespace = validateText(value, 'namespace', { required: false, max: 63 });
  if (namespace === '*' || namespace === '') {
    if (namespace === '*' && !all) throw problem('Choose one namespace for this action');
    return namespace;
  }
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(namespace)) throw problem('Invalid namespace');
  return namespace;
}

function contextArgs(value) {
  return [`--context=${validateText(value, 'context')}`];
}

function namespaceArgs(value, { all = false } = {}) {
  const namespace = validateNamespace(value, { all });
  if (!namespace || namespace === '*') return all ? ['--all-namespaces'] : [];
  return [`--namespace=${namespace}`];
}

function integer(value, label, min, max, fallback) {
  if ((value === undefined || value === null || value === '') && fallback !== undefined) return fallback;
  if (typeof value !== 'number' && !(typeof value === 'string' && /^-?\d+$/.test(value))) {
    throw problem(`Invalid ${label}`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw problem(`Invalid ${label}`);
  return number;
}

function validateSelector(value, label) {
  const selector = validateText(value, label, { max: 2000 });
  if (!/^[A-Za-z0-9_./=,!() -]+$/.test(selector) || selector.includes('--')) throw problem(`Invalid ${label}`);
  return selector;
}

function validateYAML(source) {
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > 1024 * 1024) {
    throw problem('YAML must contain between 1 byte and 1 MiB');
  }
  const documents = YAML.parseAllDocuments(source);
  for (const document of documents) {
    if (document.errors.length) throw problem(`Invalid YAML: ${document.errors[0].message}`);
    let object;
    try { object = document.toJS({ maxAliasCount: 100 }); }
    catch (error) { throw problem(`Invalid YAML: ${error.message}`); }
    if (object === null) continue;
    if (!object || Array.isArray(object) || typeof object !== 'object' ||
        typeof object.apiVersion !== 'string' || typeof object.kind !== 'string') {
      throw problem('Each YAML document must be a Kubernetes object with apiVersion and kind');
    }
  }
  if (!documents.some(document => document.contents !== null)) throw problem('YAML contains no resource');
  return source;
}

function sendJSON(res, data, status = 200) {
  // Both common call orders are supported for independent endpoint modules.
  if (typeof data === 'number') [data, status] = [status, data];
  if (res.writableEnded || res.destroyed) return;
  const payload = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(payload);
}

async function readJSON(req, limit = BODY_LIMIT) {
  if (typeof limit === 'object') limit = limit.limit || BODY_LIMIT;
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    throw problem('Request body is too large', 413);
  }
  return new Promise((resolve, reject) => {
    let length = 0;
    let parts = [];
    let settled = false;
    const fail = error => {
      if (!settled) { settled = true; parts = []; reject(error); }
    };
    req.on('aborted', () => fail(problem('Request aborted', 400)));
    req.on('error', fail);
    req.on('data', part => {
      length += part.length;
      if (length > limit) fail(problem('Request body is too large', 413));
      else if (!settled) parts.push(part);
    });
    req.on('end', () => {
      if (settled) return;
      if (!length) { settled = true; resolve({}); return; }
      const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (contentType !== 'application/json' && !/^application\/[\w.+-]+\+json$/.test(contentType)) {
        fail(problem('Use application/json for request bodies', 415));
        return;
      }
      try {
        const result = JSON.parse(Buffer.concat(parts).toString('utf8'));
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Expected an object');
        settled = true;
        resolve(result);
      } catch { fail(problem('Invalid JSON object')); }
    });
  });
}

function findExecutable(requested, fallback) {
  if (typeof requested !== 'string' || !requested || requested.includes('\0')) return null;
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  const names = process.platform === 'win32' && !path.extname(requested)
    ? [requested, ...extensions.map(extension => requested + extension.toLowerCase())] : [requested];
  const directories = /[\\/]/.test(requested) ? [''] : (process.env.PATH || '').split(path.delimiter);
  for (const directory of directories) {
    for (const name of names) {
      const candidate = directory ? path.join(directory.replace(/^"|"$/g, ''), name) : name;
      try {
        if (fs.statSync(candidate).isFile()) {
          if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
          return path.resolve(candidate);
        }
      } catch { /* Try the next PATH entry. */ }
    }
  }
  if (fallback && fallback !== requested) return findExecutable(fallback);
  return null;
}

// The local terminal. A shell opened for a cluster skips the user's startup files, so a profile
// that exports KUBECONFIG cannot silently point it at another cluster; an unscoped shell is the
// user's normal login shell (zsh on macOS, $SHELL elsewhere, PowerShell on Windows).
function localShell(scoped) {
  if (process.platform === 'win32') {
    return { command: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: scoped ? ['-NoLogo', '-NoProfile'] : ['-NoLogo'] };
  }
  const preferred = [process.env.SHELL, process.platform === 'darwin' ? '/bin/zsh' : '', '/bin/bash', '/bin/sh'].filter(Boolean);
  const command = preferred.find(candidate => path.isAbsolute(candidate) && fs.existsSync(candidate)) || '/bin/sh';
  const name = path.basename(command);
  if (!scoped) return { command, args: name === 'sh' ? [] : ['-l'] };
  if (name === 'bash') return { command, args: ['--noprofile', '--norc'] };
  if (name === 'zsh') return { command, args: ['-f'] };
  if (name === 'fish') return { command, args: ['--no-config'] };
  return { command: fs.existsSync('/bin/sh') ? '/bin/sh' : command, args: [] };
}

function shortError(error) {
  const message = error && error.message ? error.message : String(error);
  return message.slice(0, 6000);
}

function parseJSONOutput(output, label = 'CLI') {
  try { return JSON.parse(output.stdout || '{}'); }
  catch { throw problem(`${label} returned invalid JSON`, 502); }
}

function redactSecretList(document) {
  return {
    ...document,
    items: (document.items || []).map(item => {
      const { data, stringData, ...safe } = item;
      const keys = [...new Set([...Object.keys(data || {}), ...Object.keys(stringData || {})])];
      if (keys.length) safe.dataKeys = keys;
      if (safe.metadata?.annotations?.['kubectl.kubernetes.io/last-applied-configuration']) {
        const annotations = { ...safe.metadata.annotations };
        delete annotations['kubectl.kubernetes.io/last-applied-configuration'];
        safe.metadata = { ...safe.metadata, annotations };
      }
      return safe;
    }),
  };
}

// Same shape kubectl prints: apiVersion/kind/metadata first, managed fields hidden.
function objectYAML(object) {
  const { apiVersion, kind, metadata, ...rest } = object || {};
  return YAML.stringify({ apiVersion, kind, metadata, ...rest }, { lineWidth: 0 });
}

function createBackend(options = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const dataDir = path.resolve(options.dataDir || path.join(os.tmpdir(), 'rubban'));
  const preferencesPath = path.join(dataDir, 'preferences.json');
  const injectedRunner = options.runner;
  const dockerKubectl = process.platform === 'win32'
    ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', 'kubectl.exe')
    : undefined;
  const kubectlRequested = options.kubectlPath || 'kubectl';
  const helmRequested = options.helmPath || 'helm';
  const kubectlResolved = findExecutable(kubectlRequested, !options.kubectlPath ? dockerKubectl : undefined);
  const helmResolved = findExecutable(helmRequested);
  const config = {
    dataDir, preferencesPath,
    kubectlPath: kubectlResolved || kubectlRequested,
    helmPath: helmResolved || helmRequested,
    tools: {
      kubectl: { available: Boolean(kubectlResolved || injectedRunner), path: kubectlResolved || null },
      helm: { available: Boolean(helmResolved || injectedRunner), path: helmResolved || null },
    },
    contextArgs, namespaceArgs, validateText, validateResource, validateName, validateNamespace,
  };
  const processes = new Set();
  const exitedProcesses = new WeakSet();
  const terminatingProcesses = new WeakSet();
  const activeRuns = new Set();
  const forwards = new Map();
  let listeningPort = null;
  let closed = false;
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });

  function killProcess(child) {
    if (!child || exitedProcesses.has(child) || terminatingProcesses.has(child)) return;
    terminatingProcesses.add(child);
    const fallback = () => {
      if (exitedProcesses.has(child)) return;
      if (!injectedRunner && process.platform !== 'win32' && Number.isInteger(child.pid)) {
        try { process.kill(-child.pid, 'SIGTERM'); return; } catch { /* Try the direct process. */ }
      }
      try { child.kill(); } catch { /* A concurrently exited child needs no cleanup. */ }
    };
    // A local command-pipe terminal may have descendants. Close its Windows tree too.
    if (!injectedRunner && process.platform === 'win32' && Number.isInteger(child.pid)) {
      try {
        const killer = cp.spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        killer.once('error', fallback);
        killer.once('close', code => { if (code) fallback(); });
        killer.unref();
        return;
      } catch { /* Use direct cancellation if taskkill cannot start. */ }
    }
    fallback();
  }

  function spawnCommand(command, args, spawnOptions = {}) {
    const spawn = injectedRunner && injectedRunner.spawn;
    if (injectedRunner && typeof spawn !== 'function') {
      throw problem('The injected runner does not support streaming commands', 503);
    }
    const child = spawn
      ? spawn.call(injectedRunner, command, args, { ...spawnOptions, shell: false, windowsHide: true })
      : cp.spawn(command, args, { ...spawnOptions, detached: process.platform !== 'win32', shell: false, windowsHide: true });
    processes.add(child);
    child.once('close', () => { exitedProcesses.add(child); processes.delete(child); });
    child.once('error', () => { exitedProcesses.add(child); processes.delete(child); });
    return child;
  }

  async function run(command, args, runOptions = {}) {
    if (closed) throw problem('Backend is closed', 503);
    if (typeof command !== 'string' || !command || command.includes('\0') ||
        !Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
      throw problem('Invalid process arguments');
    }
    const timeoutMs = integer(runOptions.timeoutMs, 'process timeout', 1, 600000, 60000);
    const maxBytes = integer(runOptions.maxBytes, 'output limit', 1, 64 * 1024 * 1024, OUTPUT_LIMIT);
    const allowExitCodes = runOptions.allowExitCodes || [0];
    const abort = new AbortController();
    activeRuns.add(abort);
    const externalSignal = runOptions.signal;
    const onExternalAbort = () => abort.abort();
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    if (externalSignal?.aborted) abort.abort();
    let timer;
    let onAbort;
    try {
      if (abort.signal.aborted) throw problem('Command canceled', 499);
      const operation = typeof injectedRunner === 'function'
        ? Promise.resolve().then(() => {
          if (abort.signal.aborted) throw problem('Command canceled', 499);
          return injectedRunner(command, [...args], { ...runOptions, timeoutMs, maxBytes, signal: abort.signal, shell: false });
        })
        : new Promise((resolve, reject) => {
          let child;
          try { child = spawnCommand(command, args, { stdio: ['pipe', 'pipe', 'pipe'] }); }
          catch (error) { reject(error); return; }
          let stdout = '';
          let stderr = '';
          let bytes = 0;
          let settled = false;
          const stop = error => {
            if (settled) return;
            settled = true;
            killProcess(child);
            reject(error);
          };
          const capture = target => data => {
            bytes += Buffer.byteLength(data);
            if (bytes > maxBytes) { stop(problem('Command output exceeded the configured limit', 502)); return; }
            if (target === 'stdout') stdout += data.toString('utf8');
            else stderr += data.toString('utf8');
          };
          child.stdout?.setEncoding?.('utf8');
          child.stderr?.setEncoding?.('utf8');
          child.stdout?.on('data', capture('stdout'));
          child.stderr?.on('data', capture('stderr'));
          child.once('error', error => stop(problem(`Unable to start ${path.basename(command)}: ${error.message}`, 503)));
          child.once('close', (code, signal) => {
            abort.signal.removeEventListener('abort', canceled);
            if (!settled) { settled = true; resolve({ stdout, stderr, code: code ?? -1, signal }); }
          });
          const canceled = () => stop(problem('Command canceled', 499));
          abort.signal.addEventListener('abort', canceled, { once: true });
          if (abort.signal.aborted) canceled();
          child.stdin?.on('error', () => {});
          child.stdin?.end(runOptions.input === undefined ? undefined : runOptions.input);
        });
      const cancellation = new Promise((resolve, reject) => {
        onAbort = () => reject(problem('Command canceled', 499));
        abort.signal.addEventListener('abort', onAbort, { once: true });
        if (abort.signal.aborted) onAbort();
        timer = setTimeout(() => {
          reject(problem(`Command timed out after ${timeoutMs} ms`, 504));
          abort.abort();
        }, timeoutMs);
        timer.unref?.();
      });
      const raw = await Promise.race([operation, cancellation]);
      const result = typeof raw === 'string'
        ? { stdout: raw, stderr: '', code: 0 }
        : { stdout: String(raw?.stdout || ''), stderr: String(raw?.stderr || ''), code: raw?.code ?? raw?.exitCode ?? 0 };
      if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > maxBytes) {
        throw problem('Command output exceeded the configured limit', 502);
      }
      if (!allowExitCodes.includes(result.code)) {
        const detail = (result.stderr.trim() || result.stdout.trim()).slice(0, 5000);
        const error = problem(`${path.basename(command)} exited with code ${result.code}${detail ? `: ${detail}` : ''}`, 502);
        Object.assign(error, result);
        throw error;
      }
      return result;
    } finally {
      clearTimeout(timer);
      abort.signal.removeEventListener('abort', onAbort);
      externalSignal?.removeEventListener('abort', onExternalAbort);
      activeRuns.delete(abort);
    }
  }

  function requireTool(name) {
    if (!config.tools[name].available) throw problem(`${name} is not installed or configured. Set its executable path and restart Rubban.`, 503);
    return config[`${name}Path`];
  }

  function kube(args, runOptions = {}) { return run(requireTool('kubectl'), args, runOptions); }
  function helm(args, runOptions = {}) { return run(requireTool('helm'), args, runOptions); }

  async function readPreferences() {
    try {
      const value = JSON.parse(await fsp.readFile(preferencesPath, 'utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw problem('Independent preferences could not be read', 500);
    }
  }

  async function writePreferences(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw problem('Preferences must be an object');
    const serialized = JSON.stringify(value, null, 2);
    if (Buffer.byteLength(serialized) > 256 * 1024) throw problem('Preferences are too large', 413);
    await fsp.mkdir(dataDir, { recursive: true });
    const temporary = `${preferencesPath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      await fsp.writeFile(temporary, serialized + '\n', { mode: 0o600, flag: 'wx' });
      await fsp.rename(temporary, preferencesPath);
    } finally { await fsp.rm(temporary, { force: true }).catch(() => {}); }
    return value;
  }
  Object.assign(config, { readPreferences, writePreferences, requireTool });

  // Persistent per-context API connections with shared watches. Injected test
  // runners keep the original kubectl-only path unless a proxy transport is supplied.
  const live = options.live === false || (injectedRunner && !options.proxyFactory)
    ? null
    : createLive({ kubectlPath: () => requireTool('kubectl'), spawnCommand, killProcess, proxyFactory: options.proxyFactory, idleMs: options.proxyIdleMs });
  config.live = live;
  const actions = createActions({ problem, validateText, validateName, validateNamespace, validateResource, integer, contextArgs, namespaceArgs, parseJSONOutput, shortError });
  const argocd = createArgoCD({ problem, validateText, validateName, validateNamespace, integer, contextArgs, namespaceArgs, parseJSONOutput });
  const rabbitmq = createRabbitMQ({ problem, validateText, validateName, validateNamespace, listObjects, readSecret, openEmbeddedForward });

  // Prefer the live connection; fall back to one-shot kubectl only when the
  // connection process itself cannot be started.
  async function viaLive(liveRead, kubectlRead) {
    if (!live) return kubectlRead();
    try { return await liveRead(); }
    catch (error) { if (error.proxyUnavailable && error.status !== 502) return kubectlRead(); throw error; }
  }

  // Node names only (metadata-only list), to notice nodes that metrics-server did not report.
  async function nodeNames(context, signal) {
    const list = await viaLive(
      () => live.raw(context, '/api/v1/nodes', { signal, headers: { Accept: 'application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1,application/json' } }),
      async () => ({ items: (await kube([...contextArgs(context), 'get', 'nodes', '--output=name'], { signal })).stdout.split('\n').filter(Boolean).map(line => ({ metadata: { name: line.replace(/^node\//, '') } })) }));
    return (list.items || []).map(item => item.metadata?.name).filter(Boolean);
  }
  // Usage for nodes metrics-server left out, read from each kubelet's summary API through the API
  // server (needs nodes/proxy). Failures are remembered for a minute so a broken kubelet is not
  // asked again on every refresh.
  const kubeletFailures = new Map();
  async function kubeletUsage(context, names, namespace, response, signal) {
    const now = Date.now();
    const known = new Set((response.pods.items || []).map(item => `${item.metadata?.namespace}/${item.metadata?.name}`));
    const cores = value => `${Math.max(0, Math.round(Number(value) || 0))}n`;
    const bytes = value => `${Math.max(0, Math.round(Number(value) || 0))}`;
    await Promise.all(names.slice(0, 20).map(async name => {
      const key = `${context}\u0000${name}`;
      const failure = kubeletFailures.get(key);
      if (failure && failure.until > now) { response.missingNodes[name] = failure.reason; return; }
      const apiPath = `/api/v1/nodes/${encodeURIComponent(name)}/proxy/stats/summary?only_cpu_and_memory=true`;
      try {
        const summary = await viaLive(() => live.raw(context, apiPath, { signal, timeoutMs: 8000 }),
          async () => parseJSONOutput(await kube([...contextArgs(context), 'get', `--raw=${apiPath}`, '--request-timeout=8s'], { signal }), 'kubelet summary'));
        const node = summary.node || {};
        if (!Number.isFinite(Number(node.cpu?.usageNanoCores)) || !Number.isFinite(Number(node.memory?.workingSetBytes))) throw problem('the kubelet summary has no CPU or memory sample', 502);
        response.nodes.items.push({ metadata: { name }, timestamp: node.cpu.time || node.memory.time, usage: { cpu: cores(node.cpu.usageNanoCores), memory: bytes(node.memory.workingSetBytes) }, source: 'kubelet' });
        for (const pod of summary.pods || []) {
          const ref = pod.podRef || {};
          if (!ref.name || (namespace && namespace !== '*' && ref.namespace !== namespace) || known.has(`${ref.namespace}/${ref.name}`)) continue;
          const containers = (pod.containers || []).filter(c => c.cpu || c.memory).map(c => ({ name: c.name, usage: { cpu: cores(c.cpu?.usageNanoCores), memory: bytes(c.memory?.workingSetBytes) } }));
          if (containers.length) response.pods.items.push({ metadata: { name: ref.name, namespace: ref.namespace }, timestamp: pod.cpu?.time, containers, source: 'kubelet' });
        }
        kubeletFailures.delete(key);
      } catch (error) {
        if (signal?.aborted) return;
        const reason = `metrics-server has no sample for this node, and its kubelet could not be read: ${shortError(error).split('\n')[0].slice(0, 300)}`;
        kubeletFailures.set(key, { until: now + 60000, reason });
        response.missingNodes[name] = reason;
      }
    }));
  }

  function requestAuthorized(req, url, websocket = false) {
    const host = req.headers.host;
    if (!listeningPort || ![`127.0.0.1:${listeningPort}`, `localhost:${listeningPort}`].includes(host)) {
      throw problem('Invalid local Host header', 403);
    }
    const origin = req.headers.origin;
    if (origin && ![`http://127.0.0.1:${listeningPort}`, `http://localhost:${listeningPort}`].includes(origin)) {
      throw problem('Invalid local Origin', 403);
    }
    if (url.pathname.startsWith('/api/')) {
      const bearer = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
      const supplied = websocket ? url.searchParams.get('token') : (req.headers['x-rubban-token'] || bearer?.[1]);
      if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) ||
          !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) throw problem('Unauthorized', 401);
    }
  }

  function setHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
  }

  async function serveUI(req, res, url) {
    if (!['GET', 'HEAD'].includes(req.method)) throw problem('Method not allowed', 405);
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); }
    catch { throw problem('Invalid request path'); }
    if (pathname.includes('\0') || pathname.includes('\\')) throw problem('Invalid request path');
    const uiRoot = path.resolve(__dirname, '..', 'ui');
    let filename;
    if (pathname === '/node_modules/@xterm/xterm/css/xterm.css') {
      filename = path.resolve(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css');
    } else {
      filename = path.resolve(uiRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (filename !== uiRoot && !filename.startsWith(uiRoot + path.sep)) throw problem('File not found', 404);
      try {
        const real = await fsp.realpath(filename);
        if (!real.startsWith(uiRoot + path.sep)) throw problem('File not found', 404);
      } catch { throw problem('File not found', 404); }
    }
    const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
    const extension = path.extname(filename).toLowerCase();
    if (!contentTypes[extension]) throw problem('File not found', 404);
    let contents;
    try {
      const stat = await fsp.stat(filename);
      if (!stat.isFile() || stat.size > 15 * 1024 * 1024) throw new Error('Not a permitted file');
      contents = await fsp.readFile(filename);
    } catch { throw problem('File not found', 404); }
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:${listeningPort} ws://localhost:${listeningPort}; frame-src http://127.0.0.1:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    if (extension === '.html') {
      const html = contents.toString('utf8').replaceAll('__RUBBAN_TOKEN__', token);
      contents = Buffer.from(html);
    }
    res.writeHead(200, { 'Content-Type': `${contentTypes[extension]}; charset=utf-8`, 'Content-Length': contents.length });
    res.end(req.method === 'HEAD' ? undefined : contents);
  }

  async function discover(context, signal) {
    const base = contextArgs(context);
    const initial = await Promise.allSettled([
      kube([...base, 'get', '--raw=/api/v1'], { signal }),
      kube([...base, 'get', '--raw=/apis'], { signal }),
    ]);
    const resources = [];
    const warnings = [];
    const add = (document, group) => {
      for (const resource of document.resources || []) {
        if (!resource.name || resource.name.includes('/')) continue;
        resources.push({ name: resource.name, kind: resource.kind, namespaced: !!resource.namespaced, group, verbs: resource.verbs || [] });
      }
    };
    if (initial[0].status === 'fulfilled') add(parseJSONOutput(initial[0].value, 'Kubernetes discovery'), '');
    else warnings.push(`Core discovery: ${shortError(initial[0].reason)}`);
    const versions = initial[1].status === 'fulfilled'
      ? (parseJSONOutput(initial[1].value, 'Kubernetes discovery').groups || []).map(group => group.preferredVersion?.groupVersion).filter(Boolean)
      : [];
    if (initial[1].status === 'rejected') warnings.push(`API group discovery: ${shortError(initial[1].reason)}`);
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(6, versions.length) }, async () => {
      while (index < versions.length && !signal.aborted) {
        const groupVersion = versions[index++];
        if (!/^[a-z0-9.-]+\/v[a-z0-9]+$/.test(groupVersion)) { warnings.push('Skipped malformed API group version'); continue; }
        try {
          const output = await kube([...base, 'get', `--raw=/apis/${groupVersion}`], { signal });
          add(parseJSONOutput(output, 'Kubernetes discovery'), groupVersion.split('/')[0]);
        } catch (error) { warnings.push(`${groupVersion}: ${shortError(error)}`); }
      }
    }));
    if (!resources.length && warnings.length) throw problem(`Kubernetes discovery unavailable: ${warnings.join('; ')}`, 502);
    resources.sort((a, b) => `${a.group}/${a.name}`.localeCompare(`${b.group}/${b.name}`));
    return { resources, warnings };
  }

  function forwardView(forward) {
    const { child: _child, ...publicFields } = forward;
    const embed = embeds.get(forward.id);
    return embed ? { ...publicFields, embedPort: embed.port } : publicFields;
  }
  // Embed proxies (see embed-proxy.cjs) live as long as the forward they front.
  const embeds = new Map();
  function closeEmbed(id) { const embed = embeds.get(id); embeds.delete(id); return embed ? embed.close() : Promise.resolve(); }
  async function openEmbeddedForward({ context, namespace, resource, name, remotePort, scheme, signal, credentials }) {
    let forward = [...forwards.values()].find(item => item.context === context && item.namespace === namespace && item.resource === resource && item.name === name && item.remotePort === remotePort && ['starting', 'ready'].includes(item.status));
    if (!forward) forward = forwards.get(createForward({ context, namespace, resource, name, remotePort, localPort: 0 }).id);
    const deadline = Date.now() + 25000;
    while (forward.status === 'starting' && Date.now() < deadline && !signal?.aborted) await new Promise(resolve => setTimeout(resolve, 150));
    if (forward.status !== 'ready') {
      const reason = forward.error ? `: ${forward.error.split('\n')[0]}` : forward.status === 'starting' ? ' within 25 seconds' : '';
      // Do not leave a failed console forward behind in Port Forwarding.
      forward.status = 'stopped'; killProcess(forward.child); forwards.delete(forward.id);
      throw problem(`The port forward to ${resource}/${name}:${remotePort} did not start${reason}`, 502);
    }
    let embed = embeds.get(forward.id);
    if (!embed) {
      embed = await createEmbedProxy({ targetPort: forward.localPort, parentOrigins: [`http://127.0.0.1:${listeningPort}`, `http://localhost:${listeningPort}`], upstreamTLS: scheme === 'https', credentials });
      if (forward.status !== 'ready') { await embed.close(); throw problem('The port forward stopped while the console was opening', 502); }
      embeds.set(forward.id, embed);
      forward.child.once('close', () => closeEmbed(forward.id));
    }
    return { forwardId: forward.id, localPort: forward.localPort, url: `http://127.0.0.1:${embed.port}/`, origin: `http://127.0.0.1:${embed.port}` };
  }
  async function listObjects(context, resource, namespace, { signal, labelSelector, fieldSelector } = {}) {
    const selectorArgs = [...(labelSelector ? [`--selector=${labelSelector}`] : []), ...(fieldSelector ? [`--field-selector=${fieldSelector}`] : [])];
    return viaLive(() => live.list(context, resource, namespace, { signal, labelSelector, fieldSelector }),
      async () => parseJSONOutput(await kube(['get', resource, ...contextArgs(context), ...namespaceArgs(namespace, { all: true }), ...selectorArgs, '--output=json'], { signal, maxBytes: LIST_OUTPUT_LIMIT }), 'kubectl'));
  }
  async function readSecret(context, namespace, name, signal) {
    const secret = await viaLive(() => live.raw(context, `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${encodeURIComponent(name)}`, { signal }),
      async () => parseJSONOutput(await kube([...contextArgs(context), ...namespaceArgs(namespace), 'get', 'secret', name, '--output=json'], { signal }), 'kubectl'));
    return secret.data || {};
  }

  function createForward(body) {
    const context = validateText(body.context, 'context');
    const namespace = validateNamespace(body.namespace);
    const resource = validateResource(body.resource);
    const name = validateName(body.name);
    // Local port 0 lets kubectl choose a free port; the chosen port is read from its output.
    const localPort = integer(body.localPort, 'local port', 0, 65535, 0);
    const remotePort = integer(body.remotePort, 'remote port', 1, 65535);
    if (localPort && [...forwards.values()].some(item => item.localPort === localPort && ['starting', 'ready'].includes(item.status))) {
      throw problem('This local port already has a Rubban forward', 409);
    }
    const args = [...contextArgs(context), ...namespaceArgs(namespace), 'port-forward', `${resource}/${name}`, `${localPort || ''}:${remotePort}`, '--address=127.0.0.1'];
    const child = spawnCommand(requireTool('kubectl'), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const forward = { id: crypto.randomUUID(), context, namespace, resource, name, localPort, remotePort, status: 'starting', child, createdAt: new Date().toISOString() };
    forwards.set(forward.id, forward);
    let log = '';
    const data = chunk => {
      log = (log + chunk.toString('utf8')).slice(-8000);
      const ready = /Forwarding from (?:127\.0\.0\.1|\[::1\]):(\d+)/.exec(log);
      if (ready) { forward.status = 'ready'; if (!forward.localPort) forward.localPort = Number(ready[1]); }
    };
    child.stdout?.on('data', data);
    child.stderr?.on('data', data);
    child.once('error', error => { forward.status = 'error'; forward.error = shortError(error); });
    child.once('close', code => {
      if (forward.status === 'stopped') return;
      forward.status = code === 0 ? 'stopped' : 'error';
      if (code !== 0) forward.error = log.trim() || `kubectl port-forward exited with code ${code}`;
    });
    return forwardView(forward);
  }

  function validateChart(value) {
    const chart = validateText(value, 'chart', { max: 2048 });
    if (/^(?:https?|oci):\/\//i.test(chart)) {
      let parsed;
      try { parsed = new URL(chart); } catch { throw problem('Invalid chart URL'); }
      if (parsed.username || parsed.password || parsed.hash) throw problem('Chart URLs must not contain credentials or fragments');
      return chart;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(chart) || chart.split('/').includes('..') || /^[A-Za-z]:/.test(chart)) {
      throw problem('Use a repository chart reference, HTTPS chart URL, or OCI reference');
    }
    return chart;
  }

  async function helmMutation(body, signal) {
    const action = body.action;
    if (!['install', 'upgrade', 'uninstall', 'repo-add', 'repo-update', 'repo-remove', 'rollback'].includes(action)) throw problem('Unsupported Helm action');
    let args;
    let input;
    if (action === 'repo-add') {
      const repo = validateName(body.repo, 'repository name');
      let url;
      try { url = new URL(validateText(body.url, 'repository URL', { max: 2048 })); } catch { throw problem('Invalid repository URL'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw problem('Use an HTTP(S) repository URL without credentials');
      args = ['repo', 'add', repo, url.href];
    } else if (action === 'repo-remove') {
      args = ['repo', 'remove', validateName(body.repo, 'repository name')];
    } else if (action === 'repo-update') {
      args = ['repo', 'update'];
      if (body.repo) args.push(validateName(body.repo, 'repository name'));
    } else {
      const context = validateText(body.context, 'context');
      const namespace = validateNamespace(body.namespace);
      const name = validateName(body.name, 'release name');
      args = [action, name];
      if (action === 'install' || action === 'upgrade') args.push(validateChart(body.chart));
      if (action === 'rollback') args.push(String(integer(body.revision, 'revision', 1, 1000000)));
      args.push(`--kube-context=${context}`, ...namespaceArgs(namespace));
      if (body.version && ['install', 'upgrade'].includes(action)) args.push(`--version=${validateText(body.version, 'chart version', { max: 128 })}`);
      if (body.values !== undefined && ['install', 'upgrade'].includes(action)) {
        if (typeof body.values !== 'string' || Buffer.byteLength(body.values) > 1024 * 1024) throw problem('Values must be YAML text up to 1 MiB');
        try {
          for (const document of YAML.parseAllDocuments(body.values)) {
            if (document.errors.length) throw document.errors[0];
            document.toJS({ maxAliasCount: 100 });
          }
        } catch { throw problem('Invalid Helm values YAML'); }
        args.push('--values=-');
        input = body.values;
      }
    }
    const output = await helm(args, { input, signal, timeoutMs: 300000 });
    return { output: output.stdout + output.stderr };
  }

  const server = http.createServer(async (req, res) => {
    setHeaders(res);
    const abort = new AbortController();
    req.once('aborted', () => abort.abort());
    res.once('close', () => { if (!res.writableEnded) abort.abort(); });
    try {
      const url = new URL(req.url, `http://127.0.0.1:${listeningPort || 1}`);
      requestAuthorized(req, url);
      if (!url.pathname.startsWith('/api/')) { await serveUI(req, res, url); return; }
      const method = req.method;
      const route = url.pathname;
      const query = Object.fromEntries(url.searchParams);
      const body = ['POST', 'PUT', 'PATCH'].includes(method) || (method === 'DELETE' && (Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding']))
        ? await readJSON(req) : {};
      const signal = abort.signal;
      if (method === 'GET' && route === '/api/health') {
        sendJSON(res, { version: APP_VERSION, tools: config.tools, platform: process.platform, live: Boolean(live) });
      } else if (method === 'GET' && route === '/api/contexts') {
        const document = parseJSONOutput(await kube(['config', 'view', '--output=json'], { signal }), 'kubectl');
        const current = document['current-context'] || '';
        sendJSON(res, { current, contexts: (document.contexts || []).map(item => ({ name: item.name, cluster: item.context?.cluster || '', user: item.context?.user || '', namespace: item.context?.namespace || 'default', current: item.name === current })) });
      } else if (method === 'GET' && route === '/api/namespaces') {
        const context = validateText(query.context, 'context');
        sendJSON(res, await viaLive(() => live.list(context, 'namespaces', '', { signal }),
          async () => parseJSONOutput(await kube([...contextArgs(context), 'get', 'namespaces', '--output=json'], { signal }), 'kubectl')));
      } else if (method === 'GET' && (route === '/api/resources' || route === '/api/events')) {
        const resource = route === '/api/events' ? 'events' : validateResource(query.resource);
        const context = validateText(query.context, 'context');
        const namespace = validateNamespace(query.namespace, { all: true });
        const labelSelector = query.labelSelector ? validateSelector(query.labelSelector, 'label selector') : '';
        const fieldSelector = query.fieldSelector ? validateSelector(query.fieldSelector, 'field selector') : '';
        const selectorArgs = [...(labelSelector ? [`--selector=${labelSelector}`] : []), ...(fieldSelector ? [`--field-selector=${fieldSelector}`] : [])];
        const document = await viaLive(() => live.list(context, resource, namespace, { signal, labelSelector, fieldSelector }),
          // --all-namespaces belongs to get, not kubectl's root/plugin parser.
          async () => parseJSONOutput(await kube(['get', resource, ...contextArgs(context), ...namespaceArgs(namespace, { all: true }), ...selectorArgs, '--output=json'], { signal, maxBytes: LIST_OUTPUT_LIMIT }), 'kubectl'));
        sendJSON(res, /^(?:secrets?)(?:\..*)?$/.test(resource) || document.kind === 'SecretList' ? redactSecretList(document) : document);
      } else if (method === 'GET' && route === '/api/discovery') {
        const context = validateText(query.context, 'context');
        sendJSON(res, await viaLive(() => live.discover(context, { refresh: query.refresh === '1' }), () => discover(context, signal)));
      } else if (method === 'GET' && (route === '/api/resource' || route === '/api/yaml')) {
        const context = validateText(query.context, 'context');
        const namespace = validateNamespace(query.namespace);
        const resource = validateResource(query.resource);
        const name = validateName(query.name);
        const args = [...contextArgs(context), ...namespaceArgs(namespace), 'get', resource, name];
        if (route === '/api/yaml') {
          sendJSON(res, { yaml: await viaLive(async () => objectYAML(await live.get(context, resource, namespace, name, { signal })),
            async () => (await kube([...args, '--output=yaml'], { signal })).stdout) });
        } else {
          const object = await viaLive(() => live.get(context, resource, namespace, name, { signal }),
            async () => parseJSONOutput(await kube([...args, '--output=json'], { signal }), 'kubectl'));
          // Secret values are only returned by the explicit /api/secret-data and YAML reveal requests.
          sendJSON(res, object?.kind === 'Secret' ? redactSecretList({ items: [object] }).items[0] : object);
        }
      } else if (method === 'POST' && (route === '/api/diff' || route === '/api/apply')) {
        const input = validateYAML(body.yaml);
        const isDiff = route === '/api/diff';
        const output = await kube([...contextArgs(body.context), ...namespaceArgs(body.namespace), isDiff ? 'diff' : 'apply', '--filename=-'], { input, signal, allowExitCodes: isDiff ? [0, 1] : [0] });
        sendJSON(res, isDiff ? { diff: output.stdout + output.stderr, changed: output.code === 1 } : { output: output.stdout + output.stderr });
      } else if (method === 'POST' && ['/api/delete', '/api/scale', '/api/restart'].includes(route)) {
        const resource = validateResource(body.resource);
        const name = validateName(body.name);
        const args = [...contextArgs(body.context), ...namespaceArgs(body.namespace)];
        if (route === '/api/delete') args.push('delete', resource, name, '--wait=false');
        else if (route === '/api/scale') args.push('scale', resource, name, `--replicas=${integer(body.replicas, 'replicas', 0, 1000000)}`);
        else {
          if (!/^(?:deployments?|daemonsets?|statefulsets?)(?:\.apps)?$/.test(resource)) throw problem('Restart supports Deployments, DaemonSets and StatefulSets');
          args.push('rollout', 'restart', `${resource}/${name}`);
        }
        const output = await kube(args, { signal });
        sendJSON(res, { output: output.stdout + output.stderr });
      } else if (method === 'GET' && route === '/api/metrics') {
        const context = validateText(query.context, 'context');
        const args = contextArgs(context);
        const namespace = validateNamespace(query.namespace, { all: true });
        const podPath = namespace && namespace !== '*'
          ? `/apis/metrics.k8s.io/v1beta1/namespaces/${encodeURIComponent(namespace)}/pods`
          : '/apis/metrics.k8s.io/v1beta1/pods';
        const readRaw = apiPath => viaLive(() => live.raw(context, apiPath, { signal }),
          async () => parseJSONOutput(await kube([...args, 'get', `--raw=${apiPath}`], { signal }), 'Kubernetes metrics API'));
        const results = await Promise.allSettled([readRaw('/apis/metrics.k8s.io/v1beta1/nodes'), readRaw(podPath), nodeNames(context, signal)]);
        const response = { nodes: { items: [] }, pods: { items: [] }, warnings: [], missingNodes: {} };
        for (const [index, label] of ['nodes', 'pods'].entries()) {
          if (results[index].status === 'fulfilled') {
            try { response[label] = results[index].value; }
            catch (error) { response.warnings.push(`${label} metrics unavailable: ${shortError(error)}`); }
          } else response.warnings.push(`${label} metrics unavailable: ${shortError(results[index].reason)}`);
        }
        // metrics-server leaves out nodes it failed to scrape (and their pods). Read those from the
        // kubelet through the API server so a single slow node does not disappear from every total.
        if (results[0].status === 'fulfilled' && results[2].status === 'fulfilled') {
          const reported = new Set((response.nodes.items || []).map(item => item.metadata?.name));
          const missing = results[2].value.filter(name => !reported.has(name));
          if (missing.length) await kubeletUsage(context, missing, namespace, response, signal);
        }
        sendJSON(res, response);
      } else if (method === 'GET' && route === '/api/helm') {
        const args = ['list', '--all', '--output=json', `--kube-context=${validateText(query.context, 'context')}`, ...namespaceArgs(query.namespace, { all: true })];
        const results = await Promise.allSettled([helm(args, { signal }), helm(['repo', 'list', '--output=json'], { signal, allowExitCodes: [0, 1] })]);
        if (results[0].status === 'rejected') throw results[0].reason;
        const repositories = results[1].status === 'fulfilled' && results[1].value.code === 0
          ? parseJSONOutput(results[1].value, 'Helm') : [];
        const warnings = results[1].status === 'rejected' ? [shortError(results[1].reason)] : [];
        sendJSON(res, { releases: parseJSONOutput(results[0].value, 'Helm'), repositories, warnings });
      } else if (method === 'GET' && route === '/api/helm/charts') {
        // Latest version of every chart in the configured repositories, plus the repositories themselves.
        const results = await Promise.allSettled([
          helm(['search', 'repo', '--output=json'], { signal, allowExitCodes: [0, 1] }),
          helm(['repo', 'list', '--output=json'], { signal, allowExitCodes: [0, 1] }),
        ]);
        const warnings = [];
        const parse = result => {
          if (result.status === 'rejected') { warnings.push(shortError(result.reason)); return []; }
          if (result.value.code !== 0) {
            const text = (result.value.stderr || result.value.stdout).trim();
            if (text && !/no repositories/i.test(text)) warnings.push(text.slice(0, 1000));
            return [];
          }
          const parsed = parseJSONOutput(result.value, 'Helm');
          return Array.isArray(parsed) ? parsed : [];
        };
        sendJSON(res, { charts: parse(results[0]), repositories: parse(results[1]), warnings });
      } else if (method === 'POST' && route === '/api/helm') {
        sendJSON(res, await helmMutation(body, signal));
      } else if (method === 'GET' && route === '/api/forwards') {
        sendJSON(res, { items: [...forwards.values()].map(forwardView) });
      } else if (method === 'POST' && route === '/api/forwards') {
        sendJSON(res, createForward(body), 201);
      } else if (method === 'DELETE' && route.startsWith('/api/forwards/')) {
        const id = route.slice('/api/forwards/'.length);
        const forward = forwards.get(id);
        if (!forward) throw problem('Port forward not found', 404);
        forward.status = 'stopped';
        const exited = forward.child.exitCode !== null && forward.child.exitCode !== undefined
          ? Promise.resolve()
          : new Promise(resolve => { const timer = setTimeout(resolve, 3000); forward.child.once('close', () => { clearTimeout(timer); resolve(); }); });
        killProcess(forward.child);
        forwards.delete(id);
        await closeEmbed(id);
        // Answer after kubectl has released the local port, so a restart can reuse it.
        await exited;
        sendJSON(res, { ok: true });
      } else if (method === 'GET' && route === '/api/preferences') {
        sendJSON(res, await readPreferences());
      } else if (method === 'PUT' && route === '/api/preferences') {
        sendJSON(res, await writePreferences(body));
      } else if (await actions({ method, route, query, body, kube, helm, live, signal, sendJSON, res, readPreferences })) {
        // Cluster actions and detail reads own their response.
      } else if (await argocd({ method, route, body, kube, signal, sendJSON, res })) {
        // Argo CD application management owns its response.
      } else if (await rabbitmq({ method, route, query, body, signal, sendJSON, res })) {
        // RabbitMQ consoles own their response.
      } else if (options.extras && await options.extras({ req, res, url, body, run, config, token, signal, readJSON, sendJSON, helpers: { problem, validateText, validateName, validateResource, validateNamespace, contextArgs, namespaceArgs, integer, parseJSONOutput, findExecutable } })) {
        // The extension owns its completed response.
      } else throw problem('API route not found', 404);
    } catch (error) {
      if ((error.status || 500) >= 500) options.logger?.error(error, { route: String(req.url).split('?')[0] });
      if (!res.writableEnded && !res.destroyed) sendJSON(res, { error: shortError(error) }, error.status || 500);
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 64;
  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  function streamWrite(ws, data) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > STREAM_BUFFER_LIMIT) { ws.terminate(); return; }
    ws.send(data);
  }

  function attachLogs(ws, url) {
    let child;
    try {
      const query = Object.fromEntries(url.searchParams);
      const args = [...contextArgs(query.context), ...namespaceArgs(query.namespace), 'logs'];
      if (query.selector) {
        // Workload logs: every pod matching the workload's label selector, prefixed by pod/container.
        const selector = validateText(query.selector, 'selector', { max: 2000 });
        if (!/^[A-Za-z0-9_./=,!() -]+$/.test(selector) || /--/.test(selector)) throw problem('Invalid label selector');
        args.push(`--selector=${selector}`, '--prefix=true', `--max-log-requests=${integer(query.maxRequests, 'max log requests', 1, 50, 20)}`);
        if (!query.container) args.push('--all-containers=true');
      } else args.push(validateName(query.pod, 'pod'));
      args.push(`--follow=${query.follow === 'false' ? 'false' : 'true'}`, `--tail=${integer(query.tail, 'tail lines', -1, 100000, 100)}`);
      if (query.container === '*') args.push('--all-containers=true', ...(query.selector ? [] : ['--prefix=true']));
      else if (query.container) args.push(`--container=${validateName(query.container, 'container')}`);
      if (query.timestamps === 'true') args.push('--timestamps=true');
      if (query.since) args.push(`--since=${integer(query.since, 'since seconds', 1, 30 * 86400)}s`);
      if (query.previous === 'true') args.push('--previous=true');
      else if (query.previous && query.previous !== 'false') throw problem('Invalid previous-log flag');
      child = spawnCommand(requireTool('kubectl'), args, { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout?.setEncoding?.('utf8');
      child.stderr?.setEncoding?.('utf8');
      child.stdout?.on('data', data => streamWrite(ws, data.toString('utf8')));
      child.stderr?.on('data', data => streamWrite(ws, data.toString('utf8')));
      child.once('error', error => { streamWrite(ws, `[error] ${shortError(error)}\n`); ws.close(1011, 'Log command failed'); });
      child.once('close', code => {
        if (code && ws.readyState === WebSocket.OPEN) streamWrite(ws, `\n[process exited with code ${code}]\n`);
        if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'Log stream ended');
      });
      ws.once('close', () => killProcess(child));
      ws.once('error', () => killProcess(child));
    } catch (error) { streamWrite(ws, `[error] ${shortError(error)}\n`); ws.close(1008, 'Invalid log request'); }
  }

  // Live resource stream: {type:'status'|'reset'|'items'|'synced'|'changes'|'error'|'unavailable'}.
  // Messages are queued and sent one at a time so a large initial list applies
  // socket backpressure instead of buffering unboundedly.
  function attachWatch(ws, url) {
    const queue = [];
    let sending = false;
    let closed = false;
    let closeWhenDrained = false;
    let unsubscribe = null;
    const finish = () => { if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'Watch ended'); };
    const pump = () => {
      if (sending || closed || ws.readyState !== WebSocket.OPEN) return;
      const next = queue.shift();
      if (next === undefined) { if (closeWhenDrained) finish(); return; }
      sending = true;
      ws.send(next, error => {
        sending = false;
        if (error) { ws.terminate(); return; }
        pump();
      });
    };
    const send = message => {
      if (closed) return;
      if (queue.length > 5000) { ws.terminate(); return; }
      queue.push(JSON.stringify(message));
      pump();
    };
    const end = message => { send(message); closeWhenDrained = true; pump(); };
    const chunked = (items, size = 250) => { const parts = []; for (let i = 0; i < items.length; i += size) parts.push(items.slice(i, i + size)); return parts; };
    ws.once('close', () => { closed = true; queue.length = 0; unsubscribe?.(); });
    ws.once('error', () => { closed = true; unsubscribe?.(); });
    ws.on('message', () => {});
    try {
      if (!live) { end({ type: 'unavailable', message: 'Live updates are not available in this mode; showing a snapshot.' }); return; }
      const query = Object.fromEntries(url.searchParams);
      const context = validateText(query.context, 'context');
      const resource = validateResource(query.resource);
      const namespace = validateNamespace(query.namespace, { all: true });
      const listener = {
        status: status => send({ type: 'status', ...status }),
        reset: (items, resourceVersion) => {
          send({ type: 'reset' });
          for (const part of chunked(items)) send({ type: 'items', items: part });
          send({ type: 'synced', resourceVersion, count: items.length });
        },
        changes: (upserts, deletes) => {
          const parts = chunked(upserts);
          if (!parts.length) parts.push([]);
          parts.forEach((part, index) => send({ type: 'changes', upserts: part, deletes: index === 0 ? deletes : [] }));
        },
        fatal: error => end({ type: 'error', error: shortError(error), status: error.status || 502 }),
      };
      live.watch(context, resource, namespace, listener, { resync: query.resync === '1', labelSelector: query.labelSelector ? validateSelector(query.labelSelector, 'label selector') : undefined, fieldSelector: query.fieldSelector ? validateSelector(query.fieldSelector, 'field selector') : undefined })
        .then(stop => { if (closed) stop(); else unsubscribe = stop; }, error => listener.fatal(error));
    } catch (error) { end({ type: 'error', error: shortError(error), status: error.status || 400 }); }
  }

  // A local shell opened for a cluster gets its own minified kubeconfig (that context, and the
  // selected namespace), so kubectl and helm in it target the cluster on screen.
  function scopedKubeconfig(context, namespace) {
    if (!context || injectedRunner) return null;
    const output = cp.execFileSync(requireTool('kubectl'), ['config', 'view', '--raw', '--minify', '--flatten', `--context=${validateText(context, 'context')}`, '--output=json'], { timeout: 20000, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const config = JSON.parse(output);
    if (namespace && namespace !== '*' && config.contexts?.[0]?.context) config.contexts[0].context.namespace = validateNamespace(namespace);
    const directory = path.join(dataDir, 'terminals');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${crypto.randomBytes(8).toString('hex')}.kubeconfig`);
    fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    terminalKubeconfigs.add(file);
    return file;
  }
  // Scoped kubeconfigs left by a crash or forced quit are removed when the backend starts.
  const terminalKubeconfigs = new Set();
  try { fs.rmSync(path.join(dataDir, 'terminals'), { recursive: true, force: true }); } catch { /* Not present. */ }
  function attachTerminal(ws, url) {
    let terminal;
    let cleanup = () => {};
    let kubeconfigFile = null;
    const removeKubeconfig = () => { if (kubeconfigFile) { try { fs.rmSync(kubeconfigFile, { force: true }); } catch { /* Swept at next start. */ } terminalKubeconfigs.delete(kubeconfigFile); kubeconfigFile = null; } };
    const send = value => streamWrite(ws, JSON.stringify(value));
    try {
      const query = Object.fromEntries(url.searchParams);
      const cols = integer(query.cols, 'terminal columns', 20, 500, 100);
      const rows = integer(query.rows, 'terminal rows', 5, 300, 30);
      let pty;
      if (options.pty !== false && process.env.RUBBAN_DISABLE_PTY !== '1' && injectedRunner?.pty) pty = injectedRunner.pty;
      else if (options.pty !== false && process.env.RUBBAN_DISABLE_PTY !== '1' && !injectedRunner) {
        try { pty = require('@lydell/node-pty'); } catch { /* An honest pipe fallback remains available. */ }
      }
      const remote = Boolean(query.pod || query.node);
      let command;
      let args;
      let debugPod = null;
      let watchOutput = () => {};
      let mode = 'local';
      if (query.node) {
        // Node shell: a short-lived privileged debug pod on the node, entering the host filesystem.
        mode = 'node';
        command = requireTool('kubectl');
        const image = validateText(query.image || 'busybox:1.36', 'node shell image', { max: 300 });
        if (!/^[A-Za-z0-9][A-Za-z0-9._\/:@-]*$/.test(image)) throw problem('Invalid node shell image');
        args = [...contextArgs(query.context), '--namespace=kube-system', 'debug', `node/${validateName(query.node, 'node')}`, '--stdin=true', `--image=${image}`, '--profile=sysadmin'];
        if (pty) args.push('--tty=true');
        args.push('--', 'chroot', '/host', '/bin/sh', '-c', 'if [ -x /bin/bash ]; then exec /bin/bash -l; else exec /bin/sh -l; fi');
        let seen = '';
        watchOutput = data => {
          if (debugPod) return;
          seen = (seen + data).slice(-2000);
          const match = /debugging pod (node-debugger-[a-z0-9.-]+)/.exec(seen);
          if (match) debugPod = match[1];
        };
      } else if (query.pod) {
        mode = query.attach === 'true' ? 'attach' : 'exec';
        command = requireTool('kubectl');
        args = [...contextArgs(query.context), ...namespaceArgs(query.namespace), mode, '--stdin=true'];
        if (pty) args.push('--tty=true');
        args.push(validateName(query.pod, 'pod'));
        if (query.container) args.push(`--container=${validateName(query.container, 'container')}`);
        // Prefer bash when the image has it; fall back to sh.
        if (mode === 'exec') args.push('--', '/bin/sh', '-c', 'if [ -x /bin/bash ]; then exec /bin/bash; else exec /bin/sh; fi');
      } else {
        ({ command, args } = localShell(Boolean(query.context)));
        if (query.context) {
          // Fail closed: never open a "cluster" shell that would silently use another context.
          try { kubeconfigFile = scopedKubeconfig(query.context, query.namespace); }
          catch (error) { throw problem(`Could not prepare a kubeconfig for ${query.context}: ${shortError(error)}`, 502); }
        }
      }
      const shellEnv = { ...process.env, TERM: 'xterm-256color', ...(kubeconfigFile ? { KUBECONFIG: kubeconfigFile, RUBBAN_CONTEXT: query.context } : {}) };
      // Local shells start in the home folder; kubectl sessions do not depend on it.
      const workingDirectory = mode === 'local' && fs.existsSync(os.homedir()) ? os.homedir() : fs.existsSync(dataDir) ? dataDir : os.homedir();
      if (pty) {
        try {
          terminal = pty.spawn(command, args, { name: 'xterm-256color', cols, rows, cwd: workingDirectory, env: shellEnv });
          processes.add(terminal);
          terminal.onData(data => { watchOutput(data); send({ type: 'data', data }); });
          terminal.onExit(({ exitCode }) => {
            exitedProcesses.add(terminal);
            processes.delete(terminal);
            send({ type: 'exit', code: exitCode });
            if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'Terminal exited');
          });
          cleanup = () => { processes.delete(terminal); killProcess(terminal); };
          send({ type: 'status', mode: 'pty', message: mode === 'node' ? 'Node shell (privileged debug pod in kube-system)' : mode === 'attach' ? 'Attached to container' : remote ? 'Interactive pod terminal' : 'Interactive local terminal' });
        } catch (error) {
          terminal = undefined;
          send({ type: 'status', mode: 'pipes', message: `PTY unavailable; using command pipes without terminal resize: ${shortError(error)}` });
        }
      }
      if (!terminal) {
        if (remote) args = args.filter(arg => arg !== '--tty=true');
        const child = spawnCommand(command, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: workingDirectory, env: shellEnv });
        terminal = { write: data => child.stdin?.write(data), resize: () => {}, kill: () => killProcess(child) };
        cleanup = () => killProcess(child);
        send({ type: 'status', mode: 'pipes', message: 'Command-pipe fallback: interactive TTY applications and resize are unavailable.' });
        child.stdin?.on('error', () => {});
        child.stdout?.setEncoding?.('utf8');
        child.stderr?.setEncoding?.('utf8');
        child.stdout?.on('data', data => { watchOutput(String(data)); send({ type: 'data', data: data.toString('utf8') }); });
        child.stderr?.on('data', data => { watchOutput(String(data)); send({ type: 'data', data: data.toString('utf8') }); });
        child.once('error', error => { send({ type: 'error', error: shortError(error) }); ws.close(1011, 'Terminal failed'); });
        child.once('close', code => { send({ type: 'exit', code }); if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'Terminal exited'); });
      }
      ws.on('message', raw => {
        try {
          const message = JSON.parse(raw.toString('utf8'));
          if (message.type === 'input') {
            if (typeof message.data !== 'string' || Buffer.byteLength(message.data) > 32768) throw problem('Terminal input exceeds 32 KiB');
            terminal.write(message.data);
          } else if (message.type === 'resize') {
            terminal.resize(integer(message.cols, 'terminal columns', 20, 500), integer(message.rows, 'terminal rows', 5, 300));
          } else throw problem('Unsupported terminal message');
        } catch (error) { send({ type: 'error', error: shortError(error) }); }
      });
      // Remove the node-shell debug pod once the session ends.
      const removeDebugPod = () => {
        if (!debugPod || closed) return;
        const name = debugPod; debugPod = null;
        kube([...contextArgs(query.context), '--namespace=kube-system', 'delete', 'pod', name, '--wait=false', '--ignore-not-found=true'], { timeoutMs: 30000 }).catch(() => {});
      };
      const finish = () => { cleanup(); removeDebugPod(); removeKubeconfig(); };
      ws.once('close', finish);
      ws.once('error', finish);
    } catch (error) { cleanup(); removeKubeconfig(); send({ type: 'error', error: shortError(error) }); ws.close(1008, 'Invalid terminal request'); }
  }

  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${listeningPort || 1}`);
      requestAuthorized(req, url, true);
      if (!['/api/logs', '/api/terminal', '/api/watch'].includes(url.pathname)) throw problem('WebSocket route not found', 404);
      wsServer.handleUpgrade(req, socket, head, ws => {
        wsServer.emit('connection', ws, req);
        if (url.pathname === '/api/logs') attachLogs(ws, url);
        else if (url.pathname === '/api/watch') attachWatch(ws, url);
        else attachTerminal(ws, url);
      });
    } catch (error) {
      if (socket.writable) socket.end(`HTTP/1.1 ${error.status || 400} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      else socket.destroy();
    }
  });

  async function start(port = 0) {
    if (closed) throw problem('Backend is closed', 503);
    if (!server.listening) {
      await new Promise((resolve, reject) => {
        const onError = error => { server.removeListener('listening', onListening); reject(error); };
        const onListening = () => { server.removeListener('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(integer(port, 'port', 0, 65535), '127.0.0.1');
      });
      listeningPort = server.address().port;
    }
    return { url: `http://127.0.0.1:${listeningPort}`, port: listeningPort, token };
  }

  async function close() {
    if (closed) return;
    closed = true;
    for (const abort of activeRuns) abort.abort();
    live?.close();
    for (const client of wsServer.clients) client.terminate();
    for (const forward of forwards.values()) forward.status = 'stopped';
    for (const child of processes) killProcess(child);
    processes.clear();
    forwards.clear();
    await Promise.all([...embeds.keys()].map(closeEmbed));
    for (const file of terminalKubeconfigs) { try { fs.rmSync(file, { force: true }); } catch { /* Best effort. */ } }
    terminalKubeconfigs.clear();
    wsServer.close();
    if (server.listening) {
      const completion = new Promise(resolve => server.close(resolve));
      server.closeAllConnections?.();
      await completion;
    }
  }

  return { server, token, start, close, run, config };
}

module.exports = { createBackend, readJSON, sendJSON, validateText, validateName, validateResource, validateNamespace, contextArgs, namespaceArgs, validateYAML, findExecutable, problem };
