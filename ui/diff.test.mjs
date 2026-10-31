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
