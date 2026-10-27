'use strict';

// Argo CD application management through the Kubernetes API, using the same kubeconfig
// credentials and RBAC as every other Rubban action (no separate Argo CD login):
//  - refresh / hard refresh: the argocd.argoproj.io/refresh annotation the controller watches
//  - sync and rollback: an `operation` written on the Application, as the Argo CD API server does
//  - terminate: operationState.phase = Terminating (the Application CRD has no status subresource)
//  - auto-sync: spec.syncPolicy.automated
//  - delete: the resources finalizer decides cascading (foreground/background) or not

const APPS = 'applications.argoproj.io';
const RESOURCES_FINALIZER = 'resources-finalizer.argocd.argoproj.io';
const SYNC_OPTIONS = {
  skipSchemaValidation: 'Validate=false', createNamespace: 'CreateNamespace=true', pruneLast: 'PruneLast=true',
  applyOutOfSyncOnly: 'ApplyOutOfSyncOnly=true', respectIgnoreDifferences: 'RespectIgnoreDifferences=true',
  serverSideApply: 'ServerSideApply=true', replace: 'Replace=true',
};

function createArgoCD(helpers) {
  const { problem, validateText, validateName, validateNamespace, integer, contextArgs, namespaceArgs, parseJSONOutput } = helpers;
  const initiatedBy = { username: 'rubban' };

  function revisionOf(value) {
    if (value === undefined || value === null || value === '') return '';
    const revision = validateText(value, 'revision', { max: 256 });
    if (!/^[A-Za-z0-9][A-Za-z0-9._/@:+~-]*$/.test(revision)) throw problem('Invalid revision');
    return revision;
  }
  function resourceRef(entry) {
    if (!entry || typeof entry !== 'object') throw problem('Invalid resource selection');
    const kind = validateText(entry.kind, 'resource kind', { max: 100 });
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(kind)) throw problem('Invalid resource kind');
    const group = entry.group ? validateText(entry.group, 'resource group', { max: 253 }) : '';
    if (group && !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(group)) throw problem('Invalid resource group');
    return { group, kind, name: validateName(entry.name, 'resource name'), namespace: entry.namespace ? validateNamespace(entry.namespace) : '' };
  }
  function syncOperation(options = {}) {
    const syncOptions = Object.entries(SYNC_OPTIONS).filter(([key]) => options[key] === true).map(([, value]) => value);
    if (options.prunePropagationPolicy) {
      if (!['foreground', 'background', 'orphan'].includes(options.prunePropagationPolicy)) throw problem('Invalid prune propagation policy');
      syncOptions.push(`PrunePropagationPolicy=${options.prunePropagationPolicy}`);
    }
    const sync = {
      prune: options.prune === true,
      dryRun: options.dryRun === true,
      syncStrategy: options.applyOnly === true ? { apply: { force: options.force === true } } : { hook: { force: options.force === true } },
    };
    if (syncOptions.length) sync.syncOptions = syncOptions;
    const revision = revisionOf(options.revision);
    if (revision) sync.revision = revision;
    if (options.resources !== undefined) {
      if (!Array.isArray(options.resources) || options.resources.length > 1000) throw problem('Resources must be a list of up to 1000 entries');
      if (options.resources.length) sync.resources = options.resources.map(resourceRef);
    }
    const operation = { initiatedBy, sync };
    if (options.retry === true) operation.retry = { limit: integer(options.retryLimit, 'retry limit', 1, 100, 5), backoff: { duration: '5s', factor: 2, maxDuration: '3m' } };
    return operation;
  }

  return async function handle({ method, route, body, kube, signal, sendJSON, res }) {
    if (method !== 'POST' || route !== '/api/argocd') return false;
    const context = validateText(body.context, 'context');
    const namespace = validateNamespace(body.namespace);
    const name = validateName(body.name, 'application');
    const base = [...contextArgs(context), ...namespaceArgs(namespace)];
    const read = async () => parseJSONOutput(await kube([...base, 'get', APPS, name, '--output=json'], { signal }), 'kubectl');
    const patch = async (value, type = 'merge') => (await kube([...base, 'patch', APPS, name, `--type=${type}`, `--patch=${JSON.stringify(value)}`], { signal })).stdout.trim();
    const done = output => { sendJSON(res, { output }); return true; };
    switch (body.action) {
      case 'refresh':
      case 'hard-refresh': {
        const mode = body.action === 'hard-refresh' ? 'hard' : 'normal';
        const output = await kube([...base, 'annotate', APPS, name, `argocd.argoproj.io/refresh=${mode}`, '--overwrite'], { signal });
        return done(output.stdout.trim() || `${name} ${mode} refresh requested`);
      }
      case 'sync': {
        const app = await read();
        if (app.operation) throw problem('Another operation is already in progress for this application', 409);
        const operation = syncOperation(body.options || {});
        await patch({ metadata: { resourceVersion: app.metadata.resourceVersion }, operation });
        return done(`${name}: ${operation.sync.dryRun ? 'dry-run ' : ''}sync requested${operation.sync.revision ? ` to ${operation.sync.revision}` : ''}`);
      }
      case 'rollback': {
        const app = await read();
        if (app.operation) throw problem('Another operation is already in progress for this application', 409);
        if (app.spec?.syncPolicy?.automated) throw problem('Turn off auto-sync before rolling back; Argo CD would otherwise sync forward again', 409);
        const id = integer(body.id, 'history id', 0, 1e9);
        const entry = (app.status?.history || []).find(item => Number(item.id) === id);
        if (!entry) throw problem(`History entry ${id} was not found`, 404);
        const sync = { prune: body.prune === true, dryRun: body.dryRun === true, syncStrategy: { hook: {} } };
        if (entry.revisions?.length) { sync.revisions = entry.revisions; if (entry.sources) sync.sources = entry.sources; }
        else { sync.revision = entry.revision; if (entry.source) sync.source = entry.source; }
        await patch({ metadata: { resourceVersion: app.metadata.resourceVersion }, operation: { initiatedBy, sync } });
        return done(`${name}: rollback to history ${id} (${String(entry.revision || entry.revisions?.[0] || '').slice(0, 12)}) requested`);
      }
      case 'terminate': {
        const app = await read();
        if (app.status?.operationState?.phase !== 'Running') throw problem('No operation is running for this application', 409);
        await patch({ metadata: { resourceVersion: app.metadata.resourceVersion }, status: { operationState: { phase: 'Terminating' } } });
        return done(`${name}: termination requested`);
      }
      case 'auto-sync': {
        const automated = body.enabled === true ? { prune: body.prune === true, selfHeal: body.selfHeal === true, ...(body.allowEmpty === true ? { allowEmpty: true } : {}) } : null;
        await patch({ spec: { syncPolicy: { automated } } });
        return done(`${name}: auto-sync ${automated ? `on${automated.prune ? ' · prune' : ''}${automated.selfHeal ? ' · self-heal' : ''}` : 'off'}`);
      }
      case 'delete': {
        const cascade = body.cascade || 'foreground';
        if (!['foreground', 'background', 'none'].includes(cascade)) throw problem('Cascade must be foreground, background or none');
        const app = await read();
        const finalizers = (app.metadata?.finalizers || []).filter(item => !item.startsWith(RESOURCES_FINALIZER));
        if (cascade !== 'none') finalizers.push(cascade === 'background' ? `${RESOURCES_FINALIZER}/background` : RESOURCES_FINALIZER);
        // Same resourceVersion guard as Argo CD: the finalizer must match the cascade the user chose.
        await patch({ metadata: { resourceVersion: app.metadata.resourceVersion, finalizers } });
        const output = await kube([...base, 'delete', APPS, name, '--wait=false'], { signal });
        return done(`${output.stdout.trim()}${cascade === 'none' ? ' (resources kept)' : ` (${cascade} cascade: Argo CD deletes the managed resources)`}`);
      }
      default: throw problem('Unsupported Argo CD action');
    }
  };
}

module.exports = { createArgoCD, SYNC_OPTIONS };
