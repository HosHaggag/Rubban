'use strict';
// Bumps the version, checks the changelog, commits and tags: node scripts/release.cjs <major|minor|patch|x.y.z>
// Push afterwards with: git push origin main --tags
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { releaseNotes } = require('./release-notes.cjs');

const root = path.resolve(__dirname, '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
function bump(version, kind) {
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind;
  const [major, minor, patch] = version.split('.').map(Number);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error('Usage: node scripts/release.cjs <major|minor|patch|x.y.z>');
}
if (require.main === module) {
  try {
    if (git('status', '--porcelain')) throw new Error('The working tree is not clean. Commit or stash first.');
    const file = path.join(root, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const next = bump(manifest.version, process.argv[2]);
    releaseNotes(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), next);
    if (next !== manifest.version) {
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/("version":\s*")[^"]+(")/, `$1${next}$2`));
      execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--package-lock-only', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
    }
    git('add', 'package.json', 'package-lock.json');
    if (git('status', '--porcelain')) git('commit', '-m', `Release ${next}`);
    git('tag', `v${next}`);
    console.log(`Tagged v${next}. Push with: git push origin main --tags`);
  } catch (error) { console.error(error.message); process.exit(1); }
}
module.exports = { bump };
