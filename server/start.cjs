'use strict';
require('./env-compat.cjs');
const path = require('node:path');
const fs = require('node:fs');
const { createBackend } = require('./core.cjs');
const { createExtras } = require('./extras.cjs');
const dataDir = process.env.RUBBAN_DATA_DIR || path.join(__dirname, '..', 'data');
const backend = createBackend({ dataDir, extras: createExtras() });
backend.start(Number(process.env.RUBBAN_PORT || 0)).then(connection => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'connection.json'), JSON.stringify({ ...connection, pid: process.pid }, null, 2), { mode: 0o600 });
  console.log(`Rubban web interface: ${connection.url}`);
  console.log(`Local MCP connection file: ${path.join(dataDir, 'connection.json')}`);
}).catch(error => { console.error(error.message); process.exitCode = 1; });
async function stop() {
  await backend.close();
  try { fs.unlinkSync(path.join(dataDir, 'connection.json')); } catch {}
  process.exit();
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
