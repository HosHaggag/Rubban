package server

import (
	"fmt"
	"strings"
)

// Ctrl+K commands ("restart storefront", "scale cart 3") resolve their target with /api/search, asking only
// for the kinds the verb applies to: GET /api/search?kinds=deployments,statefulsets narrows the search.
// ReplicaSets are never part of a plain search (every Deployment owns several); they are searched only
// when asked for by name.

var optionalSearchKinds = []searchKind{{"replicasets", "ReplicaSet"}}

// narrowSearchKinds keeps the kinds named in the comma-separated list, in search order. An empty list keeps
// them all. Argo CD applications asked for on a cluster without Argo CD are skipped; any other unknown
// name is an error.
func narrowSearchKinds(kinds []searchKind, list string) ([]searchKind, error) {
	list = strings.TrimSpace(list)
	if list == "" {
		return kinds, nil
	}
	if len(list) > 512 {
		return nil, bad("Too many kinds to search")
	}
	universe := append(append([]searchKind{argoSearchKind}, searchKinds...), optionalSearchKinds...)
	want := map[string]bool{}
	for _, name := range strings.Split(list, ",") {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		known := false
		for _, k := range universe {
			known = known || k.resource == name
		}
		if !known {
			return nil, bad(fmt.Sprintf("Search cannot look through %q", name))
		}
		want[name] = true
	}
	var out []searchKind
	for _, k := range append(append([]searchKind{}, kinds...), optionalSearchKinds...) {
		if want[k.resource] {
			out = append(out, k)
			delete(want, k.resource)
		}
	}
	return out, nil
}
