package server

import (
	"reflect"
	"testing"
)

func kindNames(kinds []searchKind) []string {
	var out []string
	for _, k := range kinds {
		out = append(out, k.resource)
	}
	return out
}

func TestNarrowSearchKindsKeepsSearchOrderAndOptInKinds(t *testing.T) {
	all, err := narrowSearchKinds(searchKinds, "")
	if err != nil || len(all) != len(searchKinds) {
		t.Fatalf("empty list keeps every kind: %v %v", all, err)
	}
	got, err := narrowSearchKinds(searchKinds, " statefulsets, deployments ,replicasets,deployments")
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"deployments", "statefulsets", "replicasets"}; !reflect.DeepEqual(kindNames(got), want) {
		t.Fatalf("%v, want %v", kindNames(got), want)
	}
	// Argo CD applications on a cluster without Argo CD: nothing to search, not an error.
	if got, err := narrowSearchKinds(searchKinds, "applications.argoproj.io"); err != nil || len(got) != 0 {
		t.Fatalf("argo without argo: %v %v", got, err)
	}
	if got, err := narrowSearchKinds(append(append([]searchKind{}, searchKinds...), argoSearchKind), "applications.argoproj.io"); err != nil || len(got) != 1 {
		t.Fatalf("argo with argo: %v %v", got, err)
	}
	for _, list := range []string{"widgets", "pods,secrets;rm", string(make([]byte, 600))} {
		if _, err := narrowSearchKinds(searchKinds, list); err == nil {
			t.Errorf("%q should be refused", list)
		}
	}
}

func TestSearchOnlyListsTheKindsAskedFor(t *testing.T) {
	h := &searchHandler{}
	f := searchFixture(t, h)
	h.items["replicasets"] = []any{item("payments-api-5f6d8", "shop", nil, map[string]any{"spec": map[string]any{"replicas": 2.0}, "status": map[string]any{"readyReplicas": 1.0}})}
	got := results(t, f.get("/api/search?context=dev&q=payments&kinds=deployments,replicasets"))
	// payments-api, its ReplicaSet, then checkout (matched by its app label).
	if len(got) != 3 || got[0]["kind"] != "Deployment" || got[2]["name"] != "checkout" || got[1]["kind"] != "ReplicaSet" || got[1]["status"] != "1/2 ready" {
		t.Fatalf("%v", got)
	}
	if h.count("pods") != 0 || h.count("secrets") != 0 || h.count("deployments") != 1 {
		t.Fatalf("listed kinds that were not asked for: pods=%d secrets=%d", h.count("pods"), h.count("secrets"))
	}
	// A plain search never looks at ReplicaSets.
	results(t, f.get("/api/search?context=dev&q=payments"))
	if h.count("replicasets") != 1 {
		t.Fatalf("replicasets listed %d times", h.count("replicasets"))
	}
	if res := f.get("/api/search?context=dev&q=payments&kinds=widgets"); res.Status != 400 {
		t.Fatalf("unknown kind: %d", res.Status)
	}
	if got := results(t, f.get("/api/search?context=dev&q=payments&kinds=applications.argoproj.io")); len(got) != 0 {
		t.Fatalf("argo on a cluster without it: %v", got)
	}
}
