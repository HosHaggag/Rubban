'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');

const MAX_BYTES = 1024 * 1024;
const CLUSTER_ICONS = ['cluster', 'gcp', 'aws', 'azure', 'local', 'production', 'staging', 'development', 'database', 'globe', 'shield', 'flask', 'rocket', 'star', 'bolt', 'box'];
const CLUSTER_ENVS = ['production', 'staging', 'development', 'other', ''];

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// Validates a kubeconfig document and returns its context names. Throws a 400 with a readable message.
function parseKubeconfig(content) {
  if (typeof content !== 'string' || !content.trim()) throw fail('The kubeconfig is empty');
  if (Buffer.byteLength(content) > MAX_BYTES) throw fail('The kubeconfig is larger than 1 MB', 413);
  let document;
  try { document = YAML.parse(content); } catch (error) { throw fail(`The kubeconfig is not valid YAML: ${String(error.message).split('\n')[0]}`); }
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw fail('The kubeconfig must be a YAML mapping');
  if (document.apiVersion !== 'v1' || document.kind !== 'Config') throw fail('Not a kubeconfig: expected "apiVersion: v1" and "kind: Config"');
  for (const key of ['clusters', 'contexts', 'users']) if (!Array.isArray(document[key])) throw fail(`The kubeconfig has no "${key}" list`);
  const names = document.contexts.map(item => item?.name);
  if (!names.length || names.some(name => typeof name !== 'string' || !name || name.length > 253)) throw fail('The kubeconfig needs at least one context, and every context needs a name');
  return [...new Set(names)];
}

// Imported kubeconfigs live in <dataDir>/kubeconfigs and are merged only through the KUBECONFIG
// variable of the processes Rubban starts. The user's own kubeconfig is never written.
function createKubeconfigStore({ dataDir }) {
  const directory = path.join(dataDir, 'kubeconfigs');
  const indexPath = path.join(directory, 'index.json');
  const fileFor = id => path.join(directory, `${id}.yaml`);
  const readIndex = () => {
    try { const value = JSON.parse(fs.readFileSync(indexPath, 'utf8')); return Array.isArray(value) ? value.filter(item => item && /^[a-f0-9]{16}$/.test(item.id) && fs.existsSync(fileFor(item.id))) : []; }
    catch { return []; }
  };
  const writeIndex = entries => {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${indexPath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(entries, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, indexPath);
  };
  const list = () => readIndex();
  const files = () => readIndex().map(entry => fileFor(entry.id));
  // KUBECONFIG for child processes, or undefined while nothing is imported (kubectl then behaves exactly as before).
  const kubeconfigVariable = (env = process.env) => {
    const imported = files();
    if (!imported.length) return undefined;
    const base = env.KUBECONFIG || path.join(os.homedir(), '.kube', 'config');
    return [base, ...imported].join(path.delimiter);
  };
  const sourceOf = name => list().find(entry => entry.contexts.includes(name))?.id || 'default';
  function add({ name, content, source, fileName }, existingNames = []) {
    const contexts = parseKubeconfig(content);
    const clashes = contexts.filter(context => existingNames.includes(context));
    if (clashes.length) throw fail(`These contexts already exist: ${clashes.join(', ')}. Rename them in the kubeconfig before importing.`, 409);
    const label = String(name || '').trim().slice(0, 80) || String(fileName || '').trim().slice(0, 80) || 'Imported kubeconfig';
    const entry = { id: crypto.randomBytes(8).toString('hex'), name: label, source: source === 'file' ? 'file' : 'paste', fileName: source === 'file' ? String(fileName || '').slice(0, 200) : '', addedAt: new Date().toISOString(), contexts };
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(fileFor(entry.id), content, { mode: 0o600 });
    writeIndex([...readIndex(), entry]);
    return entry;
  }
  function remove(id) {
    const entries = readIndex();
    if (!entries.some(entry => entry.id === id)) throw fail('Imported kubeconfig not found', 404);
    fs.rmSync(fileFor(id), { force: true });
    writeIndex(entries.filter(entry => entry.id !== id));
  }
  return { list, files, add, remove, kubeconfigVariable, sourceOf };
}

// Per-cluster display metadata kept in preferences.json ("clusters": { <context>: { label, icon, color, env } }).
function validateClusters(value) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('Invalid clusters preference');
  const entries = Object.entries(value);
  if (entries.length > 500) throw fail('Too many cluster entries');
  for (const [name, entry] of entries) {
    if (!name || name.length > 253 || !entry || typeof entry !== 'object' || Array.isArray(entry)) throw fail('Invalid cluster entry');
    if (entry.label !== undefined && (typeof entry.label !== 'string' || entry.label.length > 80)) throw fail('Invalid cluster label');
    if (entry.icon !== undefined && entry.icon !== '' && !CLUSTER_ICONS.includes(entry.icon)) throw fail('Invalid cluster icon');
    if (entry.color !== undefined && entry.color !== '' && !/^#[0-9a-fA-F]{6}$/.test(entry.color)) throw fail('Invalid cluster colour');
    if (entry.env !== undefined && !CLUSTER_ENVS.includes(entry.env)) throw fail('Invalid cluster environment');
  }
}

module.exports = { createKubeconfigStore, parseKubeconfig, validateClusters, CLUSTER_ICONS, CLUSTER_ENVS, MAX_BYTES };
