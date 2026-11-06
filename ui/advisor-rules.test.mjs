import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { analyze, podSecurityLevel, scoreOf, gradeOf, objectSummary, pssCounts, filterFindings, groupFindings, applyPatch, cleanForApply, fixDocument, patchText, managedBy, toYAML, RULES, RULE_BY_ID, CATEGORIES, SEVERITIES, WEIGHTS, isSystemNamespace } from './advisor-rules.js';

const require = createRequire(import.meta.url);
const YAML = require('yaml');

// A well-configured container and Deployment: passes every rule.
const goodContainer = (name = 'app', extra = {}) => ({
  name, image: `registry.example.com/${name}:1.2.3`, ports: [{ name: 'http', containerPort: 8080 }],
  readinessProbe: { httpGet: { path: '/ready', port: 'http' } }, livenessProbe: { tcpSocket: { port: 8080 } },
  resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { memory: '128Mi' } },
  securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
  ...extra,
});
const goodPod = (extra = {}) => ({ containers: [goodContainer()], securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } }, automountServiceAccountToken: false, ...extra });
const deployment = (name, { ns = 'shop', replicas = 2, pod = goodPod(), labels = { app: name }, metadata = {} } = {}) => ({
  metadata: { name, namespace: ns, uid: `uid-${name}`, resourceVersion: '42', ...metadata },
  spec: { replicas, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: pod } },
  status: { replicas },
});
const pdbFor = (name, labels, spec = { maxUnavailable: 1 }, status = {}) => ({ metadata: { name, namespace: 'shop' }, spec: { selector: { matchLabels: labels }, ...spec }, status });
const baseObjects = (extra = {}) => ({ deployments: [], statefulsets: [], daemonsets: [], jobs: [], cronjobs: [], pods: [], services: [], ingresses: [], poddisruptionbudgets: [], horizontalpodautoscalers: [], resourcequotas: [], limitranges: [], serviceaccounts: [], namespaces: [], nodes: [], ...extra });
const ruleIds = result => [...new Set(result.findings.map(f => f.rule))].sort();
const findingOf = (result, rule) => result.findings.find(f => f.rule === rule);

test('every rule is fully described', () => {
  const ids = new Set();
  for (const rule of RULES) {
    assert.ok(!ids.has(rule.id), `duplicate ${rule.id}`); ids.add(rule.id);
    assert.ok(CATEGORIES.includes(rule.category), rule.id);
    assert.ok(SEVERITIES.includes(rule.severity), rule.id);
    for (const field of ['title', 'why', 'fix']) assert.ok(rule[field]?.length > 10, `${rule.id}.${field}`);
    assert.equal(typeof rule.check, 'function');
  }
  assert.equal(RULE_BY_ID.size, RULES.length);
  for (const category of CATEGORIES) assert.ok(RULES.some(rule => rule.category === category), category);
});

test('a well-configured deployment with a budget passes everything', () => {
  const result = analyze(baseObjects({ deployments: [deployment('api')], poddisruptionbudgets: [pdbFor('api', { app: 'api' })] }), { production: true });
  assert.deepEqual(result.findings, []);
  assert.ok(result.checks.length > 15);
  assert.equal(result.pss[0].level, 'restricted');
  assert.equal(scoreOf(result.checks).score, 100);
});

test('the demo-style deployment: no security context gives the expected findings', () => {
  const pod = { containers: [{ name: 'web', image: 'registry.example.com/shop/web:4.2.1', ports: [{ containerPort: 8080 }], readinessProbe: { tcpSocket: { port: 8080 } }, livenessProbe: { tcpSocket: { port: 8080 } }, resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { cpu: '250m', memory: '128Mi' } } }], securityContext: {} };
  const result = analyze(baseObjects({ deployments: [deployment('web', { pod })] }));
  assert.deepEqual(ruleIds(result), ['default-sa-token', 'drop-capabilities', 'pdb-missing', 'privilege-escalation', 'readonly-root-fs', 'run-as-root', 'seccomp-missing']);
  assert.equal(result.pss[0].level, 'baseline');
  const escalation = findingOf(result, 'privilege-escalation');
  assert.equal(escalation.id, 'privilege-escalation|deployments|shop|web');
  assert.equal(escalation.kind, 'Deployment');
  assert.deepEqual(escalation.patch, { spec: { template: { spec: { containers: [{ name: 'web', securityContext: { allowPrivilegeEscalation: false } }] } } } });
  assert.deepEqual(findingOf(result, 'run-as-root').patch, { spec: { template: { spec: { securityContext: { runAsNonRoot: true } } } } });
  assert.deepEqual(findingOf(result, 'pdb-missing').manifest, { apiVersion: 'policy/v1', kind: 'PodDisruptionBudget', metadata: { name: 'web', namespace: 'shop' }, spec: { maxUnavailable: 1, selector: { matchLabels: { app: 'web' } } } });
});

test('requests, limits and the node size', () => {
  const pod = goodPod({ containers: [goodContainer('a', { resources: {} }), goodContainer('b', { resources: { limits: { cpu: '1', memory: '1Gi' } } }), goodContainer('c', { resources: { requests: { cpu: '48', memory: '64Mi' }, limits: { memory: '64Mi' } } })] });
  const nodes = [{ metadata: { name: 'n1' }, status: { allocatable: { cpu: '8', memory: '32Gi' } } }, { metadata: { name: 'big' }, spec: { unschedulable: true }, status: { allocatable: { cpu: '96', memory: '256Gi' } } }];
  const result = analyze(baseObjects({ deployments: [deployment('pdf', { pod })], poddisruptionbudgets: [pdbFor('pdf', { app: 'pdf' })], nodes }));
  const requests = findingOf(result, 'requests-missing');
  assert.deepEqual(requests.containers, ['a']); // b has limits, which default the requests
  assert.match(requests.detail, /a: cpu and memory/);
  assert.deepEqual(requests.patch.spec.template.spec.containers, [{ name: 'a', resources: { requests: { cpu: '100m', memory: '128Mi' } } }]);
  const limits = findingOf(result, 'memory-limit-missing');
  assert.deepEqual(limits.containers, ['a']);
  assert.deepEqual(limits.patch.spec.template.spec.containers[0].resources, { limits: { memory: '256Mi' } });
  const tooBig = findingOf(result, 'requests-exceed-nodes');
  assert.equal(tooBig.severity, 'critical');
  assert.match(tooBig.detail, /CPU 49 cores > 8 cores/); // a: 0, b: 1 (from its limit), c: 48; the cordoned node does not count
  assert.equal(tooBig.patch, undefined);
  // No node list (no permission): the rule is skipped, not failed.
  assert.ok(analyze(baseObjects({ deployments: [deployment('pdf', { pod })], nodes: undefined })).skipped.includes('requests-exceed-nodes'));
});

test('probes: missing ones and ones aimed at an undeclared port', () => {
  const pod = goodPod({ containers: [
    goodContainer('notifications', { readinessProbe: { tcpSocket: { port: 9999 } } }),
    goodContainer('named', { livenessProbe: { httpGet: { path: '/', port: 'metrics' } } }),
    goodContainer('bare', { readinessProbe: undefined, livenessProbe: undefined, ports: [] }),
    goodContainer('undeclared', { ports: undefined, readinessProbe: { tcpSocket: { port: 7000 } } }),
  ] });
  const result = analyze(baseObjects({ deployments: [deployment('n', { pod })], poddisruptionbudgets: [pdbFor('n', { app: 'n' })] }));
  const wrong = findingOf(result, 'probe-port-unknown');
  assert.deepEqual(wrong.containers, ['notifications', 'named']); // a container without declared ports is not judged by number
  assert.match(wrong.detail, /notifications: readiness → 9999/);
  assert.deepEqual(wrong.patch.spec.template.spec.containers, [{ name: 'notifications', readinessProbe: { tcpSocket: { port: 8080 } } }, { name: 'named', livenessProbe: { httpGet: { port: 8080 } } }]);
  assert.deepEqual(findingOf(result, 'readiness-missing').containers, ['bare']);
  assert.deepEqual(findingOf(result, 'liveness-missing').containers, ['bare']);
  // No port to probe: no patch.
  assert.equal(findingOf(result, 'readiness-missing').patch, undefined);
  // Jobs are not expected to have probes.
  const job = { metadata: { name: 'once', namespace: 'shop' }, spec: { ttlSecondsAfterFinished: 60, template: { spec: goodPod({ containers: [goodContainer('x', { readinessProbe: undefined, livenessProbe: undefined })] }) } } };
  assert.deepEqual(ruleIds(analyze(baseObjects({ jobs: [job] }))), []);
});

test('image tags', () => {
  const pod = goodPod({ containers: [goodContainer('a', { image: 'nginx' }), goodContainer('b', { image: 'nginx:latest' }), goodContainer('c', { image: 'localhost:5000/team/app' }), goodContainer('d', { image: 'nginx@sha256:abc' }), goodContainer('e', { image: 'localhost:5000/app:2.0' })] });
  const result = analyze(baseObjects({ deployments: [deployment('img', { pod })], poddisruptionbudgets: [pdbFor('img', { app: 'img' })] }));
  assert.deepEqual(findingOf(result, 'image-latest').containers, ['a', 'b', 'c']);
  assert.equal(findingOf(result, 'image-latest').patch, undefined);
});

test('security context rules and their patches', () => {
  const pod = {
    hostNetwork: true, hostPID: true, volumes: [{ name: 'root', hostPath: { path: '/' } }, { name: 'tmp', emptyDir: {} }],
    securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } }, automountServiceAccountToken: false,
    containers: [
      goodContainer('priv', { securityContext: { privileged: true, capabilities: { drop: ['ALL'] }, readOnlyRootFilesystem: true } }),
      goodContainer('caps', { ports: [{ containerPort: 80, hostPort: 80 }], readinessProbe: { tcpSocket: { port: 80 } }, livenessProbe: undefined, securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { add: ['cap_sys_admin', 'NET_BIND_SERVICE', 'NET_ADMIN'], drop: ['ALL'] } } }),
    ],
  };
  const result = analyze(baseObjects({ daemonsets: [{ metadata: { name: 'agent', namespace: 'platform' }, spec: { selector: { matchLabels: { app: 'agent' } }, template: { metadata: { labels: { app: 'agent' } }, spec: pod } } }] }));
  assert.deepEqual(ruleIds(result), ['dangerous-capabilities', 'host-namespaces', 'host-path', 'host-port', 'liveness-missing', 'privilege-escalation', 'privileged']);
  assert.equal(result.findings[0].severity, 'critical');
  assert.deepEqual(findingOf(result, 'privileged').patch, { spec: { template: { spec: { containers: [{ name: 'priv', securityContext: { privileged: false } }] } } } });
  assert.deepEqual(findingOf(result, 'host-namespaces').patch, { spec: { template: { spec: { hostNetwork: false, hostPID: false } } } });
  assert.match(findingOf(result, 'dangerous-capabilities').detail, /caps: cap_sys_admin, NET_ADMIN/);
  assert.deepEqual(findingOf(result, 'dangerous-capabilities').patch.spec.template.spec.containers[0].securityContext.capabilities.add, ['NET_BIND_SERVICE']);
  assert.equal(findingOf(result, 'host-path').detail, 'root: /');
  // allowPrivilegeEscalation cannot be false on a privileged container: no patch until that is fixed.
  assert.equal(findingOf(result, 'privilege-escalation').patch, undefined);
  const level = podSecurityLevel(pod);
  assert.equal(level.level, 'privileged');
  for (const reason of ['hostNetwork', 'hostPID', 'privileged container', 'hostPath volume', 'hostPort']) assert.ok(level.baseline.includes(reason), reason);
  assert.ok(level.baseline.some(reason => /SYS_ADMIN, NET_ADMIN/.test(reason)));
});

test('run as root: explicit root user is not patched, a container override is', () => {
  const root = analyze(baseObjects({ deployments: [deployment('r', { replicas: 1, pod: goodPod({ securityContext: { runAsUser: 0, seccompProfile: { type: 'RuntimeDefault' } } }) })] }));
  assert.match(findingOf(root, 'run-as-root').detail, /runAsUser: 0/);
  assert.equal(findingOf(root, 'run-as-root').patch, undefined);
  const override = analyze(baseObjects({ deployments: [deployment('o', { replicas: 1, pod: goodPod({ containers: [goodContainer('app', { securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] }, runAsNonRoot: false } })] }) })] }));
  assert.deepEqual(findingOf(override, 'run-as-root').patch.spec.template.spec, { securityContext: { runAsNonRoot: true }, containers: [{ name: 'app', securityContext: { runAsNonRoot: true } }] });
});

test('seccomp and service account token', () => {
  const pod = goodPod({ securityContext: { runAsNonRoot: true }, automountServiceAccountToken: undefined, containers: [goodContainer('a'), goodContainer('b', { securityContext: { ...goodContainer().securityContext, seccompProfile: { type: 'Unconfined' } } })] });
  const result = analyze(baseObjects({ deployments: [deployment('s', { replicas: 1, pod })] }));
  const seccomp = findingOf(result, 'seccomp-missing');
  assert.match(seccomp.detail, /Unconfined in b/);
  assert.deepEqual(seccomp.patch.spec.template.spec, { securityContext: { seccompProfile: { type: 'RuntimeDefault' } }, containers: [{ name: 'b', securityContext: { seccompProfile: { type: 'RuntimeDefault' } } }] });
  assert.ok(findingOf(result, 'default-sa-token'));
  assert.equal(podSecurityLevel(pod).level, 'privileged'); // Unconfined is a baseline violation
  // The default ServiceAccount of the namespace opts out: no finding. Its own ServiceAccount: not applicable.
  const optedOut = analyze(baseObjects({ deployments: [deployment('s', { replicas: 1, pod })], serviceaccounts: [{ metadata: { name: 'default', namespace: 'shop' }, automountServiceAccountToken: false }] }));
  assert.equal(findingOf(optedOut, 'default-sa-token'), undefined);
  const own = analyze(baseObjects({ deployments: [deployment('s', { replicas: 1, pod: { ...pod, serviceAccountName: 'shop-api' } })] }));
  assert.equal(own.checks.filter(c => c.rule === 'default-sa-token').length, 0);
});

test('Pod Security Standards levels follow the upstream definitions', () => {
  assert.equal(podSecurityLevel(goodPod()).level, 'restricted');
  assert.equal(podSecurityLevel({ containers: [{ name: 'a' }] }).level, 'baseline');
  const restrictedWith = extra => podSecurityLevel(goodPod(extra));
  assert.equal(restrictedWith({ volumes: [{ name: 'cfg', configMap: { name: 'x' } }, { name: 'data', persistentVolumeClaim: { claimName: 'd' } }] }).level, 'restricted');
  assert.deepEqual(restrictedWith({ volumes: [{ name: 'nfs', nfs: { server: 'x', path: '/' } }] }).restricted, ['volume types (nfs)']);
  assert.equal(restrictedWith({ securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' }, sysctls: [{ name: 'kernel.msgmax', value: '1' }] } }).level, 'privileged');
  assert.equal(restrictedWith({ securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' }, sysctls: [{ name: 'net.ipv4.tcp_syncookies', value: '1' }] } }).level, 'restricted');
  assert.equal(restrictedWith({ securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' }, seLinuxOptions: { type: 'spc_t' } } }).level, 'privileged');
  assert.equal(restrictedWith({ securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' }, seLinuxOptions: { type: 'container_t', level: 's0:c1' } } }).level, 'restricted');
  assert.equal(podSecurityLevel(goodPod(), { annotations: { 'container.apparmor.security.beta.kubernetes.io/app': 'unconfined' } }).level, 'privileged');
  assert.equal(podSecurityLevel(goodPod(), { annotations: { 'container.apparmor.security.beta.kubernetes.io/app': 'localhost/my' } }).level, 'restricted');
  // Container-level seccomp on every container satisfies restricted without a pod-level one.
  const perContainer = goodPod({ securityContext: { runAsNonRoot: true }, containers: [goodContainer('a', { securityContext: { ...goodContainer().securityContext, seccompProfile: { type: 'Localhost', localhostProfile: 'p.json' } } })] });
  assert.equal(podSecurityLevel(perContainer).level, 'restricted');
  // Adding NET_BIND_SERVICE is allowed in restricted, CHOWN only in baseline.
  const withCap = cap => goodPod({ containers: [goodContainer('a', { securityContext: { ...goodContainer().securityContext, capabilities: { drop: ['ALL'], add: [cap] } } })] });
  assert.equal(podSecurityLevel(withCap('NET_BIND_SERVICE')).level, 'restricted');
  assert.equal(podSecurityLevel(withCap('CHOWN')).level, 'baseline');
  assert.equal(podSecurityLevel(withCap('NET_RAW')).level, 'privileged');
  // Init and ephemeral containers count too; runAsUser 0 is never restricted.
  assert.equal(podSecurityLevel(goodPod({ initContainers: [{ name: 'init', securityContext: { privileged: true } }] })).level, 'privileged');
  assert.equal(podSecurityLevel(goodPod({ ephemeralContainers: [{ name: 'debug' }] })).level, 'baseline');
  assert.ok(restrictedWith({ securityContext: { runAsNonRoot: true, runAsUser: 0, seccompProfile: { type: 'RuntimeDefault' } } }).restricted.includes('runAsUser 0'));
  assert.equal(podSecurityLevel({ ...goodPod(), containers: [goodContainer('a', { securityContext: { ...goodContainer().securityContext, procMount: 'Unmasked' } })] }).level, 'privileged');
});

test('replicas, budgets and autoscalers', () => {
  const single = deployment('solo', { replicas: 1 });
  assert.ok(findingOf(analyze(baseObjects({ deployments: [single] }), { production: true }), 'single-replica-production'));
  assert.deepEqual(findingOf(analyze(baseObjects({ deployments: [single] }), { production: true }), 'single-replica-production').patch, { spec: { replicas: 2 } });
  assert.equal(findingOf(analyze(baseObjects({ deployments: [single] }), { production: false }), 'single-replica-production'), undefined);
  const hpa = (target, min, max, ns = 'shop') => ({ metadata: { name: `${target}-hpa`, namespace: ns }, spec: { scaleTargetRef: { kind: 'Deployment', name: target }, minReplicas: min, maxReplicas: max } });
  // An autoscaler owns the replica count.
  assert.equal(findingOf(analyze(baseObjects({ deployments: [single], horizontalpodautoscalers: [hpa('solo', 2, 5)] }), { production: true }), 'single-replica-production'), undefined);
  // No HPA list: cannot tell, so skipped.
  assert.ok(analyze(baseObjects({ deployments: [single], horizontalpodautoscalers: undefined }), { production: true }).skipped.includes('single-replica-production'));

  const fixed = analyze(baseObjects({ deployments: [single], horizontalpodautoscalers: [hpa('solo', 3, 3), hpa('ghost', 1, 4)] }));
  assert.deepEqual(findingOf(fixed, 'hpa-no-range').patch, { spec: { maxReplicas: 6 } });
  assert.equal(findingOf(fixed, 'hpa-no-range').name, 'solo-hpa');
  assert.equal(findingOf(fixed, 'hpa-target-missing').name, 'ghost-hpa');
  assert.equal(findingOf(fixed, 'hpa-target-missing').detail, 'Deployment ghost not found');

  const web = deployment('web', { replicas: 3 });
  assert.ok(findingOf(analyze(baseObjects({ deployments: [web], poddisruptionbudgets: [pdbFor('other', { app: 'other' })] })), 'pdb-missing'));
  assert.equal(findingOf(analyze(baseObjects({ deployments: [web], poddisruptionbudgets: [pdbFor('web', { app: 'web' })] })), 'pdb-missing'), undefined);
  const blocking = analyze(baseObjects({ poddisruptionbudgets: [
    pdbFor('zero', { app: 'a' }, { maxUnavailable: 0 }),
    pdbFor('all', { app: 'b' }, { minAvailable: 3 }, { expectedPods: 3 }),
    pdbFor('pct', { app: 'c' }, { minAvailable: '100%' }, { expectedPods: 1 }),
    pdbFor('ok', { app: 'd' }, { minAvailable: 1 }, { expectedPods: 2 }),
  ] }));
  const byName = Object.fromEntries(blocking.findings.filter(f => f.rule === 'pdb-blocks-disruption').map(f => [f.name, f]));
  assert.deepEqual(Object.keys(byName).sort(), ['all', 'pct', 'zero']);
  assert.deepEqual(byName.zero.patch, { spec: { maxUnavailable: 1 } });
  assert.deepEqual(byName.all.patch, { spec: { minAvailable: 2 } });
  assert.equal(byName.pct.patch, undefined); // one pod: the fix is more replicas, not a different budget
});

test('services, ingresses, CronJobs, Jobs and namespaces', () => {
  const pods = [{ metadata: { name: 'web-1', namespace: 'shop', labels: { app: 'web' } } }];
  const services = [
    { metadata: { name: 'web', namespace: 'shop' }, spec: { selector: { app: 'web' } } },
    { metadata: { name: 'old', namespace: 'shop' }, spec: { selector: { app: 'gone' } } },
    { metadata: { name: 'external', namespace: 'shop' }, spec: { type: 'ExternalName', externalName: 'x.example.com' } },
    { metadata: { name: 'manual', namespace: 'shop' }, spec: {} },
  ];
  const ingresses = [{ metadata: { name: 'edge', namespace: 'shop' }, spec: { rules: [{ http: { paths: [{ backend: { service: { name: 'web' } } }, { backend: { service: { name: 'api' } } }] } }], defaultBackend: { service: { name: 'fallback' } } } }];
  const cronjobs = [
    { metadata: { name: 'warm', namespace: 'shop' }, spec: { concurrencyPolicy: 'Allow', successfulJobsHistoryLimit: 50, jobTemplate: { spec: { template: { spec: goodPod() } } } } },
    { metadata: { name: 'tidy', namespace: 'shop' }, spec: { concurrencyPolicy: 'Forbid', jobTemplate: { spec: { template: { spec: goodPod() } } } } },
  ];
  const jobs = [
    { metadata: { name: 'migrate', namespace: 'shop' }, spec: { template: { spec: goodPod() } } },
    { metadata: { name: 'warm-123', namespace: 'shop', ownerReferences: [{ kind: 'CronJob', name: 'warm' }] }, spec: { template: { spec: goodPod() } } },
  ];
  const namespaces = [{ metadata: { name: 'shop' } }, { metadata: { name: 'empty' } }, { metadata: { name: 'kube-system' } }];
  const result = analyze(baseObjects({ pods, services, ingresses, cronjobs, jobs, namespaces, limitranges: [{ metadata: { name: 'd', namespace: 'shop' } }] }));
  const of = rule => result.findings.filter(f => f.rule === rule).map(f => f.name);
  assert.deepEqual(of('service-selects-nothing'), ['old']);
  assert.deepEqual(of('ingress-backend-missing'), ['edge']);
  assert.equal(findingOf(result, 'ingress-backend-missing').detail, 'Missing: fallback, api');
  assert.deepEqual(of('cronjob-concurrency'), ['warm']);
  assert.deepEqual(findingOf(result, 'cronjob-concurrency').patch, { spec: { concurrencyPolicy: 'Forbid' } });
  assert.deepEqual(findingOf(result, 'cronjob-history').patch, { spec: { successfulJobsHistoryLimit: 3, failedJobsHistoryLimit: 1 } });
  assert.deepEqual(of('job-ttl-missing'), ['migrate']); // the CronJob's own Job is judged through the CronJob
  // Only namespaces that run something are checked, never kube-* unless asked.
  assert.deepEqual(of('namespace-no-quota'), ['shop']);
  assert.deepEqual(of('namespace-no-limitrange'), []);
  const noLimits = analyze(baseObjects({ jobs, namespaces }));
  assert.equal(findingOf(noLimits, 'namespace-no-limitrange').manifest.kind, 'LimitRange');
  assert.equal(findingOf(noLimits, 'namespace-no-limitrange').namespace, 'shop');
  // The CronJob's pod template is at spec.jobTemplate.spec.template.
  const loose = analyze(baseObjects({ cronjobs: [{ metadata: { name: 'c', namespace: 'shop' }, spec: { concurrencyPolicy: 'Forbid', jobTemplate: { spec: { template: { spec: goodPod({ containers: [goodContainer('x', { securityContext: { readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } } })] }) } } } } }] }));
  assert.deepEqual(findingOf(loose, 'privilege-escalation').patch, { spec: { jobTemplate: { spec: { template: { spec: { containers: [{ name: 'x', securityContext: { allowPrivilegeEscalation: false } }] } } } } } });
});

test('scope: namespace filter, system namespaces, bare pods', () => {
  const objects = baseObjects({
    deployments: [deployment('a', { replicas: 1, ns: 'shop', pod: { containers: [{ name: 'x', image: 'x:1' }] } }), deployment('dns', { replicas: 1, ns: 'kube-system', pod: { containers: [{ name: 'x', image: 'x:1' }] } })],
    pods: [
      { metadata: { name: 'debug', namespace: 'shop' }, spec: { containers: [{ name: 'sh', image: 'busybox', securityContext: { privileged: true } }] }, status: { phase: 'Running' } },
      { metadata: { name: 'a-123', namespace: 'shop', ownerReferences: [{ kind: 'ReplicaSet', name: 'a-1' }] }, spec: { containers: [{ name: 'x', securityContext: { privileged: true } }] }, status: { phase: 'Running' } },
      { metadata: { name: 'done', namespace: 'shop' }, spec: { containers: [{ name: 'x', securityContext: { privileged: true } }] }, status: { phase: 'Succeeded' } },
    ],
  });
  const all = analyze(objects);
  assert.ok(!all.findings.some(f => f.namespace === 'kube-system'));
  assert.ok(analyze(objects, { includeSystem: true }).findings.some(f => f.namespace === 'kube-system'));
  assert.ok(analyze(objects, { namespace: 'kube-system' }).findings.every(f => f.namespace === 'kube-system'));
  const privileged = all.findings.filter(f => f.rule === 'privileged');
  assert.deepEqual(privileged.map(f => `${f.kind}/${f.name}`), ['Pod/debug']);
  assert.equal(privileged[0].patch, undefined); // a running pod cannot be patched
  assert.ok(isSystemNamespace('kube-public') && !isSystemNamespace('shop'));
});

test('score, grade, categories and suppression', () => {
  assert.equal(gradeOf(95), 'A'); assert.equal(gradeOf(80), 'B'); assert.equal(gradeOf(79), 'C'); assert.equal(gradeOf(60), 'D'); assert.equal(gradeOf(59), 'F'); assert.equal(gradeOf(null), '—');
  const checks = [
    { id: 'c1', namespace: 'a', category: 'Security', severity: 'critical', failed: true },
    { id: 'c2', namespace: 'a', category: 'Security', severity: 'warning', failed: false },
    { id: 'c3', namespace: 'b', category: 'Reliability', severity: 'info', failed: true },
    { id: 'c4', namespace: 'b', category: 'Reliability', severity: 'warning', failed: false },
  ];
  const score = scoreOf(checks);
  // passed weight 3 + 3 = 6 of 10 + 3 + 1 + 3 = 17
  assert.equal(score.score, Math.round(600 / 17));
  assert.equal(score.grade, 'F');
  assert.equal(score.critical, 1); assert.equal(score.info, 1); assert.equal(score.warning, 0);
  assert.equal(score.categories.Security.score, Math.round(300 / 13));
  assert.equal(score.categories.Reliability.score, 75);
  assert.equal(score.categories.Efficiency.score, null);
  assert.deepEqual(score.namespaces.map(n => [n.namespace, n.score]), [['a', 23], ['b', 75]]);
  const suppressed = scoreOf(checks, new Set(['c1']));
  assert.equal(suppressed.score, Math.round(1600 / 17));
  assert.equal(suppressed.critical, 0);
  assert.equal(scoreOf([]).score, null);
  assert.deepEqual(WEIGHTS, { critical: 10, warning: 3, info: 1 });
});

test('object summary and PSS counts', () => {
  const objects = baseObjects({ deployments: [deployment('good'), deployment('bad', { pod: { containers: [{ name: 'x', image: 'x', securityContext: { privileged: true } }] } })] });
  const result = analyze(objects);
  const bad = objectSummary(result, 'deployments', 'shop', 'bad');
  assert.equal(bad.findings[0].rule, 'privileged');
  assert.equal(bad.pss.level, 'privileged');
  assert.ok(bad.score < 60);
  const good = objectSummary(result, 'deployments', 'shop', 'good');
  assert.deepEqual(good.findings.map(f => f.rule), ['pdb-missing']);
  const hidden = objectSummary(result, 'deployments', 'shop', 'good', new Set(['pdb-missing|deployments|shop|good']));
  assert.deepEqual(hidden.findings, []); assert.equal(hidden.score, 100);
  assert.deepEqual(pssCounts(result.pss), { privileged: 1, baseline: 0, restricted: 1 });
});

test('filtering and grouping findings', () => {
  const result = analyze(baseObjects({ deployments: [deployment('api', { pod: { containers: [{ name: 'x', image: 'x', securityContext: { privileged: true } }] } }), deployment('web', { pod: { containers: [{ name: 'y', image: 'y:latest' }] } })] }));
  const all = result.findings;
  assert.ok(filterFindings(all, { severities: new Set(['critical']) }).every(f => f.severity === 'critical'));
  assert.ok(filterFindings(all, { categories: new Set(['Efficiency']) }).every(f => f.category === 'Efficiency'));
  assert.deepEqual([...new Set(filterFindings(all, { text: 'web latest' }).map(f => f.rule))], ['image-latest']);
  const suppressed = new Set([all[0].id]);
  assert.equal(filterFindings(all, { suppressed }).length, all.length - 1);
  assert.equal(filterFindings(all, { suppressed, showSuppressed: true }).length, all.length);
  const byRule = groupFindings(all, 'rule');
  assert.equal(byRule[0].rule.id, 'privileged'); // the worst first
  assert.ok(byRule.find(g => g.rule.id === 'pdb-missing').findings.length === 2);
  const byWorkload = groupFindings(all, 'workload');
  assert.deepEqual(byWorkload.map(g => g.name), ['api', 'web']);
  assert.equal(byWorkload[0].kind, 'Deployment');
});

test('strategic merge, cleaning and the Fix document', () => {
  const live = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'api', namespace: 'shop', uid: 'u', resourceVersion: '9', generation: 3, creationTimestamp: '2026-01-01T00:00:00Z', managedFields: [{}], annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{}', 'deployment.kubernetes.io/revision': '4', team: 'shop' }, labels: { app: 'api' } },
    spec: { replicas: 2, template: { metadata: { creationTimestamp: null, labels: { app: 'api' } }, spec: { containers: [{ name: 'app', image: 'a:1', env: [{ name: 'A', value: '1' }], securityContext: { runAsUser: 1000 } }, { name: 'side', image: 's:1' }], volumes: [{ name: 'v', emptyDir: {} }] } } }, status: { replicas: 2 } };
  const clean = cleanForApply(live);
  assert.deepEqual(Object.keys(clean.metadata).sort(), ['annotations', 'labels', 'name', 'namespace']);
  assert.deepEqual(clean.metadata.annotations, { team: 'shop' });
  assert.equal(clean.status, undefined);
  assert.ok(!('creationTimestamp' in clean.spec.template.metadata));
  assert.equal(live.metadata.uid, 'u'); // the input is not changed
  const patch = { spec: { template: { spec: { containers: [{ name: 'app', securityContext: { allowPrivilegeEscalation: false }, env: [{ name: 'B', value: '2' }] }, { name: 'new', image: 'n:1' }], securityContext: { runAsNonRoot: true } } } } };
  const merged = applyPatch(clean, patch);
  const [app, side, added] = merged.spec.template.spec.containers;
  assert.deepEqual(app.securityContext, { runAsUser: 1000, allowPrivilegeEscalation: false });
  assert.deepEqual(app.env, [{ name: 'A', value: '1' }, { name: 'B', value: '2' }]);
  assert.equal(side.image, 's:1'); assert.equal(added.name, 'new');
  assert.deepEqual(merged.spec.template.spec.securityContext, { runAsNonRoot: true });
  assert.deepEqual(applyPatch({ a: { b: 1, c: 2 }, l: [1, 2] }, { a: { b: null }, l: [3] }), { a: { c: 2 }, l: [3] });
  assert.deepEqual(applyPatch({ spec: { template: { spec: { containers: [{ name: 'a', securityContext: { capabilities: { add: ['NET_ADMIN', 'CHOWN'] } } }] } } } }, { spec: { template: { spec: { containers: [{ name: 'a', securityContext: { capabilities: { add: ['CHOWN'] } } }] } } } }).spec.template.spec.containers[0].securityContext.capabilities.add, ['CHOWN']);

  const finding = { resource: 'deployments', namespace: 'shop', name: 'api', patch };
  const doc = fixDocument(finding, live);
  assert.equal(doc.spec.template.spec.containers[0].securityContext.allowPrivilegeEscalation, false);
  assert.equal(doc.metadata.resourceVersion, undefined);
  const manifest = { apiVersion: 'v1', kind: 'LimitRange', metadata: { name: 'defaults', namespace: 'shop' } };
  assert.equal(fixDocument({ manifest }, null), manifest);
  assert.equal(fixDocument({ resource: 'jobs' }, live), null);
});

test('patch text for the clipboard', () => {
  const text = patchText({ resource: 'deployments', namespace: 'shop', name: 'api', patch: { spec: { replicas: 2 } } }, 'prod-eu');
  assert.equal(text, `kubectl --context 'prod-eu' -n 'shop' patch deployments 'api' --type=strategic -p '{"spec":{"replicas":2}}'`);
  assert.match(patchText({ resource: 'deployments', namespace: 'shop', name: 'x', patch: { a: "it's" } }), /it'\\''s/);
  assert.equal(YAML.parse(patchText({ manifest: { kind: 'LimitRange', metadata: { name: 'd' } } })).kind, 'LimitRange');
  assert.equal(patchText({ resource: 'deployments', name: 'x' }), '');
});

test('managed-by detection', () => {
  assert.equal(managedBy({ metadata: { labels: { 'app.kubernetes.io/managed-by': 'Helm' } } }), 'Helm');
  assert.equal(managedBy({ metadata: { annotations: { 'argocd.argoproj.io/tracking-id': 'payments:apps/Deployment:payments/api' } } }), 'Argo CD');
  assert.equal(managedBy({ metadata: { labels: { app: 'x' } } }), '');
});

test('YAML writer round-trips through a real YAML parser', () => {
  const value = {
    apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'api', labels: { 'app.kubernetes.io/name': 'api', version: '1.10', on: 'yes' }, annotations: { 'prometheus.io/scrape': 'true', note: 'a: b # not a comment', empty: '' } },
    spec: { replicas: 2, paused: false, ratio: 0.5, nothing: null, list: [], map: {}, nested: [[1, 2], []],
      template: { spec: { containers: [{ name: 'app', image: 'registry.example.com/app:1.2', args: ['--port=8080', '-v', '0', 'multi\nline', "quote's \"double\""], ports: [{ containerPort: 8080 }], resources: { limits: { cpu: '250m', memory: '128Mi' } } }, { name: 'empty', env: [] }] } } },
    'with space': '~', star: '*', dash: '- x', colon: 'http://x',
  };
  const text = toYAML(value);
  assert.deepEqual(YAML.parse(text), JSON.parse(JSON.stringify(value)));
  assert.match(text, /^apiVersion: apps\/v1\nkind: Deployment\nmetadata:\n {2}name: api\n/);
  assert.match(text, /\n {6}containers:\n {6}- name: app\n {8}image: registry.example.com\/app:1.2\n/);
  assert.match(text, /cpu: 250m\n {12}memory: 128Mi\n/);
  assert.match(text, /version: "1.10"\n {4}"on": "yes"/);
  assert.deepEqual(YAML.parse(toYAML({ 1: 'numeric key', 'a:': 'x:' })), { 1: 'numeric key', 'a:': 'x:' });
  assert.equal(toYAML([]), '[]\n');
  assert.equal(toYAML('true'), '"true"\n');
});
