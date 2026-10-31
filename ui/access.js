// "Can I?" results: wording, grouping and the text that is copied for an administrator. Pure.

// get pods/log · list pods.metrics.k8s.io · patch deployments.apps/scale
export function permissionText(check) {
  const resource = `${check.resource}${check.group ? `.${check.group}` : ''}${check.subresource ? `/${check.subresource}` : ''}`;
  return `${check.verb} ${resource}`;
}

export const scopeText = check => (check.namespace ? `in ${check.namespace}` : 'cluster-wide');

// Consecutive checks of one feature share a heading.
export function groupByFeature(checks) {
  const groups = [];
  for (const check of checks || []) {
    const last = groups.at(-1);
    if (last && last.feature === check.feature) last.checks.push(check);
    else groups.push({ feature: check.feature, checks: [check] });
  }
  return groups.map(group => ({ ...group, allowed: group.checks.every(check => check.allowed) }));
}

export const denied = answer => (answer?.checks || []).filter(check => !check.allowed);

// Plain text for pasting into a ticket.
export function asText(answer, { label = '', context = '' } = {}) {
  const lines = [`Access for ${label || context}${label && context && label !== context ? ` (${context})` : ''}`];
  if (answer.user) lines.push(`Identity: ${answer.user}${answer.groups?.length ? ` · groups: ${answer.groups.join(', ')}` : ''}`);
  lines.push(`Namespace: ${answer.namespace && answer.namespace !== '*' ? answer.namespace : 'all namespaces'}`, '');
  for (const check of answer.checks || []) {
    lines.push(`${check.allowed ? '✓' : '✗'} ${check.feature}: ${permissionText(check)} ${scopeText(check)}${check.allowed ? '' : check.error ? ` — could not check: ${check.error}` : check.reason ? ` — ${check.reason}` : ''}`);
  }
  const missing = denied(answer);
  if (missing.length) lines.push('', `${missing.length} of ${answer.checks.length} checks are denied.`);
  return lines.join('\n');
}

// A sentence for the top of the panel.
export function summary(answer) {
  const missing = denied(answer);
  if (!answer?.checks?.length) return 'No checks ran.';
  if (!missing.length) return `All ${answer.checks.length} checks passed.`;
  const features = [...new Set(missing.map(check => check.feature))];
  return `${missing.length} of ${answer.checks.length} checks are denied: ${features.join(', ')}.`;
}
