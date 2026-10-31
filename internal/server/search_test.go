package server

import (
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestMatchRankPrefersPrefixThenWordStartThenSubstring(t *testing.T) {
	for _, c := range []struct {
		text, needle string
		want         int
	}{
		{"payments-api", "pay", 0}, {"checkout-payments", "pay", 1}, {"my.payments", "pay", 1},
		{"prepayments", "pay", 2}, {"api", "pay", -1}, {"paypal-payments", "pay", 0},
		{"xxpay-pay", "pay", 1}, {"", "pay", -1},
	} {
		if got := matchRank(c.text, c.needle); got != c.want {
			t.Errorf("matchRank(%q,%q) = %d, want %d", c.text, c.needle, got, c.want)
		}
	}
}

func TestSearchEntriesRankLimitAndTruncate(t *testing.T) {
	pods := []searchEntry{
		{Resource: "pods", Kind: "Pod", Namespace: "a", Name: "prepayments-1"},
		{Resource: "pods", Kind: "Pod", Namespace: "a", Name: "checkout-payments-7d9"},
		{Resource: "pods", Kind: "Pod", Namespace: "a", Name: "payments-api-5f6d8-abcde"},
		{Resource: "pods", Kind: "Pod", Namespace: "b", Name: "unrelated"},
	}
	services := []searchEntry{
		{Resource: "services", Kind: "Service", Namespace: "a", Name: "payments"},
		{Resource: "services", Kind: "Service", Namespace: "a", Name: "gateway", App: "payments-gateway"},
	}
	got, truncated := searchEntries([][]searchEntry{pods, services}, "  Pay ", 10)
	var names []string
	for _, e := range got {
		names = append(names, e.Name)
	}
	// Prefix by name (shorter first), then the label prefix (loses to names), word start, substring.
	want := []string{"payments", "payments-api-5f6d8-abcde", "gateway", "checkout-payments-7d9", "prepayments-1"}
	if !reflect.DeepEqual(names, want) || truncated {
		t.Fatalf("%v truncated=%v", names, truncated)
	}
	got, truncated = searchEntries([][]searchEntry{pods, services}, "pay", 2)
	if len(got) != 2 || !truncated || got[0].Name != "payments" {
		t.Fatalf("limit: %v %v", got, truncated)
	}
	if got, truncated := searchEntries([][]searchEntry{pods}, "zzz", 5); len(got) != 0 || truncated {
		t.Fatal("no match")
	}
	// Equal quality and length: kind order, then name.
	tie, _ := searchEntries([][]searchEntry{{{Resource: "pods", Name: "abc"}}, {{Resource: "services", Name: "abd"}}, {{Resource: "x", Name: "abb"}}}, "ab", 5)
	if tie[0].Resource != "pods" || tie[1].Resource != "services" || tie[2].Resource != "x" {
		t.Fatalf("%v", tie)
	}
}

func TestSearchStatusText(t *testing.T) {
	cases := []struct {
		resource string
		item     obj
		want     string
	}{
		{"pods", obj{"status": obj{"phase": "Running", "containerStatuses": []any{obj{"ready": true}, obj{"ready": false}}}}, "Running 1/2"},
		{"pods", obj{"status": obj{"phase": "Pending"}}, "Pending"},
		{"deployments", obj{"spec": obj{"replicas": 3.0}, "status": obj{"readyReplicas": 2.0}}, "2/3 ready"},
		{"deployments", obj{"status": obj{}}, "0/1 ready"},
		{"daemonsets", obj{"status": obj{"numberReady": 4.0, "desiredNumberScheduled": 5.0}}, "4/5 ready"},
		{"jobs", obj{"status": obj{"conditions": []any{obj{"type": "Complete", "status": "True"}}}}, "Complete"},
		{"nodes", obj{"status": obj{"conditions": []any{obj{"type": "Ready", "status": "False"}}}}, "NotReady"},
		{"persistentvolumeclaims", obj{"status": obj{"phase": "Bound"}}, "Bound"},
		{"applications.argoproj.io", obj{"status": obj{"sync": obj{"status": "OutOfSync"}, "health": obj{"status": "Degraded"}}}, "Degraded OutOfSync"},
		{"services", obj{}, ""},
	}
	for _, c := range cases {
		if got := searchStatus(c.resource, c.item); got != c.want {
			t.Errorf("%s: %q, want %q", c.resource, got, c.want)
		}
	}
}

// searchHandler serves `kubectl get <resource> --all-namespaces` from fixtures and counts the lists.
type searchHandler struct {
	mu    sync.Mutex
	lists map[string]int
	items map[string][]any
	argo  bool
	fail  map[string]string
}

func (h *searchHandler) handle(args []string, _ RunOptions) Result {
	joined := strings.Join(args, " ")
	switch {
	case strings.Contains(joined, "--raw="):
		return (&canIHandler{argo: h.argo}).handle(args, RunOptions{})
	case len(args) > 2 && args[0] == "get":
		h.mu.Lock()
		defer h.mu.Unlock()
		if h.lists == nil {
			h.lists = map[string]int{}
		}
		h.lists[args[1]]++
		if msg := h.fail[args[1]]; msg != "" {
			return Result{Stderr: msg, Code: 1}
		}
		return out(map[string]any{"items": h.items[args[1]]}, 0)
	}
	return Result{Stderr: "unexpected " + joined, Code: 1}
}

func (h *searchHandler) count(resource string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.lists[resource]
}

func item(name, namespace string, labels map[string]any, extra map[string]any) map[string]any {
	meta := map[string]any{"name": name}
	if namespace != "" {
		meta["namespace"] = namespace
	}
	if labels != nil {
		meta["labels"] = labels
	}
	m := map[string]any{"metadata": meta}
	for k, v := range extra {
		m[k] = v
	}
	return m
}

func searchFixture(t *testing.T, h *searchHandler) *fixture {
	t.Helper()
	if h.items == nil {
		h.items = map[string][]any{
			"pods":        {item("payments-api-1", "shop", map[string]any{"app": "payments"}, map[string]any{"status": map[string]any{"phase": "Running"}}), item("web-1", "shop", nil, nil)},
			"deployments": {item("payments-api", "shop", nil, map[string]any{"spec": map[string]any{"replicas": 2.0}, "status": map[string]any{"readyReplicas": 2.0}}), item("checkout", "shop", map[string]any{"app.kubernetes.io/name": "payments-checkout"}, nil)},
			"services":    {item("payments", "shop", nil, nil)},
			"namespaces":  {item("payments-staging", "", nil, map[string]any{"status": map[string]any{"phase": "Active"}})},
			"secrets":     {item("payments-db-password", "shop", nil, map[string]any{"data": map[string]any{"password": "c3VwZXItc2VjcmV0"}, "stringData": map[string]any{"x": "hunter2"}})},
		}
	}
	return newFixture(t, h.handle)
}

func results(t *testing.T, res response) []map[string]any {
	t.Helper()
	if res.Status != 200 {
		t.Fatalf("%d %v", res.Status, res.Value)
	}
	var out []map[string]any
	for _, r := range res.Value["results"].([]any) {
		out = append(out, r.(map[string]any))
	}
	return out
}

func TestSearchFindsAndRanksAcrossKinds(t *testing.T) {
	h := &searchHandler{}
	f := searchFixture(t, h)
	got := results(t, f.get("/api/search?context=dev&q=payments"))
	var order []string
	for _, r := range got {
		order = append(order, fmt.Sprintf("%s/%s", r["kind"], r["name"]))
	}
	want := []string{"Service/payments", "Deployment/payments-api", "Pod/payments-api-1", "Namespace/payments-staging", "Secret/payments-db-password", "Deployment/checkout"}
	if !reflect.DeepEqual(order, want) {
		t.Fatalf("order %v", order)
	}
	pod := got[2]
	if pod["resource"] != "pods" || pod["namespace"] != "shop" || pod["app"] != "payments" || pod["status"] != "Running" {
		t.Fatalf("pod %v", pod)
	}
	if got[1]["status"] != "2/2 ready" || got[3]["namespace"] != nil || got[5]["app"] != "payments-checkout" {
		t.Fatalf("%v %v", got[1], got[3])
	}
	for _, r := range []string{"pods", "secrets", "nodes", "namespaces"} {
		if h.count(r) != 1 {
			t.Errorf("%s listed %d times", r, h.count(r))
		}
	}
}

func TestSearchNeverReturnsSecretValues(t *testing.T) {
	f := searchFixture(t, &searchHandler{})
	res := f.get("/api/search?context=dev&q=password")
	got := results(t, res)
	if len(got) != 1 || got[0]["kind"] != "Secret" || got[0]["name"] != "payments-db-password" {
		t.Fatalf("%v", got)
	}
	for _, leak := range []string{"c3VwZXItc2VjcmV0", "hunter2", "stringData", `"data"`} {
		if strings.Contains(string(res.Raw), leak) {
			t.Fatalf("response contains %q: %s", leak, res.Raw)
		}
	}
}

func TestSearchLimitAndTruncation(t *testing.T) {
	var pods []any
	for i := 0; i < 30; i++ {
		pods = append(pods, item(fmt.Sprintf("worker-%02d", i), "jobs", nil, nil))
	}
	f := searchFixture(t, &searchHandler{items: map[string][]any{"pods": pods}})
	res := f.get("/api/search?context=dev&q=worker&limit=5")
	if got := results(t, res); len(got) != 5 || res.Value["truncated"] != true || got[0]["name"] != "worker-00" {
		t.Fatalf("%v %v", got, res.Value["truncated"])
	}
	res = f.get("/api/search?context=dev&q=worker")
	if len(results(t, res)) != searchDefault || res.Value["truncated"] != true {
		t.Fatal("default limit")
	}
	res = f.get("/api/search?context=dev&q=worker-0&limit=50")
	if len(results(t, res)) != 10 || res.Value["truncated"] != false {
		t.Fatalf("%v", res.Value["truncated"])
	}
}

func TestSearchIncludesArgoApplicationsOnlyWhenDiscovered(t *testing.T) {
	apps := []any{item("payments-app", "argocd", nil, map[string]any{"status": map[string]any{"health": map[string]any{"status": "Healthy"}, "sync": map[string]any{"status": "Synced"}}})}
	without := &searchHandler{items: map[string][]any{"applications.argoproj.io": apps}}
	f := searchFixture(t, without)
	if got := results(t, f.get("/api/search?context=dev&q=payments")); len(got) != 0 || without.count("applications.argoproj.io") != 0 {
		t.Fatalf("%v", got)
	}
	with := &searchHandler{argo: true, items: map[string][]any{"applications.argoproj.io": apps}}
	g := searchFixture(t, with)
	got := results(t, g.get("/api/search?context=dev&q=payments"))
	if len(got) != 1 || got[0]["kind"] != "Application" || got[0]["resource"] != "applications.argoproj.io" || got[0]["status"] != "Healthy Synced" {
		t.Fatalf("%v", got)
	}
}

func TestSearchSkipsKindsItCannotListButReportsTotalFailure(t *testing.T) {
	h := &searchHandler{fail: map[string]string{"secrets": `secrets is forbidden: User "x" cannot list`, "nodes": "forbidden"}}
	f := searchFixture(t, h)
	if got := results(t, f.get("/api/search?context=dev&q=payments")); len(got) < 3 {
		t.Fatalf("%v", got)
	}
	all := map[string]string{}
	for _, k := range searchKinds {
		all[k.resource] = "Unable to connect to the server: getting credentials: exec: executable gke-gcloud-auth-plugin failed with exit code 1"
	}
	g := searchFixture(t, &searchHandler{fail: all})
	res := g.get("/api/search?context=dev&q=payments")
	if res.Status != 502 || res.Value["code"] != "credentials" {
		t.Fatalf("%d %v", res.Status, res.Value)
	}
}

func TestSearchIndexIsKeptForTwentySecondsPerContext(t *testing.T) {
	h := &searchHandler{}
	f := searchFixture(t, h)
	now := time.Now()
	searchNow = func() time.Time { return now }
	t.Cleanup(func() { searchNow = time.Now })
	f.get("/api/search?context=dev&q=payments")
	f.get("/api/search?context=dev&q=pay")
	if h.count("pods") != 1 {
		t.Fatalf("keystrokes must not relist: %d", h.count("pods"))
	}
	f.get("/api/search?context=prod&q=pay")
	if h.count("pods") != 2 {
		t.Fatal("another context is another index")
	}
	now = now.Add(21 * time.Second)
	f.get("/api/search?context=dev&q=pay")
	if h.count("pods") != 3 {
		t.Fatal("an old index is rebuilt")
	}
}

func TestSearchValidatesItsInput(t *testing.T) {
	h := &searchHandler{}
	f := searchFixture(t, h)
	for name, route := range map[string]string{
		"no context": "/api/search?q=payments",
		"no query":   "/api/search?context=dev",
		"one letter": "/api/search?context=dev&q=p",
		"blank":      "/api/search?context=dev&q=%20%20%20",
		"too long":   "/api/search?context=dev&q=" + strings.Repeat("a", 65),
		"limit 0":    "/api/search?context=dev&q=pay&limit=0",
		"limit 51":   "/api/search?context=dev&q=pay&limit=51",
		"limit text": "/api/search?context=dev&q=pay&limit=ten",
		"control":    "/api/search?context=dev&q=pa%00y",
	} {
		if res := f.get(route); res.Status != 400 {
			t.Errorf("%s: %d", name, res.Status)
		}
	}
	if len(f.calls) != 0 {
		t.Fatal("nothing may run for invalid input")
	}
}
