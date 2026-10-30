'use strict';

// RabbitMQ management consoles in the cluster: find them, resolve the initial (default) login the
// deployment was created with, and open the console through a port forward plus an embed proxy.
//
// Instances are Services that expose the management port (15672, or a port named management /
// http-stats). The login is looked up, in order, from:
//  - the RabbitMQ Cluster Operator's "<cluster>-default-user" Secret (username / password keys);
//  - RABBITMQ_DEFAULT_USER / RABBITMQ_DEFAULT_PASS (official image) or RABBITMQ_USERNAME /
//    RABBITMQ_PASSWORD (Bitnami) on the RabbitMQ container: literal values, secretKeyRef,
//    envFrom Secrets, or *_FILE variables pointing into a mounted Secret;
//  - RabbitMQ's built-in guest / guest, which RabbitMQ accepts only from localhost — a port
//    forward arrives on the pod's loopback interface, so it works here.
// Lists never carry credential values; /api/rabbitmq/credentials returns them on request.

const MANAGEMENT_PORT_NAMES = new Set(['management', 'http-stats', 'http-management', 'mgmt', 'rabbitmq-management']);
const TLS_PORT_NAMES = new Set(['management-tls', 'https-stats', 'management-https']);
const USER_ENV = ['RABBITMQ_DEFAULT_USER', 'RABBITMQ_USERNAME'];
const PASS_ENV = ['RABBITMQ_DEFAULT_PASS', 'RABBITMQ_PASSWORD'];

function managementPort(service) {
  const ports = service.spec?.ports || [];
  const plain = ports.find(p => p.port === 15672 || p.targetPort === 15672 || MANAGEMENT_PORT_NAMES.has(p.name) || p.targetPort === 'management');
  if (plain) return { port: plain.port, name: plain.name || '', scheme: 'http' };
  const tls = ports.find(p => p.port === 15671 || p.targetPort === 15671 || TLS_PORT_NAMES.has(p.name));
  return tls ? { port: tls.port, name: tls.name || '', scheme: 'https' } : null;
}
const selectorText = selector => Object.entries(selector || {}).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(',');
const isReady = pod => pod.status?.phase === 'Running' && (pod.status?.conditions || []).some(c => c.type === 'Ready' && c.status === 'True');
const imageOf = container => container?.image || '';
const versionOf = image => { const tag = /:([^:@/]+)(?:@.*)?$/.exec(image || ''); return tag ? tag[1] : ''; };

function rabbitContainer(pod) {
  const containers = pod?.spec?.containers || [];
  return containers.find(c => /rabbitmq/i.test(imageOf(c)) && !/exporter/i.test(imageOf(c)))
    || containers.find(c => (c.ports || []).some(p => p.containerPort === 15672))
    || containers.find(c => /rabbitmq/i.test(c.name)) || null;
}

// Where a credential comes from, without its value.
function envSource(pod, container, names) {
  const env = container?.env || [];
  for (const name of names) {
    const entry = env.find(e => e.name === name);
    if (entry?.valueFrom?.secretKeyRef) return { type: 'secret', secret: entry.valueFrom.secretKeyRef.name, key: entry.valueFrom.secretKeyRef.key, via: name };
    if (entry && typeof entry.value === 'string' && !/\$\(/.test(entry.value)) return { type: 'literal', via: name };
    const file = env.find(e => e.name === `${name}_FILE`)?.value;
    if (file) {
      const mount = (container.volumeMounts || []).filter(m => file.startsWith(`${m.mountPath.replace(/\/$/, '')}/`)).sort((a, b) => b.mountPath.length - a.mountPath.length)[0];
      const volume = mount && (pod.spec?.volumes || []).find(v => v.name === mount.name);
      if (volume?.secret?.secretName) {
        const fileName = file.slice(mount.mountPath.replace(/\/$/, '').length + 1);
        const item = (volume.secret.items || []).find(i => i.path === fileName);
        return { type: 'secret', secret: volume.secret.secretName, key: item ? item.key : fileName, via: `${name}_FILE` };
      }
    }
  }
  const from = (container?.envFrom || []).find(item => item.secretRef?.name);
  if (from) return { type: 'secret-envfrom', secret: from.secretRef.name, key: `${from.prefix || ''}${names[0]}`, alternatives: names.map(n => `${from.prefix || ''}${n}`), via: 'envFrom' };
  return null;
}

function credentialPlan(pod) {
  const labels = pod?.metadata?.labels || {};
  if (labels['app.kubernetes.io/part-of'] === 'rabbitmq' && labels['app.kubernetes.io/name']) {
    const secret = `${labels['app.kubernetes.io/name']}-default-user`;
    return { kind: 'Cluster Operator', username: { type: 'secret', secret, key: 'username' }, password: { type: 'secret', secret, key: 'password' } };
  }
  const container = rabbitContainer(pod);
  const bitnami = /bitnami/i.test(imageOf(container));
  const withFallback = (source, value) => (source?.type === 'secret-envfrom' ? { ...source, fallback: value } : source);
  const username = withFallback(envSource(pod, container, USER_ENV), bitnami ? 'user' : 'guest') || (bitnami ? { type: 'default', value: 'user' } : null);
  const password = withFallback(envSource(pod, container, PASS_ENV), 'guest');
  if (username || password) return { kind: bitnami ? 'Bitnami' : 'RabbitMQ image', username: username || { type: 'default', value: 'guest' }, password: password || { type: 'default', value: 'guest' } };
  return { kind: bitnami ? 'Bitnami' : 'RabbitMQ image', username: { type: 'default', value: 'guest' }, password: { type: 'default', value: 'guest' } };
}

function describeSource(source) {
  if (!source) return 'unknown';
  if (source.type === 'secret' || source.type === 'secret-envfrom') return `Secret ${source.secret} › ${source.key}`;
  if (source.type === 'literal') return `${source.via} on the container`;
  return source.value === 'guest' ? 'RabbitMQ default (guest)' : `chart default (${source.value})`;
}

function createRabbitMQ(helpers) {
  const { problem, validateText, validateName, validateNamespace, listObjects, readSecret, openEmbeddedForward } = helpers;

  async function discover(context, namespace, signal) {
    const services = (await listObjects(context, 'services', namespace, { signal })).items || [];
    const candidates = services.map(service => ({ service, management: managementPort(service) })).filter(c => c.management);
    // One instance per selector: prefer the regular Service over a headless twin.
    const groups = new Map();
    for (const candidate of candidates) {
      const key = `${candidate.service.metadata.namespace}|${selectorText(candidate.service.spec?.selector) || candidate.service.metadata.name}`;
      const headless = candidate.service.spec?.clusterIP === 'None';
      const current = groups.get(key);
      if (!current || (current.headless && !headless) || (current.headless === headless && candidate.management.scheme === 'http' && current.management.scheme !== 'http')) groups.set(key, { ...candidate, headless });
    }
    const instances = [];
    for (const { service, management, headless } of groups.values()) {
      const ns = service.metadata.namespace;
      const selector = selectorText(service.spec?.selector);
      let pods = [];
      if (selector) {
        try { pods = (await listObjects(context, 'pods', ns, { signal, labelSelector: selector })).items || []; } catch { pods = []; }
      }
      const pod = pods.find(isReady) || pods[0] || null;
      const container = rabbitContainer(pod);
      if (pod && !container) continue; // a Service on 15672 in front of something that is not RabbitMQ
      const plan = credentialPlan(pod);
      instances.push({
        id: `${ns}/${service.metadata.name}`, namespace: ns, service: service.metadata.name, port: management.port, portName: management.name, scheme: management.scheme, headless,
        kind: pod ? plan.kind : 'Service', image: imageOf(container), version: versionOf(imageOf(container)),
        pods: { ready: pods.filter(isReady).length, total: pods.length }, pod: pod?.metadata?.name || '',
        amqpPort: (service.spec?.ports || []).find(p => p.port === 5672 || p.name === 'amqp')?.port || null,
        login: { username: describeSource(plan.username), password: describeSource(plan.password) },
      });
    }
    return instances.sort((a, b) => a.id.localeCompare(b.id));
  }

  async function instanceFor(context, namespace, service, signal) {
    const instances = await discover(context, namespace, signal);
    const instance = instances.find(item => item.service === service);
    if (!instance) throw problem(`No RabbitMQ management Service named ${service} in ${namespace}`, 404);
    return instance;
  }

  async function resolveValue(context, namespace, source, signal) {
    if (!source) return '';
    if (source.type === 'default') return source.value;
    if (source.type === 'literal') return source.value;
    const data = await readSecret(context, namespace, source.secret, signal);
    const keys = source.alternatives || [source.key];
    const key = keys.find(k => data[k] !== undefined);
    // envFrom Secrets may simply not set the variable; RabbitMQ then uses its default.
    if (!key && source.type === 'secret-envfrom') return source.fallback;
    if (!key) throw problem(`Secret ${source.secret} has no ${keys.join(' or ')} key`, 404);
    return Buffer.from(data[key], 'base64').toString('utf8');
  }

  async function credentials(context, namespace, service, signal) {
    const instance = await instanceFor(context, namespace, service, signal);
    let pod = null;
    if (instance.pod) {
      const pods = (await listObjects(context, 'pods', namespace, { signal, fieldSelector: `metadata.name=${instance.pod}` })).items || [];
      pod = pods[0] || null;
    }
    const plan = credentialPlan(pod);
    const container = rabbitContainer(pod);
    // Literal env values are read from the pod spec at reveal time only.
    for (const part of ['username', 'password']) {
      if (plan[part]?.type === 'literal') plan[part] = { ...plan[part], value: (container?.env || []).find(e => e.name === plan[part].via)?.value || '' };
    }
    return {
      username: await resolveValue(context, namespace, plan.username, signal),
      password: await resolveValue(context, namespace, plan.password, signal),
      source: { username: describeSource(plan.username), password: describeSource(plan.password) },
    };
  }

  return async function handle({ method, route, query, body, signal, sendJSON, res }) {
    if (method === 'GET' && route === '/api/rabbitmq') {
      const context = validateText(query.context, 'context');
      const namespace = validateNamespace(query.namespace, { all: true });
      sendJSON(res, { items: await discover(context, namespace || '*', signal) });
      return true;
    }
    if (method === 'POST' && route === '/api/rabbitmq/credentials') {
      const context = validateText(body.context, 'context');
      const namespace = validateNamespace(body.namespace);
      sendJSON(res, await credentials(context, namespace, validateName(body.service, 'service'), signal));
      return true;
    }
    if (method === 'POST' && route === '/api/rabbitmq/open') {
      const context = validateText(body.context, 'context');
      const namespace = validateNamespace(body.namespace);
      const instance = await instanceFor(context, namespace, validateName(body.service, 'service'), signal);
      sendJSON(res, await openEmbeddedForward({ context, namespace, resource: 'services', name: instance.service, remotePort: instance.port, scheme: instance.scheme, signal,
        credentials: () => credentials(context, namespace, instance.service) }));
      return true;
    }
    return false;
  };
}

module.exports = { createRabbitMQ, managementPort, credentialPlan, describeSource };
