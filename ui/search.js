// Palette resource search: the server ranks; the client only groups and decides who to ask. Pure.

// Distinct clusters that have a tab open, in tab order.
export const searchContexts = tabs => [...new Set((tabs || []).map(tab => tab.context).filter(Boolean))];

// Results of one cluster grouped by kind, kinds in order of their best result.
export function groupByKind(results) {
  const groups = [];
  for (const result of results || []) {
    let group = groups.find(item => item.resource === result.resource);
    if (!group) { group = { resource: result.resource, kind: result.kind, items: [] }; groups.push(group); }
    group.items.push(result);
  }
  return groups;
}

// The small text under a result: namespace and status.
export const resultDetail = result => [result.namespace, result.status].filter(Boolean).join(' · ');

export const searchable = query => query.trim().length >= 2;
