package server

import (
	"encoding/json"
	"slices"
	"strings"
	"sync"
	"testing"
)

func TestAccessChecksHaveUniqueIDsAndNeedARealVerb(t *testing.T) {
	seen := map[string]bool{}
	for _, c := range accessChecks {
		if seen[c.ID] {
			t.Errorf("duplicate id %q", c.ID)
		}
		seen[c.ID] = true
		if c.Feature == "" || c.Resource == "" || !slices.Contains([]string{"get", "list", "watch", "create", "patch", "delete"}, c.Verb) || !slices.Contains([]string{"namespace", "cluster"}, c.Scope) {
			t.Errorf("incomplete check %+v", c)
		}
		if c.Argo && c.Namespace != "argocd" {
			t.Errorf("%s: Argo CD checks look in the argocd namespace", c.ID)
		}
	}
	for _, id := range []string{"logs", "exec", "attach", "port-forward", "secrets", "edit", "scale", "delete", "node-shell", "helm", "crds", "prometheus", "kubelet-summary"} {
		if !seen[id] {
			t.Errorf("README §6 lists %q but no check covers it", id)
		}
	}
}

func TestAccessCheckResolvesNamespaces(t *testing.T) {
	byID := map[string]accessCheck{}
	for _, c := range accessChecks {
		byID[c.ID] = c.resolved("apps", "observability")
	}
	want := map[string]string{"logs": "apps", "browse-list-nodes": "", "node-shell": "kube-system", "prometheus": "observability", "argo-get": "argocd", "helm": "apps", "crds": ""}
	for id, ns := range want {
		if byID[id].Namespace != ns {
			t.Errorf("%s: namespace %q, want %q", id, byID[id].Namespace, ns)
		}
	}
}

// canIHandler answers `auth can-i` from a deny list and serves discovery with or without Argo CD.
type canIHandler struct {
	mu     sync.Mutex
	calls  [][]string
	deny   []string // "verb resource" prefixes that answer no
	argo   bool
	whoami string
}

func (h *canIHandler) handle(args []string, _ RunOptions) Result {
	h.mu.Lock()
	h.calls = append(h.calls, args)
	h.mu.Unlock()
	joined := strings.Join(args, " ")
	switch {
	case strings.Contains(joined, "auth can-i"):
		rest := strings.SplitN(joined, "auth can-i ", 2)[1]
		for _, d := range h.deny {
			if strings.HasPrefix(rest, d) {
				return Result{Stdout: "no\n", Code: 1}
			}
		}
		return Result{Stdout: "yes\n"}
	case strings.Contains(joined, "auth whoami"):
		if h.whoami == "" {
			return Result{Stderr: "unknown command", Code: 1}
		}
		return out(map[string]any{"status": map[string]any{"userInfo": map[string]any{"username": h.whoami, "groups": []any{"system:authenticated"}}}}, 0)
	case strings.Contains(joined, "--raw=/apis/argoproj.io/v1alpha1"):
		return out(map[string]any{"resources": []any{map[string]any{"name": "applications", "kind": "Application", "namespaced": true, "verbs": []any{"get", "list"}}}}, 0)
	case strings.Contains(joined, "--raw=/apis"):
		groups := []any{}
		if h.argo {
			groups = append(groups, map[string]any{"preferredVersion": map[string]any{"groupVersion": "argoproj.io/v1alpha1"}})
		}
		return out(map[string]any{"groups": groups}, 0)
	case strings.Contains(joined, "--raw=/api/v1"):
		return out(map[string]any{"resources": []any{}}, 0)
	}
	return Result{Stderr: "unexpected " + joined, Code: 1}
}

func (h *canIHandler) canICalls() [][]string {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out [][]string
	for _, c := range h.calls {
		if slices.Contains(c, "can-i") {
			out = append(out, c)
		}
	}
	return out
}

func checkByID(t *testing.T, res response) map[string]map[string]any {
	t.Helper()
	if res.Status != 200 {
		t.Fatalf("status %d %v", res.Status, res.Value)
	}
	out := map[string]map[string]any{}
	for _, c := range res.Value["checks"].([]any) {
		m := c.(map[string]any)
		out[m["id"].(string)] = m
	}
	return out
}

func TestAccessCheckThroughKubectl(t *testing.T) {
	h := &canIHandler{deny: []string{"patch ", "delete ", "get secrets"}, whoami: "alice@example.com"}
	f := newFixture(t, h.handle)
	res := f.post("/api/access/check", map[string]any{"context": "dev", "namespace": "apps"})
	checks := checkByID(t, res)
	if res.Value["user"] != "alice@example.com" || !sameJSON(res.Value["groups"], []any{"system:authenticated"}) {
		t.Fatalf("identity %v", res.Value)
	}
	for id, allowed := range map[string]bool{"browse-list-pods": true, "logs": true, "exec": true, "edit": false, "scale": false, "delete": false, "secrets": false, "helm": true, "node-shell": true} {
		if checks[id]["allowed"] != allowed {
			t.Errorf("%s: allowed=%v", id, checks[id]["allowed"])
		}
	}
	if _, ok := checks["argo-get"]; ok {
		t.Fatal("Argo CD checks must be skipped when the group is absent")
	}
	want := map[string][]string{
		"logs":              {"--context=dev", "auth", "can-i", "get", "pods", "--subresource=log", "--namespace=apps"},
		"browse-list-nodes": {"--context=dev", "auth", "can-i", "list", "nodes"},
		"metrics-pods":      {"--context=dev", "auth", "can-i", "list", "pods.metrics.k8s.io", "--namespace=apps"},
		"node-shell":        {"--context=dev", "auth", "can-i", "create", "pods", "--namespace=kube-system"},
		"prometheus":        {"--context=dev", "auth", "can-i", "get", "services", "--subresource=proxy", "--namespace=monitoring"},
	}
	calls := h.canICalls()
	for id, args := range want {
		if !slices.ContainsFunc(calls, func(c []string) bool { return slices.Equal(c, args) }) {
			t.Errorf("%s: no call %q among %d", id, args, len(calls))
		}
	}
	for _, c := range calls {
		if slices.Contains(c, "--all-namespaces") {
			t.Errorf("a namespace was given, got %q", c)
		}
	}
}

func sameJSON(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}

func TestAccessCheckAllNamespacesAndArgoCD(t *testing.T) {
	h := &canIHandler{argo: true}
	f := newFixture(t, h.handle)
	checks := checkByID(t, f.post("/api/access/check", map[string]any{"context": "dev", "namespace": "*"}))
	for _, id := range []string{"argo-get", "argo-patch", "argo-delete"} {
		if checks[id] == nil || checks[id]["namespace"] != "argocd" || checks[id]["group"] != "argoproj.io" {
			t.Fatalf("%s: %v", id, checks[id])
		}
	}
	calls := h.canICalls()
	if !slices.ContainsFunc(calls, func(c []string) bool {
		return slices.Equal(c, []string{"--context=dev", "auth", "can-i", "get", "secrets", "--all-namespaces"})
	}) {
		t.Fatalf("all namespaces: %q", calls)
	}
	if !slices.ContainsFunc(calls, func(c []string) bool {
		return slices.Equal(c, []string{"--context=dev", "auth", "can-i", "patch", "applications.argoproj.io", "--namespace=argocd"})
	}) {
		t.Fatal("Argo CD patch check missing")
	}
	if checks["browse-list-pods"]["namespace"] != nil {
		t.Fatal("no namespace means all namespaces")
	}
}

func TestAccessCheckIsCachedUntilRefresh(t *testing.T) {
	h := &canIHandler{}
	f := newFixture(t, h.handle)
	body := map[string]any{"context": "dev", "namespace": "apps"}
	f.post("/api/access/check", body)
	first := len(h.canICalls())
	if first != len(accessChecks)-3 { // Argo CD checks are skipped
		t.Fatalf("%d checks asked, table has %d", first, len(accessChecks))
	}
	f.post("/api/access/check", body)
	if len(h.canICalls()) != first {
		t.Fatal("the second answer comes from the cache")
	}
	f.post("/api/access/check", map[string]any{"context": "dev", "namespace": "other"})
	if len(h.canICalls()) != 2*first {
		t.Fatal("another namespace is another answer")
	}
	f.post("/api/access/check", map[string]any{"context": "dev", "namespace": "apps", "refresh": true})
	if len(h.canICalls()) != 3*first {
		t.Fatal("refresh bypasses the cache")
	}
}

func TestAccessCheckThroughSelfSubjectAccessReviews(t *testing.T) {
	var mu sync.Mutex
	var reviews []map[string]any
	withLive(t, func(kubeContext, method, apiPath string, body any) (int, string, error) {
		if kubeContext != "dev" || method != "POST" {
			t.Errorf("%s %s", kubeContext, method)
		}
		switch apiPath {
		case "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews":
			attrs := body.(obj)["spec"].(obj)["resourceAttributes"].(obj)
			mu.Lock()
			reviews = append(reviews, attrs)
			mu.Unlock()
			if attrs["resource"] == "secrets" && attrs["verb"] == "list" {
				return 201, `{"status":{"allowed":false,"reason":"RBAC: no rule allows list on secrets"}}`, nil
			}
			return 201, `{"status":{"allowed":true}}`, nil
		case "/apis/authentication.k8s.io/v1/selfsubjectreviews":
			return 201, `{"status":{"userInfo":{"username":"bob","groups":["devs"]}}}`, nil
		}
		t.Errorf("unexpected path %s", apiPath)
		return 404, `{}`, nil
	})
	h := &canIHandler{}
	f := newFixture(t, h.handle)
	res := f.post("/api/access/check", map[string]any{"context": "dev", "namespace": "monitoring"})
	checks := checkByID(t, res)
	if res.Value["user"] != "bob" || checks["helm"]["allowed"] != false || checks["helm"]["reason"] != "RBAC: no rule allows list on secrets" || checks["logs"]["allowed"] != true {
		t.Fatalf("%v", res.Value)
	}
	if len(h.canICalls()) != 0 {
		t.Fatal("kubectl auth can-i is only the fallback")
	}
	var logs map[string]any
	for _, r := range reviews {
		if r["subresource"] == "log" {
			logs = r
		}
	}
	if logs["namespace"] != "monitoring" || logs["resource"] != "pods" || logs["verb"] != "get" || logs["group"] != "" {
		t.Fatalf("log review %v", logs)
	}
	for _, r := range reviews {
		if r["resource"] == "nodes" && r["namespace"] != nil {
			t.Fatalf("cluster scoped checks carry no namespace: %v", r)
		}
	}
}

func TestAccessCheckReportsAFailureOfEveryCheck(t *testing.T) {
	f := newFixture(t, func(args []string, _ RunOptions) Result {
		return Result{Stderr: "Unable to connect to the server: getting credentials: exec: executable gke-gcloud-auth-plugin failed with exit code 1", Code: 2}
	})
	res := f.post("/api/access/check", map[string]any{"context": "dev", "namespace": "apps"})
	if res.Status != 502 || res.Value["code"] != "credentials" {
		t.Fatalf("%d %v", res.Status, res.Value)
	}
}

func TestAccessCheckValidatesItsInput(t *testing.T) {
	f := newFixture(t, (&canIHandler{}).handle)
	for name, body := range map[string]map[string]any{
		"no context":    {"namespace": "apps"},
		"bad namespace": {"context": "dev", "namespace": "Not A Namespace"},
		"bad context":   {"context": 5, "namespace": "apps"},
	} {
		if res := f.post("/api/access/check", body); res.Status != 400 {
			t.Errorf("%s: %d", name, res.Status)
		}
	}
	if len(f.calls) != 0 {
		t.Fatal("nothing may run for invalid input")
	}
}
