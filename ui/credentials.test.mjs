import test from 'node:test';
import assert from 'node:assert/strict';
import { load, authOf, isExpired, mark, clear, dismiss, bannerFor, bannerParts, needsAttention, forgetAll, tooltip, GENERIC_REMEDY } from './credentials.js';

const gke = { preset: 'gcloud-login', label: 'gcloud auth login' };
const contexts = [
  { name: 'prod', auth: { status: 'expired', message: 'exec failed', plugin: 'gke-gcloud-auth-plugin', remedy: gke } },
  { name: 'stage', auth: { status: 'ok', message: '', plugin: '', remedy: gke } },
  { name: 'old' },
];

test('load keeps the server status and a generic remedy where none was sent', () => {
  forgetAll(); load(contexts);
  assert.equal(authOf('prod').status, 'expired');
  assert.equal(authOf('stage').status, 'ok');
  assert.deepEqual(authOf('old').remedy, GENERIC_REMEDY);
  assert.equal(authOf('missing').status, 'unknown');
});

test('which contexts need attention', () => {
  forgetAll(); load(contexts);
  assert.deepEqual(needsAttention(['stage', 'prod', 'old']), ['prod']);
});

test('banner text names the cluster and the plugin', () => {
  forgetAll(); load(contexts);
  const parts = bannerParts('Tracking · prod', authOf('prod'));
  assert.equal(parts.before + parts.label + parts.after, 'Credentials for Tracking · prod expired — gke-gcloud-auth-plugin.');
  assert.equal(bannerParts('x', { plugin: '' }).after, ' expired.');
  assert.equal(tooltip('prod', authOf('prod')), 'prod · credentials expired — exec failed');
});

test('banner shows only for expired contexts, offers sign-in only with a preset, and can be dismissed', () => {
  forgetAll(); load(contexts);
  assert.equal(bannerFor('stage'), null);
  assert.equal(bannerFor(''), null);
  assert.equal(bannerFor('prod').canSignIn, true);
  assert.equal(bannerFor('prod').remedyLabel, 'gcloud auth login');
  mark('plain', { message: 'Unauthorized' });
  assert.equal(bannerFor('plain').canSignIn, false);
  assert.equal(bannerFor('plain').remedyLabel, GENERIC_REMEDY.label);
  dismiss('prod');
  assert.equal(bannerFor('prod'), null);
});

test('mark reports changes once, a recovery resets the dismissal', () => {
  forgetAll(); load(contexts);
  assert.equal(mark('prod', { message: 'exec failed', plugin: 'gke-gcloud-auth-plugin' }), false);
  assert.equal(mark('stage', { message: 'Unauthorized' }), true);
  assert.equal(mark('stage', { message: 'Unauthorized' }), false);
  dismiss('stage');
  assert.equal(clear('stage'), true);
  assert.equal(isExpired('stage'), false);
  assert.equal(clear('stage'), false);
  mark('stage', { message: 'again' });
  assert.notEqual(bannerFor('stage'), null, 'a new expiry shows the banner again');
});

test('a reload that has not seen the failure does not hide what the browser saw', () => {
  forgetAll(); load(contexts);
  mark('stage', { message: 'watch failed' });
  load([{ name: 'stage', auth: { status: 'unknown', remedy: gke } }]);
  assert.equal(isExpired('stage'), true);
  load([{ name: 'stage', auth: { status: 'ok', remedy: gke } }]);
  assert.equal(isExpired('stage'), false);
});
