import test from 'node:test';
import assert from 'node:assert/strict';
import { explainError, clusterDown } from './errors.js';

test('raw network and API errors become plain words', () => {
  const refused = explainError(new Error('Kubernetes discovery unavailable: Core discovery: dial tcp 127.0.0.1:46999: connect: connection refused'), { context: 'dev' });
  assert.equal(refused.kind, 'unreachable'); assert.match(refused.text, /127\.0\.0\.1:46999/); assert.ok(clusterDown(refused));
  assert.equal(explainError(Object.assign(new Error('pods is forbidden: User "x" cannot list'), { status: 403 })).kind, 'forbidden');
  assert.equal(explainError(new Error('dial tcp: lookup api.internal on 10.0.0.2:53: no such host')).kind, 'dns');
  assert.equal(explainError(new Error('x509: certificate signed by unknown authority')).kind, 'tls');
  assert.equal(explainError(new Error('net/http: TLS handshake timeout')).kind, 'timeout');
  assert.equal(explainError(Object.assign(new Error('getting credentials: exec: executable gke-gcloud-auth-plugin not found'), { code: 'credentials' })).kind, 'auth');
  assert.equal(explainError(new Error('weird')).kind, 'other');
  assert.ok(!clusterDown(explainError(Object.assign(new Error('forbidden'), { status: 403 }))));
});
