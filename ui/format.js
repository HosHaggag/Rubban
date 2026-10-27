// Pure helpers: Kubernetes quantities, human-readable usage, label selectors,
// cron schedules and certificate dates. No DOM access; unit tested in Node.

const BINARY = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };
const DECIMAL = { n: 1e-9, u: 1e-6, m: 1e-3, '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };

// Parses a Kubernetes resource.Quantity ("250m", "1.5", "512Mi", "2G", "1e3") into a number in base units.
export function parseQuantity(value) {
  if (value === undefined || value === null || value === '') return NaN;
  if (typeof value === 'number') return value;
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(Ki|Mi|Gi|Ti|Pi|Ei|n|u|m|k|K|M|G|T|P|E)?$/.exec(String(value).trim());
  if (!match) return NaN;
  const number = Number(match[1]);
  const suffix = match[2] || '';
  return number * (BINARY[suffix] ?? DECIMAL[suffix] ?? 1);
}
export const parseCPU = value => parseQuantity(value); // cores
export const parseMemory = value => parseQuantity(value); // bytes

const trim = number => {
  if (!Number.isFinite(number)) return '—';
  const abs = Math.abs(number);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return Number(number.toFixed(digits)).toString();
};

// CPU: below one core show millicores ("250m"), otherwise cores ("1.25 cores").
export function formatCPU(cores, { unit = true } = {}) {
  if (!Number.isFinite(cores)) return '—';
  if (cores === 0) return '0';
  if (Math.abs(cores) < 1) {
    const milli = cores * 1000;
    return `${milli < 1 ? trim(milli) : Math.round(milli)}m`;
  }
  return `${trim(cores)}${unit ? (Math.abs(cores) === 1 ? ' core' : ' cores') : ''}`;
}

// Bytes in binary units: "512 MiB", "1.5 GiB".
export function formatBytes(bytes, { decimals } = {}) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let index = 0;
  let value = Math.abs(bytes);
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  const text = decimals === undefined ? trim(value) : value.toFixed(decimals);
  return `${bytes < 0 ? '-' : ''}${text} ${units[index]}`;
}

export function formatPercent(part, whole, { digits = 0 } = {}) {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return '';
  const percent = (part / whole) * 100;
  return `${percent < 1 && percent > 0 ? '<1' : percent.toFixed(digits)}%`;
}

export const ratio = (part, whole) => (Number.isFinite(part) && Number.isFinite(whole) && whole > 0 ? part / whole : NaN);

// Adds up container requests and limits for a pod (init containers use the max rule).
// Native sidecars (init containers with restartPolicy: Always) run alongside the app containers,
// so they add to the sums; ordinary init containers run alone and count through the max rule.
// Pod objects are replaced (never mutated) when they change, so the result is cached per object.
const resourceCache = new WeakMap();
export function podResources(pod) {
  if (pod && typeof pod === 'object') {
    const cached = resourceCache.get(pod);
    if (cached) return cached;
    const result = Object.freeze(computePodResources(pod));
    resourceCache.set(pod, result);
    return result;
  }
  return computePodResources(pod);
}
function computePodResources(pod) {
  const sum = { cpuRequest: 0, cpuLimit: 0, memoryRequest: 0, memoryLimit: 0, cpuLimitMissing: false, memoryLimitMissing: false };
  const add = container => {
    const requests = container.resources?.requests || {};
    const limits = container.resources?.limits || {};
    // Kubernetes defaults a missing request to the limit.
    sum.cpuRequest += parseCPU(requests.cpu ?? limits.cpu) || 0;
    sum.memoryRequest += parseMemory(requests.memory ?? limits.memory) || 0;
    if (limits.cpu === undefined) sum.cpuLimitMissing = true; else sum.cpuLimit += parseCPU(limits.cpu) || 0;
    if (limits.memory === undefined) sum.memoryLimitMissing = true; else sum.memoryLimit += parseMemory(limits.memory) || 0;
  };
  const init = pod?.spec?.initContainers || [];
  for (const container of [...(pod?.spec?.containers || []), ...init.filter(c => c.restartPolicy === 'Always')]) add(container);
  let sidecarCPU = 0; let sidecarMemory = 0;
  for (const container of init) {
    const requests = container.resources?.requests || {};
    const limits = container.resources?.limits || {};
    if (container.restartPolicy === 'Always') { sidecarCPU += parseCPU(requests.cpu ?? limits.cpu) || 0; sidecarMemory += parseMemory(requests.memory ?? limits.memory) || 0; continue; }
    sum.cpuRequest = Math.max(sum.cpuRequest, (parseCPU(requests.cpu ?? limits.cpu) || 0) + sidecarCPU);
    sum.memoryRequest = Math.max(sum.memoryRequest, (parseMemory(requests.memory ?? limits.memory) || 0) + sidecarMemory);
  }
  return sum;
}

// Label selector matching (matchLabels + matchExpressions, or a plain map for Services).
export function matchesSelector(selector, labels = {}) {
  if (!selector) return false;
  const plain = !selector.matchLabels && !selector.matchExpressions;
  const matchLabels = plain ? selector : selector.matchLabels || {};
  const keys = Object.keys(matchLabels);
  if (plain && !keys.length) return false;
  if (!plain && !keys.length && !(selector.matchExpressions || []).length) return true;
  for (const key of keys) if (labels[key] !== matchLabels[key]) return false;
  for (const expression of selector.matchExpressions || []) {
    const has = Object.prototype.hasOwnProperty.call(labels, expression.key);
    const value = labels[expression.key];
    const values = expression.values || [];
    if (expression.operator === 'In' && !(has && values.includes(value))) return false;
    if (expression.operator === 'NotIn' && has && values.includes(value)) return false;
    if (expression.operator === 'Exists' && !has) return false;
    if (expression.operator === 'DoesNotExist' && has) return false;
  }
  return true;
}

export function selectorText(selector) {
  if (!selector) return '';
  const plain = !selector.matchLabels && !selector.matchExpressions;
  const parts = Object.entries(plain ? selector : selector.matchLabels || {}).map(([k, v]) => `${k}=${v}`);
  for (const e of selector.matchExpressions || []) {
    if (e.operator === 'Exists') parts.push(e.key);
    else if (e.operator === 'DoesNotExist') parts.push(`!${e.key}`);
    else parts.push(`${e.key} ${e.operator === 'In' ? 'in' : 'notin'} (${(e.values || []).join(',')})`);
  }
  return parts.join(',');
}

// Human-readable durations: "3d 4h", "12m", "45s".
export function formatDuration(ms, { parts = 2 } = {}) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const units = [['d', 86400000], ['h', 3600000], ['m', 60000], ['s', 1000]];
  const out = [];
  let rest = ms;
  for (const [label, size] of units) {
    const count = Math.floor(rest / size);
    if (count || (label === 's' && !out.length)) { out.push(`${count}${label}`); rest -= count * size; }
    if (out.length === parts) break;
  }
  return out.join(' ');
}

// Minimal 5-field cron evaluator for "next run" (supports *, lists, ranges, steps, @macros).
const MACROS = { '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *' };
function cronField(text, min, max) {
  const values = new Set();
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText ? Number(stepText) : 1;
    let start = min; let end = max;
    if (range !== '*' && range !== '?') {
      const [a, b] = range.split('-');
      start = Number(a); end = b === undefined ? (stepText ? max : start) : Number(b);
    }
    if (![start, end, step].every(Number.isFinite) || step <= 0) throw new Error('Invalid cron field');
    for (let value = start; value <= end; value += step) values.add(value === 7 && max === 7 ? 0 : value);
  }
  return values;
}
export function nextCronRun(schedule, from = new Date(), { timeZoneOffsetMinutes = null } = {}) {
  let text = String(schedule || '').trim();
  text = MACROS[text] || text;
  if (/^@every /.test(text)) return null;
  const fields = text.split(/\s+/);
  if (fields.length !== 5) return null;
  let minutes, hours, days, months, weekdays;
  try {
    minutes = cronField(fields[0], 0, 59); hours = cronField(fields[1], 0, 23); days = cronField(fields[2], 1, 31);
    months = cronField(fields[3], 1, 12); weekdays = cronField(fields[4], 0, 7);
  } catch { return null; }
  const dayRestricted = fields[2] !== '*' && fields[2] !== '?';
  const weekRestricted = fields[4] !== '*' && fields[4] !== '?';
  const offset = timeZoneOffsetMinutes ?? -from.getTimezoneOffset();
  // Work in the schedule's wall clock using UTC fields shifted by the offset.
  const cursor = new Date(Math.floor((from.getTime() + offset * 60000) / 60000) * 60000 + 60000);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const m = cursor.getUTCMinutes(), h = cursor.getUTCHours(), d = cursor.getUTCDate(), mo = cursor.getUTCMonth() + 1, wd = cursor.getUTCDay();
    const dayOk = dayRestricted && weekRestricted ? (days.has(d) || weekdays.has(wd)) : (days.has(d) && weekdays.has(wd));
    if (months.has(mo) && dayOk && hours.has(h) && minutes.has(m)) return new Date(cursor.getTime() - offset * 60000);
    cursor.setTime(cursor.getTime() + 60000);
  }
  return null;
}

// Extracts validity dates and names from a PEM certificate (base64 DER inside) without crypto libs.
export function certificateSummary(pem) {
  try {
    const body = String(pem).replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
    const der = Uint8Array.from(atob(body), c => c.charCodeAt(0));
    const read = offset => { let length = der[offset + 1]; let header = 2; if (length & 0x80) { const n = length & 0x7f; length = 0; for (let i = 0; i < n; i++) length = length * 256 + der[offset + 2 + i]; header += n; } return { tag: der[offset], start: offset + header, end: offset + header + length }; };
    const children = node => { const out = []; let at = node.start; while (at < node.end) { const child = read(at); out.push(child); at = child.end; } return out; };
    const cert = read(0); const tbs = children(cert)[0]; let fields = children(tbs);
    if (fields[0].tag === 0xa0) fields = fields.slice(1);
    const [, , issuerNode, validityNode, subjectNode] = fields;
    const text = node => new TextDecoder().decode(der.slice(node.start, node.end));
    const time = node => { const s = text(node); const full = node.tag === 0x17 ? (Number(s.slice(0, 2)) < 50 ? '20' : '19') + s : s; return new Date(`${full.slice(0, 4)}-${full.slice(4, 6)}-${full.slice(6, 8)}T${full.slice(8, 10)}:${full.slice(10, 12)}:${full.slice(12, 14)}Z`); };
    const name = node => children(node).map(set => { const [oid, value] = children(children(set)[0]); const id = Array.from(der.slice(oid.start, oid.end)).join('.'); const label = { '85.4.3': 'CN', '85.4.10': 'O', '85.4.11': 'OU', '85.4.6': 'C' }[id] || ''; return label ? `${label}=${text(value)}` : ''; }).filter(Boolean).join(', ');
    const [notBefore, notAfter] = children(validityNode).map(time);
    return { subject: name(subjectNode), issuer: name(issuerNode), notBefore, notAfter };
  } catch { return null; }
}

export function sumBy(items, fn) { let total = 0; for (const item of items) { const value = fn(item); if (Number.isFinite(value)) total += value; } return total; }

// Minimal JSONPath for CRD printer columns: .a.b, [n], [*], [?(@.k=="v")].
export function jsonPath(object, path) {
  let values = [object];
  const tokens = String(path || '').replace(/^\{|\}$/g, '').replace(/^\$/, '').match(/\.\.?[A-Za-z0-9_\-$/]+|\[[^\]]*\]/g) || [];
  for (const token of tokens) {
    const next = [];
    for (const value of values) {
      if (value === undefined || value === null) continue;
      if (token.startsWith('.')) { const key = token.replace(/^\.+/, ''); if (value[key] !== undefined) next.push(value[key]); continue; }
      const inner = token.slice(1, -1).trim();
      if (inner === '*') { if (Array.isArray(value)) next.push(...value); else if (typeof value === 'object') next.push(...Object.values(value)); continue; }
      if (/^-?\d+$/.test(inner)) { const index = Number(inner); if (Array.isArray(value)) { const item = value.at(index); if (item !== undefined) next.push(item); } continue; }
      const filter = /^\?\(@\.([A-Za-z0-9_.\-]+)\s*(==|!=)\s*['"]?([^'"]*)['"]?\)$/.exec(inner);
      if (filter && Array.isArray(value)) { const [, field, op, expected] = filter; for (const item of value) { const actual = field.split('.').reduce((o, k) => o?.[k], item); if ((op === '==') === (String(actual) === expected)) next.push(item); } continue; }
      const quoted = /^['"](.+)['"]$/.exec(inner);
      if (quoted && value[quoted[1]] !== undefined) next.push(value[quoted[1]]);
    }
    values = next;
  }
  return values;
}
