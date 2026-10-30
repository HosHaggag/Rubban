import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuantity, formatCPU, formatBytes, formatPercent, podResources, matchesSelector, selectorText, formatDuration, nextCronRun, certificateSummary } from './format.js';

test('quantities parse and format in human-readable units', () => {
  assert.equal(parseQuantity('250m'), 0.25);
  assert.equal(parseQuantity('2'), 2);
  assert.equal(parseQuantity('512Mi'), 512 * 2 ** 20);
  assert.equal(parseQuantity('1G'), 1e9);
  assert.ok(Math.abs(parseQuantity('123456789n') - 0.123456789) < 1e-12);
  assert.equal(parseQuantity('1e3'), 1000);
  assert.ok(Number.isNaN(parseQuantity('abc')));
  assert.equal(formatCPU(0.25), '250m');
  assert.equal(formatCPU(0.0004), '0.4m');
  assert.equal(formatCPU(1), '1 core');
  assert.equal(formatCPU(2.5), '2.5 cores');
  assert.equal(formatBytes(512 * 2 ** 20), '512 MiB');
  assert.equal(formatBytes(1.5 * 2 ** 30), '1.5 GiB');
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatPercent(1, 4), '25%');
  assert.equal(formatPercent(0.001, 4), '<1%');
  assert.equal(formatPercent(1, 0), '');
});

test('pod requests and limits add up containers and respect init containers', () => {
  const pod = { spec: { containers: [
    { resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '500m', memory: '256Mi' } } },
    { resources: { requests: { cpu: '50m' } } },
  ], initContainers: [{ resources: { requests: { cpu: '1', memory: '64Mi' } } }] } };
  const sum = podResources(pod);
  assert.equal(sum.cpuRequest, 1);
  assert.equal(sum.memoryRequest, 128 * 2 ** 20);
  assert.equal(sum.cpuLimit, 0.5);
  assert.equal(sum.memoryLimitMissing, true);
});

test('label selectors match like the API server', () => {
  const labels = { app: 'web', tier: 'front', env: 'prod' };
  assert.equal(matchesSelector({ matchLabels: { app: 'web' } }, labels), true);
  assert.equal(matchesSelector({ matchLabels: { app: 'api' } }, labels), false);
  assert.equal(matchesSelector({ matchExpressions: [{ key: 'env', operator: 'In', values: ['prod', 'stage'] }] }, labels), true);
  assert.equal(matchesSelector({ matchExpressions: [{ key: 'env', operator: 'NotIn', values: ['prod'] }] }, labels), false);
  assert.equal(matchesSelector({ matchExpressions: [{ key: 'canary', operator: 'DoesNotExist' }] }, labels), true);
  assert.equal(matchesSelector({ app: 'web' }, labels), true, 'service-style selector');
  assert.equal(matchesSelector({}, labels), false, 'empty service selector selects nothing');
  assert.equal(selectorText({ matchLabels: { app: 'web' }, matchExpressions: [{ key: 'env', operator: 'In', values: ['a', 'b'] }] }), 'app=web,env in (a,b)');
});

test('durations and cron schedules are computed for display', () => {
  assert.equal(formatDuration(3 * 86400000 + 4 * 3600000 + 5000), '3d 4h');
  assert.equal(formatDuration(45000), '45s');
  const from = new Date('2026-10-21T10:07:30Z');
  assert.equal(nextCronRun('*/15 * * * *', from, { timeZoneOffsetMinutes: 0 }).toISOString(), '2026-10-21T10:15:00.000Z');
  assert.equal(nextCronRun('0 3 * * *', from, { timeZoneOffsetMinutes: 0 }).toISOString(), '2026-10-22T03:00:00.000Z');
  assert.equal(nextCronRun('@hourly', from, { timeZoneOffsetMinutes: 0 }).toISOString(), '2026-10-21T11:00:00.000Z');
  assert.equal(nextCronRun('0 0 * * 1-5', new Date('2026-10-23T12:00:00Z'), { timeZoneOffsetMinutes: 0 }).toISOString(), '2026-10-26T00:00:00.000Z', 'Friday noon → Monday');
  assert.equal(nextCronRun('0 9 * * *', from, { timeZoneOffsetMinutes: 180 }).toISOString(), '2026-10-22T06:00:00.000Z', '09:00 Riyadh is 06:00 UTC');
  assert.equal(nextCronRun('not a cron', from), null);
});

test('certificate summary reads subject, issuer and validity from PEM', async () => {
  const { execFileSync } = await import('node:child_process');
  let pem;
  try { pem = execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', '/dev/null', '-subj', '/CN=rubban.test/O=Rubban', '-days', '30'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return; }
  const summary = certificateSummary(pem);
  assert.match(summary.subject, /CN=rubban.test/);
  assert.match(summary.issuer, /O=Rubban/);
  assert.ok(summary.notAfter > summary.notBefore);
});

test('pod requests count native sidecars, default to limits and flag missing limits', () => {
  const pod = { spec: {
    initContainers: [
      { name: 'migrate', resources: { requests: { cpu: '2' } } },
      { name: 'mesh', restartPolicy: 'Always', resources: { requests: { cpu: '500m', memory: '64Mi' }, limits: { cpu: '2', memory: '128Mi' } } },
    ],
    containers: [
      { name: 'app', resources: { requests: { cpu: '100m' }, limits: { cpu: '200m', memory: '256Mi' } } },
      { name: 'log-shipper', resources: { requests: { cpu: '50m', memory: '32Mi' } } },
    ],
  } };
  const r = podResources(pod);
  // app 100m + shipper 50m + sidecar 500m = 650m, but the 2-core init container (alone, plus sidecars started before it: none) wins.
  assert.equal(r.cpuRequest, 2);
  assert.equal(r.memoryRequest, (256 + 32 + 64) * 2 ** 20);
  assert.ok(Math.abs(r.cpuLimit - 2.2) < 1e-9);
  assert.equal(r.cpuLimitMissing, true);
  assert.equal(r.memoryLimitMissing, true);
  const noInit = podResources({ spec: { containers: pod.spec.containers, initContainers: [pod.spec.initContainers[1]] } });
  assert.ok(Math.abs(noInit.cpuRequest - 0.65) < 1e-9);
});
