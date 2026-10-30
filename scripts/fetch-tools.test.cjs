'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { urlsFor, verify, fetchTools } = require('./fetch-tools.cjs');

const versions = { kubectl: 'v1.2.3', helm: 'v3.4.5' };
const hash = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

test('download URLs follow the official layouts', () => {
  const win = urlsFor('win32', 'x64', versions);
  assert.equal(win.kubectl.url, 'https://dl.k8s.io/release/v1.2.3/bin/windows/amd64/kubectl.exe');
  assert.equal(win.helm.url, 'https://get.helm.sh/helm-v3.4.5-windows-amd64.zip');
  assert.equal(win.helm.checksum, 'https://get.helm.sh/helm-v3.4.5-windows-amd64.zip.sha256sum');
  const mac = urlsFor('darwin', 'arm64', versions);
  assert.equal(mac.kubectl.checksum, 'https://dl.k8s.io/release/v1.2.3/bin/darwin/arm64/kubectl.sha256');
  assert.equal(mac.helm.inner, 'darwin-arm64/helm');
  assert.throws(() => urlsFor('plan9', 'x64', versions), /Unsupported/);
});

test('checksum files in both formats verify, and mismatches throw', () => {
  const data = Buffer.from('binary');
  assert.equal(verify(data, hash(data), 'x'), hash(data));
  assert.equal(verify(data, `${hash(data)}  helm.zip\n`, 'x'), hash(data));
  assert.throws(() => verify(data, hash(Buffer.from('other')), 'kubectl'), /checksum mismatch/);
  assert.throws(() => verify(data, 'not a hash', 'kubectl'), /not a SHA-256/);
});

test('fetchTools writes verified binaries and refuses tampered downloads', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubban-fetch-'));
  try {
    const kubectl = Buffer.from('kubectl-bytes'); const archive = Buffer.from('helm-archive'); const helm = Buffer.from('helm-bytes');
    const make = tamper => async url => {
      const body = url.endsWith('/kubectl.exe') ? (tamper ? Buffer.from('evil') : kubectl) : url.endsWith('kubectl.exe.sha256') ? Buffer.from(hash(kubectl)) : url.endsWith('.zip') ? archive : url.endsWith('.sha256sum') ? Buffer.from(`${hash(archive)}  helm.zip`) : null;
      return body ? { ok: true, status: 200, arrayBuffer: async () => body } : { ok: false, status: 404 };
    };
    const extract = () => helm;
    const result = await fetchTools({ platform: 'win32', arch: 'x64', outDir: dir, versions, fetchImpl: make(false), extract });
    assert.equal(fs.readFileSync(result.kubectl, 'utf8'), 'kubectl-bytes');
    assert.equal(fs.readFileSync(result.helm, 'utf8'), 'helm-bytes');
    await assert.rejects(fetchTools({ platform: 'win32', arch: 'x64', outDir: dir, versions, fetchImpl: make(true), extract }), /checksum mismatch/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
