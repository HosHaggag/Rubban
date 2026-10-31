// Count of running port forwards for the sidebar badge. Pure apart from the injected timer, so it
// works on every page and is easy to test.
export const activeCount = items => items.filter(item => item.status === 'ready' || item.status === 'starting').length;

// Polls while any forward exists (a failing one still counts as present: it is being restarted).
export function createForwardsPoller({ fetchItems, onCount, interval = 15000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null; let count = -1;
  // Takes a list the caller already has (the Port Forwarding page polls on its own).
  function observe(items) {
    const next = activeCount(items);
    if (next !== count) { count = next; onCount(next); }
  }
  async function refresh() {
    clearTimer(timer); timer = null;
    let items = null;
    try { items = await fetchItems(); } catch { /* The next change or page visit tries again. */ }
    if (!items) return;
    observe(items);
    if (items.length) timer = setTimer(refresh, interval);
  }
  return { refresh, observe, get count() { return Math.max(count, 0); } };
}

// The status cell of the Port Forwarding page.
export function statusText(forward) {
  if (forward.status === 'ready') return forward.restarts ? `ready · restarted ${forward.restarts}×` : 'ready';
  if (forward.status === 'error') return `error: ${forward.lastError || forward.error || 'the forward stopped'}`;
  return forward.status === 'stopped' ? 'stopped' : forward.restarts ? `starting · restarted ${forward.restarts}×` : 'starting';
}
export const statusLevel = forward => (forward.status === 'ready' ? 'good' : forward.status === 'error' ? 'bad' : forward.status === 'stopped' ? '' : 'warn');
