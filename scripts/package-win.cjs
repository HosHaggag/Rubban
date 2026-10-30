'use strict';
// Builds Rubban for Windows (x64) and a zip in release/:
//   npm run package:win
// Runs on Windows, macOS or Linux/WSL (executable metadata and the icon are written in JavaScript).
// Optional: RUBBAN_BUNDLE_KUBECTL / RUBBAN_BUNDLE_HELM = paths to kubectl.exe / helm.exe to bundle.
const path = require('node:path');
const fs = require('node:fs');
const { root, manifest, stage, bundleTools, zipFolder, ignore } = require('./package-common.cjs');

const version = manifest.version;
const output = path.resolve(process.env.RUBBAN_RELEASE_DIR || path.join(root, 'release'));

(async () => {
  const { packager } = await import('@electron/packager');
  fs.mkdirSync(output, { recursive: true });
  const dir = stage('win32', 'x64');
  const tools = bundleTools(dir, 'win32');
  const [location] = await packager({
    dir, name: 'Rubban', executableName: 'Rubban', appBundleId: 'dev.rubban.desktop', icon: path.join(root, 'assets', 'rubban.ico'),
    appVersion: version, buildVersion: version, appCopyright: 'Rubban contributors · MIT licence',
    platform: 'win32', arch: 'x64', electronVersion: manifest.devDependencies.electron, out: path.join(root, 'build', 'packaged'), overwrite: true, asar: false, prune: false, ignore,
    download: process.env.electron_config_cache ? { cacheRoot: process.env.electron_config_cache } : {},
    win32metadata: { CompanyName: 'Rubban contributors', FileDescription: 'Rubban Kubernetes Workbench', ProductName: 'Rubban', InternalName: 'Rubban', OriginalFilename: 'Rubban.exe' },
  });
  const release = path.join(output, `Rubban-${version}-Windows-x64`);
  fs.rmSync(release, { recursive: true, force: true });
  fs.cpSync(location, release, { recursive: true });
  fs.copyFileSync(path.join(root, 'scripts', 'Install-Rubban.ps1'), path.join(release, 'Install-Rubban.ps1'));
  fs.copyFileSync(path.join(root, 'README.md'), path.join(release, 'README.md'));
  const zipFile = path.join(output, `Rubban-${version}-Windows-x64.zip`);
  zipFolder(release, zipFile);
  console.log(JSON.stringify({ version, zip: zipFile, tools }, null, 2));
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
