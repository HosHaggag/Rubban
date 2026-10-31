import test from 'node:test';
import assert from 'node:assert/strict';
import { permissionText, scopeText, groupByFeature, denied, asText, summary } from './access.js';

const answer = {
  user: 'alice@example.com', groups: ['devs'], namespace: 'monitoring',
  checks: [
    { id: 'browse-list-pods', feature: 'Browse views', verb: 'list', resource: 'pods', namespace: 'monitoring', allowed: true },
    { id: 'browse-list-nodes', feature: 'Browse views', verb: 'list', resource: 'nodes', allowed: true },
    { id: 'logs', feature: 'Logs', verb: 'get', resource: 'pods', subresource: 'log', namespace: 'monitoring', allowed: true },
    { id: 'helm', feature: 'Helm releases', verb: 'list', resource: 'secrets', namespace: 'monitoring', allowed: false, reason: 'RBAC: no rule' },
    { id: 'metrics', feature: 'Live CPU and memory', verb: 'list', resource: 'pods', group: 'metrics.k8s.io', allowed: false, error: 'timeout' },
  ],
};

test('permission wording', () => {
  assert.equal(permissionText(answer.checks[2]), 'get pods/log');
  assert.equal(permissionText(answer.checks[4]), 'list pods.metrics.k8s.io');
  assert.equal(permissionText({ verb: 'patch', resource: 'deployments', group: 'apps', subresource: 'scale' }), 'patch deployments.apps/scale');
  assert.equal(scopeText(answer.checks[0]), 'in monitoring');
  assert.equal(scopeText(answer.checks[1]), 'cluster-wide');
});

test('checks of one feature are grouped, with their combined result', () => {
  const groups = groupByFeature(answer.checks);
  assert.deepEqual(groups.map(group => [group.feature, group.checks.length, group.allowed]), [['Browse views', 2, true], ['Logs', 1, true], ['Helm releases', 1, false], ['Live CPU and memory', 1, false]]);
  assert.deepEqual(groupByFeature(undefined), []);
});

test('denied checks and the summary sentence', () => {
  assert.deepEqual(denied(answer).map(check => check.id), ['helm', 'metrics']);
  assert.equal(summary(answer), '2 of 5 checks are denied: Helm releases, Live CPU and memory.');
  assert.equal(summary({ checks: [{ allowed: true }] }), 'All 1 checks passed.');
  assert.equal(summary({ checks: [] }), 'No checks ran.');
});

test('the copied text names identity, namespace and every result', () => {
  const text = asText(answer, { label: 'Tracking · prod', context: 'gke_prod' });
  const lines = text.split('\n');
  assert.equal(lines[0], 'Access for Tracking · prod (gke_prod)');
  assert.equal(lines[1], 'Identity: alice@example.com · groups: devs');
  assert.equal(lines[2], 'Namespace: monitoring');
  assert.ok(lines.includes('✓ Logs: get pods/log in monitoring'));
  assert.ok(lines.includes('✗ Helm releases: list secrets in monitoring — RBAC: no rule'));
  assert.ok(lines.includes('✗ Live CPU and memory: list pods.metrics.k8s.io cluster-wide — could not check: timeout'));
  assert.ok(lines.includes('2 of 5 checks are denied.'));
  assert.match(asText({ ...answer, namespace: '*', user: '' }, { context: 'x' }), /^Access for x\nNamespace: all namespaces/);
});
