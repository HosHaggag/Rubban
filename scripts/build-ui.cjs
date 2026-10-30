'use strict';
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
// These are the published browser bundles, retained with their MIT notices.
// Loading them as side-effect ES modules uses their globalThis UMD branch.
for (const [source, target] of [
  ['@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
  ['@xterm/xterm/LICENSE', 'LICENSE-xterm.txt'],
  ['@xterm/addon-fit/LICENSE', 'LICENSE-xterm-fit.txt'],
]) fs.copyFileSync(path.join(root, 'node_modules', source), path.join(root, 'ui', target));
fs.writeFileSync(path.join(root, 'ui', 'vendor.js'), "import './xterm.js';\nimport './addon-fit.js';\nexport const Terminal = globalThis.Terminal;\nexport const FitAddon = globalThis.FitAddon.FitAddon;\n");
console.log('Prepared published terminal browser bundles.');
