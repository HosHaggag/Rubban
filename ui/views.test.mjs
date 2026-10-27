import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { jsonPath } from './format.js';
import { podQueries, nodeQueries, clusterQueries, namespaceQueries, pvcQueries, podPattern, stepFor } from './promql.js';
import { TEMPLATES, templateFor } from './templates.js';

const require = createRequire(import.meta.url);
const YAML = require('yaml');

test('printer-column JSONPath handles fields, indexes, wildcards and filters', () => {
  const object = { spec: { replicas: 3, hosts: ['a', 'b'] }, status: { conditions: [{ type: 'Ready', status: 'True', reason: 'Ok' }, { type: 'Synced', status: 'False' }] }, metadata: { labels: { 'app.kubernetes.io/name': 'web' } } };
  assert.deepEqual(jsonPath(object, '.spec.replicas'), [3]);
  assert.deepEqual(jsonPath(object, '.spec.hosts[0]'), ['a']);
  assert.deepEqual(jsonPath(object, '.spec.hosts[-1]'), ['b']);
  assert.deepEqual(jsonPath(object, '.spec.hosts[*]'), ['a', 'b']);
  assert.deepEqual(jsonPath(object, '.status.conditions[?(@.type=="Ready")].status'), ['True']);
  assert.deepEqual(jsonPath(object, ".status.conditions[?(@.type!='Ready')].type"), ['Synced']);
  assert.deepEqual(jsonPath(object, '{.spec.replicas}'), [3]);
  assert.deepEqual(jsonPath(object, '.missing.field'), []);
});

test('PromQL builders quote label values and scope workload pods', () => {
  const pod = podQueries('team-a', 'web-1');
  assert.match(pod.cpu, /^sum\(rate\(container_cpu_usage_seconds_total\{namespace="team-a",pod=~"web-1",container!="",container!="POD"\}\[5m\]\)\)$/);
  assert.match(podQueries('team-a', 'web-1', 'nginx').memory, /container="nginx"/);
  assert.match(podQueries('ns', ['a.b', 'c']).cpu, /pod=~"a\\\\.b\|c"/);
  const pattern = podPattern('Deployment', 'web');
  assert.equal(pattern.regex, 'web-[a-z0-9]+-[a-z0-9]+');
  assert.match(new RegExp(`^${pattern.regex}$`).source, /web/);
  assert.ok(new RegExp(`^${podPattern('StatefulSet', 'db').regex}$`).test('db-0'));
  assert.ok(!new RegExp(`^${podPattern('StatefulSet', 'db').regex}$`).test('db-x'));
  assert.match(nodeQueries('node-a', '10.0.0.1').cpu, /node="node-a"/);
  assert.match(nodeQueries('node-a', '10.0.0.1').cpu, /instance=~"\(node-a\|10\\\\\.0\\\\\.0\\\\\.1\)\(:\[0-9\]\+\)\?"/);
  assert.match(clusterQueries(['n1']).cpu, /node=~"n1"/);
  assert.doesNotMatch(clusterQueries(null).cpu, /node=~/);
  assert.match(namespaceQueries('a"b').cpu, /namespace="a\\"b"/);
  assert.match(pvcQueries('ns', 'data').used, /persistentvolumeclaim="data"/);
  assert.equal(stepFor(3600), 15);
  assert.equal(stepFor(7 * 86400), 2520);
});

test('every create template is valid YAML for its kind and maps to its resource view', () => {
  for (const template of TEMPLATES) {
    const docs = YAML.parseAllDocuments(template.build('team-a')).map(doc => doc.toJS());
    assert.equal(docs[0].kind, template.kind, template.kind);
    assert.ok(docs[0].apiVersion, `${template.kind} has apiVersion`);
    assert.ok(docs[0].metadata?.name, `${template.kind} has a name`);
  }
  assert.equal(templateFor('deployments').kind, 'Deployment');
  assert.equal(templateFor('ingresses').kind, 'Ingress');
  assert.equal(templateFor('networkpolicies').kind, 'NetworkPolicy');
  assert.equal(templateFor('priorityclasses').kind, 'PriorityClass');
  assert.equal(templateFor('endpoints').kind, 'Endpoints');
  assert.equal(templateFor('verticalpodautoscalers.autoscaling.k8s.io').kind, 'VerticalPodAutoscaler');
  assert.equal(templateFor('nodes'), null);
});

test('windowed tables render the visible rows plus overscan, and nothing extra while scrolling inside it', async () => {
  const { windowRange, covers } = await import('./virtual.js');
  // 2000 rows of 33px; the viewport shows rows 100–121.
  assert.deepEqual(windowRange({ count: 2000, rowHeight: 33, offset: 3300, height: 700, overscan: 10 }), [90, 132]);
  // List starts below the visible area (page heading above it): first rows only.
  assert.deepEqual(windowRange({ count: 2000, rowHeight: 33, offset: -200, height: 700, overscan: 10 }), [0, 26]);
  // Hidden or scrolled past: the nearest edge, never an empty window.
  assert.deepEqual(windowRange({ count: 2000, rowHeight: 33, offset: -5000, height: 700, overscan: 10 }), [0, 20]);
  assert.deepEqual(windowRange({ count: 50, rowHeight: 33, offset: 5000, height: 700, overscan: 10 }), [30, 50]);
  assert.deepEqual(windowRange({ count: 0, rowHeight: 33, offset: 0, height: 700 }), [0, 0]);
  // Scrolling within the rendered overscan needs no re-render; past it does.
  const rendered = windowRange({ count: 2000, rowHeight: 33, offset: 3300, height: 700, overscan: 10 });
  assert.ok(covers(rendered, windowRange({ count: 2000, rowHeight: 33, offset: 3500, height: 700, overscan: 0 })));
  assert.ok(!covers(rendered, windowRange({ count: 2000, rowHeight: 33, offset: 4000, height: 700, overscan: 0 })));
});
