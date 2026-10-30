'use strict';
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3;

// JSON-lines logger writing <dir>/rubban.log; rotates to rubban.log.1 … rubban.log.<KEEP> at 5 MB.
function createLogger(dir, { maxBytes = MAX_BYTES, keep = KEEP } = {}) {
  const file = path.join(dir, 'rubban.log');
  let size = 0;
  try { fs.mkdirSync(dir, { recursive: true }); size = fs.statSync(file).size; } catch { /* Logging must never stop the app. */ }
  const rotate = () => {
    try {
      fs.rmSync(`${file}.${keep}`, { force: true });
      for (let index = keep - 1; index >= 1; index--) if (fs.existsSync(`${file}.${index}`)) fs.renameSync(`${file}.${index}`, `${file}.${index + 1}`);
      fs.renameSync(file, `${file}.1`);
    } catch { /* Keep appending to the current file. */ }
    size = 0;
  };
  const write = (level, message, extra) => {
    const detail = message instanceof Error ? { message: message.message, stack: message.stack } : { message: String(message) };
    const line = JSON.stringify({ time: new Date().toISOString(), level, ...detail, ...extra }) + '\n';
    try {
      if (size + line.length > maxBytes) rotate();
      fs.appendFileSync(file, line, { mode: 0o600 });
      size += line.length;
    } catch { /* Ignore disk errors. */ }
  };
  return { file, dir, info: (message, extra) => write('info', message, extra), warn: (message, extra) => write('warn', message, extra), error: (message, extra) => write('error', message, extra) };
}

module.exports = { createLogger };
