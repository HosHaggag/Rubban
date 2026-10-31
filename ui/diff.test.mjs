import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUnified, countKind, fileCount } from './diff.js';

const sample = `diff -u -N /tmp/LIVE-1/apps.v1.Deployment.apps.api /tmp/MERGED-1/apps.v1.Deployment.apps.api
--- /tmp/LIVE-1/apps.v1.Deployment.apps.api\t2026-01-01 10:00:00
+++ /tmp/MERGED-1/apps.v1.Deployment.apps.api\t2026-01-01 10:00:00
@@ -40,7 +40,7 @@
       containers:
-      - image: api:1.0
+      - image: api:1.1
         name: api
diff -u -N /tmp/LIVE-1/v1.ConfigMap.apps.x /tmp/MERGED-1/v1.ConfigMap.apps.x
--- /tmp/LIVE-1/v1.ConfigMap.apps.x\t1970-01-01
+++ /tmp/MERGED-1/v1.ConfigMap.apps.x\t2026-01-01
@@ -0,0 +1,2 @@
+apiVersion: v1
+kind: ConfigMap
`;

test('lines are typed add, del, ctx and meta', () => {
  const lines = parseUnified(sample);
  assert.deepEqual(lines.slice(0, 9).map(line => line.kind), ['meta', 'meta', 'meta', 'meta', 'ctx', 'del', 'add', 'ctx', 'meta']);
  assert.equal(lines[5].text, '      - image: api:1.0');
  assert.equal(lines[6].text, '      - image: api:1.1');
  assert.equal(lines[4].text, '      containers:');
  assert.equal(countKind(lines, 'add'), 3);
  assert.equal(countKind(lines, 'del'), 1);
  assert.equal(fileCount(lines), 2);
});

test('a removed line that looks like a file header is still a deletion inside a hunk', () => {
  const lines = parseUnified('@@ -1,2 +1,1 @@\n--- not a header\n+++ also not\n keep\n');
  assert.deepEqual(lines.map(line => line.kind), ['meta', 'del', 'add', 'ctx']);
  assert.equal(lines[1].text, '-- not a header');
});

test('empty and missing input give no lines, CRLF is understood', () => {
  assert.deepEqual(parseUnified(''), []);
  assert.deepEqual(parseUnified(undefined), []);
  assert.deepEqual(parseUnified('+a\r\n-b\r\n').map(line => [line.kind, line.text]), [['add', 'a'], ['del', 'b']]);
});

import { lineDiff, alignRows, countDiffering, foldUnchanged, changedKeys, toUnified } from './diff.js';

// Rebuilds both sides from an edit script: the defining property of a diff.
function replay(a, b, ops) {
  const left = []; const right = [];
  for (const op of ops) {
    if (op.type === 'eq') { assert.equal(a[op.ai], b[op.bi]); left.push(a[op.ai]); right.push(b[op.bi]); }
    else if (op.type === 'del') left.push(a[op.ai]);
    else right.push(b[op.bi]);
  }
  assert.deepEqual(left, a); assert.deepEqual(right, b);
}
const lines = text => (text ? text.split(' ') : []);

test('lineDiff handles insert, delete, replace and moves', () => {
  const cases = [['a b c', 'a b c'], ['a b c', 'a x b c'], ['a b c d', 'a c d'], ['a b c', 'a x c'], ['', 'a b'], ['a b', ''], ['', ''], ['a b c d e', 'e a b c d'], ['x', 'y'], ['a a a', 'a a'], ['a b a b', 'b a b a']];
  for (const [a, b] of cases) replay(lines(a), lines(b), lineDiff(lines(a), lines(b)));
  const ops = lineDiff(lines('a b c'), lines('a x c'));
  assert.deepEqual(ops.map(op => op.type), ['eq', 'del', 'add', 'eq']);
  assert.equal(lineDiff(lines('a b c'), lines('a b c')).every(op => op.type === 'eq'), true);
});

test('lineDiff is minimal on small cases and correct on random ones', () => {
  assert.equal(lineDiff(lines('a b c d'), lines('a c d')).filter(op => op.type !== 'eq').length, 1);
  assert.equal(lineDiff(lines('a b c d e'), lines('e a b c d')).filter(op => op.type !== 'eq').length, 2, 'a moved line is one delete and one insert');
  let seed = 7; const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let round = 0; round < 200; round++) {
    const a = Array.from({ length: rnd(25) }, () => String.fromCharCode(97 + rnd(5)));
    const b = Array.from({ length: rnd(25) }, () => String.fromCharCode(97 + rnd(5)));
    replay(a, b, lineDiff(a, b));
  }
});

test('completely different large inputs still produce a valid script', () => {
  const a = Array.from({ length: 4000 }, (_, i) => `a${i}`); const b = Array.from({ length: 4000 }, (_, i) => `b${i}`);
  replay(a, b, lineDiff(a, b));
});

const yamlA = 'kind: Deployment\nspec:\n  replicas: 6\n  template:\n    image: api:1.4\n    env: x\n  paused: false\n';
const yamlB = 'kind: Deployment\nspec:\n  replicas: 2\n  template:\n    image: api:1.5\n    env: x\n  paused: false\n  extra: 1\n';

test('side-by-side rows pair changed lines and keep equal ones aligned', () => {
  const rows = alignRows(yamlA, yamlB);
  assert.deepEqual(rows.map(row => row.kind), ['eq', 'eq', 'change', 'eq', 'change', 'eq', 'eq', 'add']);
  assert.deepEqual([rows[2].left, rows[2].right, rows[2].leftNo, rows[2].rightNo], ['  replicas: 6', '  replicas: 2', 3, 3]);
  assert.deepEqual([rows[7].left, rows[7].right, rows[7].leftNo, rows[7].rightNo], [null, '  extra: 1', null, 8]);
  assert.equal(countDiffering(rows), 3);
  const swapped = alignRows(yamlB, yamlA);
  assert.deepEqual(swapped.map(row => row.kind), ['eq', 'eq', 'change', 'eq', 'change', 'eq', 'eq', 'del']);
  assert.equal(swapped[7].right, null);
  assert.equal(swapped[2].left, '  replicas: 2', 'swapping sides flips what is removed and what is added');
  assert.deepEqual(alignRows('a\n', 'a\n').map(row => row.kind), ['eq']);
  assert.deepEqual(alignRows('', ''), []);
});

test('unchanged runs fold, with context around changes', () => {
  const a = Array.from({ length: 30 }, (_, i) => `line ${i}`); const b = [...a]; b[15] = 'changed';
  const folded = foldUnchanged(alignRows(a.join('\n'), b.join('\n')), 3);
  assert.deepEqual(folded.map(row => row.kind === 'skip' ? `skip ${row.count}` : row.kind), ['skip 12', 'eq', 'eq', 'eq', 'change', 'eq', 'eq', 'eq', 'skip 11']);
  assert.deepEqual(foldUnchanged(alignRows('a\nb', 'a\nb')).map(row => row.kind), ['skip']);
  assert.deepEqual(foldUnchanged([], 3), []);
});

test('the summary names the keys that changed', () => {
  assert.deepEqual(changedKeys(alignRows(yamlA, yamlB)), ['replicas', 'image', 'extra']);
  const many = alignRows(Array.from({ length: 9 }, (_, i) => `k${i}: 1`).join('\n'), Array.from({ length: 9 }, (_, i) => `k${i}: 2`).join('\n'));
  assert.equal(changedKeys(many).at(-1), '+3 more');
  assert.deepEqual(changedKeys(alignRows('- image: a\n', '- image: b\n')), ['image']);
});

test('the copied diff is a unified diff of the two sides', () => {
  const text = toUnified(alignRows(yamlA, yamlB), 'prod/apps/api', 'staging/apps/api');
  const out = text.split('\n');
  assert.deepEqual(out.slice(0, 2), ['--- prod/apps/api', '+++ staging/apps/api']);
  assert.ok(out.includes('-  replicas: 6') && out.includes('+  replicas: 2') && out.includes('+  extra: 1') && out.includes(' kind: Deployment'));
  assert.ok(toUnified(foldUnchanged(alignRows(yamlA, yamlA)), 'a', 'b').includes('@@ 7 unchanged lines @@'));
});
