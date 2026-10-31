import test from 'node:test';
import assert from 'node:assert/strict';
import { searchContexts, groupByKind, resultDetail, searchable } from './search.js';

test('every open cluster is searched once, in tab order', () => {
  const tabs = [{ context: 'prod' }, { context: 'staging' }, { context: 'prod' }, { context: '' }];
  assert.deepEqual(searchContexts(tabs), ['prod', 'staging']);
  assert.deepEqual(searchContexts([]), []);
  assert.deepEqual(searchContexts(undefined), []);
});

test('results keep the server order, grouped by kind', () => {
  const results = [
    { resource: 'services', kind: 'Service', name: 'payments' },
    { resource: 'pods', kind: 'Pod', name: 'payments-1' },
    { resource: 'services', kind: 'Service', name: 'payments-admin' },
    { resource: 'pods', kind: 'Pod', name: 'payments-2' },
  ];
  const groups = groupByKind(results);
  assert.deepEqual(groups.map(group => [group.kind, group.items.map(item => item.name)]), [['Service', ['payments', 'payments-admin']], ['Pod', ['payments-1', 'payments-2']]]);
  assert.deepEqual(groupByKind(undefined), []);
});

test('detail text and the minimum query length', () => {
  assert.equal(resultDetail({ namespace: 'shop', status: 'Running 1/1' }), 'shop · Running 1/1');
  assert.equal(resultDetail({ status: 'Active' }), 'Active');
  assert.equal(resultDetail({}), '');
  assert.equal(searchable('p'), false);
  assert.equal(searchable(' p '), false);
  assert.equal(searchable('pa'), true);
});
