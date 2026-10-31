// Unified diffs: parsing kubectl diff output into typed lines, and drawing them. Parsing is pure;
// drawing creates DOM and is only called in the browser.

// Lines of a unified diff typed add / del / ctx / meta (file and hunk headers).
export function parseUnified(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  let inHunk = false;
  return lines.map(line => {
    if (line.startsWith('diff ')) { inHunk = false; return { kind: 'meta', text: line }; }
    if (!inHunk && (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file'))) return { kind: 'meta', text: line };
    if (line.startsWith('@@')) { inHunk = true; return { kind: 'meta', text: line }; }
    if (line.startsWith('+')) return { kind: 'add', text: line.slice(1) };
    if (line.startsWith('-')) return { kind: 'del', text: line.slice(1) };
    return { kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line };
  });
}

export const countKind = (lines, kind) => lines.filter(line => line.kind === kind).length;
// How many objects the diff touches (one `diff` header each).
export const fileCount = lines => lines.filter(line => line.kind === 'meta' && line.text.startsWith('diff ')).length;

const MARK = { add: '+', del: '-', ctx: ' ', meta: '' };

// <pre class="diff"> with one .diff-line per line; colours come from the .diff-add / .diff-del tokens.
export function renderUnified(lines) {
  const pre = document.createElement('pre');
  pre.className = 'diff';
  for (const line of lines) {
    const row = document.createElement('div');
    row.className = `diff-line diff-${line.kind}`;
    row.textContent = line.kind === 'meta' ? line.text : `${MARK[line.kind]}${line.text}`;
    pre.append(row);
  }
  return pre;
}

// ---- Comparing two texts line by line (side by side) -----------------------------------------------

// Past this many differing lines Myers' trace gets large; the middle is then shown as replaced.
const MAX_EDIT_DISTANCE = 3000;

// Edit script between a and b (arrays of lines): [{type:'eq',ai,bi} | {type:'del',ai} | {type:'add',bi}].
function myersOps(a, b) {
  const n = a.length; const m = b.length; const max = n + m;
  if (!max) return [];
  const v = new Int32Array(2 * max + 3); const off = max + 1;
  const trace = [];
  for (let d = 0; d <= max; d++) {
    if (d > MAX_EDIT_DISTANCE) break;
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  // Too different to trace: everything is replaced.
  return [...a.map((_, ai) => ({ type: 'del', ai })), ...b.map((_, bi) => ({ type: 'add', bi }))];
}

function backtrack(trace, n, m) {
  let x = n; let y = m; const ops = [];
  for (let d = trace.length - 1; d >= 0; d--) {
    const snap = trace[d]; const k = x - y;
    const at = kk => snap[kk + d + 1];
    const prevK = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
    const prevX = at(prevK); const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; ops.push({ type: 'eq', ai: x, bi: y }); }
    if (d > 0) { if (x === prevX) { y--; ops.push({ type: 'add', bi: y }); } else { x--; ops.push({ type: 'del', ai: x }); } }
  }
  return ops.reverse();
}

// Line diff of two arrays of lines: common head and tail are skipped, Myers' algorithm does the middle.
export function lineDiff(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length; let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ type: 'eq', ai: i, bi: i });
  for (const op of myersOps(a.slice(start, endA), b.slice(start, endB))) ops.push({ ...op, ...(op.ai !== undefined ? { ai: op.ai + start } : {}), ...(op.bi !== undefined ? { bi: op.bi + start } : {}) });
  for (let i = 0; i < a.length - endA; i++) ops.push({ type: 'eq', ai: endA + i, bi: endB + i });
  return ops;
}

const toLines = text => { const lines = String(text || '').replace(/\r\n/g, '\n').split('\n'); if (lines.at(-1) === '') lines.pop(); return lines; };

// Rows for two columns: eq (both sides), change (a removed and an added line side by side), del (left only)
// and add (right only). Each row carries its text and line numbers.
export function alignRows(left, right) {
  const a = toLines(left); const b = toLines(right);
  const rows = [];
  let dels = []; let adds = [];
  const flush = () => {
    const paired = Math.min(dels.length, adds.length);
    for (let i = 0; i < paired; i++) rows.push({ kind: 'change', left: a[dels[i]], right: b[adds[i]], leftNo: dels[i] + 1, rightNo: adds[i] + 1 });
    for (const ai of dels.slice(paired)) rows.push({ kind: 'del', left: a[ai], right: null, leftNo: ai + 1, rightNo: null });
    for (const bi of adds.slice(paired)) rows.push({ kind: 'add', left: null, right: b[bi], leftNo: null, rightNo: bi + 1 });
    dels = []; adds = [];
  };
  for (const op of lineDiff(a, b)) {
    if (op.type === 'del') dels.push(op.ai);
    else if (op.type === 'add') adds.push(op.bi);
    else { flush(); rows.push({ kind: 'eq', left: a[op.ai], right: b[op.bi], leftNo: op.ai + 1, rightNo: op.bi + 1 }); }
  }
  flush();
  return rows;
}

export const countDiffering = rows => rows.filter(row => row.kind !== 'eq').length;

// Keeps `context` unchanged lines around every change and folds the rest into { kind: 'skip', count }.
export function foldUnchanged(rows, context = 3) {
  const keep = new Array(rows.length).fill(false);
  rows.forEach((row, i) => { if (row.kind !== 'eq') for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) keep[j] = true; });
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    if (keep[i]) { out.push(rows[i]); continue; }
    let j = i; while (j < rows.length && !keep[j]) j++;
    out.push({ kind: 'skip', count: j - i }); i = j - 1;
  }
  return out;
}

// The keys of the changed lines: "image, replicas, env" (YAML `key:` at the start of a line or list item).
export function changedKeys(rows, limit = 6) {
  const keys = [];
  for (const row of rows) {
    if (row.kind === 'eq') continue;
    for (const text of [row.left, row.right]) {
      const m = /^\s*(?:-\s+)?([A-Za-z0-9_.\-/]+):/.exec(text || '');
      if (m && !keys.includes(m[1])) keys.push(m[1]);
    }
  }
  return keys.length > limit ? [...keys.slice(0, limit), `+${keys.length - limit} more`] : keys;
}

// One unified diff (left is "-", right is "+") for pasting into a ticket.
export function toUnified(rows, leftLabel, rightLabel) {
  const out = [`--- ${leftLabel}`, `+++ ${rightLabel}`];
  for (const row of rows) {
    if (row.kind === 'skip') { out.push(`@@ ${row.count} unchanged lines @@`); continue; }
    if (row.kind === 'eq') out.push(` ${row.left}`);
    else { if (row.left !== null) out.push(`-${row.left}`); if (row.right !== null) out.push(`+${row.right}`); }
  }
  return out.join('\n');
}

// Two aligned columns under their headings. Rows come from alignRows (optionally folded).
export function renderSideBySide(rows, { leftHead, rightHead } = {}) {
  const grid = document.createElement('div');
  grid.className = 'diff-sbs';
  const cell = (className, text, number, side) => {
    const node = document.createElement('div');
    node.className = `diff-cell ${side} ${className}`;
    const no = document.createElement('span'); no.className = 'diff-no'; no.textContent = number ?? '';
    const body = document.createElement('span'); body.className = 'diff-text'; body.textContent = text ?? '';
    node.append(no, body);
    return node;
  };
  const heading = node => { const head = document.createElement('div'); head.className = 'diff-head'; if (node) head.append(node); return head; };
  grid.append(heading(leftHead), heading(rightHead));
  for (const row of rows) {
    if (row.kind === 'skip') {
      const skip = document.createElement('div'); skip.className = 'diff-skip'; skip.textContent = `⋯ ${row.count} unchanged line${row.count === 1 ? '' : 's'}`;
      grid.append(skip);
      continue;
    }
    grid.append(
      cell(row.kind === 'eq' ? '' : row.left === null ? 'diff-gap' : 'diff-del', row.left, row.leftNo, 'diff-left'),
      cell(row.kind === 'eq' ? '' : row.right === null ? 'diff-gap' : 'diff-add', row.right, row.rightNo, 'diff-right'));
  }
  return grid;
}
