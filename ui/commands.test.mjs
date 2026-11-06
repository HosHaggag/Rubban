import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, suggestVerbs, helpFor, targetKinds, rankTargets, matchContexts, matchNamespaces, matchViews, previousRevision, forwardPreset, pickPod, defaultContainer, isDestructive, describeCommand, remember, distance, kindOfWord, kindsText, VERBS, RECENT_MAX } from './commands.js';

// The parts of an intent a case cares about.
const pick = (text, keys = ['verb', 'kindHint', 'nameQuery', 'args', 'namespace', 'context', 'errors']) => {
  const intent = parseCommand(text);
  return intent && Object.fromEntries(keys.map(key => [key, intent[key]]));
};
const target = (verb, nameQuery, extra = {}) => ({ verb, kindHint: '', nameQuery, args: {}, namespace: '', context: '', errors: [], ...extra });

test('plain searches are not commands', () => {
  for (const text of ['', '   ', 'storefront', 'pods', 'payments-api', 'Deployments', 'take the tour']) assert.equal(parseCommand(text), null, text);
});

test('restart, with synonyms, kind words and kubectl spellings', () => {
  assert.deepEqual(pick('restart storefront'), target('restart', 'storefront'));
  assert.deepEqual(pick('  Restart   StoreFront  '), target('restart', 'storefront'));
  assert.deepEqual(pick('bounce storefront'), target('restart', 'storefront'));
  assert.deepEqual(pick('restart deployment storefront'), target('restart', 'storefront', { kindHint: 'deployments' }));
  assert.deepEqual(pick('restart deploy/storefront'), target('restart', 'storefront', { kindHint: 'deployments' }));
  assert.deepEqual(pick('restart shop/storefront'), target('restart', 'storefront', { namespace: 'shop' }));
  assert.deepEqual(pick('restart storefront deployment'), target('restart', 'storefront', { kindHint: 'deployments' }));
  assert.deepEqual(pick('kubectl rollout restart deploy/storefront -n shop'), target('restart', 'storefront', { kindHint: 'deployments', namespace: 'shop' }));
  assert.deepEqual(pick('rollout restart sts/db --context=staging'), target('restart', 'db', { kindHint: 'statefulsets', context: 'staging' }));
  assert.deepEqual(pick('restart the storefront please'), target('restart', 'storefront'));
});

test('scale: a number in any of the usual spellings', () => {
  for (const text of ['scale cart 3', 'scale cart to 3', 'scale cart=3', 'scale cart = 3', 'scale cart to 3 replicas', 'scale 3 cart', 'resize cart 3']) {
    assert.deepEqual(pick(text), target('scale', 'cart', { args: { replicas: 3 } }), text);
  }
  assert.deepEqual(pick('scale cart'), target('scale', 'cart'));
  assert.deepEqual(pick('scale rs cart-5f6d 0'), target('scale', 'cart-5f6d', { kindHint: 'replicasets', args: { replicas: 0 } }));
  assert.deepEqual(pick('scale cart 200000').errors, ['Replicas must be between 0 and 100000.']);
  assert.equal(isDestructive(parseCommand('scale cart 0')), true);
  assert.equal(isDestructive(parseCommand('scale cart 1')), false);
});

test('logs, shell and their synonyms', () => {
  assert.deepEqual(pick('logs orders'), target('logs', 'orders'));
  assert.deepEqual(pick('tail orders in shop'), target('logs', 'orders', { namespace: 'shop' }));
  assert.deepEqual(pick('logs for orders'), target('logs', 'orders'));
  assert.deepEqual(pick('logs pod orders-7d9-x'), target('logs', 'orders-7d9-x', { kindHint: 'pods' }));
  for (const word of ['shell', 'exec', 'ssh', 'sh']) assert.deepEqual(pick(`${word} cart`), target('shell', 'cart'), word);
  // A kind with no name yet: the palette asks for the name.
  assert.deepEqual(pick('logs pod'), target('logs', '', { kindHint: 'pods' }));
});

test('port-forward: one port, local:remote, or two ports', () => {
  assert.deepEqual(pick('pf storefront 8080'), target('forward', 'storefront', { args: { port: 8080 } }));
  assert.deepEqual(pick('forward storefront 8080:80'), target('forward', 'storefront', { args: { localPort: 8080, remotePort: 80 } }));
  assert.deepEqual(pick('port-forward svc/storefront :80'), target('forward', 'storefront', { kindHint: 'services', args: { remotePort: 80 } }));
  assert.deepEqual(pick('port forward storefront 9000 80'), target('forward', 'storefront', { args: { localPort: 9000, remotePort: 80 } }));
  assert.deepEqual(pick('pf storefront'), target('forward', 'storefront'));
  assert.deepEqual(pick('pf storefront 99999').errors, ['Port 99999 is out of range (1–65535).']);
});

test('describe, yaml, rollback, delete, nodes, cronjobs', () => {
  assert.deepEqual(pick('describe payments-api'), target('describe', 'payments-api'));
  assert.deepEqual(pick('open payments-api'), target('describe', 'payments-api'));
  assert.deepEqual(pick('yaml storefront'), target('yaml', 'storefront'));
  assert.deepEqual(pick('edit cm/app-config'), target('yaml', 'app-config', { kindHint: 'configmaps' }));
  assert.deepEqual(pick('rollback storefront'), target('rollback', 'storefront'));
  assert.deepEqual(pick('undo storefront'), target('rollback', 'storefront'));
  assert.deepEqual(pick('roll back storefront to revision 3'), target('rollback', 'storefront', { args: { revision: 3 } }));
  assert.deepEqual(pick('rollout undo deploy/storefront'), target('rollback', 'storefront', { kindHint: 'deployments' }));
  assert.deepEqual(pick('delete pod cart-1'), target('delete', 'cart-1', { kindHint: 'pods' }));
  assert.deepEqual(pick('rm ns ft-actions'), target('delete', 'ft-actions', { kindHint: 'namespaces' }));
  assert.deepEqual(pick('cordon node worker-2'), target('cordon', 'worker-2', { kindHint: 'nodes' }));
  assert.deepEqual(pick('uncordon worker-2'), target('uncordon', 'worker-2'));
  assert.deepEqual(pick('drain worker-2'), target('drain', 'worker-2'));
  assert.deepEqual(pick('trigger cronjob nightly-report'), target('trigger', 'nightly-report', { kindHint: 'cronjobs' }));
  assert.deepEqual(pick('run nightly-report'), target('trigger', 'nightly-report'));
  assert.equal(isDestructive(parseCommand('delete pod x')), true);
  assert.equal(isDestructive(parseCommand('drain worker-2')), true);
  assert.equal(isDestructive(parseCommand('cordon worker-2')), false);
});

test('compare with another cluster', () => {
  assert.deepEqual(pick('compare storefront with staging'), target('compare', 'storefront', { args: { with: 'staging' } }));
  assert.deepEqual(pick('compare storefront to staging-eu-west-1'), target('compare', 'storefront', { args: { with: 'staging-eu-west-1' } }));
  assert.deepEqual(pick('diff storefront staging'), target('compare', 'storefront', { args: { with: 'staging' } }));
  assert.deepEqual(pick('compare deploy storefront staging'), target('compare', 'storefront', { kindHint: 'deployments', args: { with: 'staging' } }));
  assert.deepEqual(pick('compare storefront on prod with staging'), target('compare', 'storefront', { context: 'prod', args: { with: 'staging' } }));
  assert.deepEqual(pick('compare storefront').errors, ['Compare with which cluster? e.g. compare storefront with staging']);
});

test('namespace, cluster, new tab and theme', () => {
  assert.deepEqual(pick('ns shop', ['verb', 'namespace', 'errors']), { verb: 'namespace', namespace: 'shop', errors: [] });
  assert.deepEqual(pick('namespace shop', ['verb', 'namespace']), { verb: 'namespace', namespace: 'shop' });
  assert.deepEqual(pick('in shop', ['verb', 'namespace']), { verb: 'namespace', namespace: 'shop' });
  assert.deepEqual(pick('in payments on staging', ['verb', 'namespace', 'context']), { verb: 'namespace', namespace: 'payments', context: 'staging' });
  for (const text of ['ns all', 'ns *', 'namespace all namespaces']) assert.equal(parseCommand(text).namespace, '*', text);
  assert.deepEqual(pick('ns', ['verb', 'namespace', 'errors']), { verb: 'namespace', namespace: '', errors: [] });
  for (const text of ['ctx staging', 'use staging', 'switch to staging', 'switch staging', 'context staging']) assert.deepEqual(pick(text, ['verb', 'context']), { verb: 'context', context: 'staging' }, text);
  assert.deepEqual(pick('new tab staging', ['verb', 'context']), { verb: 'newtab', context: 'staging' });
  assert.deepEqual(pick('open tab prod-eu', ['verb', 'context']), { verb: 'newtab', context: 'prod-eu' });
  for (const [text, theme] of [['theme dark', 'dark'], ['theme light', 'light'], ['theme system', 'system'], ['theme auto', 'system'], ['theme to dark', 'dark']]) assert.equal(parseCommand(text).args.theme, theme, text);
  assert.deepEqual(parseCommand('theme purple').errors, ['Theme is dark, light or system.']);
  assert.deepEqual(parseCommand('theme').args, {});
});

test('go to a view, with a namespace and a cluster', () => {
  assert.deepEqual(pick('go pods', ['verb', 'nameQuery', 'namespace', 'context']), { verb: 'go', nameQuery: 'pods', namespace: '', context: '' });
  assert.deepEqual(pick('go to settings', ['verb', 'nameQuery']), { verb: 'go', nameQuery: 'settings' });
  assert.deepEqual(pick('pods in shop', ['verb', 'nameQuery', 'namespace']), { verb: 'go', nameQuery: 'pods', namespace: 'shop' });
  assert.deepEqual(pick('deployments in payments on staging', ['verb', 'nameQuery', 'namespace', 'context']), { verb: 'go', nameQuery: 'deployments', namespace: 'payments', context: 'staging' });
  assert.deepEqual(pick('get pods -n shop', ['verb', 'nameQuery', 'namespace']), { verb: 'go', nameQuery: 'pods', namespace: 'shop' });
  assert.deepEqual(pick('svc @staging', ['verb', 'nameQuery', 'context']), { verb: 'go', nameQuery: 'svc', context: 'staging' });
  assert.deepEqual(pick('show pods in shop', ['verb', 'nameQuery', 'namespace']), { verb: 'go', nameQuery: 'pods', namespace: 'shop' });
  assert.deepEqual(pick('pods in all', ['verb', 'namespace']), { verb: 'go', namespace: '*' });
  assert.equal(parseCommand('problems').verb, 'problems');
  assert.equal(parseCommand('help').verb, 'help');
  assert.equal(parseCommand('?').verb, 'help');
  assert.equal(parseCommand('help scale').args.topic, 'scale');
});

test('mistakes are reported, not guessed', () => {
  assert.deepEqual(pick('restart storefront extra words').errors, ['Did not understand “extra words”.']);
  assert.deepEqual(pick('restart Store_Front').errors, ['“store_front” is not a Kubernetes name.']);
  assert.deepEqual(pick('logs orders in').errors, ['Which namespace? e.g. … in shop']);
  assert.deepEqual(pick('problems now please').errors, []);
  assert.deepEqual(pick('problems everywhere').errors, ['Did not understand “everywhere”.']);
  assert.deepEqual(pick('ns shop payments').errors, ['Did not understand “shop payments”.']);
});

test('verb completion for a partly typed first word', () => {
  assert.deepEqual(suggestVerbs('res').map(item => item.completion), ['restart ', 'resize ']);
  assert.equal(suggestVerbs('sc')[0].completion, 'scale ');
  assert.equal(suggestVerbs('ne')[0].completion, 'new tab ');
  assert.equal(suggestVerbs('un')[0].verb, 'uncordon');
  assert.deepEqual(suggestVerbs('restart'), [], 'a whole verb needs no completion');
  assert.deepEqual(suggestVerbs('restart sto'), [], 'only the first word completes');
  assert.deepEqual(suggestVerbs('zz'), []);
  assert.deepEqual(suggestVerbs(''), []);
  assert.ok(suggestVerbs('s', 10).length <= 10);
});

test('help lists every verb with an example, or one topic', () => {
  const all = helpFor();
  assert.equal(all.length, VERBS.length);
  assert.ok(all.every(item => item.example && item.summary && item.words.length));
  assert.deepEqual(helpFor('scale').map(item => item.verb), ['scale']);
  assert.ok(helpFor('tab').some(item => item.verb === 'newtab'));
  assert.ok(helpFor('new').find(item => item.verb === 'newtab').words.includes('new tab'));
});

test('the kinds a verb looks through', () => {
  assert.deepEqual(targetKinds(parseCommand('restart storefront')).kinds, ['deployments', 'statefulsets', 'daemonsets']);
  assert.deepEqual(targetKinds(parseCommand('scale cart 3')).kinds, ['deployments', 'statefulsets', 'replicasets']);
  assert.deepEqual(targetKinds(parseCommand('restart deployment storefront')).kinds, ['deployments']);
  assert.equal(targetKinds(parseCommand('describe storefront')).kinds, null);
  assert.ok(!targetKinds(parseCommand('compare storefront with staging')).kinds.includes('secrets'));
  const wrong = targetKinds(parseCommand('restart svc storefront'));
  assert.deepEqual(wrong.kinds, []);
  assert.equal(wrong.error, 'Restart works on Deployments, StatefulSets and DaemonSets, not Services.');
  assert.equal(kindsText(['nodes']), 'Nodes');
  assert.equal(kindOfWord('Deploy'), 'deployments');
  assert.equal(kindOfWord('storefront'), '');
});

test('targets: exact names first, the tab cluster and namespace first, then the rest in search order', () => {
  const answers = [
    { context: 'prod', results: [
      { resource: 'services', kind: 'Service', namespace: 'shop', name: 'storefront' },
      { resource: 'deployments', kind: 'Deployment', namespace: 'shop', name: 'storefront' },
      { resource: 'deployments', kind: 'Deployment', namespace: 'shop', name: 'storefront-admin' },
      { resource: 'pods', kind: 'Pod', namespace: 'shop', name: 'storefront-6d9-x' },
    ] },
    { context: 'staging', results: [
      { resource: 'deployments', kind: 'Deployment', namespace: 'shop', name: 'storefront' },
      { resource: 'statefulsets', kind: 'StatefulSet', namespace: 'qa', name: 'storefront' },
    ] },
  ];
  const restart = rankTargets(parseCommand('restart storefront'), answers, { tabContext: 'staging' });
  assert.equal(restart.best.context, 'staging');
  assert.equal(restart.best.resource, 'deployments');
  assert.deepEqual(restart.targets.map(t => `${t.context}:${t.kind}/${t.name}`), ['staging:Deployment/storefront', 'staging:StatefulSet/storefront', 'prod:Deployment/storefront', 'prod:Deployment/storefront-admin']);
  assert.equal(restart.exact.length, 3);
  // The tab's namespace breaks the tie between two exact names in the tab's cluster.
  assert.equal(rankTargets(parseCommand('restart storefront'), answers, { tabContext: 'staging', tabNamespace: 'qa' }).best.kind, 'StatefulSet');
  // A kind word and a namespace narrow it.
  assert.deepEqual(rankTargets(parseCommand('describe svc storefront'), answers, { tabContext: 'prod' }).targets.map(t => t.kind), ['Service']);
  assert.deepEqual(rankTargets(parseCommand('restart storefront in qa'), answers, { tabContext: 'prod' }).targets.map(t => t.context), ['staging']);
  // No exact name: candidates only, no best.
  const fuzzy = rankTargets(parseCommand('logs storef'), answers, { tabContext: 'prod' });
  assert.equal(fuzzy.best, null);
  assert.deepEqual(fuzzy.targets.map(t => t.name), ['storefront', 'storefront-admin', 'storefront-6d9-x', 'storefront', 'storefront']);
  assert.equal(rankTargets(parseCommand('restart svc storefront'), answers, {}).targets.length, 0);
  assert.equal(rankTargets(parseCommand('restart storefront'), answers, { limit: 1 }).targets.length, 2, 'every exact match is kept, up to twice the limit');
  assert.deepEqual(rankTargets(parseCommand('restart storefront'), undefined, {}).targets, []);
});

test('clusters, namespaces and views by forgiving names', () => {
  const contexts = [{ name: 'prod-eu-west-1', label: 'Production EU' }, { name: 'staging-eu-west-1', label: 'staging-eu-west-1' }, { name: 'kind-dev', label: 'Dev' }];
  assert.deepEqual(matchContexts('staging', contexts), ['staging-eu-west-1']);
  assert.deepEqual(matchContexts('production', contexts), ['prod-eu-west-1']);
  assert.deepEqual(matchContexts('dev', contexts), ['kind-dev']);
  assert.deepEqual(matchContexts('eu', contexts), ['prod-eu-west-1', 'staging-eu-west-1']);
  assert.deepEqual(matchContexts('stagnig', contexts), ['staging-eu-west-1'], 'a small typo still finds it');
  assert.deepEqual(matchContexts('nothing-like-it', contexts), []);
  assert.equal(matchContexts('', contexts).length, 3);
  assert.deepEqual(matchNamespaces('shop', ['shop', 'shopping', 'workshop']), ['shop', 'shopping', 'workshop']);
  assert.deepEqual(matchNamespaces('shpo', ['shop', 'payments']), ['shop']);
  const views = [
    { title: 'Pods', section: 'resource', resource: 'pods' }, { title: 'Deployments', section: 'resource', resource: 'deployments' },
    { title: 'Horizontal Pod Autoscalers', section: 'resource', resource: 'horizontalpodautoscalers' }, { title: 'Settings', section: 'settings' },
    { title: 'Releases', tabTitle: 'Helm Releases', section: 'helm' }, { title: 'Problems', section: 'problems' },
  ];
  assert.equal(matchViews('po', views)[0].resource, 'pods');
  assert.equal(matchViews('deploy', views)[0].resource, 'deployments');
  assert.equal(matchViews('hpa', views)[0].resource, 'horizontalpodautoscalers');
  assert.equal(matchViews('settings', views)[0].section, 'settings');
  assert.equal(matchViews('helm', views)[0].section, 'helm');
  assert.equal(matchViews('sett', views)[0].section, 'settings');
  assert.deepEqual(matchViews('', views), []);
  assert.deepEqual(matchViews('qqqq', views), []);
  assert.equal(distance('kitten', 'sitting'), 3);
  assert.equal(distance('a', 'abcdefgh', 2), 3);
});

test('rollback finds the previous revision', () => {
  assert.equal(previousRevision([1, 2, 3, 4], 4), 3);
  assert.equal(previousRevision([1, 3, 5], 5), 3);
  assert.equal(previousRevision([5, 6], 6), 5);
  assert.equal(previousRevision([2], 2), null);
  assert.equal(previousRevision([], 1), null);
  assert.equal(previousRevision(['2', '7', 'x'], 9), 7);
});

test('forward ports: one port used on both sides when the target has it', () => {
  const ports = [{ port: 80 }, { port: 9090 }];
  assert.deepEqual(forwardPreset({ port: 9090 }, ports), { port: 9090, localPort: 9090 });
  assert.deepEqual(forwardPreset({ port: 8080 }, ports), { port: 80, localPort: 8080 });
  assert.deepEqual(forwardPreset({ port: 8080 }, []), { port: 8080, localPort: 8080 });
  assert.deepEqual(forwardPreset({ localPort: 8080, remotePort: 80 }, ports), { port: 80, localPort: 8080 });
  assert.deepEqual(forwardPreset({ remotePort: 443 }, ports), { port: 443, localPort: '' });
  assert.deepEqual(forwardPreset({}, ports), { port: 80, localPort: '' });
  assert.deepEqual(forwardPreset(undefined, undefined), { port: undefined, localPort: '' });
});

test('a workload shell picks its first ready pod and the default container', () => {
  const ready = { type: 'Ready', status: 'True' };
  const pods = [
    { metadata: { name: 'a' }, status: { phase: 'Pending' } },
    { metadata: { name: 'b', deletionTimestamp: '2026-01-01T00:00:00Z' }, status: { phase: 'Running', conditions: [ready] } },
    { metadata: { name: 'c' }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'False' }] } },
    { metadata: { name: 'd' }, status: { phase: 'Running', conditions: [ready] } },
  ];
  assert.equal(pickPod(pods).metadata.name, 'd');
  assert.equal(pickPod(pods.slice(0, 3)), null);
  assert.equal(pickPod(undefined), null);
  assert.equal(defaultContainer({ spec: { containers: [{ name: 'istio-proxy' }, { name: 'app' }] } }), 'app');
  assert.equal(defaultContainer({ metadata: { annotations: { 'kubectl.kubernetes.io/default-container': 'web' } }, spec: { containers: [{ name: 'app' }, { name: 'web' }] } }), 'web');
  assert.equal(defaultContainer({}), '');
});

test('rows say what will run', () => {
  const deployment = { resource: 'deployments', kind: 'Deployment', namespace: 'shop', name: 'storefront' };
  assert.equal(describeCommand(parseCommand('restart storefront'), deployment), 'Restart Deployment shop/storefront');
  assert.equal(describeCommand(parseCommand('scale storefront to 3'), deployment), 'Scale Deployment shop/storefront to 3');
  assert.equal(describeCommand(parseCommand('scale storefront'), deployment), 'Scale Deployment shop/storefront…');
  assert.equal(describeCommand(parseCommand('rollback storefront'), deployment), 'Roll back Deployment shop/storefront to the previous revision');
  assert.equal(describeCommand(parseCommand('rollback storefront 3'), deployment), 'Roll back Deployment shop/storefront to revision 3');
  assert.equal(describeCommand(parseCommand('shell storefront'), deployment), 'Shell into Deployment shop/storefront (first ready pod)');
  assert.equal(describeCommand(parseCommand('pf storefront 8080:80'), { ...deployment, kind: 'Service', resource: 'services' }), 'Port-forward Service shop/storefront · 8080 → 80');
  assert.equal(describeCommand(parseCommand('pf storefront'), deployment), 'Port-forward Deployment shop/storefront…');
  assert.equal(describeCommand(parseCommand('cordon worker'), { resource: 'nodes', kind: 'Node', name: 'worker' }), 'Cordon Node worker');
  assert.equal(describeCommand(parseCommand('trigger nightly'), { resource: 'cronjobs', kind: 'CronJob', namespace: 'data', name: 'nightly' }), 'Run CronJob data/nightly now');
});

test('recent commands: newest first, no repeats, at most 20', () => {
  assert.deepEqual(remember(['b', 'a'], 'c'), ['c', 'b', 'a']);
  assert.deepEqual(remember(['b', 'a'], ' a '), ['a', 'b']);
  assert.deepEqual(remember(null, 'x'), ['x']);
  assert.deepEqual(remember(['x', 3, ''], ''), ['x']);
  const many = Array.from({ length: 30 }, (_, i) => `cmd ${i}`);
  assert.equal(remember(many, 'new').length, RECENT_MAX);
  assert.equal(remember(many, 'new')[0], 'new');
});
