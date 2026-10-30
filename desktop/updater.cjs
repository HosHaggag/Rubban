'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn: nodeSpawn } = require('node:child_process');

const MAX_DOWNLOAD = 500 * 1024 * 1024;
const ALLOWED_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const CHECK_DELAY_MS = 20 * 1000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// major.minor.patch[-pre]; a version with a pre-release part sorts before the plain release.
function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(text).trim());
  if (!match) throw new Error(`Invalid version: ${text}`);
  return { numbers: match.slice(1, 4).map(Number), pre: match[4] ? match[4].split('.') : [] };
}
function compareVersions(a, b) {
  const x = parseVersion(a); const y = parseVersion(b);
  for (let index = 0; index < 3; index++) if (x.numbers[index] !== y.numbers[index]) return x.numbers[index] < y.numbers[index] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let index = 0; index < Math.max(x.pre.length, y.pre.length); index++) {
    const left = x.pre[index]; const right = y.pre[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left); const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) { if (Number(left) !== Number(right)) return Number(left) < Number(right) ? -1 : 1; }
    else if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    else if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

const allowedUrl = value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && ALLOWED_HOSTS.has(url.hostname); } catch { return false; } };

// fetch that follows redirects by hand so every hop stays on GitHub's own hosts over HTTPS.
async function safeFetch(fetchImpl, url, options = {}) {
  let target = url;
  for (let hop = 0; hop < 6; hop++) {
    if (!allowedUrl(target)) throw new Error(`Blocked download from ${(() => { try { return new URL(target).host; } catch { return 'an invalid address'; } })()}`);
    const response = await fetchImpl(target, { ...options, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400 && response.headers?.get?.('location')) { target = new URL(response.headers.get('location'), target).href; continue; }
    return response;
  }
  throw new Error('Too many redirects');
}

function validateManifest(manifest, key) {
  if (!manifest || typeof manifest !== 'object') throw new Error('The update manifest is not valid');
  parseVersion(manifest.version);
  const asset = manifest.assets?.[key];
  if (asset) {
    if (!/^Rubban-[0-9A-Za-z.+-]+\.zip$/.test(asset.name || '')) throw new Error('The update manifest names an invalid file');
    if (!/^[0-9a-f]{64}$/.test(asset.sha256 || '')) throw new Error('The update manifest has an invalid checksum');
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_DOWNLOAD) throw new Error('The update manifest has an invalid size');
  }
  return { version: manifest.version.replace(/^v/, ''), asset, notes: String(manifest.notes || '').slice(0, 20000) };
}

function createUpdater({ app, dataDir, log = {}, repo = 'HosHaggag/Rubban', onState = () => {}, fetchImpl = globalThis.fetch, isPackaged = app?.isPackaged, platform = process.platform, arch = process.arch, execPath = process.execPath, spawn = nodeSpawn, env = process.env, getPreferences = async () => ({}), scriptDir = path.join(__dirname, 'update'), tempDir = os.tmpdir() } = {}) {
  const updates = path.join(dataDir, 'updates');
  const statePath = path.join(dataDir, 'update-state.json');
  const resultPath = path.join(updates, 'result.json');
  const current = app.getVersion();
  const disabled = !isPackaged || env.RUBBAN_DISABLE_UPDATES === '1';
  let timers = [];
  let manifestAsset = null;
  let busy = false;
  const state = { status: 'idle', current, latest: '', notes: '', progress: 0, error: '', lastCheck: '', disabled, result: null };
  const emit = patch => { Object.assign(state, patch); try { onState({ ...state }); } catch { /* Listener errors must not break updates. */ } };
  const saved = () => { try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return {}; } };
  const persist = () => { try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(statePath, JSON.stringify({ lastCheck: state.lastCheck, latest: state.latest, notes: state.notes }, null, 2)); } catch { /* Not essential. */ } };
  const key = `${platform}-${arch}`;
  const userAgent = { 'User-Agent': `Rubban/${current}` };

  async function check() {
    if (disabled) return { ...state };
    if (busy || ['downloading', 'installing'].includes(state.status)) return { ...state };
    busy = true;
    emit({ status: 'checking', error: '' });
    try {
      const response = await safeFetch(fetchImpl, `https://github.com/${repo}/releases/latest/download/latest.json`, { headers: userAgent });
      if (!response.ok) throw new Error(`The update server answered ${response.status}`);
      const { version, asset, notes } = validateManifest(await response.json(), key);
      const lastCheck = new Date().toISOString();
      if (compareVersions(current, version) >= 0) { manifestAsset = null; emit({ status: 'up-to-date', latest: version, notes: '', lastCheck }); }
      else if (!asset) { manifestAsset = null; emit({ status: 'error', latest: version, notes, lastCheck, error: `Version ${version} has no download for ${key}` }); }
      else {
        manifestAsset = asset;
        const ready = fs.existsSync(path.join(updates, asset.name));
        emit({ status: ready ? 'ready' : 'available', latest: version, notes, lastCheck, progress: ready ? 1 : 0 });
      }
      persist();
    } catch (error) { log.warn?.(`Update check failed: ${error.message}`); emit({ status: 'error', error: error.message, lastCheck: new Date().toISOString() }); }
    finally { busy = false; }
    return { ...state };
  }

  async function download() {
    if (disabled) throw new Error('Updates are disabled in this build');
    if (state.status !== 'available' || !manifestAsset) throw new Error('There is no update to download');
    const asset = manifestAsset; const version = state.latest;
    fs.mkdirSync(updates, { recursive: true });
    const partial = path.join(updates, `${asset.name}.part`);
    const final = path.join(updates, asset.name);
    emit({ status: 'downloading', progress: 0, error: '' });
    const cleanup = () => fs.rmSync(partial, { force: true });
    try {
      const response = await safeFetch(fetchImpl, `https://github.com/${repo}/releases/download/v${version}/${asset.name}`, { headers: userAgent });
      if (!response.ok || !response.body) throw new Error(`The download failed (${response.status})`);
      const hash = crypto.createHash('sha256');
      const out = fs.openSync(partial, 'w', 0o600);
      let received = 0;
      try {
        for await (const chunk of response.body) {
          const buffer = Buffer.from(chunk);
          received += buffer.length;
          if (received > MAX_DOWNLOAD || received > asset.size + 1024) throw new Error('The download is larger than expected');
          hash.update(buffer); fs.writeSync(out, buffer);
          emit({ progress: Math.min(received / asset.size, 0.99) });
        }
      } finally { fs.closeSync(out); }
      if (received !== asset.size) throw new Error('The download is incomplete');
      if (hash.digest('hex') !== asset.sha256) throw new Error('The downloaded update failed its checksum and was discarded');
      fs.renameSync(partial, final);
      for (const name of fs.readdirSync(updates)) if (name !== asset.name && name !== 'result.json') fs.rmSync(path.join(updates, name), { recursive: true, force: true });
      emit({ status: 'ready', progress: 1 });
    } catch (error) { cleanup(); log.warn?.(`Update download failed: ${error.message}`); emit({ status: 'error', error: error.message, progress: 0 }); }
    return { ...state };
  }

  function install() {
    if (disabled) throw new Error('Updates are disabled in this build');
    if (state.status !== 'ready' || !manifestAsset) throw new Error('The update has not been downloaded yet');
    if (/^\/Volumes\//.test(execPath) || execPath.startsWith(tempDir + path.sep)) throw new Error('Rubban is running from a mounted disk or a temporary folder. Install it first, then update.');
    const zip = path.join(updates, manifestAsset.name);
    if (!fs.existsSync(zip)) throw new Error('The downloaded update is missing; download it again');
    const windows = platform === 'win32';
    const script = path.join(updates, windows ? 'apply-update.ps1' : 'apply-update.sh');
    fs.copyFileSync(path.join(scriptDir, windows ? 'apply-update.ps1' : 'apply-update.sh'), script);
    if (!windows) fs.chmodSync(script, 0o755);
    const args = windows
      ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, '-Zip', zip, '-Install', path.dirname(execPath), '-ProcessId', String(process.pid), '-Exe', execPath, '-ResultFile', resultPath, '-Version', state.latest]
      : [script, zip, path.resolve(execPath, '../../..'), String(process.pid), resultPath, state.latest];
    const command = windows ? path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/bin/bash';
    emit({ status: 'installing' });
    log.info?.(`Installing update ${state.latest}`);
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref?.();
    app.quit();
    return { ...state };
  }

  // The helper script leaves result.json behind; report it once on the next start.
  function consumeResult() {
    try {
      const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
      fs.rmSync(resultPath, { force: true });
      log[result.ok ? 'info' : 'error']?.(`Update ${result.ok ? 'installed' : 'failed'}: ${result.version || ''} ${result.error || ''}`.trim());
      emit({ result: { ok: Boolean(result.ok), version: String(result.version || ''), error: String(result.error || ''), installedTo: String(result.installedTo || '') } });
    } catch { /* No update ran. */ }
  }

  function start() {
    const previous = saved();
    emit({ lastCheck: previous.lastCheck || '' });
    consumeResult();
    if (disabled) return;
    const run = async () => { const preferences = await getPreferences().catch(() => ({})); if (preferences.updates?.auto !== false) await check(); };
    timers.push(setTimeout(run, CHECK_DELAY_MS), setInterval(run, CHECK_INTERVAL_MS));
    for (const timer of timers) timer.unref?.();
  }
  const stop = () => { for (const timer of timers) { clearTimeout(timer); clearInterval(timer); } timers = []; };
  return { check, download, install, start, stop, getState: () => ({ ...state }), dismissResult: () => emit({ result: null }) };
}

module.exports = { createUpdater, compareVersions, parseVersion, validateManifest, allowedUrl, safeFetch, MAX_DOWNLOAD };
