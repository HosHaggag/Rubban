'use strict';
// A small ZIP writer so release builds do not depend on an external `zip` command (it is often
// missing on WSL and Windows). It deflates files, keeps Unix permissions and keeps symlinks as
// links, which macOS app bundles (Electron frameworks) need. Limits: 65,534 entries, 4 GB.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const crc32 = typeof zlib.crc32 === 'function' ? zlib.crc32 : (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return (buffer, value = 0) => { let crc = ~value >>> 0; for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8); return ~crc >>> 0; };
})();

function dosTime(date) {
  const d = date.getFullYear() < 1980 ? new Date(1980, 0, 1) : date;
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

// Entries for `folder` (and everything inside it) named `<basename>/...`, in a stable order.
function entries(folder) {
  const out = [];
  const visit = (absolute, name) => {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) out.push({ name, kind: 'link', target: fs.readlinkSync(absolute), mode: 0o120777, mtime: stat.mtime });
    else if (stat.isDirectory()) {
      out.push({ name: `${name}/`, kind: 'dir', mode: 0o040000 | (stat.mode & 0o777 || 0o755), mtime: stat.mtime });
      for (const child of fs.readdirSync(absolute).sort()) visit(path.join(absolute, child), `${name}/${child}`);
    } else if (stat.isFile()) out.push({ name, kind: 'file', absolute, mode: 0o100000 | (stat.mode & 0o777 || 0o644), mtime: stat.mtime });
  };
  visit(path.resolve(folder), path.basename(path.resolve(folder)));
  return out;
}

function zipDirectory(folder, zipFile, { level = 6 } = {}) {
  const list = entries(folder);
  if (list.length >= 0xffff) throw new Error(`Too many files for a ZIP without ZIP64: ${list.length}`);
  const fd = fs.openSync(zipFile, 'w');
  const central = [];
  let offset = 0;
  const write = buffer => { fs.writeSync(fd, buffer); offset += buffer.length; };
  try {
    for (const entry of list) {
      const data = entry.kind === 'file' ? fs.readFileSync(entry.absolute) : entry.kind === 'link' ? Buffer.from(entry.target, 'utf8') : Buffer.alloc(0);
      let method = 0; let body = data;
      if (entry.kind === 'file' && data.length) {
        const deflated = zlib.deflateRawSync(data, { level });
        if (deflated.length < data.length) { method = 8; body = deflated; }
      }
      const crc = crc32(data);
      if (offset > 0xfffffffe || data.length > 0xfffffffe || body.length > 0xfffffffe) throw new Error('Archive larger than 4 GB needs ZIP64');
      const name = Buffer.from(entry.name, 'utf8');
      const { time, date } = dosTime(entry.mtime);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
      const headerOffset = offset;
      write(local); write(name); write(body);
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE((3 << 8) | 20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x0800, 8);
      record.writeUInt16LE(method, 10); record.writeUInt16LE(time, 12); record.writeUInt16LE(date, 14); record.writeUInt32LE(crc, 16);
      record.writeUInt32LE(body.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(name.length, 28);
      record.writeUInt16LE(0, 30); record.writeUInt16LE(0, 32); record.writeUInt16LE(0, 34); record.writeUInt16LE(0, 36);
      // Unix mode in the high 16 bits; MS-DOS directory flag for directories.
      record.writeUInt32LE(((entry.mode << 16) | (entry.kind === 'dir' ? 0x10 : 0)) >>> 0, 38);
      record.writeUInt32LE(headerOffset, 42);
      central.push(Buffer.concat([record, name]));
    }
    const start = offset;
    for (const record of central) write(record);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
    end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - start, 12); end.writeUInt32LE(start, 16); end.writeUInt16LE(0, 20);
    write(end);
  } finally { fs.closeSync(fd); }
  return { entries: list.length, bytes: offset };
}

module.exports = { zipDirectory, crc32 };
