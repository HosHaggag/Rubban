'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLogger } = require('./log.cjs');

test('logger writes JSON lines and rotates by size keeping a fixed number of files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubban-log-'));
  try {
    const log = createLogger(dir);
    log.info('hello', { port: 1 });
    log.error(new Error('boom'));
    const [first, second] = fs.readFileSync(log.file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual([first.level, first.message, first.port], ['info', 'hello', 1]);
    assert.deepEqual([second.level, second.message], ['error', 'boom']);
    const small = createLogger(dir, { maxBytes: 300, keep: 2 });
    for (let index = 0; index < 20; index++) small.warn('x'.repeat(100));
    const files = fs.readdirSync(dir).sort();
    assert.deepEqual(files, ['rubban.log', 'rubban.log.1', 'rubban.log.2']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
