'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createUpdater, compareVersions, allowedUrl, validateManifest } = require('./updater.cjs');
const { zipDirectory } = require('../scripts/zip-writer.cjs');

const temp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const KEY = `${process.platform}-${process.arch}`;

function setup({ version = '0.10.0', latest = '0.11.0', payload = Buffer.from('zip-bytes'), tamper = false, packaged = true } = {}) {
  const dataDir = temp('rubban-up-');
  const name = `Rubban-${latest}-Windows-x64.zip`;
  const manifest = { version: latest, notes: '- better', assets: { [KEY]: { name, sha256: sha(payload), size: payload.length } } };
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/latest.json')) return { ok: true, status: 200, headers: new Map(), json: async () => manifest };
    const body = tamper ? Buffer.from('X'.repeat(payload.length)) : payload;
    return { ok: true, status: 200, headers: new Map(), body: (async function* () { yield body.subarray(0, 3); yield body.subarray(3); })() };
  };
  const states = []; let quit = 0; const spawned = [];
  const updater = createUpdater({ app: { getVersion: () => version, isPackaged: packaged, quit: () => { quit++; } }, dataDir, fetchImpl, onState: state => states.push(state.status), isPackaged: packaged, execPath: path.join(dataDir, 'Rubban', 'Rubban.exe'), env: {}, spawn: (command, args) => { spawned.push({ command, args }); return { unref() {} }; }, scriptDir: path.join(__dirname, 'update'), tempDir: path.join(os.tmpdir(), 'not-the-data-dir') });
  return { updater, dataDir, name, requests, states, spawned, quitCount: () => quit, cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

test('versions compare like semver, with pre-releases before releases', () => {
  assert.equal(compareVersions('0.10.7', '0.11.0'), -1);
  assert.equal(compareVersions('0.11.0', '0.11.0'), 0);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0-rc.2', '1.0.0-rc.10'), -1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
  assert.throws(() => compareVersions('nope', '1.0.0'), /Invalid version/);
});

test('only GitHub release hosts over https are allowed', () => {
  assert.equal(allowedUrl('https://github.com/a/b/releases/download/v1/x.zip'), true);
  assert.equal(allowedUrl('https://objects.githubusercontent.com/x'), true);
  assert.equal(allowedUrl('http://github.com/x'), false);
  assert.equal(allowedUrl('https://evil.example/x'), false);
  assert.equal(allowedUrl('https://user:pw@github.com/x'), false);
  assert.throws(() => validateManifest({ version: '1.0.0', assets: { [KEY]: { name: '../x.zip', sha256: 'a'.repeat(64), size: 1 } } }, KEY), /invalid file/);
});

test('a newer manifest makes an update available and the same version is up to date', async () => {
  const newer = setup();
  try {
    assert.equal((await newer.updater.check()).status, 'available');
    assert.equal(newer.updater.getState().latest, '0.11.0');
    assert.match(newer.requests[0].url, /^https:\/\/github\.com\/HosHaggag\/Rubban\/releases\/latest\/download\/latest\.json$/);
    assert.match(newer.requests[0].options.headers['User-Agent'], /^Rubban\//);
  } finally { newer.cleanup(); }
  const same = setup({ version: '0.11.0' });
  try { assert.equal((await same.updater.check()).status, 'up-to-date'); } finally { same.cleanup(); }
});

test('download verifies the checksum, keeps the file when good and removes the partial file when not', async () => {
  const good = setup();
  try {
    await good.updater.check();
    assert.equal((await good.updater.download()).status, 'ready');
    assert.equal(fs.readFileSync(path.join(good.dataDir, 'updates', good.name), 'utf8'), 'zip-bytes');
    assert.equal(fs.existsSync(path.join(good.dataDir, 'updates', `${good.name}.part`)), false);
    assert.match(good.requests[1].url, /\/releases\/download\/v0\.11\.0\/Rubban-0\.11\.0-Windows-x64\.zip$/);
  } finally { good.cleanup(); }
  const bad = setup({ tamper: true });
  try {
    await bad.updater.check();
    const result = await bad.updater.download();
    assert.equal(result.status, 'error');
    assert.match(result.error, /checksum/);
    assert.deepEqual(fs.readdirSync(path.join(bad.dataDir, 'updates')), []);
  } finally { bad.cleanup(); }
});

test('install hands over to a detached helper and quits; it refuses source runs and unready updates', async () => {
  const source = setup({ packaged: false });
  try {
    assert.equal((await source.updater.check()).disabled, true);
    assert.throws(() => source.updater.install(), /disabled/);
  } finally { source.cleanup(); }
  const ready = setup();
  try {
    assert.throws(() => ready.updater.install(), /not been downloaded/);
    await ready.updater.check(); await ready.updater.download();
    ready.updater.install();
    assert.equal(ready.quitCount(), 1);
    assert.equal(ready.spawned.length, 1);
    assert.ok(ready.spawned[0].args.includes(path.join(ready.dataDir, 'updates', ready.name)) || ready.spawned[0].args.some(arg => arg.endsWith(ready.name)));
    assert.equal(ready.updater.getState().status, 'installing');
  } finally { ready.cleanup(); }
});

test('a result left by the helper is reported once on the next start', () => {
  const h = setup();
  try {
    fs.mkdirSync(path.join(h.dataDir, 'updates'));
    fs.writeFileSync(path.join(h.dataDir, 'updates', 'result.json'), JSON.stringify({ ok: true, version: '0.11.0' }));
    h.updater.start(); h.updater.stop();
    assert.deepEqual(h.updater.getState().result, { ok: true, version: '0.11.0', error: '', installedTo: '' });
    assert.equal(fs.existsSync(path.join(h.dataDir, 'updates', 'result.json')), false);
  } finally { h.cleanup(); }
});

// ---- Helper scripts ---------------------------------------------------------------------------------
const fakeBuild = (root, label) => { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, 'marker.txt'), label); };

test('apply-update.sh replaces the app bundle and writes result.json', { skip: process.platform === 'win32' }, () => {
  const work = temp('rubban-sh-'); const home = temp('rubban-home-');
  try {
    const bundle = path.join(work, 'apps', 'Rubban.app'); fakeBuild(bundle, 'old');
    const content = path.join(work, 'zipsrc', 'Rubban-0.11.0-macOS-arm64', 'Rubban.app'); fakeBuild(content, 'new');
    const updates = path.join(work, 'updates'); fs.mkdirSync(updates);
    const zip = path.join(updates, 'Rubban-0.11.0-macOS-arm64.zip'); zipDirectory(path.join(work, 'zipsrc'), zip);
    const result = path.join(updates, 'result.json');
    const run = spawnSync('bash', [path.join(__dirname, 'update', 'apply-update.sh'), zip, bundle, '999999', result, '0.11.0'], { env: { ...process.env, HOME: home, RUBBAN_NO_START: '1' }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(fs.readFileSync(path.join(bundle, 'marker.txt'), 'utf8'), 'new');
    assert.equal(fs.existsSync(`${bundle}.old`), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(result, 'utf8')), { ok: true, version: '0.11.0', error: '', installedTo: bundle });
    // A zip without the app leaves the old version and reports the error.
    fs.writeFileSync(zip, 'not a zip');
    const failed = spawnSync('bash', [path.join(__dirname, 'update', 'apply-update.sh'), zip, bundle, '999999', result, '0.11.1'], { env: { ...process.env, HOME: home, RUBBAN_NO_START: '1' }, encoding: 'utf8' });
    assert.equal(failed.status, 0);
    const report = JSON.parse(fs.readFileSync(result, 'utf8'));
    assert.equal(report.ok, false);
    assert.equal(fs.readFileSync(path.join(bundle, 'marker.txt'), 'utf8'), 'new');
  } finally { fs.rmSync(work, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
});

// The real installer also writes Start menu shortcuts, so the test zip carries a stub installer with the same parameters.
test('apply-update.ps1 replaces the install folder, restores it when the installer fails and writes result.json', { skip: process.platform !== 'win32' }, () => {
  const work = temp('rubban-ps-');
  const stub = fail => `param([string]$Source, [string]$Destination, [switch]$NoStart)\n${fail ? "throw 'installer failed'" : "Remove-Item (Join-Path $Destination '*') -Recurse -Force; Get-ChildItem $Source | Where-Object { $_.Name -ne 'Install-Rubban.ps1' } | Copy-Item -Destination $Destination -Recurse -Force"}\n`;
  const attempt = (label, fail) => {
    const install = path.join(work, label, 'Rubban-Windows'); fakeBuild(install, 'old'); fs.writeFileSync(path.join(install, 'Rubban.exe'), 'exe-old');
    const src = path.join(work, label, 'zipsrc', 'Rubban-0.11.0-Windows-x64'); fakeBuild(src, 'new'); fs.writeFileSync(path.join(src, 'Rubban.exe'), 'exe-new'); fs.writeFileSync(path.join(src, 'Install-Rubban.ps1'), stub(fail));
    const updates = path.join(work, label, 'updates'); fs.mkdirSync(updates);
    const zip = path.join(updates, 'Rubban-0.11.0-Windows-x64.zip'); zipDirectory(path.join(work, label, 'zipsrc'), zip);
    const result = path.join(updates, 'result.json');
    const run = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'update', 'apply-update.ps1'), '-Zip', zip, '-Install', install, '-ProcessId', '999999', '-Exe', path.join(install, 'Rubban.exe'), '-ResultFile', result, '-Version', '0.11.0', '-NoStart'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    return { install, report: JSON.parse(fs.readFileSync(result, 'utf8').replace(/^\ufeff/, '')) };
  };
  try {
    const good = attempt('good', false);
    assert.equal(good.report.ok, true);
    assert.equal(fs.readFileSync(path.join(good.install, 'marker.txt'), 'utf8'), 'new');
    const bad = attempt('bad', true);
    assert.equal(bad.report.ok, false);
    assert.match(bad.report.error, /installer failed/);
    assert.equal(fs.readFileSync(path.join(bad.install, 'marker.txt'), 'utf8'), 'old');
    assert.equal(fs.readFileSync(path.join(bad.install, 'Rubban.exe'), 'utf8'), 'exe-old');
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});
