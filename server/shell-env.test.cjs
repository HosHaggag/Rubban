'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { importShellEnvironment, parseOutput, mergePath } = require('./shell-env.cjs');

test('macOS launches pick up PATH and kubeconfig from the login shell', () => {
  const calls = [];
  const env = { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HTTPS_PROXY: 'http://kept:3128' };
  const changed = importShellEnvironment({
    env, platform: 'darwin', home: '/Users/h',
    exists: file => ['/bin/zsh', '/opt/homebrew/bin', '/Users/h/google-cloud-sdk/bin'].includes(file),
    run: (command, args) => { calls.push([command, args[0]]); return 'Last login: today\nbanner\n\n__RUBBAN_ENV__\nPATH=/opt/homebrew/bin:/Users/h/google-cloud-sdk/bin:/usr/bin:/bin\nKUBECONFIG=/Users/h/.kube/config:/Users/h/.kube/gke\nHTTPS_PROXY=http://ignored\nSECRET_TOKEN=nope\n'; },
  });
  assert.deepEqual(calls, [['/bin/zsh', '-ilc']]);
  assert.equal(env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/Users/h/google-cloud-sdk/bin');
  assert.equal(env.KUBECONFIG, '/Users/h/.kube/config:/Users/h/.kube/gke');
  assert.equal(env.HTTPS_PROXY, 'http://kept:3128', 'values the app already has win');
  assert.equal(env.SECRET_TOKEN, undefined, 'only allow-listed variables are imported');
  assert.deepEqual(Object.keys(changed).sort(), ['KUBECONFIG', 'PATH']);
});

test('a broken or slow shell still adds the usual tool folders; Windows is untouched', () => {
  const env = { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' };
  importShellEnvironment({ env, platform: 'darwin', home: '/Users/h', exists: file => ['/bin/zsh', '/usr/local/bin'].includes(file), run: () => { throw Object.assign(new Error('timeout'), { stdout: '' }); } });
  assert.equal(env.PATH, '/usr/bin:/bin:/usr/local/bin');
  const windows = { PATH: 'C:\\Windows' };
  assert.deepEqual(importShellEnvironment({ env: windows, platform: 'win32' }), {});
  assert.equal(windows.PATH, 'C:\\Windows');
  assert.deepEqual(parseOutput('no marker'), {});
  assert.equal(mergePath('/a:/b', '/b:/c', ''), '/a:/b:/c');
});

test('MARSAD_* and PRISM_* variables from earlier names still configure Rubban', () => {
  const env = { MARSAD_DATA_DIR: '/from/marsad', PRISM_DATA_DIR: '/from/prism', PRISM_HUB_PORT: '4521', RUBBAN_KUBECTL: '/new', MARSAD_KUBECTL: '/old' };
  // A fresh module scope checks startup behavior without mutating this test process's environment.
  const source = require('node:fs').readFileSync(require.resolve('./env-compat.cjs'), 'utf8');
  require('node:vm').runInNewContext(source, { process: { env }, module: { exports: {} } });
  assert.deepEqual([env.RUBBAN_DATA_DIR, env.RUBBAN_HUB_PORT, env.RUBBAN_KUBECTL], ['/from/marsad', '4521', '/new']);
});
