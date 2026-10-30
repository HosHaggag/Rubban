'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const target = path.resolve(process.argv[2] || path.join(root, 'build', 'stage'));
if (target === root || root.startsWith(target + path.sep)) throw new Error('Stage must not replace the source tree.');
fs.mkdirSync(target, { recursive: true });
const skip = new Set(['node_modules', 'data', 'dist', 'build', 'release', '.git', 'PLAN.md', 'eslint.config.js']);
for (const name of fs.readdirSync(root)) {
  if (skip.has(name) || name.startsWith('.')) continue;
  fs.cpSync(path.join(root, name), path.join(target, name), { recursive: true, filter: source => !/\.test\.(cjs|mjs)$/.test(source) });
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
delete manifest.devDependencies;
fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Production source staged: ${target}`);
