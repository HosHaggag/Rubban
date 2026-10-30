'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { zipDirectory, crc32 } = require('./zip-writer.cjs');

// Reads every entry back from the central directory, as an unzip tool would.
function readZip(file) {
  const buffer = fs.readFileSync(file);
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(at), 0x02014b50);
    const method = buffer.readUInt16LE(at + 10); const crc = buffer.readUInt32LE(at + 16);
    const size = buffer.readUInt32LE(at + 20); const nameLength = buffer.readUInt16LE(at + 28);
    const mode = buffer.readUInt32LE(at + 38) >>> 16; const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(dataStart, dataStart + size);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    assert.equal(crc32(data), crc, `CRC of ${name}`);
    out[name] = { mode, data: data.toString('utf8') };
    at += 46 + nameLength + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
  }
  return out;
}

test('release zips round-trip nested files, empty files and Unicode names on every platform', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rubban-zip-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const folder = path.join(temp, 'Rubban');
  fs.mkdirSync(path.join(folder, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'resources', 'رُبّان.txt'), 'Rubban رُبّان '.repeat(500));
  fs.writeFileSync(path.join(folder, 'empty'), '');
  const zip = path.join(temp, 'release.zip');
  const result = zipDirectory(folder, zip);
  const entries = readZip(zip);
  assert.equal(result.entries, 4);
  assert.equal(entries['Rubban/resources/رُبّان.txt'].data, 'Rubban رُبّان '.repeat(500));
  assert.equal(entries['Rubban/empty'].data, '');
  assert.equal(entries['Rubban/resources/'].mode & 0o170000, 0o040000);
});

test('release zips keep folders, permissions, symlinks and contents without a zip command', { skip: process.platform === 'win32' }, t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rubban-zip-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const app = path.join(temp, 'Rubban-1.0.0-macOS-arm64');
  fs.mkdirSync(path.join(app, 'Rubban.app', 'Contents', 'Frameworks', 'X.framework', 'Versions', 'A'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Install-Rubban.command'), '#!/bin/bash\necho hi\n'); fs.chmodSync(path.join(app, 'Install-Rubban.command'), 0o755);
  fs.writeFileSync(path.join(app, 'README.md'), 'رُبّان '.repeat(500)); fs.chmodSync(path.join(app, 'README.md'), 0o644);
  fs.writeFileSync(path.join(app, 'Rubban.app', 'Contents', 'Frameworks', 'X.framework', 'Versions', 'A', 'X'), Buffer.alloc(0));
  fs.symlinkSync('Versions/A/X', path.join(app, 'Rubban.app', 'Contents', 'Frameworks', 'X.framework', 'X'));
  const zip = path.join(temp, 'out.zip');
  const result = zipDirectory(app, zip);
  const entries = readZip(zip);
  assert.equal(result.entries, Object.keys(entries).length);
  const root = 'Rubban-1.0.0-macOS-arm64';
  assert.equal(entries[`${root}/Install-Rubban.command`].mode, 0o100755);
  assert.equal(entries[`${root}/README.md`].mode, 0o100644);
  assert.equal(entries[`${root}/README.md`].data, 'رُبّان '.repeat(500));
  assert.equal(entries[`${root}/Rubban.app/Contents/Frameworks/X.framework/X`].mode, 0o120777);
  assert.equal(entries[`${root}/Rubban.app/Contents/Frameworks/X.framework/X`].data, 'Versions/A/X');
  assert.equal(entries[`${root}/Rubban.app/`].mode & 0o170000, 0o040000);
});
