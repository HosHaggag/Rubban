// Review → Apply for YAML editors: the exact diff, the objects it touches, kubectl's warnings and the
// admission result are shown before anything is applied, and Apply stays disabled until a successful
// review of exactly the text in the editor.
import { el, button, post, task, toast, confirmAction } from './kit.js';
import { parseUnified, renderUnified, fileCount } from './diff.js';

const objectLabel = object => `${object.kind} ${object.name} (${object.created ? 'create' : object.changed ? 'update' : 'unchanged'})`;

// editor: the textarea. target: { context, namespace }. confirmText/confirmName feed the production
// guard. onApplied runs after a successful apply. Returns the node to place under the editor.
export function reviewBar({ editor, target, confirmText, confirmName, onApplied, applyClass = 'primary' }) {
  const results = el('div', { class: 'review-result' });
  const applyButton = el('button', { type: 'button', class: applyClass, disabled: true }, 'Apply');
  let reviewed = null; // { yaml, hash, count }

  const stale = () => { reviewed = null; applyButton.disabled = true; applyButton.textContent = 'Apply'; };
  editor.addEventListener('input', () => { if (reviewed) { stale(); results.prepend(el('div', { class: 'callout info', text: 'The manifest changed since the review. Review it again.' })); } });

  const show = answer => {
    const lines = parseUnified(answer.diff);
    const nodes = [];
    if (answer.error) nodes.push(el('div', { class: 'callout error review-error' }, el('strong', { text: 'The cluster refused this manifest. ' }), el('pre', { class: 'review-error-text', text: answer.error })));
    if (answer.warnings?.length) nodes.push(el('div', { class: 'callout warn review-warnings' }, answer.warnings.map(text => el('div', { text }))));
    if (answer.objects?.length) nodes.push(el('ul', { class: 'review-objects' }, answer.objects.map(object => el('li', { text: objectLabel(object) }))));
    if (lines.length) nodes.push(renderUnified(lines));
    else if (!answer.error) nodes.push(el('p', { class: 'muted', text: 'No changes: the cluster already has this manifest.' }));
    results.replaceChildren(...nodes);
  };

  const review = task(async () => {
    const yaml = editor.value;
    if (!yaml.trim()) throw new Error('Enter a YAML manifest first.');
    stale();
    results.replaceChildren(el('p', { class: 'muted', text: 'Asking the cluster what would change…' }));
    const answer = await post('/api/apply/preview', { ...target, yaml }, { context: target.context });
    // Typing while the review ran: it no longer describes the editor.
    if (editor.value !== yaml) { results.replaceChildren(el('div', { class: 'callout info', text: 'The manifest changed during the review. Review it again.' })); return; }
    show(answer);
    if (!answer.error && answer.changed && answer.previewHash) {
      const count = fileCount(parseUnified(answer.diff)) || answer.objects?.length || 1;
      reviewed = { yaml, hash: answer.previewHash, count };
      applyButton.disabled = false;
      applyButton.textContent = `Apply ${count} change${count === 1 ? '' : 's'}`;
    }
  });

  applyButton.addEventListener('click', task(async () => {
    if (!reviewed || editor.value !== reviewed.yaml) { stale(); throw new Error('Review the manifest again before applying.'); }
    if (!await confirmAction(confirmText, confirmName)) return;
    applyButton.disabled = true;
    const { yaml, hash } = reviewed;
    try {
      const response = await post('/api/apply', { ...target, yaml, previewHash: hash }, { context: target.context });
      results.replaceChildren(el('pre', { class: 'output', text: response.output }));
      toast('Applied.');
      reviewed = null; applyButton.textContent = 'Apply';
      onApplied?.();
    } catch (error) { applyButton.disabled = false; throw error; }
  }));

  return el('div', { class: 'review' }, el('div', { class: 'form-actions' }, button('Review', review, 'compact'), applyButton), results);
}
