// Pure helpers of the log dock: the [pod/container] prefix the server puts on selector logs, include and
// exclude filters (plain text or /regex/), stable colours per pod and line splitting.

const PREFIX = /^\[([^\]/\s]+)\/([^\]\s]+)\] /;

// { pod, container, prefix } for a prefixed line, null otherwise.
export function podOf(line) {
  const m = PREFIX.exec(line);
  return m ? { pod: m[1], container: m[2], prefix: m[0].length - 1 } : null;
}

// A matcher for a filter box: '' matches nothing special (null), /re/flags is a regular expression, anything
// else is a case-insensitive substring. An invalid expression gives { error }.
export function parseFilter(text) {
  const source = text.trim();
  if (!source) return null;
  const m = /^\/(.+)\/([a-z]*)$/.exec(source);
  if (m) {
    try { const re = new RegExp(m[1], m[2].replace(/[gy]/g, '')); return { test: line => re.test(line) }; } catch (error) { return { error: error.message }; }
  }
  const needle = source.toLowerCase();
  return { test: line => line.toLowerCase().includes(needle) };
}

// Whether a line is shown. include/exclude are parseFilter results (null or with an error: ignored), hidden
// is the set of pods switched off in the legend.
export function passes(line, { include = null, exclude = null, hidden = null } = {}) {
  if (hidden?.size) { const info = podOf(line); if (info && hidden.has(info.pod)) return false; }
  if (include?.test && !include.test(line)) return false;
  if (exclude?.test && exclude.test(line)) return false;
  return true;
}

// One colour slot per pod, handed out in order of appearance and never changed: 0..size-1, then around.
export function createPodColors(size = 8) {
  const slots = new Map();
  return { indexOf(pod) { if (!slots.has(pod)) slots.set(pod, slots.size % size); return slots.get(pod); }, known: () => [...slots.keys()] };
}

// Splits a chunk of output into complete lines (each keeps its newline) and the unfinished rest.
export function splitLines(rest, chunk) {
  const text = rest + chunk;
  const cut = text.lastIndexOf('\n') + 1;
  return { lines: cut ? text.slice(0, cut).match(/[^\n]*\n/g) : [], rest: text.slice(cut) };
}

// The text of the lines that pass, and the offset of every pod prefix inside it: [{ pod, start, end }].
export function renderLines(lines, options) {
  let text = ''; const marks = [];
  for (const line of lines) {
    if (!passes(line, options)) continue;
    const info = podOf(line);
    if (info) marks.push({ pod: info.pod, start: text.length, end: text.length + info.prefix });
    text += line;
  }
  return { text, marks };
}

// The sentence for the status line from the pods the server reported.
export function podsStatus(pods) {
  if (!pods?.length) return 'Waiting for pods…';
  const running = pods.filter(pod => pod.phase === 'Running').length;
  return `${pods.length} pod${pods.length === 1 ? '' : 's'}${running === pods.length ? '' : ` · ${running} running`}`;
}

// Containers across pods, in first-seen order.
export const containersOfPods = pods => [...new Set((pods || []).flatMap(pod => pod.containers || []))];
