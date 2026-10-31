// Credential health per cluster context. Pure (no DOM): the server reports it in /api/contexts, and
// failed requests or watches mark a context expired as they happen. app.js draws the banner and the
// marks from these helpers.
const book = new Map(); // context -> { status: 'unknown'|'ok'|'expired', message, plugin, remedy }
const dismissed = new Set(); // expired contexts whose banner the user closed

export const GENERIC_REMEDY = { preset: '', label: 'Sign in with your identity provider, then retry' };

// Replaces what is known with the auth blocks of a /api/contexts answer.
export function load(contexts) {
  for (const context of contexts || []) {
    const auth = context.auth || {};
    const was = book.get(context.name);
    // The browser can know more than the last answer (a watch just failed): never downgrade expired.
    if (was?.status === 'expired' && auth.status === 'unknown') { book.set(context.name, { ...was, remedy: auth.remedy || was.remedy }); continue; }
    book.set(context.name, { status: auth.status || 'unknown', message: auth.message || '', plugin: auth.plugin || '', remedy: auth.remedy || GENERIC_REMEDY });
    if (auth.status !== 'expired') dismissed.delete(context.name);
  }
}

export const authOf = context => book.get(context) || { status: 'unknown', message: '', plugin: '', remedy: GENERIC_REMEDY };
export const isExpired = context => authOf(context).status === 'expired';

// Marks a context expired. Returns true when this changed what the UI shows.
export function mark(context, { message = '', plugin = '' } = {}) {
  if (!context) return false;
  const was = authOf(context);
  if (was.status === 'expired' && was.plugin === plugin && was.message === message) return false;
  if (was.status !== 'expired') dismissed.delete(context);
  book.set(context, { ...was, status: 'expired', message, plugin });
  return true;
}

// Marks a context healthy again. Returns true when it was expired.
export function clear(context) {
  const was = book.get(context);
  if (!was || was.status === 'ok') return false;
  const expired = was.status === 'expired';
  book.set(context, { ...was, status: 'ok', message: '', plugin: '' });
  dismissed.delete(context);
  return expired;
}

export const dismiss = context => { dismissed.add(context); };
export const isDismissed = context => dismissed.has(context);
export const forgetAll = () => { book.clear(); dismissed.clear(); };

// Contexts that need a sign-in, in the given order.
export const needsAttention = names => names.filter(isExpired);

// The banner sentence in three parts, so the cluster label can be emphasised.
export function bannerParts(label, entry) {
  return { before: 'Credentials for ', label, after: ` expired${entry.plugin ? ` — ${entry.plugin}` : ''}.` };
}

// Whether the banner shows for a context, and which buttons it offers.
export function bannerFor(context) {
  if (!context || !isExpired(context) || isDismissed(context)) return null;
  const entry = authOf(context);
  return { entry, canSignIn: Boolean(entry.remedy?.preset), remedyLabel: entry.remedy?.label || GENERIC_REMEDY.label };
}

export const tooltip = (label, entry) => `${label} · credentials expired${entry.message ? ` — ${entry.message}` : ''}`;
