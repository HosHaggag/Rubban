package server

import (
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// argoNorm round-trips a value through JSON so numbers and maps compare the way the API sees them.
func argoNorm(t *testing.T, v any) any {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func argoPatchOf(t *testing.T, c call) any {
	t.Helper()
	for _, a := range c.Args {
		if text, ok := strings.CutPrefix(a, "--patch="); ok {
			var v any
			if err := json.Unmarshal([]byte(text), &v); err != nil {
				t.Fatal(err)
			}
			return v
		}
	}
	t.Fatalf("no --patch in %v", c.Args)
	return nil
}

func TestArgoCDActions(t *testing.T) {
	app := map[string]any{
		"apiVersion": "argoproj.io/v1alpha1", "kind": "Application",
		"metadata": map[string]any{"name": "web", "namespace": "argocd", "resourceVersion": "42", "finalizers": []any{"resources-finalizer.argocd.argoproj.io/background", "example.com/keep"}},
		"spec":     map[string]any{"project": "default", "source": map[string]any{"repoURL": "https://git.example/apps.git", "path": "web"}},
		"status": map[string]any{
			"history":        []any{map[string]any{"id": 3, "revision": "abc123", "source": map[string]any{"repoURL": "https://git.example/apps.git", "path": "web"}}},
			"operationState": map[string]any{"phase": "Succeeded"},
		},
	}
	with := func(extra map[string]any) map[string]any {
		out := map[string]any{}
		for k, v := range app {
			out[k] = v
		}
		for k, v := range extra {
			out[k] = v
		}
		return out
	}
	current := app
	f := newFixture(t, func(args []string, _ RunOptions) Result {
		if slices.Contains(args, "get") {
			return out(current, 0)
		}
		return out("done", 0)
	})
	post := func(body map[string]any) response {
		merged := map[string]any{"context": "dev", "namespace": "argocd", "name": "web"}
		for k, v := range body {
			merged[k] = v
		}
		return f.post("/api/argocd", merged)
	}
	base := []string{"--context=dev", "--namespace=argocd"}
	want := func(extra ...string) []string { return append(append([]string{}, base...), extra...) }

	if r := post(map[string]any{"action": "hard-refresh"}); r.Status != 200 {
		t.Fatalf("hard-refresh %d %v", r.Status, r.Value)
	}
	if got := f.last().Args; !reflect.DeepEqual(got, want("annotate", "applications.argoproj.io", "web", "argocd.argoproj.io/refresh=hard", "--overwrite")) {
		t.Fatalf("hard refresh args %v", got)
	}
	post(map[string]any{"action": "refresh"})
	if args := f.last().Args; args[len(args)-2] != "argocd.argoproj.io/refresh=normal" {
		t.Fatalf("refresh args %v", args)
	}

	r := post(map[string]any{"action": "sync", "options": map[string]any{
		"prune": true, "serverSideApply": true, "prunePropagationPolicy": "background", "revision": "v1.2.3", "retry": true, "retryLimit": 3,
		"resources": []any{map[string]any{"group": "apps", "kind": "Deployment", "name": "web", "namespace": "apps"}},
	}})
	if r.Status != 200 || r.Value["output"] != "web: sync requested to v1.2.3" {
		t.Fatalf("sync %d %v", r.Status, r.Value)
	}
	if got := f.last().Args[:6]; !reflect.DeepEqual(got, want("patch", "applications.argoproj.io", "web", "--type=merge")) {
		t.Fatalf("patch args %v", got)
	}
	wantOp := map[string]any{"metadata": map[string]any{"resourceVersion": "42"}, "operation": map[string]any{
		"initiatedBy": map[string]any{"username": "rubban"},
		"sync": map[string]any{
			"prune": true, "dryRun": false, "syncStrategy": map[string]any{"hook": map[string]any{"force": false}},
			"syncOptions": []any{"ServerSideApply=true", "PrunePropagationPolicy=background"}, "revision": "v1.2.3",
			"resources": []any{map[string]any{"group": "apps", "kind": "Deployment", "name": "web", "namespace": "apps"}},
		},
		"retry": map[string]any{"limit": 3, "backoff": map[string]any{"duration": "5s", "factor": 2, "maxDuration": "3m"}},
	}}
	if got := argoPatchOf(t, f.last()); !reflect.DeepEqual(got, argoNorm(t, wantOp)) {
		t.Fatalf("sync patch %v", got)
	}
	r = post(map[string]any{"action": "sync", "options": map[string]any{"applyOnly": true, "force": true, "dryRun": true}})
	if r.Value["output"] != "web: dry-run sync requested" {
		t.Fatalf("dry run message %v", r.Value)
	}
	op := argoPatchOf(t, f.last()).(map[string]any)["operation"].(map[string]any)["sync"]
	if !reflect.DeepEqual(op, argoNorm(t, map[string]any{"prune": false, "dryRun": true, "syncStrategy": map[string]any{"apply": map[string]any{"force": true}}})) {
		t.Fatalf("apply-only sync %v", op)
	}
	for _, options := range []any{
		map[string]any{"revision": "--upload-pack=x"}, map[string]any{"revision": "a b"}, map[string]any{"prunePropagationPolicy": "now"},
		map[string]any{"resources": []any{map[string]any{"kind": "Deployment", "name": "-x"}}}, map[string]any{"resources": "all"},
	} {
		if r := post(map[string]any{"action": "sync", "options": options}); r.Status != 400 {
			t.Fatalf("options %v: %d", options, r.Status)
		}
	}

	post(map[string]any{"action": "rollback", "id": 3, "prune": true})
	op = argoPatchOf(t, f.last()).(map[string]any)["operation"].(map[string]any)["sync"]
	wantRollback := map[string]any{"prune": true, "dryRun": false, "syncStrategy": map[string]any{"hook": map[string]any{}}, "revision": "abc123", "source": map[string]any{"repoURL": "https://git.example/apps.git", "path": "web"}}
	if !reflect.DeepEqual(op, argoNorm(t, wantRollback)) {
		t.Fatalf("rollback %v", op)
	}
	if r := post(map[string]any{"action": "rollback", "id": 9}); r.Status != 404 {
		t.Fatalf("missing history %d", r.Status)
	}

	post(map[string]any{"action": "auto-sync", "enabled": true, "prune": true, "selfHeal": false})
	if got := argoPatchOf(t, f.last()); !reflect.DeepEqual(got, argoNorm(t, map[string]any{"spec": map[string]any{"syncPolicy": map[string]any{"automated": map[string]any{"prune": true, "selfHeal": false}}}})) {
		t.Fatalf("auto-sync on %v", got)
	}
	if r := post(map[string]any{"action": "auto-sync", "enabled": false}); r.Value["output"] != "web: auto-sync off" {
		t.Fatalf("auto-sync off %v", r.Value)
	}
	if got := argoPatchOf(t, f.last()); !reflect.DeepEqual(got, argoNorm(t, map[string]any{"spec": map[string]any{"syncPolicy": map[string]any{"automated": nil}}})) {
		t.Fatalf("auto-sync off patch %v", got)
	}

	// Busy and policy guards
	current = with(map[string]any{"operation": map[string]any{"sync": map[string]any{}}})
	if r := post(map[string]any{"action": "sync", "options": map[string]any{}}); r.Status != 409 {
		t.Fatalf("busy sync %d", r.Status)
	}
	current = with(map[string]any{"spec": map[string]any{"project": "default", "syncPolicy": map[string]any{"automated": map[string]any{"prune": true}}}})
	if r := post(map[string]any{"action": "rollback", "id": 3}); r.Status != 409 {
		t.Fatalf("auto-sync rollback %d", r.Status)
	}
	if r := post(map[string]any{"action": "terminate"}); r.Status != 409 {
		t.Fatalf("idle terminate %d", r.Status)
	}
	current = with(map[string]any{"status": map[string]any{"operationState": map[string]any{"phase": "Running"}}})
	post(map[string]any{"action": "terminate"})
	if got := argoPatchOf(t, f.last()); !reflect.DeepEqual(got, argoNorm(t, map[string]any{"metadata": map[string]any{"resourceVersion": "42"}, "status": map[string]any{"operationState": map[string]any{"phase": "Terminating"}}})) {
		t.Fatalf("terminate %v", got)
	}

	// Delete: the finalizer decides cascading; other finalizers are kept.
	current = app
	for _, c := range []struct {
		cascade    string
		finalizers []any
	}{
		{"foreground", []any{"example.com/keep", "resources-finalizer.argocd.argoproj.io"}},
		{"background", []any{"example.com/keep", "resources-finalizer.argocd.argoproj.io/background"}},
		{"none", []any{"example.com/keep"}},
	} {
		if r := post(map[string]any{"action": "delete", "cascade": c.cascade}); r.Status != 200 {
			t.Fatalf("delete %s %d", c.cascade, r.Status)
		}
		patch := f.calls[len(f.calls)-2]
		if got := argoPatchOf(t, patch); !reflect.DeepEqual(got, argoNorm(t, map[string]any{"metadata": map[string]any{"resourceVersion": "42", "finalizers": c.finalizers}})) {
			t.Fatalf("delete %s patch %v", c.cascade, got)
		}
		if got := f.last().Args; !reflect.DeepEqual(got, want("delete", "applications.argoproj.io", "web", "--wait=false")) {
			t.Fatalf("delete args %v", got)
		}
	}
	if r := post(map[string]any{"action": "delete", "cascade": "orphan"}); r.Status != 400 {
		t.Fatalf("bad cascade %d", r.Status)
	}
	if r := post(map[string]any{"action": "restart"}); r.Status != 400 {
		t.Fatalf("bad action %d", r.Status)
	}
	if r := f.post("/api/argocd", map[string]any{"context": "dev", "namespace": "argocd", "name": "-web", "action": "refresh"}); r.Status != 400 {
		t.Fatalf("bad name %d", r.Status)
	}
	if r := post(map[string]any{"namespace": "*", "action": "refresh"}); r.Status != 400 {
		t.Fatalf("wildcard namespace %d", r.Status)
	}
	if r := f.get("/api/argocd"); r.Status != 404 {
		t.Fatalf("GET %d", r.Status)
	}
}
