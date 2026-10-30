'use strict';
// Writes SHA256SUMS.txt and latest.json for the release zips in a folder.
// Usage: node scripts/write-manifest.cjs <releaseDir>
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { releaseNotes } = require('./release-notes.cjs');

const TARGETS = { 'Windows-x64': 'win32-x64', 'macOS-arm64': 'darwin-arm64', 'macOS-x64': 'darwin-x64' };

function buildManifest({ files, version, notes }) {
  const assets = {};
  const sums = [];
  for (const { name, sha256, size } of files) {
    sums.push(`${sha256}  ${name}`);
    const match = /^Rubban-(.+)-(Windows-x64|macOS-arm64|macOS-x64)\.zip$/.exec(name);
    if (match && match[1] === version) assets[TARGETS[match[2]]] = { name, sha256, size };
  }
  if (!Object.keys(assets).length) throw new Error(`No Rubban-${version}-*.zip files found`);
  return { sums: sums.join('\n') + '\n', latest: { version, assets, notes } };
}
function describe(directory) {
  return fs.readdirSync(directory).filter(name => name.endsWith('.zip')).sort().map(name => {
    const buffer = fs.readFileSync(path.join(directory, name));
    return { name, size: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
  });
}
if (require.main === module) {
  try {
    const directory = path.resolve(process.argv[2] || 'release');
    const root = path.resolve(__dirname, '..');
    const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const notes = releaseNotes(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), version);
    const { sums, latest } = buildManifest({ files: describe(directory), version, notes });
    fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), sums);
    fs.writeFileSync(path.join(directory, 'latest.json'), JSON.stringify(latest, null, 2) + '\n');
    console.log(`Wrote SHA256SUMS.txt and latest.json for ${version}`);
  } catch (error) { console.error(error.message); process.exit(1); }
}
module.exports = { buildManifest };
