'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { releaseNotes } = require('./release-notes.cjs');
const { check } = require('./check-version.cjs');
const { buildManifest } = require('./write-manifest.cjs');

const changelog = '# Changelog\n\n## 0.11.0: Big one\n\n- first\n- second\n\n## 0.10.7: Older\n\n- old\n';

test('release notes are the matching changelog section', () => {
  assert.equal(releaseNotes(changelog, '0.11.0'), '- first\n- second');
  assert.equal(releaseNotes(changelog, '0.10.7'), '- old');
  assert.throws(() => releaseNotes(changelog, '0.12.0'), /no section/);
});

test('the tag must match package.json and have a changelog section', () => {
  assert.equal(check({ tag: 'v0.11.0', version: '0.11.0', changelog }), '0.11.0');
  assert.throws(() => check({ tag: 'v0.11.1', version: '0.11.0', changelog }), /does not match/);
  assert.throws(() => check({ tag: 'v0.12.0', version: '0.12.0', changelog }), /no section/);
  assert.throws(() => check({ tag: '', version: '0.11.0', changelog }), /No tag/);
});

test('the manifest lists one asset per platform and checksums for every zip', () => {
  const files = ['Rubban-0.11.0-Windows-x64.zip', 'Rubban-0.11.0-macOS-arm64.zip', 'Rubban-0.11.0-macOS-x64.zip'].map((name, index) => ({ name, sha256: String(index).repeat(64).slice(0, 64), size: 100 + index }));
  const { sums, latest } = buildManifest({ files, version: '0.11.0', notes: 'n' });
  assert.deepEqual(Object.keys(latest.assets).sort(), ['darwin-arm64', 'darwin-x64', 'win32-x64']);
  assert.equal(latest.assets['win32-x64'].name, 'Rubban-0.11.0-Windows-x64.zip');
  assert.equal(sums.trim().split('\n').length, 3);
  assert.throws(() => buildManifest({ files, version: '9.9.9', notes: '' }), /No Rubban-9.9.9/);
});
