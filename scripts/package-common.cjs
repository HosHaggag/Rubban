'use strict';
// Shared steps for the Windows and macOS release builds: a production stage of the source with
// only the runtime dependencies and the terminal's native module for the target platform.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { zipDirectory } = require('./zip-writer.cjs');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const RUNTIME_MODULES = ['ws', 'yaml', '@xterm/xterm', '@xterm/addon-fit', '@lydell/node-pty'];
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });
const which = name => { try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/)[0].trim() || null; } catch { return null; } };
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function stage(platform, arch) {
  const target = path.join(root, 'build', `stage-${platform}-${arch}`);
  fs.rmSync(target, { recursive: true, force: true });
  run(process.execPath, [path.join(root, 'scripts', 'prepare-stage.cjs'), target]);
  for (const name of RUNTIME_MODULES) fs.cpSync(path.join(root, 'node_modules', name), path.join(target, 'node_modules', name), { recursive: true });
  // The terminal's native module for the target: from node_modules when this machine already has
  // it (building for its own platform), otherwise from the npm registry.
  const binary = `@lydell/node-pty-${platform}-${arch}`;
  const destination = path.join(target, 'node_modules', binary);
  const local = path.join(root, 'node_modules', binary);
  if (fs.existsSync(path.join(local, 'package.json'))) fs.cpSync(local, destination, { recursive: true });
  else {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rubban-pty-'));
    const file = execFileSync('npm', ['pack', `${binary}@${manifest.dependencies['@lydell/node-pty']}`, '--silent', '--pack-destination', temp], { encoding: 'utf8', shell: process.platform === 'win32' }).trim().split(/\r?\n/).pop();
    fs.mkdirSync(destination, { recursive: true });
    run('tar', ['-xzf', path.join(temp, file), '-C', destination, '--strip-components=1']);
    fs.rmSync(temp, { recursive: true, force: true });
  }
  for (const executable of ['spawn-helper', 'pty.node']) { const file = path.join(destination, executable); if (fs.existsSync(file)) fs.chmodSync(file, 0o755); }
  return target;
}

// Optional bundled CLIs (tools/kubectl[.exe], tools/helm[.exe]) with their checksums.
function bundleTools(appRoot, platform) {
  const records = [];
  const suffix = platform === 'win32' ? '.exe' : '';
  for (const [name, variable] of [['kubectl', 'RUBBAN_BUNDLE_KUBECTL'], ['helm', 'RUBBAN_BUNDLE_HELM']]) {
    const input = process.env[variable];
    if (!input) continue;
    const tools = path.join(appRoot, 'tools');
    fs.mkdirSync(tools, { recursive: true });
    fs.copyFileSync(input, path.join(tools, `${name}${suffix}`));
    if (!suffix) fs.chmodSync(path.join(tools, name), 0o755);
    records.push({ name, filename: `${name}${suffix}`, sha256: sha256(input), source: path.basename(input), license: 'Apache-2.0' });
  }
  if (records.length) fs.writeFileSync(path.join(appRoot, 'tools', 'tool-provenance.json'), JSON.stringify(records, null, 2) + '\n');
  return records.map(record => record.name);
}

// macOS uses its own ditto; everywhere else the built-in writer, so no `zip` command is needed.
function zipFolder(folder, zipFile) {
  fs.rmSync(zipFile, { force: true });
  if (process.platform === 'darwin') run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', folder, zipFile]);
  else zipDirectory(folder, zipFile);
}

const ignore = [/^\/data(?:\/|$)/, /^\/dist(?:\/|$)/, /^\/build(?:\/|$)/, /^\/release(?:\/|$)/, /\.test\.(?:cjs|mjs)$/];

module.exports = { root, manifest, run, which, stage, bundleTools, zipFolder, ignore, sha256 };
