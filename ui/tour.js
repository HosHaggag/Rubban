// Guided tour: a dimmed overlay with a cut-out around one element and a card that explains it.
// Steps: { id, target: () => Element | null, title, body, placement, before?: async () => void, when?: ctx => boolean }.
// This module avoids kit.js so its pure helpers can be tested in Node.
export const visibleSteps = (steps, ctx = {}) => steps.filter(step => !step.when || step.when(ctx));

const OPPOSITE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
// Chooses where the card goes next to a target rectangle: the preferred side if it fits in the
// viewport, then the opposite and remaining sides, otherwise the preferred side clamped inside the viewport.
export function placeCard(target, card, viewport, preferred = 'bottom', { gap = 12, margin = 8 } = {}) {
  const clamp = (value, size, limit) => Math.max(margin, Math.min(value, limit - size - margin));
  if (!target) return { top: Math.round((viewport.height - card.height) / 2), left: Math.round((viewport.width - card.width) / 2), placement: 'center' };
  const spots = {
    bottom: { top: target.bottom + gap, left: target.left + target.width / 2 - card.width / 2 },
    top: { top: target.top - gap - card.height, left: target.left + target.width / 2 - card.width / 2 },
    right: { top: target.top + target.height / 2 - card.height / 2, left: target.right + gap },
    left: { top: target.top + target.height / 2 - card.height / 2, left: target.left - gap - card.width },
  };
  const fits = ({ top, left }) => top >= margin && left >= margin && top + card.height <= viewport.height - margin && left + card.width <= viewport.width - margin;
  const order = [...new Set([preferred, OPPOSITE[preferred], 'bottom', 'top', 'right', 'left'])].filter(Boolean);
  const placement = order.find(side => spots[side] && fits(spots[side])) || preferred;
  const spot = spots[placement] || spots.bottom;
  return { top: Math.round(clamp(spot.top, card.height, viewport.height)), left: Math.round(clamp(spot.left, card.width, viewport.width)), placement };
}

const node = (tag, className, text) => { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = text; return item; };

// Returns { stop } and resolves nothing: persistence is delegated to savePreference, called once on Finish or Skip.
export function startTour({ steps, ctx = {}, savePreference = () => {}, reason = 'manual', skippedNote = '' }) {
  const list = visibleSteps(steps, ctx);
  if (!list.length || document.querySelector('.tour-card')) return { stop() {} };
  let index = 0; let ended = false;
  const backdrop = node('div', 'tour-backdrop');
  const spot = node('div', 'tour-spot');
  const card = node('div', 'tour-card');
  card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-labelledby', 'tour-title');
  const title = node('h2', 'tour-title'); title.id = 'tour-title';
  const body = node('p', 'tour-body');
  const counter = node('span', 'tour-counter');
  const back = node('button', 'quiet compact', 'Back'); back.type = 'button';
  const next = node('button', 'primary compact', 'Next'); next.type = 'button';
  const skip = node('button', 'quiet compact', 'Skip tour'); skip.type = 'button';
  const footer = node('div', 'tour-footer'); const buttons = node('div', 'tour-buttons');
  buttons.append(back, next); footer.append(skip, counter, buttons);
  card.append(title, body, footer);
  document.body.append(backdrop, spot, card);

  const place = () => {
    const step = list[index];
    const target = step.target ? step.target() : null;
    const visible = target && target.getClientRects().length ? target : null;
    const rect = visible ? visible.getBoundingClientRect() : null;
    const padded = rect ? { top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12, right: rect.right + 6, bottom: rect.bottom + 6 } : null;
    spot.hidden = !padded;
    if (padded) Object.assign(spot.style, { top: `${padded.top}px`, left: `${padded.left}px`, width: `${padded.width}px`, height: `${padded.height}px` });
    const position = placeCard(padded, { width: card.offsetWidth, height: card.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, step.placement);
    Object.assign(card.style, { top: `${position.top}px`, left: `${position.left}px` });
    card.dataset.placement = position.placement;
  };
  const show = async value => {
    index = value;
    const step = list[index];
    if (step.before) { try { await step.before(); } catch { /* A missing view must not stop the tour. */ } }
    if (ended) return;
    const target = step.target ? step.target() : null;
    target?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    title.textContent = step.title;
    body.textContent = step.body + (index === list.length - 1 && skippedNote ? ` ${skippedNote}` : '');
    counter.textContent = `${index + 1} of ${list.length}`;
    back.disabled = index === 0;
    next.textContent = index === list.length - 1 ? 'Finish' : 'Next';
    place();
    next.focus();
  };
  const end = () => {
    if (ended) return;
    ended = true;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
    backdrop.remove(); spot.remove(); card.remove();
    savePreference({ reason });
  };
  const onKey = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); end(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [skip, back, next].filter(item => !item.disabled);
    const at = focusable.indexOf(document.activeElement);
    event.preventDefault();
    focusable[(at + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length].focus();
  };
  back.addEventListener('click', () => { if (index > 0) show(index - 1); });
  next.addEventListener('click', () => { if (index < list.length - 1) show(index + 1); else end(); });
  skip.addEventListener('click', end);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);
  show(0);
  return { stop: end };
}
