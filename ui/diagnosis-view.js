// The "Diagnosis" card at the top of an unhealthy pod's or workload's details: what is wrong, why,
// and the next step one click away. Fills in after the events (and nodes, when scheduling) arrive.
import { el, button, get, toast } from './kit.js';
import { diagnosePod, diagnosePods } from './diagnose.js';
import { healthTone, workloadState, replicaCounts } from './health.js';
import { selectorText, matchesSelector } from './format.js';
import { logsFor, rollback } from './ops.js';

const WORKLOADS = new Set(['deployments', 'statefulsets', 'daemonsets', 'replicasets', 'jobs']);
// `code` spans for the parts of a sentence written in backticks.
const rich = text => String(text || '').split(/(`[^`]+`)/).map(part => (part.startsWith('`') && part.endsWith('`') ? el('code', { text: part.slice(1, -1) }) : part));
const eventTime = event => new Date(event.lastTimestamp || event.eventTime || event.metadata?.creationTimestamp || 0).getTime();

async function podEvents(selected, uid) {
  const response = await get('/api/events', { context: selected.context, namespace: selected.namespace || '*', ...(uid ? { fieldSelector: `involvedObject.uid=${uid}` } : {}) });
  return (response.items || []).sort((a, b) => eventTime(b) - eventTime(a));
}
const needsNodes = pods => pods.some(pod => (pod.status?.conditions || []).some(c => c.type === 'PodScheduled' && c.status === 'False'));
async function nodesFor(selected, pods) {
  if (!needsNodes(pods)) return [];
  try { return (await get('/api/resources', { context: selected.context, resource: 'nodes' })).items || []; } catch { return []; }
}

function actionButtons(finding, selected, pod) {
  const target = pod ? { context: selected.context, namespace: selected.namespace, resource: 'pods', name: pod.metadata.name, item: pod } : selected;
  const buttons = [];
  for (const action of finding.actions || []) {
    if (action === 'previous-logs' && target.resource === 'pods') buttons.push(button('Logs of the crashed run', () => logsFor(target, { previous: true, container: finding.container }), 'compact primary'));
    if (action === 'logs') buttons.push(button(target.resource === 'pods' ? 'Logs' : 'Logs (all pods)', () => logsFor(target, finding.container ? { container: finding.container } : {}), 'compact'));
    if (action === 'events') buttons.push(button('Events', () => document.getElementById('resource-tab-events')?.click(), 'compact'));
    if (action === 'yaml') buttons.push(button('Edit YAML', () => document.getElementById('resource-tab-yaml')?.click(), 'compact'));
    if (action === 'rollback' && selected.resource === 'deployments') {
      const revision = Number(selected.item.metadata?.annotations?.['deployment.kubernetes.io/revision']);
      if (revision > 1) buttons.push(button(`Roll back to revision ${revision - 1}`, () => rollback(selected, revision - 1).catch(error => toast(error.message, true)), 'compact'));
    }
  }
  return buttons;
}

function card(findings, selected, { podsByName = new Map(), headline = '' } = {}) {
  const worst = findings.some(f => f.tone === 'bad') ? 'bad' : 'warn';
  const [first, ...rest] = findings;
  const pod = podsByName.get(first.pods?.[0]) || (selected.resource === 'pods' ? selected.item : null);
  return el('section', { class: `diagnosis ${worst}`, role: 'status', 'aria-label': 'Diagnosis' },
    el('div', { class: 'diagnosis-eyebrow' }, el('span', { class: 'diagnosis-mark', text: worst === 'bad' ? '!' : 'i' }), 'Diagnosis', headline ? el('span', { class: 'diagnosis-headline', text: headline }) : null),
    el('h3', { class: 'diagnosis-title' }, first.title, first.pods?.length ? el('span', { class: 'diagnosis-count', text: `${first.pods.length} pod${first.pods.length === 1 ? '' : 's'}` }) : null),
    el('p', { class: 'diagnosis-text' }, rich(first.text)),
    first.hints?.length ? el('ul', { class: 'diagnosis-hints' }, first.hints.map(hint => el('li', {}, rich(hint)))) : null,
    el('div', { class: 'actions diagnosis-actions' }, actionButtons(first, selected, selected.resource === 'pods' ? null : pod)),
    rest.length ? el('details', { class: 'diagnosis-more' }, el('summary', { text: `${rest.length} more finding${rest.length === 1 ? '' : 's'}` }),
      rest.map(finding => el('div', { class: `diagnosis-extra ${finding.tone}` }, el('b', {}, finding.title, finding.pods?.length ? ` · ${finding.pods.length} pod${finding.pods.length === 1 ? '' : 's'}` : ''), el('p', {}, rich(finding.text)), finding.hints?.length ? el('p', { class: 'muted' }, rich(finding.hints[0])) : null))) : null);
}

export function diagnosisCard(selected) {
  const item = selected.item; const resource = selected.resource;
  const isPod = resource === 'pods';
  if (!isPod && !WORKLOADS.has(resource)) return null;
  const tone = healthTone(resource, item);
  if (tone !== 'bad' && tone !== 'warn') return null;
  const host = el('div', { class: 'diagnosis-slot' });
  (async () => {
    try {
      if (isPod) {
        const events = await podEvents(selected, item.metadata?.uid);
        const findings = diagnosePod(item, { events, nodes: await nodesFor(selected, [item]) });
        if (findings.length) host.replaceChildren(card(findings, selected));
        return;
      }
      const selector = item.spec?.selector;
      const query = { context: selected.context, resource: 'pods', namespace: selected.namespace, ...(selector?.matchLabels && !selector.matchExpressions?.length ? { labelSelector: selectorText(selector) } : {}) };
      const pods = ((await get('/api/resources', query)).items || []).filter(pod => (pod.metadata?.ownerReferences || []).some(ref => ref.uid === item.metadata?.uid) || (selector && matchesSelector(selector, pod.metadata?.labels || {})));
      const unhealthy = pods.filter(pod => ['bad', 'warn'].includes(healthTone('pods', pod)));
      const state = resource === 'jobs' ? null : workloadState(resource, item);
      let findings = [];
      if (unhealthy.length) {
        const all = await podEvents(selected, '');
        const names = new Set(unhealthy.map(pod => pod.metadata.name));
        const eventsByPod = new Map();
        for (const event of all) { const name = event.involvedObject?.name; if (names.has(name)) { if (!eventsByPod.has(name)) eventsByPod.set(name, []); eventsByPod.get(name).push(event); } }
        findings = diagnosePods(unhealthy, { eventsByPod, nodes: await nodesFor(selected, unhealthy) });
      }
      if (!findings.length && state && state.tone !== 'good') findings = [{ tone: state.tone, code: 'state', title: state.label, text: state.detail || '', hints: state.label === 'Rollout stuck' ? ['The rollout passed its progress deadline. Look at the newest pods, or roll back.'] : [], actions: ['events', ...(resource === 'deployments' ? ['rollback'] : [])] }];
      if (findings.length) host.replaceChildren(card(findings, selected, { podsByName: new Map(pods.map(pod => [pod.metadata.name, pod])), headline: state ? `${state.label} · ${replicaCounts(resource, item).ready}/${replicaCounts(resource, item).desired} ready` : '' }));
    } catch (error) {
      if (error?.name !== 'AbortError') host.replaceChildren(el('div', { class: 'callout warn', text: `Could not diagnose: ${error.message}` }));
    }
  })();
  return host;
}
