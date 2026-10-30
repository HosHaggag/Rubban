'use strict';
// Prints the CHANGELOG.md section for a version: node scripts/release-notes.cjs 0.11.0 > notes.md
const fs = require('node:fs');
const path = require('node:path');

function releaseNotes(changelog, version) {
  const lines = String(changelog).split(/\r?\n/);
  const start = lines.findIndex(line => line.startsWith('## ') && line.slice(3).trim().split(/[\s:]/)[0] === version);
  if (start < 0) throw new Error(`CHANGELOG.md has no section for ${version}`);
  let end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).join('\n').trim();
  if (!body) throw new Error(`The CHANGELOG.md section for ${version} is empty`);
  return body;
}
if (require.main === module) {
  try { process.stdout.write(releaseNotes(fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8'), process.argv[2]) + '\n'); }
  catch (error) { console.error(error.message); process.exit(1); }
}
module.exports = { releaseNotes };
