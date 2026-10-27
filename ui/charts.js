// Small dependency-free SVG charts for metrics: line/area series, usage meters and donuts.
const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => { const node = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v); return node; };
const PALETTE = ['#3d90ce', '#4caf50', '#ff9800', '#c93dce', '#e85555', '#26a69a'];

function niceMax(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  const n = value / exp;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * exp;
}

// series: [{ name, values: [[unixSeconds, number], ...], color?, dashed? }]
// The SVG is redrawn at the container's pixel width so text and lines are never stretched.
export function lineChart(series, { format = v => String(v), height = 150, title = '', empty = 'No data in this time range' } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'chart';
  if (title) { const h = document.createElement('div'); h.className = 'chart-title'; h.textContent = title; wrap.append(h); }
  const points = series.flatMap(s => s.values).filter(p => Number.isFinite(p[1]));
  if (!points.length) { const note = document.createElement('div'); note.className = 'chart-empty'; note.textContent = empty; wrap.append(note); return wrap; }
  const xs = points.map(p => p[0]); const minX = Math.min(...xs); const maxX = Math.max(...xs) > minX ? Math.max(...xs) : minX + 1;
  const maxY = niceMax(Math.max(...points.map(p => p[1]), 0));
  const pad = { l: 56, r: 10, t: 8, b: 20 };
  const box = document.createElement('div'); box.className = 'chart-box';
  const tip = document.createElement('div'); tip.className = 'chart-tip hidden';
  let svg = null; let width = 0; let cursor = null;
  const x = t => pad.l + ((t - minX) / (maxX - minX)) * (width - pad.l - pad.r);
  const y = v => pad.t + (1 - v / maxY) * (height - pad.t - pad.b);
  const spanSeconds = maxX - minX;
  const timeLabel = t => { const d = new Date(t * 1000); return spanSeconds > 2 * 86400 ? d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
  function draw(nextWidth) {
    width = Math.max(240, Math.round(nextWidth));
    const next = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'chart-svg', role: 'img', 'aria-label': title || 'Metric chart' });
    for (let i = 0; i <= 4; i++) {
      const value = (maxY * i) / 4; const py = y(value);
      next.append(svgEl('line', { x1: pad.l, x2: width - pad.r, y1: py, y2: py, class: 'chart-grid' }));
      const label = svgEl('text', { x: pad.l - 6, y: py + 3, class: 'chart-axis', 'text-anchor': 'end' }); label.textContent = format(value); next.append(label);
    }
    const ticks = width > 480 ? 5 : 3;
    for (let i = 0; i < ticks; i++) {
      const t = minX + ((maxX - minX) * i) / (ticks - 1);
      const label = svgEl('text', { x: x(t), y: height - 5, class: 'chart-axis', 'text-anchor': i === 0 ? 'start' : i === ticks - 1 ? 'end' : 'middle' });
      label.textContent = timeLabel(t); next.append(label);
    }
    series.forEach((s, index) => {
      const color = s.color || PALETTE[index % PALETTE.length];
      const values = s.values.filter(p => Number.isFinite(p[1]));
      if (!values.length) return;
      const line = values.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
      if (!s.dashed && index === 0) next.append(svgEl('path', { d: `${line}L${x(values.at(-1)[0]).toFixed(1)},${y(0)}L${x(values[0][0]).toFixed(1)},${y(0)}Z`, fill: color, 'fill-opacity': '.12', stroke: 'none' }));
      next.append(svgEl('path', { d: line, fill: 'none', stroke: color, 'stroke-width': '1.6', 'stroke-dasharray': s.dashed ? '4 3' : '', 'stroke-linejoin': 'round' }));
    });
    cursor = svgEl('line', { y1: pad.t, y2: height - pad.b, class: 'chart-cursor', visibility: 'hidden' });
    next.append(cursor);
    if (svg) svg.replaceWith(next); else box.prepend(next);
    svg = next;
  }
  draw(600);
  box.append(tip);
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(entries => { const w = entries[0]?.contentRect?.width; if (w && Math.abs(w - width) > 4) draw(w); });
    observer.observe(box);
  }
  const legend = document.createElement('div'); legend.className = 'chart-legend';
  series.forEach((s, index) => {
    const item = document.createElement('span');
    const swatch = document.createElement('i'); swatch.style.background = s.color || PALETTE[index % PALETTE.length]; if (s.dashed) { swatch.className = 'dashed'; swatch.style.color = s.color || PALETTE[index % PALETTE.length]; }
    const last = [...s.values].reverse().find(p => Number.isFinite(p[1]));
    item.append(swatch, document.createTextNode(`${s.name}${last ? ` · ${format(last[1])}` : ''}`));
    legend.append(item);
  });
  box.addEventListener('mousemove', event => {
    const rect = svg.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * width;
    const t = minX + ((px - pad.l) / (width - pad.l - pad.r)) * (maxX - minX);
    if (t < minX || t > maxX) { cursor.setAttribute('visibility', 'hidden'); tip.classList.add('hidden'); return; }
    cursor.setAttribute('x1', px); cursor.setAttribute('x2', px); cursor.setAttribute('visibility', 'visible');
    const rows = series.map(s => { let best = null; for (const p of s.values) if (Number.isFinite(p[1]) && (!best || Math.abs(p[0] - t) < Math.abs(best[0] - t))) best = p; return best ? `${s.name}: ${format(best[1])}` : ''; }).filter(Boolean);
    tip.textContent = `${new Date(t * 1000).toLocaleString()}\n${rows.join('\n')}`;
    tip.classList.remove('hidden');
    tip.style.left = `${Math.min(rect.width - 190, Math.max(0, event.clientX - rect.left + 12))}px`;
  });
  box.addEventListener('mouseleave', () => { cursor.setAttribute('visibility', 'hidden'); tip.classList.add('hidden'); });
  wrap.append(box, legend);
  return wrap;
}

// Horizontal meter: used vs total, with optional request/limit markers.
export function meter({ used, total, request, limit, label = '', detail = '' }) {
  const wrap = document.createElement('div'); wrap.className = 'meter';
  const pct = v => (Number.isFinite(v) && total > 0 ? Math.max(0, Math.min(100, (v / total) * 100)) : null);
  const head = document.createElement('div'); head.className = 'meter-head';
  const l = document.createElement('span'); l.textContent = label;
  const d = document.createElement('span'); d.className = 'meter-detail'; d.textContent = detail;
  head.append(l, d);
  const bar = document.createElement('div'); bar.className = 'meter-bar';
  const fill = document.createElement('div'); fill.className = 'meter-fill';
  const usedPct = pct(used);
  if (usedPct !== null) { fill.style.width = `${usedPct}%`; fill.dataset.level = usedPct >= 90 ? 'bad' : usedPct >= 75 ? 'warn' : 'good'; }
  bar.append(fill);
  for (const [value, kind] of [[request, 'request'], [limit, 'limit']]) {
    const p = pct(value); if (p === null) continue;
    const mark = document.createElement('i'); mark.className = `meter-mark ${kind}`; mark.style.left = `${p}%`; mark.title = kind; bar.append(mark);
  }
  wrap.append(head, bar);
  return wrap;
}
