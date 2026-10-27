'use strict';
// Builds Rubban.app for macOS and one zip per architecture in release/:
//   npm run package:mac                # Apple silicon (arm64) and Intel (x64)
//   npm run package:mac -- --arch=arm64
// Runs on macOS or on Linux/WSL. Rubban has no Apple Developer ID, so the app is signed ad hoc:
// with codesign on macOS, or with rcodesign (apple-codesign) when it is on PATH elsewhere. Without
// either, Install-Rubban.command signs it ad hoc on the Mac during installation.
// Optional: RUBBAN_BUNDLE_KUBECTL / RUBBAN_BUNDLE_HELM = paths to macOS binaries to bundle.
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { root, manifest, run, which, stage, bundleTools, zipFolder, ignore } = require('./package-common.cjs');

const version = manifest.version;
const archFlag = process.argv.find(arg => arg.startsWith('--arch='));
const archs = (archFlag ? archFlag.slice('--arch='.length) : 'arm64,x64').split(',').map(a => a.trim()).filter(Boolean);
for (const arch of archs) if (!['arm64', 'x64'].includes(arch)) throw new Error(`Unsupported macOS architecture: ${arch}`);
const output = path.resolve(process.env.RUBBAN_RELEASE_DIR || path.join(root, 'release'));

function sign(app) {
  if (process.platform === 'darwin') {
    run('codesign', ['--force', '--deep', '--sign', '-', app]);
    run('codesign', ['--verify', '--deep', '--strict', app]);
    return 'codesign (ad hoc)';
  }
  const rcodesign = which('rcodesign');
  if (!rcodesign) return 'unsigned (Install-Rubban.command signs it on the Mac)';
  run(rcodesign, ['sign', app], { stdio: ['ignore', 'ignore', 'inherit'] });
  // rcodesign's verify does not understand ad hoc signatures (no CMS blob); check that the main
  // executable carries a code directory instead. Install-Rubban.command verifies with codesign.
  const info = execFileSync(rcodesign, ['print-signature-info', path.join(app, 'Contents', 'MacOS', 'Rubban')], { encoding: 'utf8' });
  if (!/code_directory/.test(info)) throw new Error('rcodesign did not produce a code signature');
  return 'rcodesign (ad hoc)';
}

(async () => {
  const { packager } = await import('@electron/packager');
  fs.mkdirSync(output, { recursive: true });
  const results = [];
  for (const arch of archs) {
    const dir = stage('darwin', arch);
    const tools = bundleTools(dir, 'darwin');
    const [location] = await packager({
      dir, name: 'Rubban', executableName: 'Rubban', appBundleId: 'dev.rubban.desktop', appCategoryType: 'public.app-category.developer-tools',
      icon: path.join(root, 'assets', 'rubban.icns'), appVersion: version, buildVersion: version, appCopyright: 'Rubban contributors · MIT licence',
      platform: 'darwin', arch, electronVersion: manifest.devDependencies.electron, out: path.join(root, 'build', 'packaged'), overwrite: true, asar: false, prune: false,
      darwinDarkModeSupport: true, ignore, download: process.env.electron_config_cache ? { cacheRoot: process.env.electron_config_cache } : {},
    });
    const app = path.join(location, 'Rubban.app');
    const signature = sign(app);
    const release = path.join(output, `Rubban-${version}-macOS-${arch}`);
    fs.rmSync(release, { recursive: true, force: true });
    fs.mkdirSync(release, { recursive: true });
    fs.cpSync(app, path.join(release, 'Rubban.app'), { recursive: true, verbatimSymlinks: true });
    fs.copyFileSync(path.join(root, 'scripts', 'Install-Rubban.command'), path.join(release, 'Install-Rubban.command'));
    fs.chmodSync(path.join(release, 'Install-Rubban.command'), 0o755);
    fs.copyFileSync(path.join(root, 'README.md'), path.join(release, 'README.md'));
    const zipFile = path.join(output, `Rubban-${version}-macOS-${arch}.zip`);
    zipFolder(release, zipFile);
    results.push({ arch, zip: zipFile, signature, tools });
  }
  console.log(JSON.stringify({ version, results }, null, 2));
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
