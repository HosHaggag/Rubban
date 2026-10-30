'use strict';

// Apps started from Finder, the Dock or Spotlight on macOS do not get the PATH (or other
// variables) set in ~/.zprofile / ~/.zshrc, so kubectl, helm and kubeconfig credential plugins
// such as gke-gcloud-auth-plugin, aws and kubelogin are not found. This reads a small allowlist of
// variables from the user's login shell once at start-up and adds the usual tool folders.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
// This module imports Unix shells only, including when its macOS behavior is tested on Windows.
const path = require('node:path').posix;

const IMPORTED = ['PATH', 'KUBECONFIG', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy',
  'CLOUDSDK_CONFIG', 'CLOUDSDK_PYTHON', 'USE_GKE_GCLOUD_AUTH_PLUGIN', 'GOOGLE_APPLICATION_CREDENTIALS',
  'AWS_PROFILE', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_REGION', 'AWS_DEFAULT_REGION',
  'AZURE_CONFIG_DIR', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'LANG'];
const MARKER = '__RUBBAN_ENV__';

function commonToolFolders(home = os.homedir()) {
  return ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin',
    path.join(home, 'google-cloud-sdk', 'bin'), '/opt/homebrew/share/google-cloud-sdk/bin', '/usr/local/share/google-cloud-sdk/bin',
    '/opt/homebrew/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/bin', '/usr/local/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/bin',
    path.join(home, '.krew', 'bin'), path.join(home, '.rd', 'bin'), path.join(home, '.local', 'bin'), path.join(home, 'bin'),
    '/Applications/Docker.app/Contents/Resources/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
}

function parseOutput(text) {
  const start = text.lastIndexOf(`${MARKER}\n`);
  if (start < 0) return {};
  const values = {};
  for (const line of text.slice(start + MARKER.length + 1).split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) { const key = line.slice(0, index); if (IMPORTED.includes(key)) values[key] = line.slice(index + 1); }
  }
  return values;
}

function mergePath(...lists) {
  const seen = new Set(); const out = [];
  for (const entry of lists.flatMap(list => String(list || '').split(path.delimiter))) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry); out.push(entry);
  }
  return out.join(path.delimiter);
}

// Returns the variables that were changed. `run` and `exists` are injectable for tests.
function importShellEnvironment({ env = process.env, platform = process.platform, run = execFileSync, exists = fs.existsSync, home = os.homedir(), timeoutMs = 5000 } = {}) {
  if (platform === 'win32' || env.RUBBAN_SKIP_SHELL_ENV === '1') return {};
  const shell = [env.SHELL, platform === 'darwin' ? '/bin/zsh' : '/bin/bash'].find(candidate => candidate && path.isAbsolute(candidate) && exists(candidate));
  let imported = {};
  if (shell) {
    try {
      // -i -l: read the same startup files as a Terminal window. Output before the marker
      // (banners, motd) is ignored; stdin is closed so prompts cannot block start-up.
      const script = `printf '\\n${MARKER}\\n'; for v in ${IMPORTED.join(' ')}; do eval "x=\\\${$v-__unset__}"; if [ "$x" != "__unset__" ]; then printf '%s=%s\\n' "$v" "$x"; fi; done; exit 0`;
      const output = run(shell, ['-ilc', script], { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'], env: { ...env, DISABLE_AUTO_UPDATE: 'true', ZSH_DISABLE_COMPFIX: 'true', RUBBAN_SHELL_PROBE: '1' } });
      imported = parseOutput(String(output));
    } catch (error) { imported = error?.stdout ? parseOutput(String(error.stdout)) : {}; }
  }
  const changed = {};
  // What the app was started with keeps priority (a Finder launch only has the system folders,
  // which hold no Kubernetes tools); then the login shell's PATH, then the usual tool folders.
  const nextPath = mergePath(env.PATH, imported.PATH, commonToolFolders(home).filter(folder => exists(folder)).join(path.delimiter));
  if (nextPath !== env.PATH) { env.PATH = nextPath; changed.PATH = nextPath; }
  for (const [key, value] of Object.entries(imported)) {
    if (key === 'PATH' || env[key] !== undefined || !value) continue;
    env[key] = value; changed[key] = value;
  }
  return changed;
}

module.exports = { importShellEnvironment, parseOutput, mergePath, commonToolFolders, IMPORTED };
