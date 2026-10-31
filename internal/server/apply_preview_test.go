package server

import (
	"context"
	"reflect"
	"strings"
	"testing"
)

const updateDiff = `diff -u -N /tmp/LIVE-123/apps.v1.Deployment.apps.api /tmp/MERGED-123/apps.v1.Deployment.apps.api
--- /tmp/LIVE-123/apps.v1.Deployment.apps.api	2026-01-01 10:00:00.000000000 +0000
+++ /tmp/MERGED-123/apps.v1.Deployment.apps.api	2026-01-01 10:00:00.000000000 +0000
@@ -40,7 +40,7 @@
       containers:
-      - image: api:1.0
+      - image: api:1.1
diff -u -N /tmp/LIVE-123/v1.ConfigMap.apps.settings /tmp/MERGED-123/v1.ConfigMap.apps.settings
--- /tmp/LIVE-123/v1.ConfigMap.apps.settings	1970-01-01 00:00:00.000000000 +0000
+++ /tmp/MERGED-123/v1.ConfigMap.apps.settings	2026-01-01 10:00:00.000000000 +0000
@@ -0,0 +1,8 @@
+apiVersion: v1
`

const twoObjects = `apiVersion: apps/v1
kind: Deployment
metadata: {name: api, namespace: apps}
---
apiVersion: v1
kind: ConfigMap
metadata: {name: settings, namespace: apps}
`

func previewHandler(diff string, diffCode int, diffErr string, dryRun Result) func([]string, RunOptions) Result {
	return func(args []string, _ RunOptions) Result {
		for _, a := range args {
			switch a {
			case "diff":
				return Result{Stdout: diff, Stderr: diffErr, Code: diffCode}
			case "--dry-run=server":
				return dryRun
			}
		}
		return Result{Stderr: "unexpected " + strings.Join(args, " "), Code: 1}
	}
}

func TestApplyPreviewRunsDiffAndServerDryRunAndParsesTheAnswer(t *testing.T) {
	list := map[string]any{"kind": "List", "items": []any{
		map[string]any{"kind": "Deployment", "metadata": map[string]any{"name": "api", "namespace": "apps"}},
		map[string]any{"kind": "ConfigMap", "metadata": map[string]any{"name": "settings", "namespace": "apps"}},
	}}
	dry := out(list, 0)
	dry.Stderr = "Warning: spec.template.spec.containers[0]: deprecated\nWarning: spec.template.spec.containers[0]: deprecated\n"
	f := newFixture(t, previewHandler(updateDiff, 1, "Warning: policy/v1beta1 PodSecurityPolicy is deprecated\n", dry))
	res := f.post("/api/apply/preview", map[string]any{"context": "dev", "namespace": "apps", "yaml": twoObjects})
	if res.Status != 200 || res.Value["error"] != "" || res.Value["changed"] != true || res.Value["diff"] != updateDiff {
		t.Fatalf("%d %v", res.Status, res.Value)
	}
	if len(f.calls) != 2 ||
		!reflect.DeepEqual(f.calls[0].Args, []string{"--context=dev", "--namespace=apps", "diff", "--field-manager=rubban", "--filename=-"}) ||
		!reflect.DeepEqual(f.calls[0].Opts.AllowExit, []int{0, 1}) || f.calls[0].Opts.Input != twoObjects ||
		!reflect.DeepEqual(f.calls[1].Args, []string{"--context=dev", "--namespace=apps", "apply", "--dry-run=server", "--field-manager=rubban", "--output=json", "--filename=-"}) {
		t.Fatalf("calls %+v", f.calls)
	}
	want := []any{
		map[string]any{"kind": "Deployment", "namespace": "apps", "name": "api", "created": false, "changed": true},
		map[string]any{"kind": "ConfigMap", "namespace": "apps", "name": "settings", "created": true, "changed": true},
	}
	if !reflect.DeepEqual(res.Value["objects"], want) {
		t.Fatalf("objects %v", res.Value["objects"])
	}
	wantWarnings := []any{"Warning: policy/v1beta1 PodSecurityPolicy is deprecated", "Warning: spec.template.spec.containers[0]: deprecated"}
	if !reflect.DeepEqual(res.Value["warnings"], wantWarnings) {
		t.Fatalf("warnings %v", res.Value["warnings"])
	}
	if res.Value["previewHash"] != manifestHash(twoObjects) {
		t.Fatalf("hash %v", res.Value["previewHash"])
	}
}

func TestApplyPreviewSingleObjectWithoutChanges(t *testing.T) {
	one := out(map[string]any{"kind": "ConfigMap", "metadata": map[string]any{"name": "example"}}, 0)
	f := newFixture(t, previewHandler("", 0, "", one))
	res := f.post("/api/apply/preview", map[string]any{"context": "dev", "yaml": manifest})
	want := []any{map[string]any{"kind": "ConfigMap", "name": "example", "created": false, "changed": false}}
	if res.Value["changed"] != false || res.Value["diff"] != "" || !reflect.DeepEqual(res.Value["objects"], want) || res.Value["previewHash"] == nil {
		t.Fatalf("%v", res.Value)
	}
	if !reflect.DeepEqual(f.calls[0].Args, []string{"--context=dev", "diff", "--field-manager=rubban", "--filename=-"}) {
		t.Fatalf("no namespace flag without a namespace: %v", f.calls[0].Args)
	}
}

func TestApplyPreviewReportsAdmissionFailuresInTheBodyWithoutAHash(t *testing.T) {
	denied := Result{Stderr: "Warning: something old\nError from server (Forbidden): admission webhook \"policy.example.com\" denied the request: replicas must be <= 5\n", Code: 1}
	f := newFixture(t, previewHandler("- a\n+ b\n", 1, "", denied))
	res := f.post("/api/apply/preview", map[string]any{"context": "dev", "namespace": "apps", "yaml": manifest})
	if res.Status != 200 || !strings.Contains(res.Value["error"].(string), "replicas must be <= 5") || strings.Contains(res.Value["error"].(string), "Warning:") {
		t.Fatalf("%d %v", res.Status, res.Value)
	}
	if res.Value["previewHash"] != nil || res.Value["diff"] != "- a\n+ b\n" {
		t.Fatalf("a failed review must not be appliable: %v", res.Value)
	}
	if !reflect.DeepEqual(res.Value["warnings"], []any{"Warning: something old"}) {
		t.Fatalf("warnings %v", res.Value["warnings"])
	}

	// kubectl diff itself failing (exit 2) is reported the same way, and the dry-run is not attempted.
	f = newFixture(t, previewHandler("", 2, "error: the server doesn't have a resource type \"Foo\"\n", Result{}))
	res = f.post("/api/apply/preview", map[string]any{"context": "dev", "yaml": manifest})
	if res.Status != 200 || !strings.Contains(res.Value["error"].(string), "doesn't have a resource type") || len(f.calls) != 1 {
		t.Fatalf("%d %v calls=%d", res.Status, res.Value, len(f.calls))
	}
}

func TestApplyPreviewKeepsCredentialFailuresAsErrorsAndValidatesInput(t *testing.T) {
	f := newFixture(t, previewHandler("", 1, "", Result{}))
	f.b.runner = func(_ context.Context, _ string, _ []string, _ RunOptions) (Result, error) {
		return Result{Stderr: "Unable to connect to the server: getting credentials: exec: executable gke-gcloud-auth-plugin failed with exit code 1", Code: 1}, nil
	}
	res := f.post("/api/apply/preview", map[string]any{"context": "dev", "yaml": manifest})
	if res.Status != 502 || res.Value["code"] != "credentials" {
		t.Fatalf("%d %v", res.Status, res.Value)
	}
	g := newFixture(t, nil)
	for name, body := range map[string]map[string]any{
		"bad yaml":   {"context": "dev", "yaml": "kind: ["},
		"no object":  {"context": "dev", "yaml": "hello: world"},
		"no context": {"yaml": manifest},
		"bad ns":     {"context": "dev", "namespace": "Bad NS", "yaml": manifest},
	} {
		if res := g.post("/api/apply/preview", body); res.Status != 400 {
			t.Errorf("%s: %d", name, res.Status)
		}
	}
	if len(g.calls) != 0 {
		t.Fatal("nothing may run for invalid input")
	}
}

func TestApplyRefusesAManifestThatChangedSinceThePreview(t *testing.T) {
	f := newFixture(t, nil)
	reviewed := manifest
	edited := strings.Replace(manifest, "hello", "goodbye", 1)
	body := map[string]any{"context": "dev", "namespace": "apps", "yaml": edited, "previewHash": manifestHash(reviewed)}
	if res := f.post("/api/apply", body); res.Status != 409 || res.Value["error"] != "The manifest changed since the preview" {
		t.Fatalf("%d %v", res.Status, res.Value)
	}
	if res := f.post("/api/apply", map[string]any{"context": "dev", "namespace": "apps", "yaml": edited}); res.Status != 400 {
		t.Fatalf("missing hash: %d", res.Status)
	}
	if len(f.calls) != 0 {
		t.Fatal("a stale or unreviewed manifest must never reach kubectl")
	}
	body["yaml"] = reviewed
	if res := f.post("/api/apply", body); res.Status != 200 || !contains(f.last().Args, "--field-manager=rubban") || contains(f.last().Args, "--force-conflicts") {
		t.Fatalf("%d %v", res.Status, f.calls)
	}
}

func TestCreatedFilesReadsKubectlDiffHeaders(t *testing.T) {
	got := createdFiles(updateDiff)
	want := map[string]bool{"apps.v1.Deployment.apps.api": false, "v1.ConfigMap.apps.settings": true}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%v", got)
	}
	cluster := createdFiles("diff -u -N /tmp/LIVE-1/rbac.authorization.k8s.io.v1.ClusterRole.reader /tmp/MERGED-1/rbac.authorization.k8s.io.v1.ClusterRole.reader\n--- a\n+++ b\n@@ -0,0 +1,3 @@\n")
	if !cluster["rbac.authorization.k8s.io.v1.ClusterRole.reader"] {
		t.Fatalf("%v", cluster)
	}
	objects := previewObjects(map[string]any{"kind": "ClusterRole", "metadata": map[string]any{"name": "reader"}}, "diff -u -N /tmp/L/rbac.authorization.k8s.io.v1.ClusterRole.reader /tmp/M/rbac.authorization.k8s.io.v1.ClusterRole.reader\n@@ -0,0 +1,3 @@\n")
	if len(objects) != 1 || !objects[0].Created {
		t.Fatalf("%+v", objects)
	}
}
