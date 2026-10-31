import { $, state, hooks, makeForm, modal, el, button, badge, actions, info, loading, toast, task, api, get, post, clusterQuery, targetOf, socketURL, readStore, writeStore, age, statusOf, liveKey, liveStamp, table, page, panel, empty, displayError, dl, link, MOD } from './kit.js';
import { createUsage } from './usage.js';
import { applyTheme, storedTheme, THEMES } from './theme.js';
import { renderCluster, openSwitcher, clustersPage, importPanels, infoFor, labelFor, envFor } from './clusterui.js';
import { clusterIcon } from './cluster-icons.js';
import { startTour } from './tour.js';
import { setupUpdates, updatesPanel } from './updates.js';
import { formatCPU, formatBytes, formatPercent, parseCPU, parseMemory } from './format.js';
import { lineChart, meter } from './charts.js';
import { kindColumns, pageContext, needsPods, usesUsage, podScopeFor, searchTextFor, eventColumns, eventTime, involved, usageCell, controllerOf, resourceForKind, isControlPlane, nodeCondition } from './kinds.js';
import { rowMenu, bulkActions, logsFor, openExternal as openExternalLink } from './ops.js';
import { kindOverview, kindMetrics, detailActions, metricsView } from './details.js';
import { openLogs, openTerminal, setupDock, toggleDock, localShellTarget } from './dock.js';
import { clusterQueries } from './promql.js';
import { TEMPLATES, templateFor } from './templates.js';
import { showChart, installDialog, showRelease, releaseMenu, repositoriesPanel } from './helm.js';
import { consumption, resetPrometheusProvider } from './detail-common.js';
import { argoDetails, argoManagerPage, appMenu as argoMenu, appErrors as argoErrors } from './argocd.js';
import { rabbitmqPage } from './rabbitmq.js';
import * as credentials from './credentials.js';
import { reviewBar } from './review.js';
import { createProblemStore } from './problems.js';
import { searchContexts, groupByKind, resultDetail, searchable } from './search.js';
import { permissionText, scopeText, groupByFeature, asText, summary } from './access.js';
import { createForwardsPoller, statusText, statusLevel } from './forwards.js';

const usage = createUsage({ api });
hooks.usage = usage;
const activeTab = () => state.tabs.find(tab => tab.id === state.active) || state.tabs[0];
// Tabs work like a browser's: each one remembers its cluster, namespace and view, so two clusters
// can be open side by side and switching is a click. The active tab's cluster is state.context.
let tabSeq = 0;
const newTabId = () => `tab-${++tabSeq}-${Date.now().toString(36)}`;
const homeTab = (context, namespace = '*') => ({ id: newTabId(), context, namespace, section: 'overview', title: 'Overview', trail: [] });
const TABS_STORE = 'rubban.tabs';
function saveTabs() {
  writeStore(TABS_STORE, { active: state.tabs.findIndex(tab => tab.id === state.active), tabs: state.tabs.map(({ context, namespace, section, resource, title, trail }) => ({ context, namespace, section, resource, title, trail })) });
}
// What a cluster already told us, kept while another tab is active so coming back is instant.
const clusterCache = new Map();
const cacheOf = name => { if (!clusterCache.has(name)) clusterCache.set(name, { discovery: [], crds: null, namespaces: null }); return clusterCache.get(name); };

// ---- Sidebar navigation: collapsible sections ------------------------------------------------
const SVG_NS = 'http://www.w3.org/2000/svg';
// Simple 16px stroke icons drawn for Rubban.
const ICONS = {
  overview: 'M2.5 2.5h4.5v4.5H2.5z M9 2.5h4.5v4.5H9z M2.5 9h4.5v4.5H2.5z M9 9h4.5v4.5H9z',
  applications: 'M8 1.8 14 5 8 8.2 2 5z M2 8l6 3.2L14 8 M2 11l6 3.2 6-3.2',
  queue: 'M2 4.5h9 M2 8h9 M2 11.5h9 M11 2.5l2.5 2-2.5 2 M11 6l2.5 2-2.5 2 M11 9.5l2.5 2-2.5 2',
  argo: 'M5.5 3.5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0z M5.5 12.5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0z M13.5 5.5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0z M4 5v6 M12 7c0 2.5-1.5 3.2-4 3.6-1.6.3-3 .7-4 1.4',
  nodes: 'M2.5 2.5h11v4.5h-11z M2.5 9h11v4.5h-11z M5 4.75h.01 M5 11.25h.01 M8 4.75h3 M8 11.25h3',
  workloads: 'M8 1.8l5.5 3.1v6.2L8 14.2l-5.5-3.1V4.9z M2.5 4.9 8 8l5.5-3.1 M8 8v6.2',
  config: 'M2 4h4 M9 4h5 M2 12h7 M12 12h2 M2 8h1 M6 8h8 M9 4a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0z M12 12a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0z M6 8a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0z',
  network: 'M5 13V3 M2.5 5.5 5 3l2.5 2.5 M11 3v10 M8.5 10.5 11 13l2.5-2.5',
  storage: 'M3 4c0-1.1 2.2-2 5-2s5 .9 5 2-2.2 2-5 2-5-.9-5-2z M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4 M3 8c0 1.1 2.2 2 5 2s5-.9 5-2',
  namespaces: 'M2.5 2.5h7v7h-7z M6.5 6.5h7v7h-7z',
  events: 'M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0z M8 4.5V8l2.5 1.5',
  helm: 'M12 8a4 4 0 1 1-8 0a4 4 0 1 1 8 0z M9 8a1 1 0 1 1-2 0a1 1 0 1 1 2 0z M8 1v3 M8 12v3 M1 8h3 M12 8h3 M3 3l2.2 2.2 M10.8 10.8 13 13 M3 13l2.2-2.2 M10.8 5.2 13 3',
  access: 'M8 1.8 13.5 4v4c0 3.2-2.3 5.5-5.5 6.4C4.8 13.5 2.5 11.2 2.5 8V4z',
  custom: 'M3 4.5h2.6a1.6 1.6 0 1 1 3.2 0h2.7v2.7a1.6 1.6 0 1 1 0 3.2v2.6H8.8a1.6 1.6 0 1 0-3.2 0H3v-2.6a1.6 1.6 0 1 0 0-3.2z',
  chevron: 'M6 4l4 4-4 4',
  cluster: 'M8 2l5.2 3v6L8 14l-5.2-3V5z M8 8l5.2-3 M8 8v6 M8 8L2.8 5',
  search: 'M11 7a4 4 0 1 1-8 0a4 4 0 1 1 8 0z M10 10l3.5 3.5',
  refresh: 'M13 8a5 5 0 1 1-1.5-3.5 M13 2.5v3h-3',
  terminal: 'M3 4.5l3 3-3 3 M8 11.5h5',
  plus: 'M8 3v10 M3 8h10',
  workspace: 'M2.5 2.5h4.5v4.5H2.5z M9 2.5h4.5v4.5H9z M2.5 9h4.5v4.5H2.5z M9 9h4.5v4.5H9z',
  cloud: 'M4.6 12.5h6.9a3 3 0 0 0 .3-6A4 4 0 0 0 4.1 7.1a2.75 2.75 0 0 0 .5 5.4z',
  extensions: 'M2.5 2.5h4.5v4.5H2.5z M9 2.5h4.5v4.5H9z M2.5 9h4.5v4.5H2.5z M11.25 9v4.5 M9 11.25h4.5',
  metrics: 'M2.5 13.5h11 M4.5 11V8 M8 11V4.5 M11.5 11V6.5',
  security: 'M8 1.8 13.5 4v4c0 3.2-2.3 5.5-5.5 6.4C4.8 13.5 2.5 11.2 2.5 8V4z M5.6 8l1.7 1.7 3.1-3.3',
  team: 'M8.2 4.75a2.25 2.25 0 1 1-4.5 0a2.25 2.25 0 1 1 4.5 0z M1.8 13.5c.5-2.3 2.1-3.5 4.2-3.5s3.7 1.2 4.2 3.5 M10.5 2.8a2 2 0 0 1 0 3.9 M11.6 10.1c1.4.4 2.4 1.5 2.7 3.4',
  alert: 'M8 2l6.5 11.5h-13z M8 6.5v3 M8 11.6h.01',
  ai: 'M8 1.5l1.4 3.6 3.6 1.4-3.6 1.4L8 11.5 6.6 7.9 3 6.5l3.6-1.4z M12.5 10.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z',
  settings: 'M10 8a2 2 0 1 1-4 0a2 2 0 1 1 4 0z M12.5 8a4.5 4.5 0 1 1-9 0a4.5 4.5 0 1 1 9 0z M8 1.5v2 M8 12.5v2 M1.5 8h2 M12.5 8h2 M3.4 3.4l1.4 1.4 M11.2 11.2l1.4 1.4 M3.4 12.6l1.4-1.4 M11.2 4.8l1.4-1.4',
  gitops: 'M5.5 3.5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0z M5.5 12.5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0z M13.5 8a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0z M4 5v6 M4 8h6.5',
  cost: 'M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0z M10 5.8C9.5 5.3 8.8 5 8 5c-1.2 0-2 .6-2 1.5S6.8 7.7 8 8s2 .8 2 1.6S9.2 11 8 11c-.9 0-1.6-.3-2.1-.9 M8 3.8V5 M8 11v1.2',
};
function icon(name, className = 'nav-svg') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', className);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name] || ICONS.overview);
  svg.append(path); return svg;
}
// Running port forwards, counted for the sidebar on every page.
const forwardsPoller = createForwardsPoller({ fetchItems: async () => (await get('/api/forwards')).items || [], onCount: () => navigation() });
hooks.forwardsChanged = () => forwardsPoller.refresh();
const leaf = (title, section, resource, extra = {}) => ({ title, section, resource, ...extra });
const kube = (title, resource, extra) => leaf(title, 'resource', resource, extra);
const NAV = [
  leaf('Overview', 'overview', undefined, { icon: 'overview' }),
  leaf('Applications', 'applications', undefined, { icon: 'applications' }),
  { id: 'argocd', title: 'Argo CD', icon: 'argo', children: [
    leaf('Manage', 'argocd', undefined, { tabTitle: 'Argo CD · Manage' }),
    kube('Applications', 'applications.argoproj.io', { tabTitle: 'Argo CD Applications' }),
    kube('ApplicationSets', 'applicationsets.argoproj.io'),
    kube('AppProjects', 'appprojects.argoproj.io'),
  ] },
  leaf('RabbitMQ', 'rabbitmq', undefined, { icon: 'queue' }),
  kube('Nodes', 'nodes', { icon: 'nodes' }),
  { id: 'workloads', title: 'Workloads', icon: 'workloads', children: [
    leaf('Overview', 'workloads', undefined, { tabTitle: 'Workloads overview' }),
    kube('Pods', 'pods'), kube('Deployments', 'deployments'), kube('Daemon Sets', 'daemonsets'), kube('Stateful Sets', 'statefulsets'),
    kube('Replica Sets', 'replicasets'), kube('Replication Controllers', 'replicationcontrollers'), kube('Jobs', 'jobs'), kube('Cron Jobs', 'cronjobs'),
  ] },
  { id: 'config', title: 'Config', icon: 'config', children: [
    kube('Config Maps', 'configmaps'), kube('Secrets', 'secrets'), kube('Resource Quotas', 'resourcequotas'), kube('Limit Ranges', 'limitranges'),
    kube('Horizontal Pod Autoscalers', 'horizontalpodautoscalers'),
    kube('Vertical Pod Autoscalers', 'verticalpodautoscalers.autoscaling.k8s.io', { requires: { name: 'verticalpodautoscalers', group: 'autoscaling.k8s.io' } }),
    kube('Pod Disruption Budgets', 'poddisruptionbudgets'), kube('Priority Classes', 'priorityclasses'), kube('Runtime Classes', 'runtimeclasses'),
    kube('Leases', 'leases'), kube('Mutating Webhook Configs', 'mutatingwebhookconfigurations'), kube('Validating Webhook Configs', 'validatingwebhookconfigurations'),
    kube('Validating Admission Policies', 'validatingadmissionpolicies.admissionregistration.k8s.io', { requires: { name: 'validatingadmissionpolicies', group: 'admissionregistration.k8s.io' } }),
    kube('Validating Admission Policy Bindings', 'validatingadmissionpolicybindings.admissionregistration.k8s.io', { requires: { name: 'validatingadmissionpolicybindings', group: 'admissionregistration.k8s.io' } }),
  ] },
  { id: 'network', title: 'Network', icon: 'network', children: [
    kube('Services', 'services'), kube('Endpoints', 'endpoints'), kube('Endpoint Slices', 'endpointslices'), kube('Ingresses', 'ingresses'),
    kube('Ingress Classes', 'ingressclasses'), kube('Network Policies', 'networkpolicies'),
    kube('Gateway Classes', 'gatewayclasses.gateway.networking.k8s.io', { requires: { name: 'gatewayclasses', group: 'gateway.networking.k8s.io' } }), kube('Gateways', 'gateways.gateway.networking.k8s.io', { requires: { name: 'gateways', group: 'gateway.networking.k8s.io' } }),
    kube('HTTP Routes', 'httproutes.gateway.networking.k8s.io', { requires: { name: 'httproutes', group: 'gateway.networking.k8s.io' } }), kube('GRPC Routes', 'grpcroutes.gateway.networking.k8s.io', { requires: { name: 'grpcroutes', group: 'gateway.networking.k8s.io' } }),
    leaf('Port Forwarding', 'forwards'),
  ] },
  { id: 'storage', title: 'Storage', icon: 'storage', children: [
    kube('Persistent Volume Claims', 'persistentvolumeclaims'), kube('Persistent Volumes', 'persistentvolumes'), kube('Storage Classes', 'storageclasses'),
  ] },
  kube('Namespaces', 'namespaces', { icon: 'namespaces' }),
  leaf('Events', 'events', undefined, { icon: 'events' }),
  { id: 'helm', title: 'Helm', icon: 'helm', children: [leaf('Charts', 'helm-charts', undefined, { tabTitle: 'Helm Charts' }), leaf('Releases', 'helm', undefined, { tabTitle: 'Helm Releases' })] },
  { id: 'access', title: 'Access Control', icon: 'access', children: [
    kube('Service Accounts', 'serviceaccounts'), kube('Cluster Roles', 'clusterroles'), kube('Roles', 'roles'),
    kube('Cluster Role Bindings', 'clusterrolebindings'), kube('Role Bindings', 'rolebindings'),
  ] },
  { id: 'custom', title: 'Custom Resources', icon: 'custom', dynamic: 'custom' },
];
// Views reached from the rail and the command palette rather than the sidebar.
const EXTRA_VIEWS = [
  leaf('Metrics & monitoring', 'metrics', undefined, { icon: 'metrics' }),
  leaf('API resources', 'discovery', undefined, { icon: 'custom' }),
  leaf('AI assistant', 'ai', undefined, { icon: 'ai' }),
  leaf('Clusters', 'clusters', undefined, { icon: 'cluster' }),
  leaf('Settings', 'settings', undefined, { icon: 'settings' }),
  leaf('Problems', 'problems', undefined, { icon: 'alert' }),
];
const BUILTIN_GROUP = group => !group || ['apps', 'batch', 'autoscaling', 'policy'].includes(group) || (group.endsWith('.k8s.io') && group !== 'autoscaling.k8s.io');
// Custom resources come from the cluster's CRDs (live), or from discovery when CRDs cannot be listed.
let customMemo = null;
function customChildren() {
  if (customMemo && customMemo.crds === state.crds && customMemo.discovery === state.discovery) return customMemo.children;
  const groups = new Map();
  const add = (group, kind, plural) => { if (!groups.has(group)) groups.set(group, new Map()); groups.get(group).set(plural, kind); };
  if (Array.isArray(state.crds)) for (const crd of state.crds) { const names = crd.spec?.names || {}; if (crd.spec?.group && names.plural) add(crd.spec.group, names.kind || names.plural, names.plural); }
  else for (const resource of state.discovery) if (!BUILTIN_GROUP(resource.group) && (resource.verbs || []).includes('list')) add(resource.group, resource.kind || resource.name, resource.name);
  const children = [kube('Definitions', 'customresourcedefinitions', { tabTitle: 'Custom Resource Definitions' })];
  for (const group of [...groups.keys()].sort()) {
    const kinds = [...groups.get(group)].sort((a, b) => a[1].localeCompare(b[1]));
    children.push({ id: `crd:${group}`, title: group, children: kinds.map(([plural, kind]) => kube(kind, `${plural}.${group}`, { tabTitle: kind, groupTitle: group })) });
  }
  customMemo = { crds: state.crds, discovery: state.discovery, children };
  return children;
}
function navChildren(node) {
  const children = node.dynamic === 'custom' ? customChildren() : node.children || [];
  return children.filter(child => !child.requires || state.discovery.some(r => r.name === child.requires.name && r.group === child.requires.group));
}
function readNavOpen() { try { return new Set(JSON.parse(localStorage.getItem('rubban.nav.open') || '[]')); } catch { return new Set(); } }
function saveNavOpen() { try { localStorage.setItem('rubban.nav.open', JSON.stringify([...state.navOpen])); } catch { /* Per-window convenience only. */ } }
state.navOpen = readNavOpen();
const sameView = (node, tab) => node.section === tab.section && (node.resource || '') === (tab.resource || '');
// Path of group ids leading to the view, so the sidebar can open it.
function navPath(tab, nodes = NAV, trail = []) {
  for (const node of nodes) {
    if (node.section && sameView(node, tab)) return trail;
    if (node.children || node.dynamic) { const found = navPath(tab, navChildren(node), [...trail, node]); if (found) return found; }
  }
  return null;
}
let allNavMemo = null;
function allNav() {
  if (allNavMemo && allNavMemo.crds === state.crds && allNavMemo.discovery === state.discovery) return allNavMemo.list;
  const out = [];
  const walk = (nodes, trail) => { for (const node of nodes) { if (node.section) out.push({ ...node, trail }); else walk(navChildren(node), [...trail, node]); } };
  walk(NAV, []);
  const list = out.concat(EXTRA_VIEWS.map(view => ({ ...view, trail: [] })));
  allNavMemo = { crds: state.crds, discovery: state.discovery, list };
  return list;
}
function navigation() {
  const filter = $('#nav-search').value.trim().toLowerCase();
  const tab = activeTab();
  const build = (nodes, level, parentMatched) => {
    const out = [];
    for (const node of nodes) {
      const selfMatch = !filter || parentMatched || node.title.toLowerCase().includes(filter);
      if (node.section) {
        if (!selfMatch) continue;
        const selected = sameView(node, tab);
        const go = event => openView(node.section, node.resource, node.tabTitle || node.title, { newTab: event.ctrlKey || event.metaKey || event.button === 1 });
        const badgeCount = node.section === 'forwards' ? forwardsPoller.count : 0;
        const item = button([level === 0 ? el('span', { class: 'nav-chevron-spacer' }) : null, level === 0 ? icon(node.icon) : null, el('span', { class: 'nav-label', text: node.title }), badgeCount ? el('span', { class: 'nav-badge', title: `${badgeCount} active port forward${badgeCount === 1 ? '' : 's'}`, text: String(badgeCount) }) : null], go, `nav-item nav-level-${level}${selected ? ' selected' : ''}`);
        item.addEventListener('auxclick', event => { if (event.button === 1) { event.preventDefault(); go(event); } });
        item.title = `Click to open · ${MOD}+click to open in a new tab`;
        out.push(item);
        if (selected) out.at(-1).setAttribute('aria-current', 'page');
        continue;
      }
      const id = node.id;
      if (node.optional && !navChildren(node).length) continue;
      const childNodes = build(navChildren(node), level + 1, selfMatch && Boolean(filter));
      if (filter && !childNodes.length && !selfMatch) continue;
      const open = filter ? true : state.navOpen.has(id);
      const header = button([icon('chevron', `nav-chevron${open ? ' open' : ''}`), level === 0 ? icon(node.icon) : null, el('span', { class: 'nav-label', text: node.title })], () => {
        if (state.navOpen.has(id)) state.navOpen.delete(id); else state.navOpen.add(id);
        saveNavOpen(); navigation();
      }, `nav-item nav-group nav-level-${level}`);
      header.setAttribute('aria-expanded', String(open));
      out.push(header);
      if (open) out.push(el('div', { class: 'nav-children', role: 'group', 'aria-label': node.title }, childNodes.length ? childNodes : el('div', { class: `nav-empty nav-level-${level + 1}`, text: node.dynamic ? (state.context ? 'No custom resources found' : 'Select a cluster') : 'Nothing here' })));
    }
    return out;
  };
  $('#navigation').replaceChildren(...build(NAV, 0, false));
}
function openView(section, resource, title, { newTab = false } = {}) {
  state.selected = null; $('#drawer').classList.add('hidden');
  const context = state.context;
  let tab = state.tabs.find(item => item.context === context && sameView(item, { section, resource }));
  if (!tab) {
    const known = allNav().find(item => sameView(item, { section, resource }));
    tab = { id: newTabId(), context, namespace: state.namespace, section, resource, title: title || known?.tabTitle || known?.title || section, trail: (known?.trail || []).map(node => node.title) };
    // Navigate within the current tab like a browser; a cluster's Overview tab is its home and stays.
    const index = state.tabs.findIndex(item => item.id === state.active);
    if (!newTab && index >= 0 && state.tabs[index].section !== 'overview') state.tabs[index] = tab; else state.tabs.push(tab);
  } else tab.namespace = state.namespace;
  state.active = tab.id;
  // Reveal the view's section in the sidebar.
  for (const node of navPath({ section, resource }) || []) if (node.id) state.navOpen.add(node.id);
  saveNavOpen();
  navigation();
  $('#navigation .nav-item.selected')?.scrollIntoView({ block: 'nearest' });
  renderTabs();
  render();
}
// Brings a tab to the front, switching cluster and namespace to the tab's own.
async function activateTab(id) {
  const tab = state.tabs.find(item => item.id === id);
  if (!tab) return;
  state.active = id;
  if (tab.context && !state.contexts.some(context => context.name === tab.context)) { toast(`${tab.context} is no longer in your kubeconfig.`, true); tab.context = ''; }
  if (tab.context !== state.context) { await selectContext(tab.context, { namespace: tab.namespace, fromTab: true }); return; }
  if (tab.namespace !== state.namespace) { state.namespace = tab.namespace; $('#namespace').value = tab.namespace; state.selected = null; $('#drawer').classList.add('hidden'); }
  navigation(); renderTabs(); render(); saveTabs();
}
function closeTab(id) {
  const index = state.tabs.findIndex(tab => tab.id === id);
  if (index < 0) return;
  state.tabs.splice(index, 1);
  if (!state.tabs.length) state.tabs.push(homeTab(state.context, state.namespace));
  if (state.active === id) activateTab(state.tabs[Math.min(index, state.tabs.length - 1)].id); else { renderTabs(); saveTabs(); }
}
function cycleTab(step) {
  const index = state.tabs.findIndex(tab => tab.id === state.active);
  activateTab(state.tabs[(index + step + state.tabs.length) % state.tabs.length].id);
}
// A new tab on another cluster, opened at its Overview.
function newClusterTab(name) {
  const tab = homeTab(name);
  state.tabs.push(tab); state.active = tab.id;
  return selectContext(name, { fromTab: true });
}
function renderTabs() {
  const clustersOpen = new Set(state.tabs.map(tab => tab.context)).size > 1;
  $('#tabbar').replaceChildren(...state.tabs.map(tab => {
    const meta = tab.context ? infoFor(tab.context) : null;
    const expired = tab.context && credentials.isExpired(tab.context);
    const found = tab.context ? problemsStore.countsFor(tab.context) : { critical: 0, warning: 0 };
    const dot = found.critical ? 'critical' : found.warning ? 'warning' : '';
    const mark = meta ? el('span', { class: `tab-cluster${expired ? ' auth-expired' : ''}`, style: `color:${meta.color}` }, clusterIcon(meta.icon), dot ? el('i', { class: `tab-dot ${dot}` }) : null) : null;
    const node = button([mark, icon(tab.icon || allNav().find(item => sameView(item, tab))?.icon || allNav().find(item => sameView(item, tab))?.trail?.[0]?.icon || 'overview', 'ui-svg tab-svg'), el('span', { class: 'tab-title', text: clustersOpen && meta ? `${meta.label} · ${tab.title}` : tab.title }), el('span', { class: 'tab-close', title: `Close tab (${MOD}+W)`, role: 'button', 'aria-label': `Close ${tab.title}`, onclick: event => { event.stopPropagation(); closeTab(tab.id); }, text: '×' })], () => activateTab(tab.id), `tab${state.active === tab.id ? ' active' : ''}`);
    node.title = meta ? `${meta.label} · ${tab.context}${tab.namespace !== '*' ? ` · ${tab.namespace}` : ''}${expired ? ` — credentials expired${credentials.authOf(tab.context).message ? `: ${credentials.authOf(tab.context).message}` : ''}` : ''}${dot ? ` — ${found.critical ? `${found.critical} critical` : ''}${found.critical && found.warning ? ', ' : ''}${found.warning ? `${found.warning} warning${found.warning === 1 ? '' : 's'}` : ''}` : ''}` : 'No cluster';
    node.addEventListener('auxclick', event => { if (event.button === 1) { event.preventDefault(); closeTab(tab.id); } });
    node.setAttribute('role', 'tab'); node.setAttribute('aria-selected', state.active === tab.id ? 'true' : 'false'); return node;
  }), el('button', { type: 'button', class: 'tab-new', title: `Open a cluster in a new tab (${MOD}+T)`, 'aria-label': 'Open a cluster in a new tab', onclick: () => openSwitcher({ newTab: true }), text: '+' }));
  const tab = activeTab();
  const parts = [...(tab.trail?.length ? tab.trail : ['Workspace']), tab.title];
  $('#breadcrumb').replaceChildren(...parts.flatMap((part, index) => index ? [el('span', { text: '/' }), part] : [part]));
  let railMatched = false;
  document.querySelectorAll('.rail-button[data-section]').forEach(node => { const active = node.dataset.section === tab.section; node.classList.toggle('active', active); railMatched ||= active; });
  $('#workspace-button').classList.toggle('active', !railMatched);
  renderAuthBanner();
  problemsStore.sync(state.tabs.map(item => item.context));
}
// ---- Problems inbox -----------------------------------------------------------------------------
const problemsStore = createProblemStore({
  liveList, readStore, writeStore,
  hasArgo: context => Boolean(cacheOf(context).crds?.some(crd => crd.metadata?.name === 'applications.argoproj.io')),
  onChange: () => problemsChanged(),
});
let problemsPageRefresh = null;
function problemsChanged() {
  const totals = problemsStore.totals();
  const badgeNode = $('#problems-badge');
  const count = totals.critical || totals.warning;
  badgeNode.textContent = count > 99 ? '99+' : String(count || '');
  badgeNode.className = `rail-badge ${totals.critical ? 'critical' : totals.warning ? 'warning' : 'hidden'}`;
  $('#problems-button').title = count ? `${totals.critical} critical, ${totals.warning} warning${totals.warning === 1 ? '' : 's'} in your open clusters` : 'Problems in your open clusters';
  renderTabs();
  problemsPageRefresh?.();
}
const PROBLEM_KINDS = { pods: 'Pod', deployments: 'Deployment', statefulsets: 'StatefulSet', daemonsets: 'DaemonSet', jobs: 'Job', persistentvolumeclaims: 'PVC', nodes: 'Node', 'applications.argoproj.io': 'Application', cluster: 'Cluster' };
async function openProblem(problem) {
  if (problem.context !== state.context) await selectContext(problem.context, { namespace: '*' });
  if (problem.resource !== 'cluster') showResource({ metadata: { name: problem.name, namespace: problem.namespace } }, problem.resource);
}
async function podLogsOf(problem) {
  if (problem.context !== state.context) await selectContext(problem.context, { namespace: '*' });
  const item = await get('/api/resource', { context: problem.context, namespace: problem.namespace, resource: 'pods', name: problem.name });
  logsFor({ context: problem.context, namespace: problem.namespace, resource: 'pods', name: problem.name, item });
}
const problemFilters = { severities: new Set(['critical', 'warning', 'info']), context: '', namespace: '', onlyTab: false };
function problemsPage() {
  const signal = state.pageAbort.signal;
  const root = page('Problems', 'What is wrong in every cluster you have open: crash loops, pods that cannot start, workloads below their replica count, unhealthy nodes and Argo CD applications.');
  const chips = el('div', { class: 'chips filter-chips' }, ['critical', 'warning', 'info'].map(severity => {
    const chip = el('button', { type: 'button', class: `chip-button ${severity}${problemFilters.severities.has(severity) ? ' on' : ''}`, 'aria-pressed': String(problemFilters.severities.has(severity)) }, severity);
    chip.addEventListener('click', () => { if (problemFilters.severities.has(severity)) problemFilters.severities.delete(severity); else problemFilters.severities.add(severity); chip.classList.toggle('on'); chip.setAttribute('aria-pressed', String(problemFilters.severities.has(severity))); draw(); });
    return chip;
  }));
  const clusterSelect = el('select', { 'aria-label': 'Cluster' });
  const namespaceInput = el('input', { type: 'search', placeholder: 'Namespace', 'aria-label': 'Namespace filter', value: problemFilters.namespace });
  const onlyTab = el('input', { type: 'checkbox', checked: problemFilters.onlyTab });
  const list = el('div', { class: 'problems-list' });
  root.append(el('div', { class: 'form-actions start problems-filters' }, chips, clusterSelect, namespaceInput, el('label', { class: 'inline-label' }, onlyTab, " Only this tab's cluster")), list);
  const fillClusters = () => { clusterSelect.replaceChildren(el('option', { value: '', text: 'All clusters' }), ...problemsStore.contexts().map(context => el('option', { value: context, text: labelFor(context) }))); clusterSelect.value = problemFilters.context; };
  clusterSelect.addEventListener('change', () => { problemFilters.context = clusterSelect.value; draw(); });
  namespaceInput.addEventListener('input', () => { problemFilters.namespace = namespaceInput.value.trim(); draw(); });
  onlyTab.addEventListener('change', () => { problemFilters.onlyTab = onlyTab.checked; draw(); });
  function row(problem) {
    const actionsNode = el('span', { class: 'problem-actions' },
      problem.credentials ? button('Sign in again', event => { event.stopPropagation(); signIn(problem.context).catch(error => toast(error.message, true)); }, 'compact') : null,
      problem.resource === 'pods' ? button('Logs', event => { event.stopPropagation(); task(() => podLogsOf(problem))(); }, 'compact quiet') : null,
      problem.resource === 'cluster' ? null : button('Open', event => { event.stopPropagation(); task(() => openProblem(problem))(); }, 'compact quiet'),
      button('Snooze 1 h', event => { event.stopPropagation(); problemsStore.snooze(problem.id); }, 'compact quiet'));
    const node = el('div', { class: 'problem-row', role: 'button', tabindex: '0', title: problem.detail },
      el('i', { class: `severity-dot ${problem.severity}`, title: problem.severity }),
      el('span', { class: 'problem-what' }, el('span', { class: 'problem-kind', text: PROBLEM_KINDS[problem.resource] || problem.resource }), el('strong', { text: problem.name })),
      el('span', { class: 'problem-ns muted', text: problem.namespace }),
      el('span', { class: 'problem-title' }, el('span', { text: problem.title }), problem.detail ? el('small', { class: 'muted', text: problem.detail }) : null),
      el('span', { class: 'problem-since muted', text: problem.since ? age(problem.since) : '' }),
      actionsNode);
    const open = () => { if (problem.resource === 'cluster') { if (problem.context !== state.context) task(() => selectContext(problem.context, { namespace: '*' }))(); } else task(() => openProblem(problem))(); };
    node.addEventListener('click', open);
    node.addEventListener('keydown', event => { if (event.key === 'Enter' && event.target === node) open(); });
    return node;
  }
  function draw() {
    fillClusters();
    const tabContext = activeTab().context;
    const shown = problemsStore.all().filter(problem => problemFilters.severities.has(problem.severity)
      && (!problemFilters.context || problem.context === problemFilters.context)
      && (!problemFilters.onlyTab || problem.context === tabContext)
      && (!problemFilters.namespace || (problem.namespace || '').includes(problemFilters.namespace)));
    const contexts = problemsStore.contexts();
    if (!shown.length) { list.replaceChildren(empty(contexts.length ? `Nothing to report in ${contexts.length} cluster${contexts.length === 1 ? '' : 's'}` : 'No clusters are being watched yet', contexts.length ? 'Pods, workloads, nodes and Argo CD applications look healthy.' : 'Open a cluster and its problems appear here.', undefined, contexts.length ? '✓' : '◈')); return; }
    const nodes = [];
    for (const context of [...new Set(shown.map(problem => problem.context))]) {
      const meta = infoFor(context);
      nodes.push(el('div', { class: 'problem-cluster' }, el('span', { class: 'tab-cluster', style: `color:${meta.color}` }, clusterIcon(meta.icon)), el('strong', { text: meta.label }), el('span', { class: 'muted', text: `${shown.filter(problem => problem.context === context).length} problems` })));
      nodes.push(...shown.filter(problem => problem.context === context).map(row));
    }
    list.replaceChildren(...nodes);
  }
  draw();
  problemsPageRefresh = draw;
  const timer = setInterval(draw, 30000);
  signal.addEventListener('abort', () => { clearInterval(timer); if (problemsPageRefresh === draw) problemsPageRefresh = null; }, { once: true });
  return root;
}
// ---- Credential health --------------------------------------------------------------------------
// A cluster whose credentials expired is marked on its tab, in the switcher and on the hotbar, and the
// page shows a banner offering the one command that fixes it, run in the terminal dock.
function authChanged() { renderTabs(); renderCluster(); }
hooks.authProblem = (context, problem) => { if (credentials.mark(context, { message: problem?.error || problem?.message || '', plugin: problem?.plugin || '' })) authChanged(); };
function renderAuthBanner() {
  const node = $('#auth-banner');
  const context = activeTab().context;
  const banner = credentials.bannerFor(context);
  if (!banner) { node.classList.add('hidden'); node.replaceChildren(); return; }
  const parts = credentials.bannerParts(labelFor(context), banner.entry);
  node.classList.remove('hidden');
  node.replaceChildren(
    el('span', { class: 'auth-banner-text' }, parts.before, el('strong', { text: parts.label }), parts.after, banner.canSignIn ? null : el('small', { text: ` ${banner.remedyLabel}` })),
    el('span', { class: 'spacer' }),
    banner.canSignIn ? button('Sign in again', task(() => signIn(context)), 'compact primary') : button('Retry', task(() => reconnect(context)), 'compact'),
    button('Dismiss', () => { credentials.dismiss(context); renderAuthBanner(); }, 'compact quiet'));
}
// After a sign-in the server forgets the failure and drops its proxy, then the views reconnect.
async function reconnect(context) {
  await post('/api/contexts/recheck', { context });
  credentials.clear(context);
  if (state.context === context) await selectContext(context, { namespace: state.namespace, fromTab: true });
  else authChanged();
}
async function signIn(context) {
  const remedy = credentials.authOf(context).remedy;
  if (!remedy?.preset) { await reconnect(context); return; }
  await openTerminal({ context, run: remedy.preset, title: `Sign in · ${labelFor(context)}`, onExit: code => {
    if (code === 0) reconnect(context).catch(error => toast(error.message, true));
    else $('#status-message').textContent = 'Sign-in failed; try again';
  } });
}
// ---- Access checks (Settings › Access) -------------------------------------------------------
// Opens the access panel of a cluster (the current one by default).
async function showAccess(context = state.context) {
  if (context && context !== state.context) await selectContext(context, { namespace: '*' });
  state.scrollTarget = 'access-panel';
  openView('settings', undefined, 'Settings');
}
hooks.showAccess = showAccess;
function accessPanel() {
  const context = state.context;
  const body = el('div');
  const namespace = el('select', { 'aria-label': 'Namespace to check' }, el('option', { value: '*', text: 'All namespaces' }), ...(cacheOf(context).namespaces || []).map(value => el('option', { value, text: value })));
  namespace.value = state.namespace === '*' || (cacheOf(context).namespaces || []).includes(state.namespace) ? state.namespace : '*';
  let last = null;
  const run = refresh => task(async () => {
    body.replaceChildren(loading('Asking your cluster what you may do…'));
    try { last = await post('/api/access/check', { context, namespace: namespace.value, refresh }, { context }); draw(); } catch (error) { last = null; if (error.name !== 'AbortError') body.replaceChildren(info(error.message, 'error')); }
  });
  const draw = () => {
    const rows = [];
    for (const group of groupByFeature(last.checks)) group.checks.forEach((check, index) => rows.push(el('tr', {},
      el('td', { text: index ? '' : group.feature }),
      el('td', {}, el('code', { text: permissionText(check) }), el('small', { class: 'muted', text: ` ${scopeText(check)}` })),
      el('td', { title: check.error || check.reason || (check.allowed ? 'Allowed' : 'Denied') }, el('span', { class: check.allowed ? 'access-yes' : 'access-no', text: check.allowed ? '✓' : '✗' }), check.allowed ? null : el('small', { class: 'muted', text: ` ${check.error ? 'could not check' : check.reason || 'denied'}` })))));
    body.replaceChildren(
      el('p', { class: 'muted', text: `${last.user ? `Signed in as ${last.user}${last.groups?.length ? ` · groups: ${last.groups.join(', ')}` : ''}. ` : ''}${summary(last)}` }),
      el('table', { class: 'access-table' }, el('thead', {}, el('tr', {}, ['Feature', 'Permission', 'Result'].map(title => el('th', { text: title })))), el('tbody', {}, rows)));
  };
  namespace.addEventListener('change', run(false));
  const copy = button('Copy as text', task(async () => { if (!last) return; await navigator.clipboard.writeText(asText(last, { label: labelFor(context), context })); toast('Copied.'); }), 'compact quiet');
  const node = panel(`Access · ${labelFor(context)}`, [info('What your identity may do in this cluster, asked of the API server (SelfSubjectAccessReview). Nothing is changed.'), el('div', { class: 'form-actions start', style: 'margin:10px 0' }, el('label', { class: 'inline-label', text: 'Namespace ' }, namespace), button('Re-check', run(true), 'compact'), copy), body]);
  node.id = 'access-panel';
  run(false)();
  return node;
}
// ---- Live data: WebSocket subscriptions to shared Kubernetes watches -------------------------
const LIVE_LABELS = { connecting: 'Connecting', live: 'Live', reconnecting: 'Reconnecting', polling: 'Polling', snapshot: 'Snapshot', error: 'Error' };
const LIVE_RANK = { error: 5, reconnecting: 4, connecting: 3, snapshot: 2, polling: 1, live: 0 };
function liveBadge() {
  const label = el('span', { class: 'live-label', text: LIVE_LABELS.connecting });
  const node = el('span', { class: 'live-status connecting', role: 'status', title: 'Connecting to the cluster…' }, el('span', { class: 'live-dot' }), label);
  const sources = new Map();
  // Several subscriptions can share one badge; the least healthy state wins.
  node.track = (source, status) => {
    sources.set(source, status);
    const worst = [...sources.values()].sort((a, b) => (LIVE_RANK[b.state] ?? 3) - (LIVE_RANK[a.state] ?? 3))[0];
    node.className = `live-status ${worst.state}`; label.textContent = LIVE_LABELS[worst.state] || worst.state; node.title = worst.message || '';
    state.pageLive = [...sources.values()].every(status => ['live', 'polling', 'connecting', 'reconnecting'].includes(status.state));
  };
  return node;
}
// One feed per (context, namespace, resource) is shared by every view that shows it and kept for a
// few minutes after the last view closes, so returning to a page renders at once from memory
// while the watch keeps it current. Fatal errors and snapshots are not kept.
const FEED_LINGER_MS = 5 * 60 * 1000;
const feeds = new Map();
function openFeed(key, { context, namespace, resource }) {
  const feed = { key, items: new Map(), synced: false, status: null, listeners: new Set(), closed: false, snapshot: false };
  let staging = null; let socket = null; let attempt = 0; let resyncNext = false;
  let retryTimer = null; let flushTimer = null; let lingerTimer = null;
  let changed = new Set(); let deleted = new Set();
  const abort = new AbortController();
  const each = fn => { for (const listener of [...feed.listeners]) { try { fn(listener); } catch (error) { console.error(error); } } };
  const emit = () => {
    clearTimeout(flushTimer); flushTimer = null;
    if (feed.closed) return;
    const change = { changed, deleted, map: feed.items }; changed = new Set(); deleted = new Set();
    each(listener => listener.onData([...feed.items.values()], change));
  };
  const schedule = () => { if (!flushTimer) flushTimer = setTimeout(emit, 120); };
  const setStatus = status => { feed.status = status; each(listener => listener.onStatus?.(status)); };
  const forget = () => { if (feeds.get(key) === feed) feeds.delete(key); };
  feed.close = () => {
    if (feed.closed) return;
    feed.closed = true; forget();
    clearTimeout(retryTimer); clearTimeout(flushTimer); clearTimeout(lingerTimer);
    abort.abort(); const ws = socket; socket = null; ws?.close();
  };
  const fail = error => { forget(); each(listener => listener.onError?.(error)); feed.close(); };
  async function snapshot(message) {
    feed.snapshot = true;
    setStatus({ state: 'snapshot', message: message || 'Live updates are unavailable; showing a snapshot. Use Refresh to update.' });
    try {
      const result = await get('/api/resources', { context, namespace, resource }, { signal: abort.signal });
      feed.items = new Map((result.items || []).map(item => [liveKey(item), item])); changed = new Set(feed.items.keys()); feed.synced = true; emit();
    } catch (error) { if (!abort.signal.aborted) fail(error); }
  }
  function connect() {
    if (feed.closed) return;
    const ws = new WebSocket(socketURL('/api/watch', { context, namespace, resource, resync: resyncNext ? '1' : undefined }));
    resyncNext = false; socket = ws;
    ws.onmessage = event => {
      if (socket !== ws) return;
      let message; try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'status') setStatus(message);
      else if (message.type === 'reset') staging = new Map();
      else if (message.type === 'items') for (const item of message.items || []) staging?.set(liveKey(item), item);
      else if (message.type === 'synced') {
        const previous = feed.items; feed.items = staging || new Map(); staging = null; attempt = 0;
        if (feed.synced) { for (const [id, item] of feed.items) if (liveStamp(previous.get(id) || {}) !== liveStamp(item)) changed.add(id); for (const id of previous.keys()) if (!feed.items.has(id)) deleted.add(id); }
        feed.synced = true; emit();
        if (credentials.clear(context)) authChanged();
      } else if (message.type === 'changes') {
        for (const item of message.upserts || []) { const id = liveKey(item); feed.items.set(id, item); changed.add(id); deleted.delete(id); }
        for (const id of message.deletes || []) { feed.items.delete(id); deleted.add(id); changed.delete(id); }
        schedule();
      } else if (message.type === 'error') { setStatus({ state: 'error', message: message.error }); fail(Object.assign(new Error(message.error), { status: message.status, code: message.code, plugin: message.plugin })); if (message.code === 'credentials') hooks.authProblem(context, message); }
      else if (message.type === 'unavailable') { socket = null; ws.close(); snapshot(message.message); }
    };
    ws.onclose = () => {
      if (feed.closed || socket !== ws) return;
      attempt++;
      setStatus({ state: 'reconnecting', message: 'The connection to Rubban was interrupted. Reconnecting…' });
      retryTimer = setTimeout(connect, Math.min(15000, 500 * 2 ** attempt));
    };
  }
  // Refresh: relist on the server; the current items stay on screen until the new list arrives.
  feed.resync = () => {
    if (feed.closed) return;
    if (feed.snapshot) { snapshot(); return; }
    clearTimeout(retryTimer); resyncNext = true;
    const ws = socket; socket = null; ws?.close(); staging = null;
    connect();
  };
  feed.subscribe = listener => {
    clearTimeout(lingerTimer);
    feed.listeners.add(listener);
    // Delivered after the caller finishes building its view, before the page is painted.
    queueMicrotask(() => {
      if (!feed.listeners.has(listener) || feed.closed) return;
      if (feed.status) listener.onStatus?.(feed.status);
      if (feed.synced) listener.onData([...feed.items.values()], { changed: new Set(), deleted: new Set(), map: feed.items, cached: true });
    });
  };
  feed.unsubscribe = listener => {
    if (!feed.listeners.delete(listener) || feed.listeners.size || feed.closed) return;
    if (feed.snapshot) { feed.close(); return; }
    lingerTimer = setTimeout(feed.close, FEED_LINGER_MS);
  };
  feed.start = resync => { resyncNext = resync; connect(); };
  return feed;
}
function liveList({ resource, context = state.context, namespace = state.namespace, signal, onData, onStatus, onError, resync = false }) {
  if (signal?.aborted) return;
  const key = JSON.stringify([context, namespace, resource]);
  let feed = feeds.get(key);
  if (!feed || feed.closed) { feed = openFeed(key, { context, namespace, resource }); feeds.set(key, feed); feed.start(resync); }
  else if (resync) feed.resync();
  const listener = { onData, onStatus, onError };
  feed.subscribe(listener);
  signal?.addEventListener('abort', () => feed.unsubscribe(listener), { once: true });
}
const byNamespaceName = (a, b) => (a.metadata?.namespace || '').localeCompare(b.metadata?.namespace || '') || (a.metadata?.name || '').localeCompare(b.metadata?.name || '');
// Ages are rendered text; refresh them periodically while the view is open.
function tickAges(views, signal) { const timer = setInterval(() => views.forEach(view => view.refresh()), 30000); signal.addEventListener('abort', () => clearInterval(timer), { once: true }); }
// Keep an open detail drawer in sync with the list it was opened from.
function syncSelected(change) {
  const selected = state.selected;
  if (!selected || selected.context !== state.context || !selected.item?.metadata) return;
  const id = liveKey(selected.item);
  if (change.deleted.has(id)) selected.liveUpdate?.(null, true);
  else if (change.changed.has(id)) selected.liveUpdate?.(change.map.get(id), false);
}
function consumeResync() { const value = state.resync; state.resync = false; return Boolean(value); }
function refreshView() { state.resync = true; render(); }
function afterMutation() { if (!state.pageLive) render(); }

// From the switcher, hotbar or welcome page the current tab moves to the cluster; from a tab
// (fromTab) the tab already names it. Cached discovery, CRDs and namespaces show at once.
async function selectContext(name, { namespace = '*', fromTab = false } = {}) {
  state.contextAbort?.abort();
  const contextAbort = new AbortController(); state.contextAbort = contextAbort;
  if (!fromTab) {
    const tab = activeTab();
    const twin = state.tabs.find(item => item !== tab && item.context === name && sameView(item, tab));
    if (twin) { state.tabs = state.tabs.filter(item => item !== tab); state.active = twin.id; twin.namespace = namespace; }
    else { tab.context = name; tab.namespace = namespace; }
  }
  const cache = cacheOf(name);
  state.context = name; state.namespace = namespace; state.discovery = cache.discovery; state.crds = cache.crds; state.selected = null;
  $('#drawer').classList.add('hidden'); state.drawerHistory = [];
  usage.setContext(name);
  $('#context-caption').textContent = name ? 'Live connection · kubeconfig credentials' : 'Choose a kubeconfig context';
  $('#connection-status').textContent = name ? (cache.namespaces ? 'Cluster connected' : 'Context selected') : 'No cluster selected';
  $('#connection-dot').classList.toggle('connected', Boolean(name)); $('#workspace-dot').classList.toggle('connected', Boolean(name));
  $('#namespace').replaceChildren(el('option', { value: '*', text: 'All namespaces' }), ...(cache.namespaces || []).map(value => el('option', { value, text: value })));
  $('#namespace').value = namespace;
  renderFavorites();
  navigation();
  renderTabs();
  render();
  saveTabs();
  if (!name) return;
  liveList({ resource: 'customresourcedefinitions', context: name, namespace: '*', signal: contextAbort.signal,
    onData: items => { cache.crds = items; problemsStore.sync(state.tabs.map(tab => tab.context)); if (state.context === name) { state.crds = items; navigation(); } },
    onError: () => { if (state.context === name) { state.crds = null; navigation(); } } });
  let namespacesLoaded = false;
  liveList({ resource: 'namespaces', context: name, namespace: '*', signal: contextAbort.signal,
    onStatus: value => { if (state.context === name) $('#connection-status').textContent = value.state === 'live' ? 'Cluster connected · live' : value.state === 'reconnecting' ? 'Reconnecting to cluster…' : value.state === 'error' ? 'Connection needs attention' : value.state === 'snapshot' ? 'Cluster connected' : $('#connection-status').textContent; },
    onData: items => {
      if (state.context !== name) return;
      const names = items.map(item => item.metadata.name).sort();
      cache.namespaces = names;
      if (state.namespace !== '*' && !names.includes(state.namespace)) names.push(state.namespace);
      $('#namespace').replaceChildren(el('option', { value: '*', text: 'All namespaces' }), ...names.map(value => el('option', { value, text: value })));
      $('#namespace').value = state.namespace;
      namespacesLoaded = true;
    },
    onError: error => {
      if (state.context !== name) return;
      // Namespace-scoped credentials cannot list namespaces: offer the context's own namespace instead of failing loudly.
      if (!namespacesLoaded && (error.status === 403 || /forbidden/i.test(error.message))) {
        const own = state.contexts.find(context => context.name === name)?.namespace;
        if (own) $('#namespace').append(el('option', { value: own, text: own }));
        $('#connection-status').textContent = 'Cluster connected · namespace list not permitted';
        return;
      }
      $('#connection-status').textContent = namespacesLoaded ? 'Connection needs attention' : 'Namespaces unavailable'; toast(error.message, true);
    } });
  try {
    const discovery = await get('/api/discovery', { context: name }, { signal: contextAbort.signal });
    if (state.context !== name || contextAbort.signal.aborted) return;
    cache.discovery = discovery.resources || []; state.discovery = cache.discovery; navigation(); if (activeTab().section === 'discovery') render();
  } catch (error) { if (!contextAbort.signal.aborted) toast(`Discovery: ${error.message}`, true); }
}
function welcome() {
  const root = el('div', { class: 'welcome' }, el('span', { class: 'welcome-tag' }, '◈  YOUR INDEPENDENT WORKSPACE'), el('h1', { text: 'Your clusters. A clearer perspective.' }), el('p', { text: 'Explore Kubernetes, troubleshoot workloads, and manage your infrastructure from one local desktop workspace. Choose a kubeconfig context to get started.' }));
  const choices = el('div', { class: 'context-list' });
  for (const context of state.contexts) { const meta = infoFor(context.name); const mark = el('span', { style: `color:${meta.color}` }); mark.append(clusterIcon(meta.icon)); choices.append(button([mark, el('div', {}, el('strong', { text: meta.label }), el('small', { text: meta.label === context.name ? context.cluster || 'Kubeconfig context' : context.name })), el('span', { class: 'spacer' }), credentials.isExpired(context.name) ? badge('credentials expired', 'warn') : null, meta.env ? badge(meta.env, meta.env === 'production' ? 'bad' : meta.env === 'staging' ? 'warn' : 'info') : null, el('span', { text: '→' })], () => selectContext(context.name), 'context-choice')); }
  if (state.contextsError) choices.append(info(`Could not read kubeconfig contexts: ${state.contextsError}`, 'error'), button('Reload contexts', task(reloadContexts), 'compact'));
  else if (!state.contexts.length) choices.append(info('No kubeconfig contexts were found. Paste or import a kubeconfig below, or configure one with kubectl.'));
  root.append(el('div', { class: 'welcome-grid' }, panel('Choose a cluster', choices, badge(`${state.contexts.length} contexts`)), panel('Built for the work you do', [el('div', { class: 'feature-row' }, el('span', { text: '▦' }), el('div', {}, el('strong', { text: 'See the whole cluster' }), 'Workloads, networking, storage, access, and custom resources.')), el('div', { class: 'feature-row' }, el('span', { text: '›_' }), el('div', {}, el('strong', { text: 'Troubleshoot in context' }), 'Live logs, interactive terminals, metrics, and port forwarding.')), el('div', { class: 'feature-row' }, el('span', { text: '⑂' }), el('div', {}, el('strong', { text: 'Operate on your terms' }), 'Helm, Argo CD, and your own connected services.'))])));
  root.append(el('div', { style: 'margin-top:18px' }, importPanels(() => openView('clusters'))));
  const tools = state.health?.tools || {};
  root.append(el('div', { class: 'actions', style: 'margin-top:22px' }, badge(`kubectl ${toolAvailable(tools.kubectl) ? 'available' : 'not found'}`, toolAvailable(tools.kubectl) ? 'good' : 'warn'), badge(`Helm ${toolAvailable(tools.helm) ? 'available' : 'not found'}`, toolAvailable(tools.helm) ? 'good' : 'warn'), button('Connection settings', () => openView('settings'), 'quiet compact')));
  return root;
}
function toolAvailable(value) { return typeof value === 'object' ? value?.available !== false && Boolean(value?.path || value?.available || value?.version) : Boolean(value); }

async function render() {
  state.pageAbort?.abort(); state.pageAbort = new AbortController(); state.pageLive = false;
  const id = ++state.renderId;
  const tab = activeTab();
  $('#status-message').textContent = state.context ? (state.namespace === '*' ? 'all namespaces' : state.namespace) : 'Ready';
  const globalPages = ['settings', 'ai', 'forwards', 'helm-charts', 'clusters', 'problems'];
  if (!state.context && !globalPages.includes(tab.section)) { $('#main').replaceChildren(welcome()); return; }
  $('#main').replaceChildren(loading());
  try {
    let node;
    switch (tab.section) {
      case 'overview': node = await overview(); break;
      case 'applications': node = await applicationsPage(); break;
      case 'argocd': node = argoManagerPage({ liveList, liveBadge, consumeResync, refreshView, syncSelected, tickAges }); break;
      case 'rabbitmq': node = rabbitmqPage(); break;
      case 'workloads': node = await workloadsPage(); break;
      case 'resource': node = await resourcePage(tab); break;
      case 'helm-charts': node = await helmChartsPage(); break;
      case 'events': node = await eventPage(); break;
      case 'metrics': node = await metricsPage(); break;
      case 'helm': node = await helmPage(); break;
      case 'forwards': node = await forwardsPage(); break;
      case 'discovery': node = discoveryPage(); break;
      case 'settings': node = await settingsPage(); break;
      case 'clusters': node = await clustersPage(); break;
      case 'problems': node = problemsPage(); break;
      case 'ai': node = aiPage(); break;
      default: node = empty('View not available', 'Select a view from the sidebar.');
    }
    if (id === state.renderId) {
      $('#main').replaceChildren(node);
      if (state.scrollTarget) { document.getElementById(state.scrollTarget)?.scrollIntoView(); state.scrollTarget = ''; }
      // The problems inbox starts watching a cluster once a tab on it has been drawn.
      if (state.context) problemsStore.contextRendered(state.context);
    }
  } catch (error) { if (id === state.renderId) $('#main').replaceChildren(displayError(error)); }
}

// ---- Cluster overview: capacity, consumption, history, top consumers and issues --------------
function sumUsage(nodes, pods) {
  const total = { cpu: 0, memory: 0, cpuAllocatable: 0, memoryAllocatable: 0, podsAllocatable: 0, cpuCapacity: 0, memoryCapacity: 0, measuredNodes: 0, cpuMeasuredAllocatable: 0, memoryMeasuredAllocatable: 0, unmeasured: [] };
  for (const node of nodes) {
    total.cpuAllocatable += parseCPU(node.status?.allocatable?.cpu) || 0; total.memoryAllocatable += parseMemory(node.status?.allocatable?.memory) || 0;
    total.cpuCapacity += parseCPU(node.status?.capacity?.cpu) || 0; total.memoryCapacity += parseMemory(node.status?.capacity?.memory) || 0;
    total.podsAllocatable += Number(node.status?.allocatable?.pods) || 0;
    const sample = usage.node(node.metadata.name);
    if (sample) { total.cpu += sample.cpu; total.memory += sample.memory; total.measuredNodes++; total.cpuMeasuredAllocatable += parseCPU(node.status?.allocatable?.cpu) || 0; total.memoryMeasuredAllocatable += parseMemory(node.status?.allocatable?.memory) || 0; }
    else total.unmeasured.push(node.metadata.name);
  }
  const names = new Set(nodes.map(n => n.metadata.name));
  const scheduled = pods.filter(p => names.has(p.spec?.nodeName));
  const specs = usage.summarize(scheduled);
  return { ...total, cpuRequest: specs.cpuRequest, cpuLimit: specs.cpuLimit, memoryRequest: specs.memoryRequest, memoryLimit: specs.memoryLimit, pods: scheduled.filter(p => !['Succeeded', 'Failed'].includes(p.status?.phase)).length };
}
function usageColumn(title, fmt, used, request, limit, allocatable, capacity, measured) {
  const ratioText = value => (allocatable ? ` (${formatPercent(value, allocatable) || '0%'})` : '');
  return el('div', { class: 'usage-column' },
    meter({ label: title, used: measured ? used : NaN, total: allocatable, request: request || undefined, limit: limit || undefined, detail: measured ? `${formatPercent(used, allocatable) || '0%'} used` : 'usage not reported' }),
    el('dl', { class: 'usage-legend' },
      el('dt', {}, el('i', { class: 'swatch usage' }), 'Usage'), el('dd', { text: measured ? `${fmt(used)}${ratioText(used)}` : '—' }),
      el('dt', {}, el('i', { class: 'swatch request' }), 'Requests'), el('dd', { text: `${fmt(request)}${ratioText(request)}` }),
      el('dt', {}, el('i', { class: 'swatch limit' }), 'Limits'), el('dd', { text: `${fmt(limit)}${ratioText(limit)}` }),
      el('dt', {}, el('i', { class: 'swatch allocatable' }), 'Allocatable'), el('dd', { text: fmt(allocatable) }),
      capacity !== undefined ? el('dt', {}, el('i', { class: 'swatch capacity' }), 'Capacity') : null, capacity !== undefined ? el('dd', { text: fmt(capacity) }) : null));
}
function clusterIssues(nodes, pods, events) {
  const issues = [];
  for (const node of nodes) {
    const [text, level] = nodeCondition(node);
    if (level !== 'good') issues.push({ key: `node/${node.metadata.name}`, level, kind: 'Node', name: node.metadata.name, namespace: '', message: text, time: (node.status?.conditions || []).find(c => c.type === 'Ready')?.lastTransitionTime, item: node, resource: 'nodes' });
  }
  for (const pod of pods) {
    const [text, level] = statusOf(pod);
    if (level === 'bad' || (level === 'warn' && pod.status?.phase !== 'Succeeded' && Date.now() - new Date(pod.metadata.creationTimestamp).getTime() > 300000)) issues.push({ key: `pod/${pod.metadata.namespace}/${pod.metadata.name}`, level, kind: 'Pod', name: pod.metadata.name, namespace: pod.metadata.namespace, message: text, time: pod.status?.startTime || pod.metadata.creationTimestamp, item: pod, resource: 'pods' });
  }
  for (const event of events.filter(e => e.type === 'Warning').sort((a, b) => eventTime(b) - eventTime(a)).slice(0, 200)) {
    const target = involved(event);
    issues.push({ key: `event/${event.metadata.uid}`, level: 'warn', kind: target.kind || 'Event', name: target.name || event.metadata.name, namespace: event.metadata.namespace, message: `${event.reason}: ${event.message || event.note || ''}`, time: event.lastTimestamp || event.eventTime || event.metadata.creationTimestamp, item: event, resource: 'events' });
  }
  return issues.sort((a, b) => (a.level === 'bad' ? 0 : 1) - (b.level === 'bad' ? 0 : 1) || new Date(b.time) - new Date(a.time));
}
function namespaceRows(pods) {
  const groups = new Map();
  for (const pod of pods) { const ns = pod.metadata.namespace; if (!groups.has(ns)) groups.set(ns, []); groups.get(ns).push(pod); }
  return [...groups].map(([name, list]) => ({ name, pods: list, summary: usage.summarize(list), metadata: { uid: `ns:${name}`, name } }));
}
const aggregateColumns = (label, nameOf, extra = []) => [
  { id: 'name', title: label, class: 'name', locked: true, render: nameOf, sort: row => row.metadata?.name },
  ...extra,
  { id: 'pods', title: 'Pods', class: 'num', render: row => String(row.pods.length), sort: row => row.pods.length },
  { id: 'cpu', title: 'CPU', class: 'usage', sortDesc: true, render: row => (row.summary.measured ? usageCell('cpu', row.summary.cpu, row.summary.cpuLimit && !row.summary.cpuLimitMissing ? { base: row.summary.cpuLimit, baseLabel: 'limits' } : { base: row.summary.cpuRequest, baseLabel: 'requests' }) : el('span', { class: 'muted', text: '—' })), sort: row => (row.summary.measured ? row.summary.cpu : NaN) },
  { id: 'cpuRequests', title: 'CPU requests', class: 'num', render: row => (row.summary.cpuRequest ? formatCPU(row.summary.cpuRequest) : '—'), sort: row => row.summary.cpuRequest },
  { id: 'cpuLimits', title: 'CPU limits', class: 'num', render: row => (row.summary.cpuLimit ? formatCPU(row.summary.cpuLimit) : '—'), sort: row => row.summary.cpuLimit },
  { id: 'memory', title: 'Memory', class: 'usage', sortDesc: true, render: row => (row.summary.measured ? usageCell('memory', row.summary.memory, row.summary.memoryLimit && !row.summary.memoryLimitMissing ? { base: row.summary.memoryLimit, baseLabel: 'limits' } : { base: row.summary.memoryRequest, baseLabel: 'requests' }) : el('span', { class: 'muted', text: '—' })), sort: row => (row.summary.measured ? row.summary.memory : NaN) },
  { id: 'memoryRequests', title: 'Memory requests', class: 'num', render: row => (row.summary.memoryRequest ? formatBytes(row.summary.memoryRequest) : '—'), sort: row => row.summary.memoryRequest },
  { id: 'memoryLimits', title: 'Memory limits', class: 'num', render: row => (row.summary.memoryLimit ? formatBytes(row.summary.memoryLimit) : '—'), sort: row => row.summary.memoryLimit },
  { id: 'efficiency', title: 'CPU used / requested', class: 'num', hidden: true, help: 'How much of the requested CPU is actually used', render: row => (row.summary.measured && row.summary.cpuRequest ? formatPercent(row.summary.cpu, row.summary.cpuRequest) : '—'), sort: row => (row.summary.measured && row.summary.cpuRequest ? row.summary.cpu / row.summary.cpuRequest : NaN) },
];
async function overview() {
  const signal = state.pageAbort.signal;
  const status = liveBadge();
  const roleFilter = el('select', { class: 'compact-select', 'aria-label': 'Nodes' }, el('option', { value: 'all', text: 'All nodes' }), el('option', { value: 'control', text: 'Control plane' }), el('option', { value: 'workers', text: 'Workers' }));
  roleFilter.value = readStore('rubban.overview.nodes', 'all');
  const root = page('Cluster overview', `${state.context} · live health, capacity and consumption across the whole cluster.`, actions(status, roleFilter, button('↻ Refresh', refreshView, 'compact')));
  const data = { nodes: null, pods: null, events: null };
  const errors = new Map();
  const cardDefs = [['nodes', 'Nodes', '⬡'], ['pods', 'Pods', '▦'], ['cpu', 'CPU in use', '◔'], ['memory', 'Memory in use', '◑'], ['issues', 'Issues', '⚑']];
  const cards = Object.fromEntries(cardDefs.map(([id, label, glyph]) => { const value = el('div', { class: 'card-value', text: '—' }); const detail = el('div', { class: 'card-detail', text: 'Loading…' }); return [id, { node: el('div', { class: 'card' }, el('div', { class: 'card-label' }, label, el('span', { class: 'card-icon', text: glyph })), value, detail), value, detail }]; }));
  const notes = el('div');
  const usagePanel = el('div', { class: 'usage-columns' }, loading());
  const historyHost = el('div');
  const topCtx = pageContext(usage);
  const topColumns = kindColumns('pods', topCtx).filter(c => ['name', 'namespace', 'cpu', 'memory', 'node'].includes(c.id));
  const topCPU = table([], topColumns, item => showResource(item, 'pods'), { key: liveKey, stamp: item => `${liveStamp(item)}|${usage.version}`, menu: item => rowMenu('pods', item), empty: 'Waiting for metrics…', placeholder: 'Filter…' });
  const topMemory = table([], topColumns, item => showResource(item, 'pods'), { key: liveKey, stamp: item => `${liveStamp(item)}|${usage.version}`, menu: item => rowMenu('pods', item), empty: 'Waiting for metrics…', placeholder: 'Filter…' });
  const namespacesView = table([], aggregateColumns('Namespace', row => row.name), row => showResource({ kind: 'Namespace', metadata: { name: row.name } }, 'namespaces'), { id: 'overview:namespaces', key: row => row.metadata.uid, stamp: row => `${row.pods.length}|${usage.version}|${row.pods.map(p => p.metadata.resourceVersion).join(',').length}`, sortBy: 'cpu', sortDesc: true, placeholder: 'Filter namespaces…', searchText: row => row.name });
  const issuesView = table([], [
    { id: 'level', title: '', render: row => el('span', { class: `issue-dot ${row.level}` }) },
    { id: 'message', title: 'Message', class: 'wrap', locked: true, render: row => row.message, sort: row => row.message },
    { id: 'object', title: 'Object', render: row => el('span', {}, el('span', { class: 'kind-tag', text: row.kind }), ' ', row.name), sort: row => `${row.kind}/${row.name}` },
    { id: 'namespace', title: 'Namespace', render: row => row.namespace || '—', sort: row => row.namespace },
    { id: 'age', title: 'Age', render: row => age(row.time), sort: row => -(new Date(row.time).getTime() || 0) },
  ], row => showResource(row.item, row.resource), { id: 'overview:issues', key: row => row.key, stamp: row => `${row.message}|${row.time}`, pending: true, empty: 'No issues: all nodes are ready, no pods are failing and there are no warning events.', placeholder: 'Filter issues…', searchText: row => `${row.message} ${row.kind} ${row.name} ${row.namespace}` });
  root.append(el('div', { class: 'cards' }, Object.values(cards).map(card => card.node)), notes,
    el('div', { class: 'section-label' }, el('h2', { text: 'Cluster usage' }), el('span', { text: 'Live usage from metrics.k8s.io; requests and limits from pod specs' })), panel('', usagePanel),
    el('div', { class: 'section-label' }, el('h2', { text: 'Usage over time' })), historyHost,
    el('div', { class: 'two-columns' }, el('div', {}, el('div', { class: 'section-label' }, el('h2', { text: 'Top pods by CPU' })), topCPU), el('div', {}, el('div', { class: 'section-label' }, el('h2', { text: 'Top pods by memory' })), topMemory)),
    el('div', { class: 'section-label' }, el('h2', { text: 'Consumption by namespace' }), el('span', { text: 'Every namespace with running pods' })), namespacesView,
    el('div', { class: 'section-label' }, el('h2', { text: 'Cluster issues' }), button('All events →', () => openView('events'), 'quiet compact')), issuesView);
  const selectedNodes = () => (data.nodes || []).filter(node => roleFilter.value === 'all' || (roleFilter.value === 'control' ? isControlPlane(node) : !isControlPlane(node)));
  const setCard = (id, value, detail) => { cards[id].value.textContent = value === undefined || value === null ? '—' : String(value); cards[id].detail.textContent = detail; };
  let historyKey = '';
  function renderHistory(nodes) {
    const key = `${roleFilter.value}:${nodes.length}`;
    if (key === historyKey) return;
    historyKey = key;
    const names = roleFilter.value === 'all' ? null : nodes.map(n => n.metadata.name);
    const totals = () => sumUsage(selectedNodes(), data.pods || []);
    historyHost.replaceChildren(panel('', metricsView({ context: state.context }, {
      queries: () => clusterQueries(names),
      charts: [
        { title: 'CPU', format: 'cpu', series: [{ key: 'cpu', name: 'Usage' }, { key: 'cpuRequests', name: 'Requests', dashed: true }, { key: 'cpuLimits', name: 'Limits', dashed: true }, { key: 'cpuAllocatable', name: 'Allocatable', dashed: true }] },
        { title: 'Memory', format: 'bytes', series: [{ key: 'memory', name: 'Usage' }, { key: 'memoryRequests', name: 'Requests', dashed: true }, { key: 'memoryLimits', name: 'Limits', dashed: true }, { key: 'memoryAllocatable', name: 'Allocatable', dashed: true }] },
        { title: 'Pods', format: 'count', series: [{ key: 'pods', name: 'Pods' }, { key: 'podsAllocatable', name: 'Allocatable', dashed: true }] },
      ],
      session: () => {
        const filter = names ? name => names.includes(name) : () => true;
        const h = usage.clusterHistory(filter); const t = totals();
        const line = (values, value) => (values.length && value ? [[values[0][0], value], [values.at(-1)[0], value]] : []);
        return [{ title: 'CPU', format: 'cpu', series: [{ name: 'Usage', values: h.cpu }, { name: 'Requests', dashed: true, values: line(h.cpu, t.cpuRequest) }, { name: 'Allocatable', dashed: true, values: line(h.cpu, t.cpuAllocatable) }] },
          { title: 'Memory', format: 'bytes', series: [{ name: 'Usage', values: h.memory }, { name: 'Requests', dashed: true, values: line(h.memory, t.memoryRequest) }, { name: 'Allocatable', dashed: true, values: line(h.memory, t.memoryAllocatable) }] }];
      },
    })));
  }
  function update() {
    const { nodes, pods, events } = data;
    if (nodes) { const ready = nodes.filter(n => n.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True')).length; setCard('nodes', nodes.length, `${ready} ready · ${nodes.length - ready} need attention · ${nodes.filter(isControlPlane).length} control plane`); }
    else if (errors.has('nodes')) setCard('nodes', null, 'Node inventory unavailable');
    if (pods) setCard('pods', pods.length, `${pods.filter(p => p.status?.phase === 'Running').length} running · ${pods.filter(p => p.status?.phase === 'Pending').length} pending · ${pods.filter(p => statusOf(p)[1] === 'bad').length} failing`);
    else if (errors.has('pods')) setCard('pods', null, 'Pod inventory unavailable');
    if (nodes && pods) {
      const shown = selectedNodes();
      const t = sumUsage(shown, pods);
      const measured = t.measuredNodes > 0;
      const partial = measured && t.unmeasured.length > 0;
      const onNodes = partial ? ` on ${t.measuredNodes} of ${shown.length} nodes` : '';
      setCard('cpu', measured ? formatCPU(t.cpu) : '—', measured ? `${formatPercent(t.cpu, t.cpuMeasuredAllocatable)} of ${formatCPU(t.cpuMeasuredAllocatable)} allocatable${onNodes} · ${formatPercent(t.cpuRequest, t.cpuAllocatable)} requested` : usage.available === false ? 'metrics-server unavailable' : 'Waiting for metrics…');
      setCard('memory', measured ? formatBytes(t.memory) : '—', measured ? `${formatPercent(t.memory, t.memoryMeasuredAllocatable)} of ${formatBytes(t.memoryMeasuredAllocatable)} allocatable${onNodes} · ${formatPercent(t.memoryRequest, t.memoryAllocatable)} requested` : usage.available === false ? 'metrics-server unavailable' : 'Waiting for metrics…');
      usagePanel.replaceChildren(
        usageColumn('CPU', formatCPU, t.cpu, t.cpuRequest, t.cpuLimit, t.cpuAllocatable, t.cpuCapacity, measured),
        usageColumn('Memory', formatBytes, t.memory, t.memoryRequest, t.memoryLimit, t.memoryAllocatable, t.memoryCapacity, measured),
        el('div', { class: 'usage-column' }, meter({ label: 'Pods', used: t.pods, total: t.podsAllocatable, detail: `${formatPercent(t.pods, t.podsAllocatable) || '0%'} of capacity` }), el('dl', { class: 'usage-legend' }, el('dt', {}, el('i', { class: 'swatch usage' }), 'Running'), el('dd', { text: String(t.pods) }), el('dt', {}, el('i', { class: 'swatch allocatable' }), 'Allocatable'), el('dd', { text: String(t.podsAllocatable) }), el('dt', {}, 'Nodes'), el('dd', { text: `${shown.length} of ${nodes.length}` }))));
      if (usage.available === false) usagePanel.append(info(`Live usage is unavailable: ${usage.message}. Install metrics-server to see consumption; requests and limits are still shown.`));
      else if (partial) usagePanel.append(info(`No usage for ${t.unmeasured.length} of ${shown.length} nodes (${t.unmeasured.slice(0, 3).join(', ')}${t.unmeasured.length > 3 ? ', …' : ''}): ${usage.nodeMissing(t.unmeasured[0]) || 'metrics-server has no sample for them'}. Usage totals cover the other nodes.`, 'warn'));
      renderHistory(shown);
      const measuredPods = pods.filter(p => usage.pod(p));
      topCtx.setPods(pods);
      topCPU.update([...measuredPods].sort((a, b) => usage.pod(b).cpu - usage.pod(a).cpu).slice(0, 10));
      topMemory.update([...measuredPods].sort((a, b) => usage.pod(b).memory - usage.pod(a).memory).slice(0, 10));
      namespacesView.update(namespaceRows(pods));
    }
    if (nodes && pods && events) {
      const issues = clusterIssues(nodes, pods, events);
      setCard('issues', issues.length, `${issues.filter(i => i.level === 'bad').length} critical · ${events.filter(e => e.type === 'Warning').length} warning events`);
      issuesView.update(issues);
    } else if (errors.has('events')) setCard('issues', null, 'Events unavailable');
    const messages = [...errors.values()];
    notes.replaceChildren(...(messages.length ? [info(messages.join(' · '))] : []));
  }
  let pending = null;
  const schedule = () => { if (!pending) pending = setTimeout(() => { pending = null; update(); }, 250); };
  signal.addEventListener('abort', () => clearTimeout(pending), { once: true });
  roleFilter.addEventListener('change', () => { writeStore('rubban.overview.nodes', roleFilter.value); historyKey = ''; update(); });
  const resync = consumeResync();
  const subscribe = (resource, onItems) => liveList({ resource, namespace: '*', signal, resync, onStatus: value => status.track(resource, value), onError: error => { errors.set(resource, `${resource}: ${error.message}`); schedule(); }, onData: (items, change) => { errors.delete(resource); onItems(items, change); schedule(); } });
  subscribe('nodes', items => { data.nodes = items; });
  subscribe('pods', (items, change) => { data.pods = items; syncSelected(change); });
  subscribe('events', items => { data.events = items; });
  // Cached feeds deliver before the page is painted: draw it now instead of after the debounce.
  queueMicrotask(() => { if (pending && data.nodes && data.pods) { clearTimeout(pending); pending = null; update(); } });
  usage.onChange(schedule, signal);
  tickAges([issuesView], signal);
  return root;
}
function usageStrip(resource, items, ctx) {
  if (!usesUsage(resource) || !items.length) return [];
  let total;
  if (resource === 'pods') total = usage.summarize(items);
  else if (resource === 'nodes') {
    total = { cpu: 0, memory: 0, measured: 0, cpuRequest: 0, memoryRequest: 0, cpuLimit: 0, memoryLimit: 0, cpuAllocatable: 0, memoryAllocatable: 0, cpuMeasuredAllocatable: 0, memoryMeasuredAllocatable: 0, fromKubelet: 0 };
    for (const node of items) {
      const sample = usage.node(node.metadata.name);
      const cpuAllocatable = parseCPU(node.status?.allocatable?.cpu) || 0; const memoryAllocatable = parseMemory(node.status?.allocatable?.memory) || 0;
      total.cpuAllocatable += cpuAllocatable; total.memoryAllocatable += memoryAllocatable;
      if (sample) { total.cpu += sample.cpu; total.memory += sample.memory; total.measured++; total.cpuMeasuredAllocatable += cpuAllocatable; total.memoryMeasuredAllocatable += memoryAllocatable; if (sample.source === 'kubelet') total.fromKubelet++; }
      const s = ctx.summary(node); if (s) { total.cpuRequest += s.cpuRequest; total.memoryRequest += s.memoryRequest; total.cpuLimit += s.cpuLimit; total.memoryLimit += s.memoryLimit; }
    }
  } else {
    total = { cpu: 0, memory: 0, measured: 0, cpuRequest: 0, memoryRequest: 0, cpuLimit: 0, memoryLimit: 0, pods: 0 };
    for (const item of items) { const s = ctx.summary(item); if (!s) continue; for (const key of Object.keys(total)) total[key] += s[key] || 0; }
  }
  if (!total.measured && !total.cpuRequest && !total.memoryRequest) return [];
  // Percentages compare usage with the allocatable of the nodes that reported usage, so a node
  // without metrics does not make the cluster look emptier than it is.
  const partial = resource === 'nodes' && total.measured && total.measured < items.length;
  const part = (label, fmt, used, request, limit, allocatable, measuredAllocatable) => el('span', { class: 'strip-item' }, el('strong', { text: label }), total.measured ? ` ${fmt(used)} used` : ' usage not reported',
    allocatable ? (partial ? ` of ${fmt(measuredAllocatable)} on ${total.measured} of ${items.length} nodes (${formatPercent(used, measuredAllocatable)})` : total.measured ? ` of ${fmt(allocatable)} (${formatPercent(used, allocatable)})` : ` · ${fmt(allocatable)} allocatable`) : '',
    request ? ` · ${fmt(request)} requested` : '', limit ? ` · ${fmt(limit)} limits` : '');
  const notes = [];
  if (partial) notes.push(el('span', { class: 'strip-item warn-text', title: items.filter(node => !usage.node(node.metadata.name)).map(node => `${node.metadata.name}: ${usage.nodeMissing(node.metadata.name) || 'metrics-server has no sample for this node'}`).join('\n') }, `${items.length - total.measured} node${items.length - total.measured === 1 ? '' : 's'} without usage`));
  if (resource === 'nodes' && total.fromKubelet) notes.push(el('span', { class: 'strip-item muted', title: 'metrics-server returned no sample for these nodes, so Rubban read their usage from the kubelet summary API.' }, `${total.fromKubelet} node${total.fromKubelet === 1 ? '' : 's'} read from the kubelet`));
  return [el('span', { class: 'strip-item muted' }, `${items.length.toLocaleString()} ${resource === 'nodes' ? 'nodes' : resource === 'pods' ? 'pods' : 'in view'}`),
    part('CPU', formatCPU, total.cpu, total.cpuRequest, total.cpuLimit, total.cpuAllocatable, total.cpuMeasuredAllocatable),
    part('Memory', formatBytes, total.memory, total.memoryRequest, total.memoryLimit, total.memoryAllocatable, total.memoryMeasuredAllocatable), ...notes];
}
async function resourcePage(tab) {
  const signal = state.pageAbort.signal;
  const status = liveBadge();
  const resource = tab.resource;
  const ctx = pageContext(usage);
  const withUsage = usesUsage(resource); const withPods = needsPods(resource);
  const template = templateFor(resource);
  const [plural, ...groupParts] = resource.split('.');
  const discovered = state.discovery.find(r => r.name === plural && (r.group || '') === groupParts.join('.'));
  const clusterScoped = discovered ? !discovered.namespaced : ['nodes', 'namespaces', 'persistentvolumes', 'storageclasses', 'clusterroles', 'clusterrolebindings', 'customresourcedefinitions', 'ingressclasses', 'priorityclasses', 'runtimeclasses', 'mutatingwebhookconfigurations', 'validatingwebhookconfigurations'].includes(resource);
  const root = page(tab.title, `${clusterScoped ? 'Cluster-scoped' : state.namespace === '*' ? 'All namespaces' : state.namespace} · ${discovered?.kind || resource}${discovered?.group ? ` · ${discovered.group}/${discovered.version || ''}` : ''}`, actions(status, button(template ? `Create ${template.kind}` : 'Create resource', () => createManifest(template?.kind), 'primary compact'), button('↻ Refresh', refreshView, 'compact')));
  root.classList.add('fill-page');
  if (resource === 'secrets') root.append(info('Secret names, types and keys are listed here. Values are fetched only when you reveal them in a secret’s details.'));
  const strip = el('div', { class: 'usage-strip' });
  const view = table([], columnsFor(resource, ctx), item => showResource(item, resource), { id: `resource:${resource}`, key: liveKey, stamp: withUsage || withPods ? item => `${liveStamp(item)}|${ctx.version()}` : liveStamp, pending: true, menu: item => rowMenu(resource, item), bulk: bulkActions(resource), searchText: searchTextFor(resource), sortBy: resource === 'events' ? 'lastSeen' : null, placeholder: `Filter ${tab.title.toLowerCase()}…` });
  root.append(strip, view);
  let items = [];
  const renderStrip = () => strip.replaceChildren(...usageStrip(resource, items, ctx));
  let throttle = null;
  const refreshRows = () => { if (throttle) return; throttle = setTimeout(() => { throttle = null; if (signal.aborted) return; view.update(items); renderStrip(); }, 400); };
  signal.addEventListener('abort', () => clearTimeout(throttle), { once: true });
  const resync = consumeResync();
  liveList({ resource, signal, resync, onStatus: value => status.track('list', value),
    onData: (next, change) => { items = resource === 'events' ? next : next.sort(byNamespaceName); view.update(items, change); renderStrip(); syncSelected(change); },
    onError: error => { if (root.contains(view)) view.replaceWith(error.status === 404 || /doesn't have a resource type|does not serve/.test(error.message) ? unavailableResource(resource) : displayError(error)); } });
  if (withPods) liveList({ resource: 'pods', namespace: podScopeFor(resource) || state.namespace, signal, resync, onStatus: value => status.track('pods', value), onData: pods => { ctx.setPods(pods); refreshRows(); }, onError: () => { ctx.setPods(null); refreshRows(); } });
  queueMicrotask(() => { if (throttle && items.length) { clearTimeout(throttle); throttle = null; view.update(items); renderStrip(); } });
  if (withUsage) usage.onChange(refreshRows, signal);
  tickAges([view], signal);
  return root;
}
function eventTable(events, options = {}) {
  return table(events, eventColumns(), item => showResource(item, 'events'), { key: liveKey, searchText: searchTextFor('events'), sortBy: 'lastSeen', placeholder: 'Filter events…', ...options });
}
async function eventPage() {
  const signal = state.pageAbort.signal;
  const status = liveBadge();
  const typeFilter = el('select', { class: 'compact-select', 'aria-label': 'Event type' }, el('option', { value: '', text: 'All types' }), el('option', { value: 'Warning', text: 'Warnings' }), el('option', { value: 'Normal', text: 'Normal' }));
  const root = page('Events', `${state.namespace === '*' ? 'All namespaces' : state.namespace} · scheduling, health and lifecycle events from the Kubernetes API.`, actions(status, typeFilter, button('↻ Refresh', refreshView, 'compact')));
  const view = eventTable([], { pending: true, id: 'events' });
  root.classList.add('fill-page');
  root.append(view);
  let items = [];
  const apply = change => view.update(typeFilter.value ? items.filter(item => (item.type || 'Normal') === typeFilter.value) : items, change);
  typeFilter.addEventListener('change', () => apply());
  liveList({ resource: 'events', signal, resync: consumeResync(), onStatus: value => status.track('events', value), onData: (next, change) => { items = next.sort((a, b) => eventTime(b) - eventTime(a)); apply(change); syncSelected(change); }, onError: error => view.replaceWith(displayError(error)) });
  tickAges([view], signal);
  return root;
}
// ---- Per-resource table columns ---------------------------------------------------------------
const ageColumn = { title: 'Age', render: item => age(item.metadata?.creationTimestamp) };
const nameColumn = { title: 'Name', class: 'name', render: item => item.metadata?.name || '—' };
const namespaceColumn = { title: 'Namespace', render: item => item.metadata?.namespace || 'Cluster scoped' };
const shortRepo = url => String(url || '').replace(/^https?:\/\//, '').replace(/\.git$/, '');
function argoSource(item) {
  const sources = item.spec?.sources?.length ? item.spec.sources : [item.spec?.source || {}];
  const first = sources[0] || {};
  const where = first.chart ? `${first.chart}${first.targetRevision ? `@${first.targetRevision}` : ''}` : first.path || '';
  return `${shortRepo(first.repoURL) || '—'}${where ? ` · ${where}` : ''}${sources.length > 1 ? ` (+${sources.length - 1})` : ''}`;
}
const argoHealthBadge = status => badge(status || 'Unknown', status === 'Healthy' ? 'good' : ['Degraded', 'Missing'].includes(status) ? 'bad' : 'warn');
const argoSyncBadge = status => badge(status || 'Unknown', status === 'Synced' ? 'good' : 'warn');
const COLUMNS = {
  'applications.argoproj.io': [nameColumn, namespaceColumn, { title: 'Project', render: item => item.spec?.project || 'default' },
    { title: 'Sync', render: item => argoSyncBadge(item.status?.sync?.status) }, { title: 'Health', render: item => argoHealthBadge(item.status?.health?.status) },
    { id: 'problems', title: 'Problems', class: 'wrap', render: item => { const errors = argoErrors(item); return errors.length ? el('span', { class: 'argo-problem' }, el('span', { class: `problem-count ${errors.some(e => e.level === 'error') ? 'bad' : 'warn'}`, text: String(errors.length) }), el('span', { class: 'argo-message', text: errors[0].message.slice(0, 120) })) : '—'; }, sort: item => -argoErrors(item).length, tooltip: item => argoErrors(item).map(e => `${e.source}: ${e.message}`).join('\n') },
    { title: 'Source', render: argoSource }, { title: 'Revision', class: 'mono', render: item => String(item.status?.sync?.revision || item.status?.sync?.revisions?.[0] || '').slice(0, 8) || '—' }, ageColumn],
  'applicationsets.argoproj.io': [nameColumn, namespaceColumn,
    { title: 'Generators', render: item => (item.spec?.generators || []).flatMap(generator => Object.keys(generator)).join(', ') || '—' },
    { title: 'Project', render: item => item.spec?.template?.spec?.project || '—' },
    { title: 'Status', render: item => { const error = (item.status?.conditions || []).find(c => c.type === 'ErrorOccurred' && c.status === 'True'); return error ? badge('Error', 'bad') : badge('OK', 'good'); } }, ageColumn],
  'appprojects.argoproj.io': [nameColumn, namespaceColumn, { title: 'Description', render: item => item.spec?.description || '—' },
    { title: 'Source repos', render: item => (item.spec?.sourceRepos || []).map(shortRepo).join(', ') || '—' },
    { title: 'Destinations', render: item => String((item.spec?.destinations || []).length) }, ageColumn],
};
const columnsFor = (resource, ctx = pageContext(usage)) => COLUMNS[resource] || kindColumns(resource, ctx);
const isArgoApplication = item => item?.kind === 'Application' && String(item.apiVersion || '').startsWith('argoproj.io/');
function unavailableResource(resource) {
  if (/\.argoproj\.io$/.test(resource)) return empty('Argo CD is not installed in this cluster', 'Rubban reads Argo CD’s own custom resources (Applications, ApplicationSets and AppProjects). Install Argo CD here, or switch to the cluster where Argo CD runs.', null, '⑂');
  return empty('Not available in this cluster', `This cluster does not serve the resource type “${resource}”. It may need a controller or custom resource definition that is not installed.`, null, '◌');
}
// ---- Applications: workloads grouped by their app instance labels ------------------------------
const APP_WORKLOADS = [['deployments', 'Deployment'], ['statefulsets', 'StatefulSet'], ['daemonsets', 'DaemonSet']];
function appIdentity(item) {
  const labels = item.metadata?.labels || {}; const annotations = item.metadata?.annotations || {};
  const tracking = annotations['argocd.argoproj.io/tracking-id'];
  const argoApp = labels['argocd.argoproj.io/instance'] || (tracking ? tracking.split(':')[0] : '');
  const name = labels['app.kubernetes.io/instance'] || argoApp || annotations['meta.helm.sh/release-name'] || labels['app.kubernetes.io/name'] || labels.app || labels['k8s-app'] || item.metadata?.name;
  const managedBy = argoApp ? 'Argo CD' : (annotations['meta.helm.sh/release-name'] || labels['app.kubernetes.io/managed-by'] === 'Helm') ? 'Helm' : labels['app.kubernetes.io/managed-by'] || '—';
  return { name, managedBy, version: labels['app.kubernetes.io/version'] || '' };
}
function readiness(item, kind) {
  if (kind === 'DaemonSet') return [item.status?.numberReady || 0, item.status?.desiredNumberScheduled || 0];
  return [item.status?.readyReplicas || 0, item.spec?.replicas ?? 1];
}
function rollingOut(item) {
  const generationBehind = (item.status?.observedGeneration ?? item.metadata?.generation) < (item.metadata?.generation ?? 0);
  const desired = item.spec?.replicas ?? item.status?.desiredNumberScheduled ?? 0;
  const updated = item.status?.updatedReplicas ?? item.status?.updatedNumberScheduled ?? desired;
  return generationBehind || updated < desired;
}
function appStatus(ready, desired, progressing) {
  if (!desired) return ['Scaled down', ''];
  if (ready >= desired) return progressing ? ['Progressing', 'info'] : ['Healthy', 'good'];
  if (progressing) return ['Progressing', 'info'];
  return ready ? ['Degraded', 'warn'] : ['Unavailable', 'bad'];
}
function groupApplications(byKind) {
  const apps = new Map();
  for (const [resource, kind] of APP_WORKLOADS) {
    for (const item of byKind[resource] || []) {
      const identity = appIdentity(item);
      const key = `${item.metadata?.namespace || ''}/${identity.name}`;
      if (!apps.has(key)) apps.set(key, { key, name: identity.name, namespace: item.metadata?.namespace || '', managedBy: new Set(), versions: new Set(), workloads: [], metadata: { uid: key } });
      const app = apps.get(key);
      if (identity.managedBy !== '—') app.managedBy.add(identity.managedBy);
      if (identity.version) app.versions.add(identity.version);
      const [ready, desired] = readiness(item, kind);
      app.workloads.push({ kind, resource, item, ready, desired, progressing: rollingOut(item) });
    }
  }
  return [...apps.values()].map(app => {
    const ready = app.workloads.reduce((sum, w) => sum + w.ready, 0);
    const desired = app.workloads.reduce((sum, w) => sum + w.desired, 0);
    const created = app.workloads.map(w => w.item.metadata?.creationTimestamp).filter(Boolean).sort()[0];
    const stamp = app.workloads.map(w => w.item.metadata?.resourceVersion).join(',');
    return { ...app, ready, desired, status: appStatus(ready, desired, app.workloads.some(w => w.progressing)), created, metadata: { uid: app.key, resourceVersion: stamp, name: app.name, namespace: app.namespace },
      managedByText: [...app.managedBy].join(', ') || '—', versionText: [...app.versions].join(', ') || '—' };
  }).sort((a, b) => (a.status[1] === 'good') - (b.status[1] === 'good') || a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
}
function workloadSummary(app) {
  const counts = new Map();
  for (const w of app.workloads) counts.set(w.kind, (counts.get(w.kind) || 0) + 1);
  return [...counts].map(([kind, count]) => `${count} ${kind}${count === 1 ? '' : 's'}`).join(', ');
}
function showApplication(app) {
  state.selected = { context: state.context, application: app.key };
  $('#drawer').classList.remove('hidden');
  $('#drawer-kind').textContent = `Application / ${app.namespace || 'cluster scoped'}`;
  $('#drawer-name').textContent = app.name;
  const root = el('div');
  root.append(el('div', { class: 'actions' }, badge(...app.status), badge(`${app.ready}/${app.desired} ready`)));
  if (app.summary) root.append(el('h3', { class: 'mini-title', text: 'Consumption' }), consumption(app.summary));
  const definition = el('dl', { class: 'definition' });
  for (const [label, value] of [['Namespace', app.namespace], ['Managed by', app.managedByText], ['Version', app.versionText], ['Workloads', workloadSummary(app)], ['Oldest workload', app.created ? new Date(app.created).toLocaleString() : '—']]) definition.append(el('dt', { text: label }), el('dd', { text: value || '—' }));
  root.append(definition, el('h3', { class: 'mini-title', text: 'Workloads' }));
  root.append(table(app.workloads, [{ title: 'Kind', render: w => w.kind }, { title: 'Name', class: 'name', render: w => w.item.metadata?.name }, { title: 'Ready', render: w => `${w.ready}/${w.desired}` },
    { title: 'CPU', class: 'num', render: w => { const pods = (app.pods || []).filter(p => (p.metadata?.labels && w.item.spec?.selector) ? Object.entries(w.item.spec.selector.matchLabels || {}).every(([k, v]) => p.metadata.labels[k] === v) : false); const s = usage.summarize(pods); return s.measured ? formatCPU(s.cpu) : '—'; } },
    { title: 'Memory', class: 'num', render: w => { const pods = (app.pods || []).filter(p => (p.metadata?.labels && w.item.spec?.selector) ? Object.entries(w.item.spec.selector.matchLabels || {}).every(([k, v]) => p.metadata.labels[k] === v) : false); const s = usage.summarize(pods); return s.measured ? formatBytes(s.memory) : '—'; } },
    { title: 'Status', render: w => badge(...appStatus(w.ready, w.desired, w.progressing)) }], w => showResource(w.item, w.resource), { searchText: w => `${w.kind} ${w.item.metadata?.name}` }));
  root.append(el('p', { class: 'list-note', text: 'Grouped by app.kubernetes.io/instance, Argo CD tracking, Helm release, app.kubernetes.io/name or app labels, in that order.' }));
  $('#drawer-content').replaceChildren(root);
}
async function applicationsPage() {
  const signal = state.pageAbort.signal;
  const status = liveBadge();
  const root = page('Applications', 'Workloads grouped into applications by their instance, Argo CD, Helm and app labels.', actions(status, button('↻ Refresh', refreshView, 'compact')));
  const view = table([], [
    { title: 'Application', class: 'name', render: app => app.name }, { title: 'Namespace', render: app => app.namespace },
    { title: 'Workloads', render: workloadSummary }, { id: 'ready', title: 'Ready', render: app => `${app.ready}/${app.desired}`, sort: app => app.desired },
    { id: 'cpu', title: 'CPU', class: 'usage', sortDesc: true, render: app => (app.summary?.measured ? usageCell('cpu', app.summary.cpu, app.summary.cpuLimit && !app.summary.cpuLimitMissing ? { base: app.summary.cpuLimit, baseLabel: 'limits' } : { base: app.summary.cpuRequest, baseLabel: 'requests' }) : el('span', { class: 'muted', text: '—' })), sort: app => (app.summary?.measured ? app.summary.cpu : NaN), tooltip: app => (app.summary ? `${app.summary.pods} pods · requests ${formatCPU(app.summary.cpuRequest)} · limits ${formatCPU(app.summary.cpuLimit)}` : '') },
    { id: 'memory', title: 'Memory', class: 'usage', sortDesc: true, render: app => (app.summary?.measured ? usageCell('memory', app.summary.memory, app.summary.memoryLimit && !app.summary.memoryLimitMissing ? { base: app.summary.memoryLimit, baseLabel: 'limits' } : { base: app.summary.memoryRequest, baseLabel: 'requests' }) : el('span', { class: 'muted', text: '—' })), sort: app => (app.summary?.measured ? app.summary.memory : NaN), tooltip: app => (app.summary ? `requests ${formatBytes(app.summary.memoryRequest)} · limits ${formatBytes(app.summary.memoryLimit)}` : '') },
    { title: 'Status', render: app => badge(...app.status) }, { title: 'Managed by', render: app => app.managedByText },
    { title: 'Version', render: app => app.versionText }, { title: 'Age', render: app => age(app.created) },
  ], showApplication, { id: 'applications', key: app => app.key, stamp: app => `${app.metadata.resourceVersion}|${appCtx.version()}`, pending: true, searchText: app => `${app.name} ${app.namespace} ${app.managedByText} ${app.workloads.map(w => w.item.metadata?.name).join(' ')}`, placeholder: 'Filter applications…', empty: 'No Deployments, StatefulSets or DaemonSets in this scope.' });
  root.append(view);
  const byKind = {}; const loaded = new Set(); let previous = new Map();
  const resync = consumeResync();
  const appCtx = pageContext(usage);
  const update = () => {
    if (loaded.size < APP_WORKLOADS.length) return;
    const apps = groupApplications(byKind);
    for (const app of apps) { const pods = new Map(); for (const w of app.workloads) for (const pod of appCtx.podsFor(w.item)) pods.set(pod.metadata.uid, pod); app.summary = usage.summarize([...pods.values()]); app.pods = [...pods.values()]; }
    const next = new Map(apps.map(app => [app.key, app]));
    const changed = new Set(apps.filter(app => previous.has(app.key) && previous.get(app.key).metadata.resourceVersion !== app.metadata.resourceVersion || !previous.has(app.key) && previous.size).map(app => app.key));
    previous = next;
    view.update(apps, { changed });
    if (state.selected?.application && next.has(state.selected.application) && !$('#drawer').classList.contains('hidden')) showApplication(next.get(state.selected.application));
  };
  for (const [resource] of APP_WORKLOADS) {
    liveList({ resource, signal, resync, onStatus: value => status.track(resource, value),
      onData: items => { byKind[resource] = items; loaded.add(resource); update(); },
      onError: error => { byKind[resource] = []; loaded.add(resource); toast(`${resource}: ${error.message}`, true); update(); } });
  }
  let throttle = null;
  const later = () => { if (!throttle) throttle = setTimeout(() => { throttle = null; if (!signal.aborted) update(); }, 500); };
  liveList({ resource: 'pods', signal, resync, onStatus: value => status.track('pods', value), onData: pods => { appCtx.setPods(pods); later(); }, onError: () => {} });
  queueMicrotask(() => { if (throttle) { clearTimeout(throttle); throttle = null; update(); } });
  usage.onChange(later, signal);
  tickAges([view], signal);
  return root;
}

// ---- Workloads overview ----------------------------------------------------------------------
const WORKLOAD_KINDS = [['pods', 'Pods'], ['deployments', 'Deployments'], ['daemonsets', 'Daemon Sets'], ['statefulsets', 'Stateful Sets'], ['replicasets', 'Replica Sets'], ['jobs', 'Jobs'], ['cronjobs', 'Cron Jobs']];
const HEALTH_LABELS = { pods: ['Running', 'Pending', 'Failed'], jobs: ['Succeeded', 'Running', 'Failed'], cronjobs: ['Scheduled', 'Suspended', 'Failed'] };
function workloadHealth(resource, item) {
  if (resource === 'pods') {
    const waiting = (item.status?.containerStatuses || []).some(c => ['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError'].includes(c.state?.waiting?.reason));
    if (waiting || ['Failed', 'Unknown'].includes(item.status?.phase)) return 'bad';
    return ['Running', 'Succeeded'].includes(item.status?.phase) ? 'good' : 'warn';
  }
  if (resource === 'jobs') {
    const condition = type => (item.status?.conditions || []).some(c => c.type === type && c.status === 'True');
    return condition('Complete') ? 'good' : condition('Failed') ? 'bad' : 'warn';
  }
  if (resource === 'cronjobs') return item.spec?.suspend ? 'warn' : 'good';
  const [ready, desired] = readiness(item, resource === 'daemonsets' ? 'DaemonSet' : '');
  if (!desired || ready >= desired) return 'good';
  return ready ? 'warn' : 'bad';
}
// Every pod rolls up to its top-level controller (Deployment via ReplicaSet, CronJob via Job).
function topOwner(pod, replicaSets, jobs, existing) {
  const ref = controllerOf(pod);
  const ns = pod.metadata.namespace;
  // Owners that are no longer listed (garbage collection pending) roll up to the nearest live object.
  const live = up => !existing || existing.has(up.uid);
  if (!ref) return { kind: 'Pod', name: pod.metadata.name, namespace: ns };
  if (ref.kind === 'ReplicaSet') { const up = controllerOf(replicaSets.get(ref.uid) || {}); return up?.kind === 'Deployment' && live(up) ? { kind: 'Deployment', name: up.name, namespace: ns } : { kind: 'ReplicaSet', name: ref.name, namespace: ns }; }
  if (ref.kind === 'Job') { const up = controllerOf(jobs.get(ref.uid) || {}); return up?.kind === 'CronJob' && live(up) ? { kind: 'CronJob', name: up.name, namespace: ns } : { kind: 'Job', name: ref.name, namespace: ns }; }
  return { kind: ref.kind, name: ref.name, namespace: ns, apiVersion: ref.apiVersion };
}
function workloadRows(pods, replicaSets, jobs, owners) {
  const rsIndex = new Map((replicaSets || []).map(rs => [rs.metadata.uid, rs]));
  const jobIndex = new Map((jobs || []).map(job => [job.metadata.uid, job]));
  const existing = owners ? new Set(owners.map(item => item.metadata.uid)) : null;
  const groups = new Map();
  for (const pod of pods) {
    const owner = topOwner(pod, rsIndex, jobIndex, existing);
    const key = `${owner.namespace}/${owner.kind}/${owner.name}`;
    if (!groups.has(key)) groups.set(key, { ...owner, key, pods: [] });
    groups.get(key).pods.push(pod);
  }
  return [...groups.values()].map(group => ({ ...group, summary: usage.summarize(group.pods), metadata: { uid: group.key, name: group.name, namespace: group.namespace } }));
}
async function workloadsPage() {
  const signal = state.pageAbort.signal;
  const status = liveBadge();
  const root = page('Workloads', `${state.namespace === '*' ? 'All namespaces' : state.namespace} · health and consumption of every workload, updated live.`, actions(status, button('↻ Refresh', refreshView, 'compact')));
  const grid = el('div', { class: 'workload-grid' });
  const cards = {};
  for (const [resource, title] of WORKLOAD_KINDS) {
    const count = el('span', { class: 'card-value', text: '—' });
    const bar = el('span', { class: 'health-bar' });
    const legend = el('span', { class: 'card-detail', text: 'Loading…' });
    const card = button([el('span', { class: 'card-label' }, el('span', { text: title }), el('span', { class: 'card-icon', text: '→' })), count, bar, legend], () => openView('resource', resource, title), 'card workload-card');
    cards[resource] = { count, bar, legend };
    grid.append(card);
  }
  const strip = el('div', { class: 'usage-strip' });
  const consumptionView = table([], aggregateColumns('Workload', row => el('span', {}, el('span', { class: 'kind-tag', text: row.kind }), ' ', row.name), [{ id: 'namespace', title: 'Namespace', render: row => row.namespace, sort: row => row.namespace }, { id: 'kind', title: 'Kind', hidden: true, render: row => row.kind, sort: row => row.kind }]),
    row => showResource({ kind: row.kind, apiVersion: row.apiVersion, metadata: { name: row.name, namespace: row.namespace } }, resourceForKind(row.kind, row.apiVersion || '')),
    { id: 'workloads:consumption', key: row => row.key, stamp: row => `${row.pods.map(p => p.metadata.resourceVersion).join(',')}|${usage.version}`, sortBy: 'cpu', sortDesc: true, pending: true, placeholder: 'Filter workloads…', searchText: row => `${row.kind} ${row.name} ${row.namespace}`, empty: 'No pods in this scope.',
      menu: row => [{ icon: '≋', label: 'Logs (all pods)', action: task(async () => { const resource = resourceForKind(row.kind, row.apiVersion || ''); const item = await get('/api/resource', { context: state.context, namespace: row.namespace, resource, name: row.name }); logsFor({ context: state.context, namespace: row.namespace, resource, name: row.name, item }); }) }] });
  const warnings = eventTable([], { pending: true, empty: 'No warning events in this scope.' });
  root.append(grid,
    el('div', { class: 'section-label' }, el('h2', { text: 'Consumption by workload' }), el('span', { text: 'Pods rolled up to their Deployment, StatefulSet, DaemonSet, CronJob or Job' })), strip, consumptionView,
    el('div', { class: 'section-label' }, el('h2', { text: 'Recent warnings' }), button('All events →', () => openView('events', undefined, 'Events'), 'quiet compact')), warnings);
  const resync = consumeResync();
  const byKind = {};
  let pending = null;
  const runConsumption = () => { pending = null; if (!byKind.pods) return; const rows = workloadRows(byKind.pods, byKind.replicasets, byKind.jobs, byKind.deployments && byKind.cronjobs ? [...byKind.deployments, ...byKind.cronjobs] : null); consumptionView.update(rows); const total = usage.summarize(byKind.pods); strip.replaceChildren(el('span', { class: 'strip-item muted', text: `${rows.length} workloads · ${byKind.pods.length} pods` }), el('span', { class: 'strip-item' }, el('strong', { text: 'CPU' }), total.measured ? ` ${formatCPU(total.cpu)} used` : ' usage not reported', ` · ${formatCPU(total.cpuRequest)} requested · ${formatCPU(total.cpuLimit)} limits`), el('span', { class: 'strip-item' }, el('strong', { text: 'Memory' }), total.measured ? ` ${formatBytes(total.memory)} used` : ' usage not reported', ` · ${formatBytes(total.memoryRequest)} requested · ${formatBytes(total.memoryLimit)} limits`)); };
  const refreshConsumption = () => { if (!pending) pending = setTimeout(runConsumption, 300); };
  signal.addEventListener('abort', () => clearTimeout(pending), { once: true });
  for (const [resource] of WORKLOAD_KINDS) {
    liveList({ resource, signal, resync, onStatus: value => status.track(resource, value),
      onData: items => {
        byKind[resource] = items;
        if (['pods', 'replicasets', 'jobs', 'deployments', 'cronjobs'].includes(resource)) refreshConsumption();
        const totals = { good: 0, warn: 0, bad: 0 };
        for (const item of items) totals[workloadHealth(resource, item)]++;
        const card = cards[resource];
        card.count.textContent = items.length.toLocaleString();
        card.bar.replaceChildren(...['good', 'warn', 'bad'].filter(key => totals[key]).map(key => el('span', { class: `segment ${key}`, style: `flex:${totals[key]}` })));
        const labels = HEALTH_LABELS[resource] || ['Ready', 'Progressing', 'Unavailable'];
        card.legend.textContent = items.length ? ['good', 'warn', 'bad'].map((key, i) => totals[key] || i === 0 ? `${totals[key]} ${labels[i].toLowerCase()}` : '').filter(Boolean).join(' · ') : 'None in this scope';
      },
      onError: error => { cards[resource].legend.textContent = error.message; cards[resource].count.textContent = '—'; if (resource === 'pods') consumptionView.replaceWith(info(error.message, 'error')); } });
  }
  queueMicrotask(() => { if (pending) { clearTimeout(pending); runConsumption(); } });
  usage.onChange(refreshConsumption, signal);
  liveList({ resource: 'events', signal, resync, onStatus: value => status.track('events', value),
    onData: (items, change) => warnings.update(items.filter(item => item.type === 'Warning').sort((a, b) => eventTime(b) - eventTime(a)).slice(0, 25), change),
    onError: error => warnings.replaceWith(info(error.message, 'error')) });
  tickAges([warnings], signal);
  return root;
}
// ---- Helm charts (repository browser) --------------------------------------------------------
async function helmChartsPage() {
  const root = page('Helm charts', 'Charts from your Helm repositories. Open one for its README, versions and default values, then install it into the selected cluster.', actions(button('Add repository', () => helmDialog('repo-add'), 'compact'), button('Update repositories', task(async () => { const result = await post('/api/helm', clusterQuery({ action: 'repo-update' })); toast(result.output || 'Repositories updated.'); render(); }), 'compact')));
  if (state.health && !toolAvailable(state.health.tools?.helm)) { root.append(helmMissing()); return root; }
  const data = await get('/api/helm/charts', {}, { signal: state.pageAbort.signal });
  for (const warning of data.warnings || []) root.append(info(warning));
  const repoOf = chart => chart.name.split('/')[0];
  root.append(table(data.charts || [], [
    { id: 'name', title: 'Chart', class: 'name', locked: true, render: chart => chart.name.split('/').slice(1).join('/'), sort: chart => chart.name.split('/').pop() },
    { id: 'repository', title: 'Repository', render: repoOf, sort: repoOf },
    { id: 'version', title: 'Version', render: chart => chart.version || '—' },
    { id: 'appVersion', title: 'App version', render: chart => chart.app_version || '—' },
    { id: 'description', title: 'Description', class: 'wrap', render: chart => chart.description || '—' },
  ], showChart, { id: 'helm:charts', key: chart => chart.name, stamp: chart => chart.version, menu: chart => [{ icon: '⇩', label: 'Install', action: () => installDialog(chart.name, chart.version) }, { icon: '☰', label: 'Details', action: () => showChart(chart) }], searchText: chart => `${chart.name} ${chart.description || ''}`, placeholder: 'Search charts…', empty: (data.repositories || []).length ? 'No charts found. Update your repositories to refresh their indexes.' : 'No Helm repositories configured yet. Add a repository to browse its charts.' }));
  root.append(el('div', { class: 'section-label' }, el('h2', { text: 'Repositories' })), repositoriesPanel(data.repositories, render));
  return root;
}
async function metricsPage() {
  const root = page('Metrics & monitoring', 'Cluster consumption from metrics.k8s.io and history from the Prometheus running in your cluster.', actions(button('Metrics settings', () => openView('settings'), 'quiet compact')));
  const providerPanel = el('div', {}, loading('Detecting Prometheus…'));
  root.append(panel('Prometheus', providerPanel));
  const detect = async refresh => {
    providerPanel.replaceChildren(loading('Detecting Prometheus…'));
    const result = await get('/api/prometheus/provider', { context: state.context, refresh: refresh ? '1' : undefined }).catch(error => ({ error: error.message }));
    providerPanel.replaceChildren(result.provider ? dl([['Endpoint', `${result.provider.scheme}://${result.provider.service}.${result.provider.namespace}:${result.provider.port}${result.provider.prefix || ''}`], ['Source', result.provider.source === 'settings' ? 'Settings' : 'Auto-detected'], ['Access', 'Through the Kubernetes API server service proxy with your kubeconfig credentials']]) : info(result.error || 'Prometheus was not found.'), el('div', { class: 'form-actions start' }, button('Detect again', () => detect(true), 'compact')));
  };
  detect(false);
  root.append(el('div', { class: 'section-label' }, el('h2', { text: 'Cluster usage over time' })), panel('', metricsView({ context: state.context }, {
    queries: () => clusterQueries(null),
    charts: [
      { title: 'CPU', format: 'cpu', series: [{ key: 'cpu', name: 'Usage' }, { key: 'cpuRequests', name: 'Requests', dashed: true }, { key: 'cpuAllocatable', name: 'Allocatable', dashed: true }] },
      { title: 'Memory', format: 'bytes', series: [{ key: 'memory', name: 'Usage' }, { key: 'memoryRequests', name: 'Requests', dashed: true }, { key: 'memoryAllocatable', name: 'Allocatable', dashed: true }] },
      { title: 'Pods', format: 'count', series: [{ key: 'pods', name: 'Pods' }, { key: 'podsAllocatable', name: 'Allocatable', dashed: true }] },
    ],
    session: () => { const h = usage.clusterHistory(); return [{ title: 'CPU', format: 'cpu', series: [{ name: 'Usage', values: h.cpu }] }, { title: 'Memory', format: 'bytes', series: [{ name: 'Usage', values: h.memory }] }]; },
  })));
  // PromQL explorer through the in-cluster Prometheus.
  const query = el('input', { class: 'promql-input', value: readStore('rubban.promql', 'sum by (namespace) (rate(container_cpu_usage_seconds_total{container!=""}[5m]))'), spellcheck: 'false', 'aria-label': 'PromQL query' });
  const range = el('select', { class: 'compact-select', 'aria-label': 'Range' }, [['3600', '1 hour'], ['21600', '6 hours'], ['86400', '24 hours'], ['604800', '7 days']].map(([value, label]) => el('option', { value, text: label })));
  const unit = el('select', { class: 'compact-select', 'aria-label': 'Unit' }, [['', 'Number'], ['cpu', 'CPU cores'], ['bytes', 'Bytes'], ['rate', 'Bytes/second']].map(([value, label]) => el('option', { value, text: label })));
  const resultHost = el('div');
  const run = task(async () => {
    writeStore('rubban.promql', query.value);
    resultHost.replaceChildren(loading('Running query…'));
    const seconds = Number(range.value); const end = Math.floor(Date.now() / 1000);
    const response = await post('/api/prometheus/range', { context: state.context, queries: { q: query.value }, start: end - seconds, end, step: Math.max(15, Math.round(seconds / 240)) });
    if (response.errors?.q) { resultHost.replaceChildren(info(response.errors.q, 'error')); return; }
    const series = (response.series.q || []).map(s => ({ name: Object.entries(s.metric).filter(([k]) => k !== '__name__').map(([k, v]) => `${k}=${v}`).join(', ') || s.metric.__name__ || 'value', values: s.values }));
    const fmt = { cpu: formatCPU, bytes: formatBytes, rate: v => `${formatBytes(v)}/s` }[unit.value] || (v => (Math.abs(v) >= 1000 ? v.toFixed(0) : Number(v.toPrecision(4)).toString()));
    resultHost.replaceChildren(lineChart(series.slice(0, 12), { format: fmt, height: 220, title: `${series.length} series${series.length > 12 ? ' (first 12 charted)' : ''}` }), table(series.map((s, i) => ({ ...s, id: i, last: s.values.at(-1)?.[1] })), [{ id: 'series', title: 'Series', class: 'wrap mono-cell', render: s => s.name, sort: s => s.name }, { id: 'last', title: 'Latest', class: 'num', render: s => (Number.isFinite(s.last) ? fmt(s.last) : '—'), sort: s => s.last, sortDesc: true }], null, { key: s => String(s.id), stamp: () => '', sortBy: 'last', sortDesc: true }));
  });
  query.addEventListener('keydown', event => { if (event.key === 'Enter') run(); });
  root.append(el('div', { class: 'section-label' }, el('h2', { text: 'PromQL explorer' }), el('span', { text: 'Runs against the Prometheus shown above' })), panel('', [el('div', { class: 'form-actions start promql-bar' }, query, range, unit, button('Run', run, 'primary compact')), resultHost]));
  // Live samples from metrics.k8s.io, in human-readable units.
  const ctx = pageContext(usage);
  const nodeRows = el('div');
  root.append(el('div', { class: 'section-label' }, el('h2', { text: 'Live samples (metrics.k8s.io)' }), el('span', { text: 'Refreshed every 15 seconds' })), nodeRows);
  const renderSamples = () => {
    const rows = [...usage.nodes].map(([name, sample]) => ({ name, scope: 'Node', namespace: '', ...sample, metadata: { uid: `node:${name}`, name } }))
      .concat([...usage.pods].map(([key, sample]) => { const [namespace, name] = key.split('/'); return { name, namespace, scope: 'Pod', ...sample, metadata: { uid: `pod:${key}`, name, namespace } }; }));
    nodeRows.replaceChildren(usage.available === false ? info(usage.message || 'metrics.k8s.io is unavailable. Install metrics-server to see live usage.') : table(rows, [
      { id: 'name', title: 'Name', class: 'name', locked: true, render: r => r.name, sort: r => r.name }, { id: 'scope', title: 'Type', render: r => r.scope, sort: r => r.scope },
      { id: 'namespace', title: 'Namespace', render: r => r.namespace || '—', sort: r => r.namespace },
      { id: 'cpu', title: 'CPU', class: 'num', render: r => formatCPU(r.cpu), sort: r => r.cpu, sortDesc: true }, { id: 'memory', title: 'Memory', class: 'num', render: r => formatBytes(r.memory), sort: r => r.memory, sortDesc: true },
      { id: 'containers', title: 'Containers', class: 'wrap', render: r => (r.containers ? [...r.containers].map(([n, c]) => `${n}: ${formatCPU(c.cpu)} · ${formatBytes(c.memory)}`).join('  |  ') : '—') },
      { id: 'sampled', title: 'Sampled', render: r => age(r.timestamp) },
    ], r => (r.scope === 'Node' ? showResource({ kind: 'Node', metadata: { name: r.name } }, 'nodes') : showResource({ kind: 'Pod', metadata: { name: r.name, namespace: r.namespace } }, 'pods')), { id: 'metrics:samples', key: r => r.metadata.uid, stamp: () => String(usage.version), sortBy: 'cpu', sortDesc: true, placeholder: 'Filter samples…', searchText: r => `${r.name} ${r.namespace}` }));
  };
  renderSamples();
  usage.onChange(renderSamples, state.pageAbort.signal);
  if (state.preferences.prometheusUrl) {
    root.append(el('div', { class: 'section-label' }, el('h2', { text: 'External Prometheus' })));
    const form = makeForm([{ name: 'query', label: 'PromQL query', value: 'sum(rate(container_cpu_usage_seconds_total[5m]))', required: true, full: true }], 'Run query', values => post('/api/prometheus', { ...values, context: state.context, url: state.preferences.prometheusUrl }));
    root.append(panel(`Endpoint ${state.preferences.prometheusUrl}`, form));
  }
  void ctx;
  return root;
}
function createManifest(kind) {
  if (!state.context) { toast('Choose a cluster context before creating resources.', true); return; }
  const target = { context: state.context, namespace: state.namespace === '*' ? '' : state.namespace };
  const ns = target.namespace || 'default';
  const editor = el('textarea', { class: 'editor tall', 'aria-label': 'Resource YAML', spellcheck: 'false', placeholder: 'Paste Kubernetes YAML here, or pick a template…' });
  const picker = el('select', { class: 'compact-select', 'aria-label': 'Template' }, el('option', { value: '', text: 'Start from a template…' }), [...new Set(TEMPLATES.map(t => t.group))].map(group => el('optgroup', { label: group }, TEMPLATES.filter(t => t.group === group).map(t => el('option', { value: t.kind, text: t.kind })))));
  const useTemplate = name => { const chosen = TEMPLATES.find(t => t.kind === name); if (!chosen) return; editor.value = chosen.build(ns); editor.dataset.template = editor.value; };
  picker.addEventListener('change', () => useTemplate(picker.value));
  const review = reviewBar({ editor, target, confirmText: 'Apply this manifest to the selected cluster. Review the diff before continuing.', confirmName: target.context, onApplied: afterMutation });
  modal('Create resource', `Context: ${target.context} · Namespace: ${target.namespace || 'from manifest, or default'}`, el('div', {}, el('div', { class: 'form-actions start' }, picker, el('span', { class: 'muted', text: 'Templates are starting points. Review shows exactly what would change before anything is applied.' })), editor, review));
  if (kind) { picker.value = kind; useTemplate(kind); }
}
const EDITABLE_DETAILS = new Set(['configmaps', 'secrets', 'rolebindings', 'clusterrolebindings']);
async function showResource(item, resource, options = {}) {
  if (state.selected?.item?.metadata && state.selected.resource && !$('#drawer').classList.contains('hidden') && !(state.selected.name === item.metadata?.name && state.selected.resource === resource && state.selected.namespace === (item.metadata?.namespace || ''))) {
    state.drawerHistory = [...(state.drawerHistory || []), { item: state.selected.item, resource: state.selected.resource }].slice(-20);
  } else if (!options.keepHistory && $('#drawer').classList.contains('hidden')) state.drawerHistory = [];
  const selected = { context: state.context, namespace: item.metadata?.namespace || '', resource, name: item.metadata?.name, item, initialTab: options.tab };
  state.selected = selected; $('#drawer').classList.remove('hidden');
  $('#drawer-kind').textContent = `${item.kind || resource} · ${item.metadata?.namespace || 'cluster scoped'}`; $('#drawer-name').textContent = selected.name;
  $('#drawer-back').classList.toggle('hidden', !(state.drawerHistory || []).length);
  $('#drawer-content').replaceChildren(loading());
  try {
    const isSecret = resource === 'secrets' || item.kind === 'Secret';
    const data = isSecret && item.metadata?.uid ? item : await get('/api/resource', targetOf(selected));
    if (state.selected !== selected) return;
    selected.item = data;
    $('#drawer-kind').textContent = `${data.kind || resource} · ${data.metadata?.namespace || 'cluster scoped'}`;
    resourceDetails(selected);
  } catch (error) { if (state.selected === selected) $('#drawer-content').replaceChildren(displayError(error, 'Unable to load this resource')); }
}
function closeDrawer() {
  state.selected = null; state.drawerHistory = [];
  $('#drawer').classList.add('hidden'); $('#drawer-back').classList.add('hidden');
}
function drawerBack() {
  const previous = (state.drawerHistory || []).pop();
  if (!previous) return;
  state.selected = null;
  showResource(previous.item, previous.resource, { keepHistory: true });
  $('#drawer-back').classList.toggle('hidden', !(state.drawerHistory || []).length);
}
function overviewContent(selected) {
  const item = selected.item;
  const [statusText, statusLevel] = statusOf(item);
  return el('div', {}, el('div', { class: 'drawer-status' }, statusText !== '—' ? badge(statusText, statusLevel) : null, item.metadata?.creationTimestamp ? el('span', { class: 'muted', text: `created ${age(item.metadata.creationTimestamp)} ago` }) : ''), isArgoApplication(item) ? argoDetails(selected) : null, kindOverview(selected));
}
function resourceDetails(selected) {
  const root = $('#drawer-content'); const body = el('div', { class: 'drawer-body', id: 'resource-detail-panel', role: 'tabpanel', tabindex: '0' });
  const metrics = kindMetrics(selected);
  const tabDefs = [['overview', 'Overview'], ...(metrics ? [['metrics', 'Metrics']] : []), ['yaml', 'YAML'], ['events', 'Events']];
  const tabs = el('div', { class: 'detail-tabs', role: 'tablist' });
  const notice = el('div', { class: 'live-notice-slot' });
  let generation = 0;
  async function show(id) {
    const current = ++generation;
    selected.detailTab = id;
    selected.yamlRevealed = false;
    if (!selected.deleted) notice.replaceChildren();
    for (const child of tabs.children) {
      const active = child.dataset.tab === id;
      child.classList.toggle('active', active); child.setAttribute('aria-selected', String(active)); child.tabIndex = active ? 0 : -1;
    }
    body.setAttribute('aria-labelledby', `resource-tab-${id}`);
    body.replaceChildren(loading());
    const live = () => current === generation && state.selected === selected;
    try {
      if (id === 'overview') body.replaceChildren(overviewContent(selected));
      if (id === 'metrics') body.replaceChildren(metricsView(selected, metrics));
      if (id === 'yaml') await yamlDetail(selected, body, false, live);
      if (id === 'events') {
        const uid = selected.item.metadata?.uid;
        const response = await get('/api/events', { context: selected.context, namespace: selected.namespace || '*', ...(uid ? { fieldSelector: `involvedObject.uid=${uid}` } : {}) });
        const events = (response.items || []).filter(event => { const target = involved(event); return uid && target.uid ? target.uid === uid : target.name === selected.name; }).sort((a, b) => eventTime(b) - eventTime(a));
        if (live()) body.replaceChildren(events.length ? eventTable(events, { empty: 'No events.' }) : empty('No events', 'Kubernetes keeps events for about an hour by default; nothing has been recorded for this object recently.', null, '⚑'));
      }
    } catch (error) { if (live()) body.replaceChildren(info(error.message, 'error')); }
  }
  for (const [id, title] of tabDefs) { const tab = button(title, () => show(id), 'quiet compact'); tab.dataset.tab = id; tab.id = `resource-tab-${id}`; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', body.id); tabs.append(tab); }
  tabs.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...tabs.children]; const current = buttons.indexOf(event.target); if (current < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus(); show(buttons[next].dataset.tab);
  });
  const actionBar = () => (isArgoApplication(selected.item) ? el('div') : detailActions(selected));
  root.replaceChildren(actionBar(), tabs, notice, body);
  show(selected.initialTab && tabDefs.some(([id]) => id === selected.initialTab) ? selected.initialTab : 'overview');
  // Called by live list views when this object changes or disappears in the cluster.
  let rerender = null;
  selected.liveUpdate = (item, deleted) => {
    if (state.selected !== selected) return;
    if (deleted) { selected.deleted = true; notice.replaceChildren(el('div', { class: 'callout warn live-notice', text: 'This resource was deleted from the cluster.' })); return; }
    if (!item || liveStamp(item) === liveStamp(selected.item)) return;
    const merged = { ...selected.item, ...item };
    if (selected.detailTab === 'overview' && !EDITABLE_DETAILS.has(selected.resource)) {
      selected.item = merged;
      clearTimeout(rerender);
      rerender = setTimeout(() => { if (state.selected !== selected || selected.detailTab !== 'overview') return; const scroll = $('#drawer').scrollTop; const open = [...body.querySelectorAll('details.detail-section')].map(node => node.open); body.replaceChildren(overviewContent(selected)); [...body.querySelectorAll('details.detail-section')].forEach((node, i) => { if (open[i] !== undefined) node.open = open[i]; }); $('#drawer').scrollTop = scroll; root.firstChild.replaceWith(actionBar()); }, 800);
    } else if (selected.detailTab === 'yaml' || (selected.detailTab === 'overview' && EDITABLE_DETAILS.has(selected.resource))) {
      notice.replaceChildren(el('div', { class: 'callout info live-notice' }, el('span', { text: `Changed in the cluster since this view was loaded (resourceVersion ${liveStamp(item)}).` }), button('Reload', task(async () => { notice.replaceChildren(); selected.item = merged; if (selected.detailTab === 'yaml') await yamlDetail(selected, body, Boolean(selected.yamlRevealed), () => state.selected === selected && selected.detailTab === 'yaml'); else body.replaceChildren(overviewContent(selected)); }), 'compact')));
    } else selected.item = merged;
  };
}
async function yamlDetail(selected, body, revealed = false, current = () => state.selected === selected) {
  if ((selected.item.kind === 'Secret' || selected.resource === 'secrets') && !revealed) { selected.yamlRevealed = false; if (current()) body.replaceChildren(empty('Secret values are hidden', 'Kubernetes secrets contain sensitive information. Revealing the YAML fetches the full secret into this editor.', button('Reveal secret YAML', task(() => yamlDetail(selected, body, true, current)), 'compact'), '◇')); return; }
  const result = await get('/api/yaml', targetOf(selected));
  if (!current()) return;
  selected.yamlRevealed = revealed;
  const editor = el('textarea', { class: 'editor', value: result.yaml, spellcheck: 'false', 'aria-label': 'Resource YAML' });
  body.replaceChildren(editor, reviewBar({ editor, target: { context: selected.context, namespace: selected.namespace }, confirmText: 'Apply the edited YAML to this resource. Review your diff before continuing.', confirmName: selected.name, onApplied: afterMutation, applyClass: 'primary compact' }));
}

async function forwardsPage() {
  const signal = state.pageAbort.signal;
  const root = page('Port forwarding', 'Local connections to pods and services in your clusters. Forwarded ports listen on 127.0.0.1 only.', actions(button('↻ Refresh', render, 'compact')));
  const stop = forward => task(async () => { await api(`/api/forwards/${encodeURIComponent(forward.id)}`, { method: 'DELETE' }); toast('Port forward stopped.'); load(); });
  const restart = forward => task(async () => { await post(`/api/forwards/${encodeURIComponent(forward.id)}/restart`, {}); toast('Port forward restarted.'); load(); });
  const openForward = (forward, scheme = 'http') => openExternalLink(`${scheme}://localhost:${forward.localPort}`);
  const clusterCell = context => { const meta = infoFor(context); const mark = el('span', { class: 'tab-cluster', style: `color:${meta.color}` }, clusterIcon(meta.icon)); return el('span', { class: 'cluster-cell', title: context }, mark, meta.label); };
  const statusCell = r => el('span', { class: 'forward-status' }, badge(statusText(r), statusLevel(r)), r.status === 'error' ? button('Restart', restart(r), 'compact quiet') : null);
  const view = table([], [
    { id: 'status', title: 'Status', locked: true, render: statusCell, sort: r => r.status },
    { id: 'name', title: 'Name', class: 'name', locked: true, render: r => r.name, sort: r => r.name },
    { id: 'kind', title: 'Kind', render: r => (r.resource === 'services' ? 'Service' : r.resource === 'pods' ? 'Pod' : r.resource), sort: r => r.resource },
    { id: 'namespace', title: 'Namespace', render: r => r.namespace, sort: r => r.namespace },
    { id: 'context', title: 'Cluster', render: r => clusterCell(r.context), sort: r => labelFor(r.context) },
    { id: 'ports', title: 'Local → Remote', class: 'num', render: r => `${r.localPort ? r.localPort : 'choosing…'} → ${r.remotePort}`, sort: r => r.localPort },
    { id: 'link', title: 'Open', render: r => (r.status === 'ready' && r.localPort ? link(`http://localhost:${r.localPort}`, () => openForward(r)) : '—') },
    { id: 'age', title: 'Started', render: r => (r.createdAt ? `${age(r.createdAt)} ago` : '—'), sort: r => -(new Date(r.createdAt).getTime() || 0) },
    { id: 'error', title: 'Details', class: 'wrap', hidden: true, render: r => r.error || '—' },
  ], null, { id: 'forwards', key: r => r.id, stamp: r => `${r.status}|${r.localPort}|${r.restarts}|${r.lastError || ''}|${r.error || ''}`, searchText: r => `${r.name} ${r.context} ${labelFor(r.context)} ${r.namespace} ${r.localPort} ${r.error || ''}`, empty: 'No port forwards. Open a pod or service and choose Port forward.',
    menu: r => [{ icon: '↗', label: 'Open in browser', action: () => openForward(r), disabled: r.status !== 'ready' }, { icon: '↗', label: 'Open with HTTPS', action: () => openForward(r, 'https'), disabled: r.status !== 'ready' }, { icon: '⧉', label: 'Copy address', action: task(async () => { await navigator.clipboard.writeText(`http://localhost:${r.localPort}`); toast('Copied.'); }) }, { icon: '↻', label: 'Restart', action: restart(r) }, '-', { icon: '■', label: 'Stop', danger: true, action: stop(r) }],
    bulk: (items, clear) => button(`Stop ${items.length}`, task(async () => { for (const item of items) await api(`/api/forwards/${encodeURIComponent(item.id)}`, { method: 'DELETE' }).catch(() => {}); clear(); load(); }), 'danger compact') });
  root.append(view, el('p', { class: 'list-note', text: 'Forwards are restored when Rubban starts, and restarted on the same local port if kubectl loses the connection.' }));
  async function load() { try { const response = await get('/api/forwards', {}, { signal }); view.update(response.items || []); forwardsPoller.observe(response.items || []); } catch (error) { if (!signal.aborted) toast(error.message, true); } }
  await load();
  if (signal.aborted) return root;
  const timer = setInterval(load, 3000); signal.addEventListener('abort', () => clearInterval(timer), { once: true });
  return root;
}
const helmMissing = () => empty('Helm CLI not found', 'Rubban manages charts and releases with the Helm command-line tool. The Windows build includes it; for a source build, install Helm and make sure helm is on PATH, then restart Rubban.', button('Settings', () => openView('settings'), 'compact'), '⎈');
async function helmPage() {
  let response;
  try { response = await get('/api/helm', clusterQuery()); }
  catch (error) { if (error.status === 503 && /helm/i.test(error.message)) return helmMissing(); throw error; }
  const root = page('Helm releases', `${state.namespace === '*' ? 'All namespaces' : state.namespace} · releases installed in this cluster.`, actions(button('Browse charts', () => openView('helm-charts', undefined, 'Helm Charts'), 'compact'), button('Install chart', () => helmDialog('install'), 'primary compact'), button('↻ Refresh', render, 'compact')));
  const updated = r => { const date = new Date(String(r.updated || '').replace(/ \+0000 UTC$/, 'Z').replace(' ', 'T')); return Number.isFinite(date.getTime()) ? date : null; };
  root.append(table(response.releases || [], [
    { id: 'name', title: 'Release', class: 'name', locked: true, render: r => r.name, sort: r => r.name },
    { id: 'namespace', title: 'Namespace', render: r => r.namespace, sort: r => r.namespace },
    { id: 'chart', title: 'Chart', render: r => r.chart, sort: r => r.chart },
    { id: 'revision', title: 'Revision', class: 'num', render: r => String(r.revision), sort: r => Number(r.revision) },
    { id: 'appVersion', title: 'App version', render: r => r.app_version || r.appVersion || '—' },
    { id: 'status', title: 'Status', render: r => badge(r.status, r.status === 'deployed' ? 'good' : /failed/.test(r.status) ? 'bad' : 'warn'), sort: r => r.status },
    { id: 'updated', title: 'Updated', render: r => (updated(r) ? `${age(updated(r).toISOString())} ago` : r.updated || '—'), sort: r => -(updated(r)?.getTime() || 0) },
  ], showRelease, { id: 'helm:releases', key: r => `${r.namespace}/${r.name}`, stamp: r => `${r.revision}|${r.status}`, menu: releaseMenu, searchText: r => `${r.name} ${r.namespace} ${r.chart} ${r.status}`, empty: 'No Helm releases in this scope.' }));
  return root;
}
function helmDialog(action, release = {}) {
  let specs;
  if (action === 'repo-add') specs = [{ name: 'repo', label: 'Repository name', required: true }, { name: 'url', label: 'Repository URL', type: 'url', required: true }];
  else if (action === 'rollback') specs = [{ name: 'name', label: 'Release name', value: release.name, required: true }, { name: 'revision', label: 'Revision to restore', type: 'number', min: 1, required: true }, { name: 'namespace', label: 'Namespace', value: release.namespace || (state.namespace === '*' ? 'default' : state.namespace), required: true }];
  else specs = [{ name: 'name', label: 'Release name', value: release.name || '', required: true }, { name: 'namespace', label: 'Namespace', value: release.namespace || (state.namespace === '*' ? 'default' : state.namespace), required: true }, { name: 'chart', label: 'Chart reference', value: release.chartRef || '', placeholder: 'repository/chart or oci://…', required: true }, { name: 'version', label: 'Chart version', value: release.chartRef ? release.version || '' : '', placeholder: 'Optional; defaults to latest available chart' }, { name: 'values', label: 'Values YAML', type: 'textarea', full: true, placeholder: '# Optional chart values' }];
  const label = ({ 'repo-add': 'Add repository', install: 'Install chart', upgrade: 'Upgrade release', rollback: 'Roll back release' })[action];
  modal(label, `Context: ${state.context}`, makeForm(specs, label, async values => { const result = await post('/api/helm', clusterQuery({ ...values, action })); toast(`${label} completed.`); render(); return result; }, action === 'repo-add' ? {} : { confirm: `${label} changes cluster resources. Review the chart reference, namespace, and values before continuing.` }));
}

function discoveryPage() {
  const root = page('API & custom resources', 'Browse resource types discovered directly from your cluster API. Open any type as a first class resource view.');
  const available = state.discovery.filter(resource => (resource.verbs || []).includes('list'));
  root.append(table(available, [{ title: 'Resource', class: 'name', render: item => item.name }, { title: 'Kind', render: item => item.kind }, { title: 'API group', render: item => item.group || 'core' }, { title: 'Scope', render: item => badge(item.namespaced ? 'Namespaced' : 'Cluster') }, { title: 'Supported actions', render: item => (item.verbs || []).join(', ') }], item => openView('resource', item.group ? `${item.name}.${item.group}` : item.name, item.kind || item.name), { searchText: item => `${item.name} ${item.kind} ${item.group}`, placeholder: 'Find an API resource type…', empty: 'No discovery data is available yet. Refresh or reconnect the cluster.' })); return root;
}

async function settingsPage() {
  state.preferences = await get('/api/preferences');
  renderFavorites();
  const root = page('Settings', 'Preferences are stored locally on this computer. Service endpoints are used only when you request data.');
  const save = async patch => { state.preferences = await api('/api/preferences', { method: 'PUT', body: { ...state.preferences, ...patch } }); renderFavorites(); toast('Preferences saved.'); return 'Preferences saved locally.'; };
  root.append(panel('Help', [el('p', { class: 'muted', text: 'A short walk through the main parts of Rubban.' }), el('div', { class: 'actions' }, button('Show the tour', () => takeTour(), 'compact'))]));
  root.append(updatesPanel());
  const themeLabels = { system: 'System', light: 'Light', dark: 'Dark' };
  root.append(panel('Appearance', makeForm([{ name: 'theme', label: 'Theme', options: THEMES.map(value => ({ value, label: themeLabels[value] })), value: state.preferences.theme || 'system', help: 'System follows your Windows or macOS appearance setting.' }], 'Save appearance', values => { applyTheme(values.theme); return save({ theme: values.theme }); })));
  if (state.context) root.append(accessPanel());
  if (state.context) {
    const current = state.preferences.prometheusByContext?.[state.context] || { mode: 'auto' };
    const form = makeForm([
      { name: 'mode', label: 'Prometheus for this cluster', options: [{ value: 'auto', label: 'Auto-detect (Prometheus, Thanos, VictoriaMetrics)' }, { value: 'service', label: 'A specific in-cluster service' }, { value: 'off', label: 'Off' }], value: current.mode || 'auto' },
      { name: 'namespace', label: 'Service namespace', value: current.namespace || 'monitoring', placeholder: 'monitoring' },
      { name: 'service', label: 'Service name', value: current.service || '', placeholder: 'prometheus-operated' },
      { name: 'port', label: 'Service port', type: 'number', value: current.port || 9090, min: 1, max: 65535 },
      { name: 'prefix', label: 'Path prefix', value: current.prefix || '', placeholder: '/ or /prometheus' },
      { name: 'scheme', label: 'Scheme', options: ['http', 'https'], value: current.scheme || 'http' },
    ], 'Save metrics settings', async values => {
      const byContext = { ...(state.preferences.prometheusByContext || {}) };
      if (values.mode === 'auto') delete byContext[state.context];
      else byContext[state.context] = values.mode === 'off' ? { mode: 'off' } : { mode: 'service', namespace: values.namespace, service: values.service, port: Number(values.port), prefix: values.prefix.replace(/\/+$/, ''), scheme: values.scheme };
      resetPrometheusProvider(state.context);
      return save({ prometheusByContext: byContext });
    });
    root.append(panel(`Metrics · ${state.context}`, [info('Rubban reaches Prometheus through the Kubernetes API server’s service proxy using your kubeconfig credentials; nothing is exposed locally. Auto-detect checks well-known service names and verifies them with a test query.'), form]));
  }
  root.append(panel('Terminal', makeForm([{ name: 'nodeShellImage', label: 'Node shell image', value: state.preferences.nodeShellImage || '', placeholder: 'busybox:1.36', help: 'Image for the privileged debug pod that node shells run in (kubectl debug node). It needs a shell; the host filesystem is mounted at /host.' }], 'Save terminal settings', values => save({ nodeShellImage: values.nodeShellImage.trim() }))));
  root.append(panel('Connected services', makeForm([{ name: 'prometheusUrl', label: 'External Prometheus URL', type: 'url', value: state.preferences.prometheusUrl || '', placeholder: 'http://127.0.0.1:9090', help: 'Optional. Used only by the External Prometheus query on the Metrics page.' }, { name: 'aiCommand', label: 'AI CLI', options: [{ value: '', label: 'Not configured' }, { value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude' }, { value: 'gemini', label: 'Gemini' }, { value: 'opencode', label: 'OpenCode' }], value: state.preferences.aiCommand || '', help: 'Use an installed, authenticated CLI under your own account.' }], 'Save preferences', values => save(values))));
  root.append(el('div', { class: 'section-label' }, el('h2', { text: 'Local environment' })));
  const environment = el('div'); for (const [name, value] of Object.entries(state.health?.tools || {})) environment.append(el('div', { class: 'key-value' }, el('span', { text: name }), el('span', {}, badge(toolAvailable(value) ? 'Available' : 'Not found', toolAvailable(value) ? 'good' : 'warn'), el('span', { class: 'mono', style: 'margin-left:10px', text: typeof value === 'object' ? value?.path || value?.version || '' : typeof value === 'string' ? value : '' }))));
  environment.append(el('div', { class: 'key-value' }, el('span', { text: 'Platform' }), el('span', { text: state.health?.platform || 'Unknown' })), el('div', { class: 'key-value' }, el('span', { text: 'App version' }), el('span', { text: state.health?.version || 'Development build' })));
  if (state.contexts.length) {
    const sign = el('div');
    for (const context of state.contexts) {
      const entry = credentials.authOf(context.name); const expired = entry.status === 'expired';
      sign.append(el('div', { class: 'key-value' }, el('span', { text: labelFor(context.name), title: context.name }), el('span', {}, badge(expired ? 'Credentials expired' : entry.status === 'ok' ? 'Signed in' : 'Not checked yet', expired ? 'warn' : entry.status === 'ok' ? 'good' : ''), el('span', { class: 'muted', style: 'margin-left:10px', text: expired ? entry.remedy?.label || '' : '' }))));
    }
    environment.append(el('div', { class: 'section-label' }, el('h3', { text: 'Cluster sign-in' })), sign);
  }
  root.append(panel('Prerequisites', environment), info('Rubban uses local kubeconfig contexts and installed command line tools. Cluster connection, metrics, Argo CD and cost availability depend on your infrastructure.'));
  root.append(panel('Keyboard shortcuts', dl([[`${MOD}+K`, 'Command palette'], [`${MOD}+Shift+K`, 'Switch cluster'], [`${MOD}+1`, 'Cluster overview'], [`${MOD}+\``, 'Show or hide the terminal dock'], ['/', 'Filter the sidebar'], ['Esc', 'Close the details panel'], ['Right-click a row', 'Row actions']])));
  return root;
}
function aiPage() {
  const root = page('AI assistant', 'Ask an installed AI CLI for help. Only the prompt you submit and the selected context name are sent; cluster secrets are never added automatically.');
  root.append(info(state.preferences.aiCommand ? `Configured CLI: ${state.preferences.aiCommand}. Your CLI’s account and service terms apply.` : 'Choose and configure an authenticated AI CLI in Settings before submitting a prompt.'));
  root.append(panel('Infrastructure assistant', makeForm([{ name: 'command', label: 'AI CLI', options: ['codex', 'claude', 'gemini', 'opencode'], value: state.preferences.aiCommand || 'codex' }, { name: 'prompt', label: 'Your prompt', type: 'textarea', full: true, required: true, rows: 9, placeholder: 'Describe what you want to understand or troubleshoot…', help: 'Review prompts before sending. Include only information you intend to share with your selected CLI.' }], 'Send prompt', values => post('/api/ai', { ...values, context: state.context }))));
  return root;
}
function commandPalette() { $('#command-dialog').showModal(); $('#command-search').value = ''; commandResults(''); $('#command-search').focus(); }
function renderFavorites() { renderCluster(); }
async function toggleFavorite() {
  if (!state.context) return;
  const favorites = Array.isArray(state.preferences.favoriteContexts) ? state.preferences.favoriteContexts.filter(name => typeof name === 'string') : [];
  const pinned = favorites.includes(state.context);
  state.preferences = await api('/api/preferences', { method: 'PUT', body: { ...state.preferences, favoriteContexts: pinned ? favorites.filter(name => name !== state.context) : [...favorites, state.context] } });
  renderFavorites(); toast(pinned ? 'Context removed from hotbar.' : 'Context pinned to hotbar.');
}
// Resources by name in every cluster that has a tab open. The server ranks; this groups the answers by
// cluster and kind, one request per cluster, started 250 ms after the last keystroke.
const searchHolder = el('div', { class: 'command-resources' });
let searchTimer = null; let searchAbort = null;
async function openSearchResult(context, hit, newTab) {
  $('#command-dialog').close();
  if (newTab) await newClusterTab(context);
  else if (context !== state.context) await selectContext(context, { namespace: '*' });
  showResource({ kind: hit.kind, metadata: { name: hit.name, namespace: hit.namespace || '' } }, hit.resource);
}
function scheduleResourceSearch(query) {
  clearTimeout(searchTimer); searchAbort?.abort(); searchAbort = null;
  if (!searchable(query)) { searchHolder.replaceChildren(); return; }
  searchTimer = setTimeout(() => runResourceSearch(query.trim()), 250);
}
function runResourceSearch(query) {
  const abort = new AbortController(); searchAbort = abort;
  const sections = searchContexts(state.tabs).map(context => {
    const meta = infoFor(context);
    const mark = el('span', { class: 'tab-cluster', style: `color:${meta.color}` }, clusterIcon(meta.icon));
    const body = el('div', {}, el('div', { class: 'command-note', text: 'Searching…' }));
    return { context, body, node: el('div', { class: 'command-cluster' }, el('div', { class: 'command-group' }, mark, el('span', { text: meta.label })), body) };
  });
  searchHolder.replaceChildren(...sections.map(section => section.node));
  for (const section of sections) {
    get('/api/search', { context: section.context, q: query, limit: 20 }, { signal: abort.signal }).then(answer => {
      if (abort.signal.aborted) return;
      const rows = [];
      for (const group of groupByKind(answer.results)) {
        rows.push(el('div', { class: 'command-kind', text: group.kind }));
        for (const hit of group.items) rows.push(button([el('span', { text: hit.name }), el('small', { text: resultDetail(hit) })], event => openSearchResult(section.context, hit, event.ctrlKey || event.metaKey), 'command-option'));
      }
      if (!rows.length) rows.push(el('div', { class: 'command-note', text: 'No matches' }));
      if (answer.truncated) rows.push(el('div', { class: 'command-note', text: 'More matches than shown; type more to narrow them down.' }));
      section.body.replaceChildren(...rows);
    }).catch(error => {
      if (abort.signal.aborted || error.name === 'AbortError') return;
      section.body.replaceChildren(el('div', { class: 'command-note', text: error.code === 'credentials' ? 'Credentials expired.' : `Could not search: ${error.message}` }), error.code === 'credentials' ? button('Sign in again', () => { $('#command-dialog').close(); signIn(section.context).catch(err => toast(err.message, true)); }, 'compact') : null);
    });
  }
}
function commandResults(query) {
  const needle = query.toLowerCase();
  const choices = allNav().filter(item => `${item.title} ${item.tabTitle || ''} ${item.resource || ''} ${item.trail.map(node => node.title).join(' ')}`.toLowerCase().includes(needle));
  $('#command-results').replaceChildren(...choices.slice(0, 80).map(item => button([icon(item.icon || item.trail[0]?.icon || 'overview', 'command-svg'), el('span', { text: item.title }), el('small', { text: item.trail.map(node => node.title).join(' › ') || 'Workspace' })], () => { $('#command-dialog').close(); openView(item.section, item.resource, item.tabTitle || item.title); }, 'command-option')));
  if ('take the tour onboarding help'.includes(needle) && needle) $('#command-results').prepend(button([icon('overview', 'command-svg'), el('span', { text: 'Take the tour' }), el('small', { text: 'Help' })], () => { $('#command-dialog').close(); takeTour(); }, 'command-option'));
  if (!choices.length && !$('#command-results').children.length && !searchable(query)) $('#command-results').append(el('p', { class: 'list-note', style: 'padding:12px', text: 'No matching views.' }));
  $('#command-results').append(searchHolder);
  scheduleResourceSearch(query);
}
async function reloadContexts() {
  let response;
  try { response = await get('/api/contexts'); state.contextsError = ''; } catch (error) { state.contextsError = error.message; if (!state.context) render(); throw error; }
  state.contexts = response.contexts || [];
  credentials.load(state.contexts);
  renderFavorites(); renderAuthBanner();
  if (!state.context) render();
}
// ---- Onboarding tour --------------------------------------------------------------------------
const waitFor = async (test, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { const found = test(); if (found) return found; await new Promise(resolve => setTimeout(resolve, 100)); } return null; };
const tourSteps = () => [
  { id: 'cluster', target: () => $('#context-switcher'), placement: 'right', title: 'Pick a cluster', body: 'Rubban reads your kubeconfig and never changes it. Pin clusters here for one-click switching, or import a kubeconfig from the Clusters page.' },
  { id: 'namespace', target: () => $('#namespace'), placement: 'bottom', title: 'Namespaces', body: 'Scope every view to one namespace, or keep all namespaces.' },
  { id: 'navigation', target: () => $('#navigation'), placement: 'right', title: 'The sidebar', body: 'Workloads, config, network, storage, Helm, Argo CD, RabbitMQ and custom resources are all here. Press / to filter.' },
  { id: 'command', target: () => $('#command-open'), placement: 'bottom', title: 'Jump anywhere', body: `${MOD}+K opens any view or resource. ${MOD}+Shift+K switches cluster.` },
  { id: 'row', when: ctx => ctx.cluster, before: async () => { openView('resource', 'pods'); await waitFor(() => $('#main table tbody tr')); }, target: () => $('#main table tbody tr'), placement: 'bottom', title: 'Details on click', body: 'Click a row for its overview, metrics, YAML and events.' },
  { id: 'row-actions', when: ctx => ctx.cluster, target: () => $('#main table tbody tr .row-menu'), placement: 'left', title: 'Row actions', body: 'Edit YAML, scale, restart, open logs or a shell, delete. Right-click works too.' },
  { id: 'terminal', target: () => $('#local-terminal'), placement: 'bottom', title: 'Terminal', body: 'Open a terminal already pointed at this cluster. Pod exec, attach and node shells open in the same dock.' },
  { id: 'create', target: () => $('#create-manifest'), placement: 'bottom', title: 'Create', body: 'Create any resource from a template or your own YAML.' },
  { id: 'settings', target: () => document.querySelector('[data-section="settings"]'), placement: 'right', title: 'Settings', body: 'Theme, metrics source, node shell image and shortcuts live in Settings.' },
  { id: 'updates', when: () => document.querySelector('#update-button'), target: () => $('#update-button'), placement: 'right', title: 'Updates', body: 'Rubban checks GitHub for new versions and installs them in place.' },
  { id: 'done', target: () => null, placement: 'bottom', title: 'You are set', body: 'Restart the tour any time from Settings › Help or the command palette.' },
];
const minorVersion = () => String(state.health?.version || '').split('.').slice(0, 2).join('.');
function takeTour(reason = 'manual') {
  const cluster = Boolean(state.context);
  startTour({ steps: tourSteps(), ctx: { cluster }, reason, skippedNote: cluster ? '' : 'Connect a cluster to see the table and row steps.',
    savePreference: async () => { try { state.preferences = await api('/api/preferences', { method: 'PUT', body: { ...state.preferences, tourCompletedVersion: minorVersion() || 'seen' } }); } catch { /* Preferences are optional here. */ } } });
}
// Last session's tabs come back like a browser's; tabs on clusters that are gone are dropped.
function restoreTabs() {
  const saved = readStore(TABS_STORE, null);
  const tabs = Array.isArray(saved?.tabs) ? saved.tabs.filter(tab => tab && typeof tab.section === 'string' && (!tab.context || state.contexts.some(context => context.name === tab.context)))
    .map(tab => ({ id: newTabId(), context: tab.context || '', namespace: typeof tab.namespace === 'string' ? tab.namespace : '*', section: tab.section, resource: tab.resource, title: String(tab.title || tab.section), trail: Array.isArray(tab.trail) ? tab.trail : [] })) : [];
  if (!tabs.length) { render(); return; }
  state.tabs = tabs;
  const active = tabs[Math.min(Math.max(Number(saved.active) || 0, 0), tabs.length - 1)];
  state.active = active.id;
  if (active.context) selectContext(active.context, { namespace: active.namespace, fromTab: true });
  else { navigation(); renderTabs(); render(); }
}
applyTheme(storedTheme());
async function init() {
  document.querySelectorAll('[data-icon]').forEach(node => {
    const svgIcon = icon(node.dataset.icon, node.classList.contains('rail-button') ? 'rail-svg' : 'ui-svg');
    if (node.tagName === 'SPAN') node.replaceWith(svgIcon); else if (node.childElementCount || node.textContent.trim()) node.prepend(svgIcon); else node.replaceChildren(svgIcon);
  });
  navigation(); renderTabs(); $('#main').replaceChildren(loading());
  const results = await Promise.allSettled([get('/api/health'), get('/api/contexts'), get('/api/preferences')]);
  if (results[0].status === 'fulfilled') { state.health = results[0].value; $('#app-version').textContent = `Rubban ${state.health.version || 'Desktop'}`; }
  if (results[1].status === 'fulfilled') { state.contexts = results[1].value.contexts || []; credentials.load(state.contexts); }
  else state.contextsError = results[1].reason.message;
  if (results[2].status === 'fulfilled') { state.preferences = results[2].value; applyTheme(state.preferences.theme || 'system'); }
  renderFavorites();
  for (const result of results) if (result.status === 'rejected') toast(result.reason.message, true);
  restoreTabs();
  // The installer's first run copies the settings of the layout it replaced; say so once.
  if (state.health?.migratedFrom && readStore('rubban.migratedToast', '') !== state.health.migratedFrom) { toast(`Settings copied from ${state.health.migratedFrom}.`); writeStore('rubban.migratedToast', state.health.migratedFrom); }
  forwardsPoller.refresh();
  setupUpdates({ openSettings: () => openView('settings') });
  if (results[2].status === 'fulfilled' && !state.preferences.tourCompletedVersion) setTimeout(() => takeTour('first-run'), 600);
}
$('#context-switcher').addEventListener('click', () => openSwitcher());
$('#pin-context').addEventListener('click', task(toggleFavorite));
$('#namespace').addEventListener('change', event => { state.namespace = event.target.value; activeTab().namespace = state.namespace; $('#drawer').classList.add('hidden'); renderTabs(); render(); saveTabs(); });
$('#nav-search').addEventListener('input', event => navigation(event.target.value));
$('#refresh').addEventListener('click', refreshView);
$('#reload-contexts').addEventListener('click', task(reloadContexts));
$('#workspace-button').addEventListener('click', () => openView('overview'));
document.querySelectorAll('[data-section]').forEach(node => node.addEventListener('click', () => openView(node.dataset.section)));
$('#create-manifest').addEventListener('click', () => createManifest());
$('#command-open').addEventListener('click', commandPalette);
$('#command-search').addEventListener('input', event => commandResults(event.target.value));
$('#command-search').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('#command-results button')?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: event.ctrlKey, metaKey: event.metaKey })); } if (event.key === 'ArrowDown') { event.preventDefault(); $('#command-results button')?.focus(); } });
$('#local-terminal').addEventListener('click', () => openTerminal(localShellTarget()));
$('#drawer-close').addEventListener('click', closeDrawer);
$('#drawer-back').addEventListener('click', drawerBack);
// Dismiss before the background control's click runs, so clicking another resource can open
// its details immediately. Menus and input dialogs opened from the drawer stay usable.
document.addEventListener('pointerdown', event => {
  const drawer = $('#drawer');
  if (event.button !== 0 || drawer.classList.contains('hidden') || drawer.contains(event.target)) return;
  if (event.target.closest('.popup-menu') || document.querySelector('dialog[open]')) return;
  closeDrawer();
}, { capture: true });
setupDock();
if (MOD !== 'Ctrl') { const kbd = $('#command-open kbd'); if (kbd) kbd.textContent = `${MOD}K`; $('#dock-min')?.setAttribute('title', `Hide dock (${MOD}+\`)`); }
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === '`') { event.preventDefault(); toggleDock(); } if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'k') { event.preventDefault(); openSwitcher(); } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); commandPalette(); } if ((event.ctrlKey || event.metaKey) && event.key === '1') { event.preventDefault(); openView('overview'); } if (event.key === 'Escape' && !document.querySelector('dialog[open]')) closeDrawer();
  // Browser-style tab keys: new cluster tab, close, cycle.
  const mod = event.ctrlKey || event.metaKey;
  if (mod && !event.shiftKey && event.key.toLowerCase() === 't') { event.preventDefault(); openSwitcher({ newTab: true }); }
  else if (mod && !event.shiftKey && event.key.toLowerCase() === 'w' && !document.querySelector('dialog[open]')) { event.preventDefault(); closeTab(state.active); }
  else if (event.ctrlKey && (event.key === 'Tab' || event.key === 'PageDown' || event.key === 'PageUp')) { event.preventDefault(); cycleTab(event.shiftKey || event.key === 'PageUp' ? -1 : 1); }
});
Object.assign(hooks, { takeTour, selectContext, newClusterTab, activateTab, reloadContexts, labelFor, clusterEnv: () => envFor(state.context), showResource, openView, render, afterMutation, openLogs, openTerminal, argoMenu, openExternal: openExternalLink });
init();
