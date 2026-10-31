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
