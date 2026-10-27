'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const flags = Object.fromEntries(process.argv.slice(2).map(arg => { const i = arg.indexOf('='); return [arg.slice(0, i).replace(/^--/, ''), arg.slice(i + 1)]; }));
if (!flags.dir) throw new Error('Use --dir=<packaged application directory>, plus explicit --kubectl, --helm, --node, and --licenses paths.');
const root = path.resolve(flags.dir);
if (!fs.existsSync(path.join(root, 'Rubban.exe'))) throw new Error('Choose a Rubban package containing Rubban.exe.');
const resources = path.join(root, 'resources', 'app');
const tools = path.join(resources, 'tools');
const runtime = path.join(root, 'runtime');
fs.mkdirSync(tools, { recursive: true }); fs.mkdirSync(runtime, { recursive: true });
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const records = [];
for (const [key, filename, version, origin, licenseName] of [
  ['kubectl', 'kubectl.exe', flags['kubectl-version'] || 'caller-supplied', 'Caller-supplied standalone Kubernetes CLI', 'kubectl-LICENSE.txt'],
  ['helm', 'helm.exe', flags['helm-version'] || 'caller-supplied', 'Caller-supplied standalone Helm CLI', 'helm-LICENSE.txt'],
]) {
  if (!flags[key]) continue;
  const input = path.resolve(flags[key]); fs.copyFileSync(input, path.join(tools, filename));
  if (!flags.licenses || !fs.existsSync(path.join(flags.licenses, licenseName))) throw new Error(`Supply ${licenseName} in --licenses directory.`);
  fs.copyFileSync(path.join(flags.licenses, licenseName), path.join(tools, licenseName));
  records.push({ name: key, filename, version, origin, sha256: hash(input), license: 'Apache-2.0' });
}
fs.writeFileSync(path.join(tools, 'tool-provenance.json'), JSON.stringify(records, null, 2) + '\n');
if (flags.node) {
  fs.copyFileSync(path.resolve(flags.node), path.join(runtime, 'node.exe'));
  if (!flags.licenses || !fs.existsSync(path.join(flags.licenses, 'node-LICENSE.txt'))) throw new Error('Supply complete Node license in --licenses directory.');
  fs.copyFileSync(path.join(flags.licenses, 'node-LICENSE.txt'), path.join(runtime, 'LICENSE.txt'));
  fs.writeFileSync(path.join(runtime, 'provenance.json'), JSON.stringify({ name: 'Node.js', version: flags['node-version'] || 'caller-supplied', sha256: hash(flags.node), license: 'MIT plus included component notices in LICENSE.txt', upstream: 'https://nodejs.org/' }, null, 2) + '\n');
  for (const [filename, script] of [['Start-Team-Hub.cmd', 'team-hub.cjs'], ['Start-Cluster-Agent.cmd', 'agent.cjs'], ['Rubban-MCP.cmd', 'mcp.cjs']]) {
    const lines = ['@echo off', 'setlocal', 'if not defined RUBBAN_DATA_DIR set "RUBBAN_DATA_DIR=%~dp0..\\Rubban-Data\\services"', 'if not defined RUBBAN_KUBECTL set "RUBBAN_KUBECTL=%~dp0resources\\app\\tools\\kubectl.exe"', `"%~dp0runtime\\node.exe" "%~dp0resources\\app\\services\\${script}" %*`, 'exit /b %errorlevel%', ''];
    fs.writeFileSync(path.join(root, filename), lines.join('\r\n'));
  }
}
for (const name of ['README.md', 'FEATURE-PARITY.md', 'THIRD-PARTY-NOTICES.md']) {
  let content = fs.readFileSync(path.join(resources, name), 'utf8');
  if (name === 'README.md') content = content.replace('](services/README.md)', '](resources/app/services/README.md)');
  fs.writeFileSync(path.join(root, name), content);
}
console.log(JSON.stringify({ runtimeAssembled: root, tools: records.map(x => x.name), node: !!flags.node }));
