// Theme preference: 'system' | 'light' | 'dark'. The resolved theme drives CSS tokens (data-theme), the terminal and charts.
export const THEMES = ['system', 'light', 'dark'];
export const resolveTheme = (preference, prefersDark) => preference === 'light' ? 'light' : preference === 'dark' ? 'dark' : prefersDark ? 'dark' : 'light';
const listeners = new Set();
const darkQuery = () => typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
let preference = 'system';
let attached = false;

export const currentTheme = () => resolveTheme(preference, Boolean(darkQuery()?.matches));
export const onThemeChange = listener => { listeners.add(listener); return () => listeners.delete(listener); };
const notify = () => { for (const listener of listeners) listener(currentTheme()); };

export function applyTheme(value) {
  preference = THEMES.includes(value) ? value : 'system';
  if (typeof document !== 'undefined') {
    if (preference === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = preference;
  }
  try { localStorage.setItem('rubban.theme', preference); } catch { /* Per-window convenience only. */ }
  try { window.rubbanDesktop?.setTheme?.(preference); } catch { /* Not in the desktop app. */ }
  const query = darkQuery();
  if (query && !attached) { attached = true; query.addEventListener('change', () => { if (preference === 'system') notify(); }); }
  notify();
}
export const storedTheme = () => { try { return localStorage.getItem('rubban.theme') || 'system'; } catch { return 'system'; } };
