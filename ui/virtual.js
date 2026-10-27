// Windowed rendering for long tables: which rows to put in the DOM for the part of the list that
// is on screen. Pure functions so they can be tested without a browser.

// Rows [start, end) covering the visible span (offset/height in pixels from the top of the list)
// plus `overscan` rows on each side. When nothing is visible (the list is hidden, detached or
// scrolled out of view) the nearest edge of the list is returned so there is always content.
export function windowRange({ count, rowHeight, offset, height, overscan = 10 }) {
  if (!(count > 0)) return [0, 0];
  const size = rowHeight > 0 ? rowHeight : 32;
  const first = Math.floor(offset / size);
  const last = Math.ceil((offset + Math.max(0, height)) / size);
  if (last <= 0) return [0, Math.min(count, Math.max(1, overscan * 2))];
  if (first >= count) return [Math.max(0, count - Math.max(1, overscan * 2)), count];
  return [Math.max(0, first - overscan), Math.min(count, last + overscan)];
}

// True when the rendered rows already include every visible row, so a scroll needs no work.
export function covers(rendered, visible) {
  const [start, end] = rendered; const [visibleStart, visibleEnd] = visible;
  return start <= visibleStart && visibleEnd <= end;
}
