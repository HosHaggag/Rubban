import test from 'node:test';
import assert from 'node:assert/strict';
import { guessIcon, guessEnv, hashColor, clusterInfo, isProduction, CLUSTER_COLORS } from './clusters.js';
import { CLUSTER_ICON_IDS } from './cluster-icons.js';

test('icons are guessed from the provider in the context name', () => {
  assert.equal(guessIcon('gke_proj_europe-west1_tracking'), 'gcp');
  assert.equal(guessIcon('arn:aws:eks:eu-west-1:123:cluster/x'), 'aws');
  assert.equal(guessIcon('my-aks-cluster'), 'azure');
  assert.equal(guessIcon('docker-desktop'), 'local');
  assert.equal(guessIcon('kind-dev'), 'local');
  assert.equal(guessIcon('something'), 'cluster');
});

test('environment is guessed from the name and saved values win', () => {
  assert.equal(guessEnv('tracking-prod'), 'production');
  assert.equal(guessEnv('gke_p_r_stg-1'), 'staging');
  assert.equal(guessEnv('team-dev'), 'development');
  assert.equal(guessEnv('sandbox'), '');
  assert.equal(clusterInfo('tracking-prod').label, 'tracking-prod');
  const saved = { 'tracking-prod': { label: 'Tracking', icon: 'rocket', color: '#112233', env: 'staging' } };
  assert.deepEqual(clusterInfo('tracking-prod', saved), { name: 'tracking-prod', label: 'Tracking', icon: 'rocket', color: '#112233', env: 'staging' });
  assert.equal(isProduction('tracking-prod', saved), false);
  assert.equal(isProduction('tracking-prod', {}), true);
});

test('colours are stable and come from the palette; every guessed icon exists', () => {
  assert.equal(hashColor('a'), hashColor('a'));
  assert.ok(CLUSTER_COLORS.includes(hashColor('anything')));
  for (const name of ['gke_a', 'eks', 'aks', 'kind-x', 'x']) assert.ok(CLUSTER_ICON_IDS.includes(guessIcon(name)));
});
