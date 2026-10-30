'use strict';
// Downloads the official kubectl and helm for a platform, verifies their published SHA-256 and writes
// the executables into <outDir>. Usage: node scripts/fetch-tools.cjs <win32|darwin> <x64|arm64> <outDir>
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const OS = { win32: 'windows', darwin: 'darwin', linux: 'linux' };
const ARCH = { x64: 'amd64', arm64: 'arm64' };

function urlsFor(platform, arch, versions) {
  const os = OS[platform]; const cpu = ARCH[arch];
  if (!os || !cpu) throw new Error(`Unsupported target ${platform}-${arch}`);
  const exe = platform === 'win32' ? '.exe' : '';
  const kubectl = `https://dl.k8s.io/release/${versions.kubectl}/bin/${os}/${cpu}/kubectl${exe}`;
  const helmFile = `helm-${versions.helm}-${os}-${cpu}.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
  const helm = `https://get.helm.sh/${helmFile}`;
  return { kubectl: { url: kubectl, checksum: `${kubectl}.sha256` }, helm: { url: helm, checksum: `${helm}.sha256sum`, file: helmFile, inner: `${os}-${cpu}/helm${exe}` } };
}

const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
// Checksum files are either "<hash>" or "<hash>  <name>".
function verify(buffer, checksumText, label) {
  const expected = String(checksumText).trim().split(/\s+/)[0].toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error(`${label}: the published checksum is not a SHA-256`);
  const actual = sha256(buffer);
  if (actual !== expected) throw new Error(`${label}: checksum mismatch (expected ${expected}, got ${actual})`);
  return actual;
}

async function download(fetchImpl, url) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(15 * 60 * 1000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function fetchTools({ platform, arch, outDir, versions = require('./tool-versions.json'), fetchImpl = fetch, extract = defaultExtract }) {
  const urls = urlsFor(platform, arch, versions);
  fs.mkdirSync(outDir, { recursive: true });
  const exe = platform === 'win32' ? '.exe' : '';
  const kubectl = await download(fetchImpl, urls.kubectl.url);
  verify(kubectl, (await download(fetchImpl, urls.kubectl.checksum)).toString('utf8'), 'kubectl');
  const kubectlPath = path.join(outDir, `kubectl${exe}`);
  fs.writeFileSync(kubectlPath, kubectl, { mode: 0o755 });
  const archive = await download(fetchImpl, urls.helm.url);
  verify(archive, (await download(fetchImpl, urls.helm.checksum)).toString('utf8'), 'helm');
  const helmPath = path.join(outDir, `helm${exe}`);
  fs.writeFileSync(helmPath, extract(archive, urls.helm), { mode: 0o755 });
  return { kubectl: kubectlPath, helm: helmPath };
}

// Extracts one file from the helm archive with the system tar (bsdtar reads zips on Windows too).
function defaultExtract(archive, { file, inner }) {
  const temporary = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'rubban-helm-'));
  try {
    fs.writeFileSync(path.join(temporary, file), archive);
    execFileSync('tar', ['-xf', file, inner], { cwd: temporary, stdio: 'inherit' });
    return fs.readFileSync(path.join(temporary, inner));
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

if (require.main === module) {
  const [platform, arch, outDir] = process.argv.slice(2);
  if (!platform || !arch || !outDir) { console.error('Usage: node scripts/fetch-tools.cjs <win32|darwin> <x64|arm64> <outDir>'); process.exit(2); }
  fetchTools({ platform, arch, outDir: path.resolve(outDir) }).then(result => console.log(JSON.stringify(result)), error => { console.error(error.message); process.exit(1); });
}
module.exports = { urlsFor, verify, fetchTools };
