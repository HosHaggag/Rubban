// Log intelligence for the log dock, entirely local: a streaming Drain-style clusterer that folds log lines into
// a short list of templates ("GET /healthz 200 <*> trace=<*>"), with per-pattern counts, level, pods, first and
// last seen and a ring-buffer histogram, plus the analysis on top of it: which patterns are new and which spike.
//
// How a line becomes a pattern:
//   1. parseLine strips the [pod/container] prefix of workload logs, leading timestamps (RFC 3339, the
//      Kubernetes --timestamps prefix, Go's log package, klog) and the level, and unwraps JSON and logfmt
//      lines to their message. The timestamp found is the line's time; lines without one use the arrival time.
//   2. tokenize masks the variable parts (numbers, durations, sizes, hex and trace ids, UUIDs, IP:port, dates,
//      pod-name hash suffixes, quoted strings) to <*> and splits on whitespace. HTTP status codes stay literal
//      and "pinned": 200s and 503s are never folded into one pattern.
//   3. The miner groups by level, token count and pinned tokens, walks a fixed-depth prefix tree on the first
//      tokens, and joins the most similar template in that leaf when at least `similarity` of the tokens are
//      equal; positions that differ become <*>. Otherwise the line starts a new pattern.
// Memory is bounded: at most `maxPatterns` patterns (the least recently seen are dropped in batches), a fixed
// number of histogram buckets per pattern, and capped examples and pod lists.

import { podOf } from './logs-util.js';

export const WILDCARD = '<*>';
export const LEVELS = ['error', 'warn', 'info', 'debug'];
export const levelRank = level => { const index = LEVELS.indexOf(level); return index < 0 ? LEVELS.length : index; };

const LEVEL_WORDS = {
  ERROR: 'error', ERR: 'error', EROR: 'error', FATAL: 'error', FATL: 'error', PANIC: 'error', CRITICAL: 'error', CRIT: 'error', SEVERE: 'error', ALERT: 'error', EMERG: 'error', EMERGENCY: 'error',
  WARN: 'warn', WARNING: 'warn', WRN: 'warn',
  INFO: 'info', INF: 'info', NOTICE: 'info',
  DEBUG: 'debug', DBG: 'debug', TRACE: 'debug', TRC: 'debug', VERBOSE: 'debug', FINE: 'debug', FINER: 'debug', FINEST: 'debug',
};
const KLOG_LEVELS = { I: 'info', W: 'warn', E: 'error', F: 'error' };
// pino / bunyan numeric levels.
const numericLevel = n => (n >= 50 ? 'error' : n >= 40 ? 'warn' : n >= 30 ? 'info' : n > 0 ? 'debug' : '');

export function normalizeLevel(value) {
  if (typeof value === 'number') return numericLevel(value);
  if (typeof value !== 'string' || !value) return '';
  return LEVEL_WORDS[value.trim().toUpperCase()] || '';
}

// ---- timestamps --------------------------------------------------------------------------------------
// 2026-11-06T14:29:17.482Z, 2026-11-06 14:29:17,482, 2026/11/06 14:29:17, optionally in [brackets]. A time
// without a zone is read as UTC, the default inside containers.
const TS_RE = /^\[?(\d{4})[-/](\d{2})[-/](\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?\]?(?:\s+|$)/;
// klog: I1106 14:29:17.482123    1 controller.go:123] message
const KLOG_RE = /^([IWEF])(\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?\s+\d+\s+[^\s\]]+\]\s?/;

// Milliseconds since the epoch from the parts of a timestamp, with plain arithmetic (Date.UTC is slow in a
// loop of 100k lines). Days from the civil date as in Howard Hinnant's algorithm.
function utc(y, mo, d, h, mi, s, frac, zone) {
  let year = +y; const month = +mo;
  if (month <= 2) year--;
  const era = Math.floor(year / 400); const yoe = year - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + +d - 1;
  const days = era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468;
  let ms = ((days * 24 + +h) * 60 + +mi) * 60000 + +s * 1000;
  if (frac) ms += frac.length === 3 ? +frac : Math.floor(+(frac.length > 3 ? frac.slice(0, 3) : frac.padEnd(3, '0')));
  if (zone && zone !== 'Z') {
    const sign = zone[0] === '-' ? -1 : 1; const digits = zone.slice(1).replace(':', '');
    ms -= sign * (+digits.slice(0, 2) * 60 + +digits.slice(2, 4)) * 60000;
  }
  return ms;
}

export function parseTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e14 ? value / 1000 : value > 1e11 ? value : value * 1000;
  if (typeof value !== 'string' || !value) return NaN;
  const m = TS_RE.exec(value.trim());
  if (m) return utc(m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);
  if (/^\d{10}(\.\d+)?$/.test(value)) return Number(value) * 1000;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : NaN;
}

// ---- structured lines ----------------------------------------------------------------------------------
const MSG_KEYS = ['msg', 'message', '@m', '@mt', 'event', 'log', 'text'];
const LEVEL_KEYS = ['level', 'lvl', 'severity', 'levelname', 'log.level', 'loglevel', '@l', 'priority'];
const TIME_KEYS = ['time', 'ts', 'timestamp', '@timestamp', '@t', 'datetime', 'date'];
// Fields worth keeping next to the message: they tell otherwise identical "request done" lines apart.
const EXTRA_KEYS = ['method', 'path', 'route', 'url', 'uri', 'status', 'status_code', 'statusCode', 'code', 'error', 'err', 'reason'];
const firstOf = (object, keys) => { for (const key of keys) { const value = key.includes('.') ? key.split('.').reduce((at, part) => at?.[part], object) : object[key]; if (value !== undefined && value !== null && value !== '') return value; } return undefined; };
const short = value => String(typeof value === 'object' ? JSON.stringify(value) : value).split('\n')[0].slice(0, 300);

function fromStructured(fields, fallback) {
  const message = firstOf(fields, MSG_KEYS);
  const extras = [];
  for (const key of EXTRA_KEYS) { const value = fields[key]; if (value !== undefined && value !== null && value !== '' && typeof value !== 'object') extras.push(`${key}=${short(value)}`); }
  return {
    level: normalizeLevel(firstOf(fields, LEVEL_KEYS)),
    ts: parseTime(firstOf(fields, TIME_KEYS)),
    message: [message === undefined ? fallback : short(message), ...extras].join(' '),
  };
}

const LOGFMT_RE = /([A-Za-z_@][\w.@-]*)=("(?:[^"\\]|\\.)*"|\S*)/g;
function logfmt(text) {
  const fields = {}; let m; LOGFMT_RE.lastIndex = 0;
  while ((m = LOGFMT_RE.exec(text))) fields[m[1]] = m[2][0] === '"' ? m[2].slice(1, -1).replace(/\\(.)/g, '$1') : m[2];
  return fields;
}

// The level a single word names: INFO, WARN:, [error], <debug>, level=info. Bare words must be upper case, so
// a message that starts with "Info about" keeps its first word.
function levelWord(token) {
  const first = token.charCodeAt(0);
  if (first >= 65 && first <= 90) return LEVEL_WORDS[token.charCodeAt(token.length - 1) === 58 ? token.slice(0, -1) : token] || '';
  if (first === 91 || first === 60 || first === 40) { const m = /^[[<(](\w+)[\]>)]:?$/.exec(token); return m ? normalizeLevel(m[1]) : ''; }
  if (first === 108 && token.startsWith('level=')) return normalizeLevel(token.slice(6));
  return '';
}

// One line of the dock (with or without its newline and [pod/container] prefix) as
// { pod, container, ts (ms, NaN when the line has none), level ('' when unknown), message }.
export function parseLine(raw) {
  let text = raw.length > 4000 ? raw.slice(0, 4000) : raw;
  let end = text.length; while (end > 0 && (text.charCodeAt(end - 1) === 10 || text.charCodeAt(end - 1) === 13)) end--;
  if (end !== text.length) text = text.slice(0, end);
  let pod = ''; let container = '';
  if (text.charCodeAt(0) === 91) { const info = podOf(text); if (info) { pod = info.pod; container = info.container; text = text.slice(info.prefix + 1); } }
  let ts = NaN; let level = '';
  // Up to two timestamps: the one kubectl adds with --timestamps and the application's own.
  for (let i = 0; i < 2; i++) {
    const code = text.charCodeAt(0);
    if (!(code >= 48 && code <= 57) && code !== 91) break;
    const m = TS_RE.exec(text);
    if (!m) break;
    const t = utc(m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);
    if (Number.isNaN(ts)) ts = t;
    text = text.slice(m[0].length);
  }
  const klog = KLOG_LEVELS[text[0]] && KLOG_RE.exec(text);
  if (klog) {
    level = KLOG_LEVELS[klog[1]];
    if (Number.isNaN(ts)) { const year = new Date().getUTCFullYear(); ts = utc(year, klog[2], klog[3], klog[4], klog[5], klog[6], klog[7], 'Z'); }
    text = text.slice(klog[0].length);
  }
  const first = text.charCodeAt(0);
  if (first === 123 && text.charCodeAt(text.length - 1) === 125) {
    try {
      const fields = JSON.parse(text);
      if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
        const parsed = fromStructured(fields, text);
        return { pod, container, ts: Number.isNaN(ts) ? parsed.ts : ts, level: parsed.level || level, message: parsed.message };
      }
    } catch { /* Not JSON after all. */ }
  }
  if (!level && (text.startsWith('level=') || text.startsWith('time=') || text.startsWith('ts=') || text.startsWith('lvl=') || text.startsWith('t=')) && text.includes('msg=')) {
    const fields = logfmt(text);
    const parsed = fromStructured(fields, text);
    const extras = Object.entries(fields).filter(([key]) => ![...MSG_KEYS, ...LEVEL_KEYS, ...TIME_KEYS, ...EXTRA_KEYS].includes(key)).map(([key, value]) => `${key}=${value}`);
    return { pod, container, ts: Number.isNaN(ts) ? parsed.ts : ts, level: parsed.level, message: [parsed.message, ...extras].join(' ') };
  }
  if (!level) {
    // The level is one of the first few words: "INFO msg", "[warn] msg", "ERROR: msg", "app - INFO - msg".
    let at = 0;
    for (let word = 0; word < 4 && at < text.length; word++) {
      while (text.charCodeAt(at) === 32 || text.charCodeAt(at) === 9) at++;
      let stop = text.indexOf(' ', at); if (stop < 0) stop = text.length;
      const found = stop - at <= 16 ? levelWord(text.slice(at, stop)) : '';
      if (found) {
        level = found;
        let rest = stop; while (text.charCodeAt(rest) === 32) rest++;
        if ((text[rest] === '-' || text[rest] === '|' || text[rest] === ':') && text.charCodeAt(rest + 1) === 32) { rest++; while (text.charCodeAt(rest) === 32) rest++; }
        text = text.slice(rest);
        break;
      }
      const single = stop - at === 1 && (text[at] === '-' || text[at] === '|');
      if (!single && word >= 2) break;
      at = stop;
    }
  }
  return { pod, container, ts, level, message: text };
}

// ---- masking and tokens --------------------------------------------------------------------------------
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE']);
const STATUS_RE = /^[1-5]\d\d$/;
const STATUS_FIELD_RE = /^"?(?:status|code|status_code|statusCode|http_status|http\.status_code)"?[=:]"?([1-5]\d\d)"?,?$/;
const QUOTED_RE = /"(?:[^"\\\n]|\\.){0,400}"|(?<![\w'])'[^'\n]{0,400}'(?![\w'])/g;
const DIGIT_RE = /\d/;
const POD_HASH_RE = /(?<![A-Za-z0-9-])([a-z][a-z0-9]*(?:-[a-z0-9]+)*?)-(?=[a-f0-9]{0,9}\d)[a-f0-9]{6,10}-[a-z0-9]{5}(?![A-Za-z0-9-])/g;
const MASK_RE = new RegExp([
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', // UUID
  '(?<![\\w.])\\d{1,3}(?:\\.\\d{1,3}){3}(?::\\d{1,5})?(?![\\w.])', // IPv4[:port]
  '\\[?[0-9a-fA-F]{0,4}(?::[0-9a-fA-F]{0,4}){2,7}\\]?:\\d{1,5}(?!\\w)', // [IPv6]:port
  '\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{2}:\\d{2}(?::\\d{2}(?:[.,]\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})?)?', // dates
  '(?<!\\w)\\d{1,2}:\\d{2}(?::\\d{2}(?:[.,]\\d+)?)?(?!\\w)', // times of day
  '(?<![A-Za-z0-9])0x[0-9a-fA-F]+(?![A-Za-z0-9])', // 0x-prefixed hex
  '(?<![A-Za-z0-9])(?=[0-9a-fA-F]*[0-9])(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{6,}(?![A-Za-z0-9])', // hex ids, trace ids, digests
  '(?<![A-Za-z0-9_])(?:\\d+(?:\\.\\d+)?(?:ns|us|µs|ms|s|m|h))+(?![A-Za-z0-9_])', // durations: 13ms, 1.5s, 1h2m3s
  '(?<![A-Za-z0-9_])\\d+(?:[.,]\\d+)*(?:%|[kKMGTP]i?B|[kKMGT]|B|b|bytes)?(?![A-Za-z0-9_])', // numbers and sizes
].join('|'), 'g');
const COLLAPSE_RE = /(?:<\*>[.:/-]?){2,}/g;
const collapse = text => text.replace(COLLAPSE_RE, match => (/[.:/-]$/.test(match) ? `${WILDCARD}${match[match.length - 1]}` : WILDCARD));

// Ids made of hex letters only ("fbcadeef") have no digit; long enough, they are ids all the same.
const LETTER_HEX_TEST = /(?<![A-Za-z0-9])[0-9a-f]{8,}(?![A-Za-z0-9])/;
const LETTER_HEX_RE = new RegExp(LETTER_HEX_TEST.source, 'g');
// The shapes most values take, checked before the full expression.
const SIMPLE_VALUE_RE = /^(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h)?|(?=[0-9a-f]*\d)[0-9a-f]{6,}|\d+(?:\.\d+)?%?)$/;
function maskValue(value) {
  if (SIMPLE_VALUE_RE.test(value)) return WILDCARD;
  let out = value;
  if (out.includes('-')) out = out.replace(POD_HASH_RE, `$1-${WILDCARD}`);
  out = out.replace(MASK_RE, WILDCARD);
  return out.includes(WILDCARD + WILDCARD) || /<\*>[.:/-]<\*>/.test(out) ? collapse(out) : out;
}
export function maskToken(token) {
  if (!DIGIT_RE.test(token)) return token.length >= 8 && LETTER_HEX_TEST.test(token) ? token.replace(LETTER_HEX_RE, WILDCARD) : token;
  // key=value: mask the value alone when the key is a plain word.
  const eq = token.indexOf('=');
  if (eq > 0 && eq < token.length - 1 && !DIGIT_RE.test(token.slice(0, eq))) return token.slice(0, eq + 1) + maskValue(token.slice(eq + 1));
  return maskValue(token);
}

// The part of a request path that names the route: its first segment, or two for /api/..., /v1/... and the
// like. GET /healthz and GET /api/orders/<*> are never folded together; /products/a and /products/b may be.
const ROUTE_PREFIX_RE = /^(?:api|apis|v\d+|rest|internal|admin|public|auth|graphql)$/i;
function routeOf(path) {
  let end = path.length;
  for (let i = 1; i < path.length; i++) { const c = path.charCodeAt(i); if (c === 63 || c === 35) { end = i; break; } }
  const cut = path.indexOf('/', 1);
  const firstEnd = cut < 0 || cut > end ? end : cut;
  const first = path.slice(1, firstEnd);
  if (!first || first.includes(WILDCARD)) return '';
  if (firstEnd === end || !ROUTE_PREFIX_RE.test(first)) return `/${first}`;
  let secondEnd = path.indexOf('/', firstEnd + 1); if (secondEnd < 0 || secondEnd > end) secondEnd = end;
  const second = path.slice(firstEnd + 1, secondEnd);
  return second && !second.includes(WILDCARD) ? `/${first}/${second}` : `/${first}`;
}

// The tokens of a message with variables masked, and the pinned tokens (HTTP status codes) as "index:value".
export function tokenize(message, maxTokens = 64) {
  let text = message;
  if (text.includes('"') || text.includes('\'')) {
    text = text.replace(QUOTED_RE, quoted => (quoted[0] === '"' && /^"[A-Z]+ \//.test(quoted) ? quoted.slice(1, -1) : `${quoted[0]}${WILDCARD}${quoted[0]}`));
  }
  const raw = (text.includes('\t') ? text.replace(/\t/g, ' ') : text).split(' ');
  const tokens = []; let pinned = ''; let previous = '';
  for (let i = 0; i < raw.length && tokens.length < maxTokens; i++) {
    const token = raw[i];
    if (!token) continue;
    const after = previous; previous = token;
    if (token.charCodeAt(0) === 47 && HTTP_METHODS.has(after)) {
      // The path of a request: masked like any token, and its route root pinned.
      const masked = maskToken(token); const route = routeOf(masked);
      if (route) pinned += `${tokens.length}:${route} `;
      tokens.push(masked); continue;
    }
    if (!DIGIT_RE.test(token)) { tokens.push(token.length >= 8 && LETTER_HEX_TEST.test(token) ? token.replace(LETTER_HEX_RE, WILDCARD) : token); continue; }
    if (token.length === 3 && STATUS_RE.test(token) && (HTTP_METHODS.has(after) || after[0] === '/' || after.endsWith('"') || /^HTTP\/\d/.test(after))) { pinned += `${tokens.length}:${token} `; tokens.push(token); continue; }
    if (token.length <= 24 && (token.includes('=') || token.includes(':')) && STATUS_FIELD_RE.test(token)) { pinned += `${tokens.length}:${token} `; tokens.push(token); continue; }
    tokens.push(maskToken(token));
  }
  return { tokens, pinned };
}

// ---- the miner -----------------------------------------------------------------------------------------
export const DEFAULTS = {
  depth: 2, // prefix tokens the tree branches on (after level and length)
  similarity: 0.5, // share of equal tokens needed to join a pattern
  maxChildren: 64, // per tree node; further distinct tokens share the <*> branch
  maxPatterns: 1000, // older patterns are dropped beyond this
  maxTokens: 64,
  bucketMs: 10000, // histogram resolution
  buckets: 360, // histogram length (one hour at 10 s)
  maxPods: 64,
  exampleLength: 500,
};

// A template token covers a token when it is <*>, or key=<*> and the token has the same key.
const KEYED = `=${WILDCARD}`;
const isPath = token => token.charCodeAt(0) === 47 && token.length > 1;
function pathCovers(template, token) {
  if (!isPath(token)) return false;
  const a = template.split('/'); const b = token.split('/');
  if (a.length === b.length) { for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && a[i] !== WILDCARD) return false; return true; }
  return a[a.length - 1] === WILDCARD && b.length > a.length && a.slice(0, -1).every((part, i) => part === b[i]);
}
// A template token covers a token when it is <*>, key=<*> with the same key, or a path whose differing
// segments are <*>.
const covers = (template, token) => template === WILDCARD || (template.endsWith(KEYED) && token.startsWith(template.slice(0, -WILDCARD.length)))
  || (isPath(template) && template.includes(WILDCARD) && pathCovers(template, token));
// Two different tokens folded into one: key=<*> when they share a key, paths segment by segment, <*> otherwise.
function generalize(template, token) {
  if (template === WILDCARD) return template;
  if (isPath(template) && isPath(token)) {
    const a = template.split('/'); const b = token.split('/');
    if (a.length === b.length) return a.map((part, i) => (part === b[i] ? part : WILDCARD)).join('/');
    let common = 0; while (common < a.length && common < b.length && a[common] === b[common]) common++;
    return common > 1 ? `${a.slice(0, common).join('/')}/${WILDCARD}` : WILDCARD;
  }
  const eq = template.indexOf('=');
  return eq > 0 && eq < template.length - 1 && token.startsWith(template.slice(0, eq + 1)) ? template.slice(0, eq + 1) + WILDCARD : WILDCARD;
}

export function createMiner(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const groups = new Map(); // level|length|pinned -> tree node
  const byId = new Map();
  let nextId = 1; let total = 0; let start = Infinity; let clock = -Infinity; let evicted = 0;

  const node = () => ({ children: new Map(), clusters: null });
  const branchKey = token => (token.includes(WILDCARD) || DIGIT_RE.test(token) ? WILDCARD : token);

  function leafFor(level, tokens, pinned, create) {
    const key = `${level}|${tokens.length}|${pinned}`;
    let at = groups.get(key);
    if (!at) { if (!create) return null; at = node(); groups.set(key, at); }
    const depth = Math.min(config.depth, tokens.length);
    for (let i = 0; i < depth; i++) {
      let branch = branchKey(tokens[i]);
      let next = at.children.get(branch);
      if (!next && branch !== WILDCARD) { branch = WILDCARD; next = at.children.get(WILDCARD); }
      if (!next) {
        if (!create) return null;
        if (at.children.size >= config.maxChildren) branch = WILDCARD;
        next = at.children.get(branch);
        if (!next) { next = node(); at.children.set(branch, next); }
      }
      at = next;
    }
    if (!at.clusters) { if (!create) return null; at.clusters = []; }
    return at.clusters;
  }
  // Prefer the exact branch; fall back to <*> when the token was new once the node was full.
  function leafLookup(level, tokens, pinned) {
    const key = `${level}|${tokens.length}|${pinned}`;
    let at = groups.get(key);
    if (!at) return null;
    const depth = Math.min(config.depth, tokens.length);
    for (let i = 0; i < depth && at; i++) at = at.children.get(branchKey(tokens[i])) || at.children.get(WILDCARD);
    return at?.clusters || null;
  }

  // The closest template in a leaf: one the line fits (every literal token equal) wins, otherwise the one
  // with the most equal tokens, if that share reaches `similarity`. Ties go to the more general template.
  function best(clusters, tokens) {
    let found = null; let bestScore = -1; let bestParams = -1;
    for (const cluster of clusters) {
      const template = cluster.tokens; let equal = 0; let params = 0; let mismatch = 0;
      for (let i = 0; i < tokens.length; i++) {
        const t = template[i];
        if (t === tokens[i]) equal++; else if (covers(t, tokens[i])) params++; else mismatch++;
      }
      const share = equal / tokens.length;
      const score = mismatch === 0 && equal > 0 ? 2 + share : share >= config.similarity ? share : -1;
      if (score > bestScore || (score === bestScore && score >= 0 && params > bestParams)) { found = cluster; bestScore = score; bestParams = params; }
    }
    return bestScore >= 0 ? found : null;
  }

  function bucketAdd(cluster, ts) {
    const b = Math.floor(ts / config.bucketMs); const n = config.buckets; const hist = cluster.hist;
    if (cluster.lastBucket < 0) cluster.lastBucket = b;
    if (b > cluster.lastBucket) {
      for (let x = Math.max(cluster.lastBucket + 1, b - n + 1); x <= b; x++) hist[((x % n) + n) % n] = 0;
      cluster.lastBucket = b;
    } else if (b <= cluster.lastBucket - n) return;
    hist[((b % n) + n) % n]++;
  }

  function evict() {
    const all = [...byId.values()].sort((a, b) => a.lastSeen - b.lastSeen || a.count - b.count);
    const drop = Math.max(1, Math.ceil(config.maxPatterns / 10));
    for (const cluster of all.slice(0, drop)) {
      const index = cluster.leaf.indexOf(cluster);
      if (index >= 0) cluster.leaf.splice(index, 1);
      byId.delete(cluster.id); evicted++;
    }
  }

  // Adds one line; `now` is the time of lines that carry no timestamp. Returns the pattern it joined.
  function add(line, now = Date.now()) {
    const parsed = parseLine(line);
    let ts = parsed.ts;
    if (!(ts > 0) || ts > now + 3600000) ts = now;
    const { tokens, pinned } = tokenize(parsed.message, config.maxTokens);
    if (!tokens.length) tokens.push('');
    total++;
    if (ts < start) start = ts;
    if (ts > clock) clock = ts;
    const leaf = leafFor(parsed.level, tokens, pinned, true);
    let cluster = best(leaf, tokens);
    if (cluster) {
      const template = cluster.tokens; let changed = false;
      for (let i = 0; i < tokens.length; i++) {
        const t = template[i];
        if (t !== tokens[i] && !covers(t, tokens[i])) { template[i] = generalize(t, tokens[i]); changed = true; }
      }
      if (changed) cluster.text = null;
    } else {
      if (byId.size >= config.maxPatterns) evict();
      cluster = { id: nextId++, level: parsed.level, tokens: tokens.slice(), pinned, leaf, count: 0, firstSeen: ts, lastSeen: ts, pods: new Map(), hist: new Uint32Array(config.buckets), lastBucket: -1, example: '', text: null };
      leaf.push(cluster); byId.set(cluster.id, cluster);
    }
    cluster.count++;
    if (ts < cluster.firstSeen) cluster.firstSeen = ts;
    if (ts >= cluster.lastSeen) { cluster.lastSeen = ts; cluster.example = parsed.message.length > config.exampleLength ? `${parsed.message.slice(0, config.exampleLength)}…` : parsed.message; }
    if (parsed.pod && (cluster.pods.has(parsed.pod) || cluster.pods.size < config.maxPods)) cluster.pods.set(parsed.pod, (cluster.pods.get(parsed.pod) || 0) + 1);
    bucketAdd(cluster, ts);
    return cluster;
  }

  // The id of the pattern a line belongs to, without counting it; 0 when none fits.
  function match(line) {
    const parsed = parseLine(line);
    const { tokens, pinned } = tokenize(parsed.message, config.maxTokens);
    if (!tokens.length) tokens.push('');
    const leaf = leafLookup(parsed.level, tokens, pinned);
    return (leaf && best(leaf, tokens)?.id) || 0;
  }

  function reset() { groups.clear(); byId.clear(); total = 0; start = Infinity; clock = -Infinity; evicted = 0; }

  return {
    config, add, match, reset,
    get: id => byId.get(id) || null,
    patterns: () => [...byId.values()],
    get total() { return total; }, get start() { return start; }, get clock() { return clock; }, get evicted() { return evicted; }, get size() { return byId.size; },
  };
}

export const templateText = cluster => cluster.text || (cluster.text = cluster.tokens.join(' '));

// ---- analysis ------------------------------------------------------------------------------------------
// "Now" for a stream: the wall clock while the lines are recent, the newest line's time for old logs (a
// previous container, a capture from yesterday) so that new and spiking still mean something there.
export function streamNow(miner, wall = Date.now()) {
  const clock = miner.clock;
  if (!Number.isFinite(clock)) return wall;
  return wall - clock < 3600000 && clock - wall < 120000 ? Math.max(wall, clock) : clock;
}

function countAt(cluster, b, n) {
  if (b > cluster.lastBucket || b <= cluster.lastBucket - n || b < 0) return 0;
  return cluster.hist[b % n];
}
function windowSum(cluster, endBucket, width, n) {
  let sum = 0;
  for (let b = endBucket - width + 1; b <= endBucket; b++) sum += countAt(cluster, b, n);
  return sum;
}

export const ANALYSIS = {
  warmupMs: 120000, // nothing is new or spiking before the stream covers two minutes
  newWindowMs: 300000, // a pattern first seen in the last five minutes is new
  windowMs: 60000, // spikes compare the last minute ...
  baselineWindows: 15, // ... with up to fifteen minutes before it
  alpha: 0.3, // EWMA weight of the newest baseline minute
  minCount: 10, // a spike needs at least this many lines in the last minute
  ratio: 4, // ... and this many times the baseline rate
  sigmas: 3, // ... and this many deviations above it
  points: 30, // sparkline points
};

// The spike of one pattern at `now`, or null: the count of the last window against an EWMA mean and variance
// of the windows before it (only windows the stream covers count).
export function spikeOf(cluster, miner, now, options = {}) {
  const o = { ...ANALYSIS, ...options };
  const n = miner.config.buckets; const bucketMs = miner.config.bucketMs;
  const width = Math.max(1, Math.round(o.windowMs / bucketMs));
  const nowBucket = Math.floor(now / bucketMs);
  const startBucket = Math.floor(miner.start / bucketMs);
  if (!(now - miner.start >= o.warmupMs)) return null;
  const count = windowSum(cluster, nowBucket, width, n);
  if (count < o.minCount) return null;
  const windows = [];
  for (let w = 1; w <= o.baselineWindows; w++) {
    const end = nowBucket - w * width;
    // Only windows the stream covers completely: one that began before the first line would look quiet
    // and make anything after it a spike.
    if (end - width + 1 <= startBucket || end - width + 1 <= nowBucket - n) break;
    windows.push(windowSum(cluster, end, width, n));
  }
  if (!windows.length) return null;
  let mean = windows[windows.length - 1]; let variance = 0;
  for (let i = windows.length - 2; i >= 0; i--) {
    const diff = windows[i] - mean; const inc = o.alpha * diff;
    mean += inc; variance = (1 - o.alpha) * (variance + diff * inc);
  }
  const threshold = Math.max(o.minCount, o.ratio * mean, mean + o.sigmas * Math.sqrt(variance));
  return count >= threshold ? { count, baseline: mean, factor: mean > 0 ? count / mean : Infinity } : null;
}

// The histogram as `points` values covering the stream (at most the ring), oldest first.
export function seriesOf(cluster, miner, now, points = ANALYSIS.points) {
  const n = miner.config.buckets; const bucketMs = miner.config.bucketMs;
  const nowBucket = Math.floor(now / bucketMs);
  const span = Math.min(n, Math.max(points, nowBucket - Math.floor(miner.start / bucketMs) + 1));
  const per = Math.ceil(span / points);
  const out = new Array(points).fill(0);
  for (let p = 0; p < points; p++) out[p] = windowSum(cluster, nowBucket - (points - 1 - p) * per, per, n);
  return { values: out, bucketMs: per * bucketMs };
}

// Everything the view needs, one row per pattern: sorted by count (or 'newest' / 'severity').
export function summarize(miner, { now = streamNow(miner), sort = 'count', ...options } = {}) {
  const o = { ...ANALYSIS, ...options };
  const warm = now - miner.start >= o.warmupMs;
  const total = miner.total || 1;
  const rows = miner.patterns().map(cluster => ({
    id: cluster.id,
    template: templateText(cluster),
    level: cluster.level,
    count: cluster.count,
    share: cluster.count / total,
    firstSeen: cluster.firstSeen,
    lastSeen: cluster.lastSeen,
    pods: [...cluster.pods.entries()].sort((a, b) => b[1] - a[1]),
    example: cluster.example,
    isNew: warm && cluster.firstSeen - miner.start >= o.warmupMs && now - cluster.firstSeen <= o.newWindowMs,
    spike: spikeOf(cluster, miner, now, o),
    series: seriesOf(cluster, miner, now, o.points),
  }));
  const comparators = {
    count: (a, b) => b.count - a.count || a.id - b.id,
    newest: (a, b) => b.firstSeen - a.firstSeen || b.count - a.count,
    severity: (a, b) => levelRank(a.level) - levelRank(b.level) || b.count - a.count,
  };
  rows.sort(comparators[sort] || comparators.count);
  const spikes = rows.filter(row => row.spike).sort((a, b) => b.spike.count - a.spike.count);
  return { rows, spikes, total: miner.total, now, warm, evicted: miner.evicted };
}

// The template split into literal text and masked parts, for drawing: [{ text, masked }].
export function templateParts(template) {
  const parts = []; let at = 0;
  for (let index = template.indexOf(WILDCARD); index >= 0; index = template.indexOf(WILDCARD, at)) {
    if (index > at) parts.push({ text: template.slice(at, index), masked: false });
    parts.push({ text: WILDCARD, masked: true });
    at = index + WILDCARD.length;
  }
  if (at < template.length) parts.push({ text: template.slice(at), masked: false });
  return parts;
}
