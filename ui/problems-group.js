// Groups the Problems inbox so it reads like a to-do list: the pods of one workload that fail the
// same way become one row ("checkout-worker · 2 pods"), and a pod's "keeps restarting" warning is
// folded into its crash-loop row. Pure: no DOM.

// The workload a pod belongs to, from its generated name (Deployment: name-<rs hash>-<pod hash>;
// StatefulSet: name-<ordinal>; DaemonSet and Job: name-<hash>).
export function workloadOfPod(name = '') {
  return name.match(/^(.+)-(?=[a-z]*\d)[a-z0-9]{6,10}-[a-z0-9]{5}$/)?.[1] || name.match(/^(.+)-\d+$/)?.[1] || name.match(/^(.+)-[a-z0-9]{5}$/)?.[1] || name;
}

const RANK = { critical: 0, warning: 1, info: 2 };

export function groupProblems(problems) {
  // A pod that is already reported critical needs no separate warning ("N restarts", "Pending", "Not ready").
  const critical = new Set(problems.filter(p => p.resource === 'pods' && p.severity === 'critical').map(p => `${p.context}|${p.namespace}|${p.name}`));
  const kept = problems.filter(p => !(p.resource === 'pods' && p.severity !== 'critical' && critical.has(`${p.context}|${p.namespace}|${p.name}`)));
  const groups = new Map();
  for (const problem of kept) {
    const owner = problem.resource === 'pods' ? workloadOfPod(problem.name) : problem.name;
    const key = [problem.context, problem.resource, problem.namespace, owner, problem.severity, problem.title].join('|');
    const group = groups.get(key);
    if (!group) { groups.set(key, { ...problem, owner, members: [problem] }); continue; }
    group.members.push(problem);
    if (problem.since && (!group.since || new Date(problem.since) < new Date(group.since))) group.since = problem.since;
  }
  return [...groups.values()].sort((a, b) => (RANK[a.severity] ?? 3) - (RANK[b.severity] ?? 3) || a.context.localeCompare(b.context) || (a.namespace || '').localeCompare(b.namespace || '') || a.owner.localeCompare(b.owner));
}

export function totalsOf(problems) {
  const totals = { critical: 0, warning: 0, info: 0, clusters: new Set(), namespaces: new Set() };
  for (const p of problems) { totals[p.severity] = (totals[p.severity] || 0) + 1; totals.clusters.add(p.context); if (p.namespace) totals.namespaces.add(`${p.context}/${p.namespace}`); }
  return totals;
}
