// Small Markdown renderer for chart READMEs. Builds DOM nodes directly (no innerHTML), so
// raw HTML in a README is shown as text. Supports headings, paragraphs, lists, code, tables,
// quotes, rules, links (opened externally), images as links, bold, italic and inline code.
const node = (tag, className, children = []) => { const n = document.createElement(tag); if (className) n.className = className; for (const c of [].concat(children)) if (c !== null && c !== undefined) n.append(c); return n; };

function inline(text) {
  const out = [];
  const pattern = /(`+)([^`]+?)\1|!\[([^\]]*)\]\(([^)\s]+)[^)]*\)|\[([^\]]+)\]\(([^)\s]+)[^)]*\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|<(https?:\/\/[^>\s]+)>/g;
  let last = 0; let match;
  while ((match = pattern.exec(text))) {
    if (match.index > last) out.push(text.slice(last, match.index));
    if (match[2] !== undefined) out.push(node('code', '', match[2]));
    else if (match[4] !== undefined) out.push(link(match[3] || 'image', match[4]));
    else if (match[6] !== undefined) out.push(link(match[5], match[6]));
    else if (match[7] !== undefined || match[8] !== undefined) out.push(node('strong', '', inline(match[7] ?? match[8])));
    else if (match[9] !== undefined || match[10] !== undefined) out.push(node('em', '', inline(match[9] ?? match[10])));
    else if (match[11] !== undefined) out.push(link(match[11], match[11]));
    last = pattern.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
function link(label, href) {
  const a = node('a', 'link', label);
  a.href = '#';
  a.title = href;
  a.addEventListener('click', event => {
    event.preventDefault();
    if (!/^https?:\/\//.test(href)) return;
    if (window.rubbanDesktop?.openExternal) window.rubbanDesktop.openExternal(href).catch(() => {}); else window.open(href, '_blank', 'noopener');
  });
  return a;
}
const splitRow = line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());

export function renderMarkdown(source) {
  const root = node('div', 'markdown');
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^\s*(```|~~~)\s*([\w-]*)/.exec(line);
    if (fence) {
      const body = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      root.append(node('pre', 'output code', node('code', '', body.join('\n'))));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) { root.append(node(`h${Math.min(6, heading[1].length + 1)}`, '', inline(heading[2]))); i++; continue; }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { root.append(node('hr')); i++; continue; }
    if (/^\s*>/.test(line)) { const body = []; while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, '')); const inner = renderMarkdown(body.join('\n')); root.append(node('blockquote', '', [...inner.childNodes])); continue; }
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const head = splitRow(line); i += 2;
      const rows = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) rows.push(splitRow(lines[i++]));
      root.append(node('div', 'mini-table-wrap', node('table', 'mini-table', [node('thead', '', node('tr', '', head.map(cell => node('th', '', inline(cell))))), node('tbody', '', rows.map(row => node('tr', '', head.map((_, c) => node('td', '', inline(row[c] || ''))))))])));
      continue;
    }
    const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
    if (listItem.test(line)) {
      const ordered = /\d/.test(listItem.exec(line)[2]);
      const list = node(ordered ? 'ol' : 'ul');
      while (i < lines.length && (listItem.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && list.lastChild))) {
        const m = listItem.exec(lines[i]);
        if (m) list.append(node('li', '', inline(m[3].replace(/^\[( |x)\]\s*/i, (all, mark) => (mark.trim() ? '☑ ' : '☐ ')))));
        else list.lastChild.append(' ', ...inline(lines[i].trim()));
        i++;
      }
      root.append(list);
      continue;
    }
    if (/^\s*</.test(line)) {
      // Raw HTML: keep any text content readable without interpreting markup.
      const body = []; while (i < lines.length && lines[i].trim()) body.push(lines[i++]);
      const text = body.join(' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text) root.append(node('p', 'muted', text));
      continue;
    }
    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*(```|~~~)|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[i])) paragraph.push(lines[i++].trim());
    if (!paragraph.length) { paragraph.push(lines[i++].trim()); }
    root.append(node('p', '', inline(paragraph.join(' '))));
  }
  return root;
}
