'use strict';
// Fails unless the release tag matches package.json and CHANGELOG.md has a section for it.
const fs = require('node:fs');
const path = require('node:path');
const { releaseNotes } = require('./release-notes.cjs');

function check({ tag, version, changelog }) {
  const wanted = String(tag || '').replace(/^v/, '');
  if (!wanted) throw new Error('No tag given (GITHUB_REF_NAME is empty)');
  if (wanted !== version) throw new Error(`Tag ${tag} does not match package.json version ${version}`);
  releaseNotes(changelog, version);
  return version;
}
if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  try {
    const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    console.log(`Release ${check({ tag: process.env.GITHUB_REF_NAME, version, changelog: fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8') })} is consistent`);
  } catch (error) { console.error(error.message); process.exit(1); }
}
module.exports = { check };
