package server

import (
	"reflect"
	"strings"
	"testing"
)

func deployment(image string, replicas int, extraMeta map[string]any) map[string]any {
	meta := map[string]any{
		"name": "api", "namespace": "apps", "uid": "abc-123", "resourceVersion": "9981", "generation": 7.0, "creationTimestamp": "2026-01-01T00:00:00Z",
		"selfLink":      "/apis/apps/v1/namespaces/apps/deployments/api",
		"managedFields": []any{map[string]any{"manager": "kubectl"}},
		"labels":        map[string]any{"app": "api", "tier": "backend"},
		"annotations": map[string]any{
			"kubectl.kubernetes.io/last-applied-configuration": "{...}", "deployment.kubernetes.io/revision": "12",
			"autoscaling.alpha.kubernetes.io/conditions": "[]", "autoscaling.alpha.kubernetes.io/current-metrics": "[]",
			"team": "payments",
		},
	}
	for k, v := range extraMeta {
		meta[k] = v
	}
	return map[string]any{
		"apiVersion": "apps/v1", "kind": "Deployment", "metadata": meta,
		"spec":   map[string]any{"replicas": float64(replicas), "template": map[string]any{"spec": map[string]any{"containers": []any{map[string]any{"name": "app", "image": image}}}}},
		"status": map[string]any{"availableReplicas": float64(replicas), "conditions": []any{}},
	}
}

func TestNormalizeDropsExactlyTheNoisyFields(t *testing.T) {
	got := normalizeForCompare(deployment("api:1", 2, nil), false)
	want := map[string]any{
		"apiVersion": "apps/v1", "kind": "Deployment",
		"metadata": map[string]any{"name": "api", "namespace": "apps", "labels": map[string]any{"app": "api", "tier": "backend"}, "annotations": map[string]any{"team": "payments"}},
		"spec":     map[string]any{"replicas": 2.0, "template": map[string]any{"spec": map[string]any{"containers": []any{map[string]any{"name": "app", "image": "api:1"}}}}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%v", got)
	}
	withStatus := normalizeForCompare(deployment("api:1", 2, nil), true)
	if withStatus["status"] == nil || objOf(withStatus["metadata"])["uid"] != nil {
		t.Fatalf("status is kept on request, metadata noise is still dropped: %v", withStatus)
	}
	// The input is not modified.
	in := deployment("api:1", 2, nil)
	normalizeForCompare(in, false)
	if objOf(in["metadata"])["uid"] != "abc-123" || in["status"] == nil || objOf(objOf(in["metadata"])["annotations"])["deployment.kubernetes.io/revision"] != "12" {
		t.Fatal("normalizeForCompare modified its argument")
	}
}

func TestNormalizeRemovesAnAnnotationsMapThatBecomesEmpty(t *testing.T) {
	only := deployment("a", 1, map[string]any{"annotations": map[string]any{"deployment.kubernetes.io/revision": "3"}})
	if _, ok := objOf(normalizeForCompare(only, false)["metadata"])["annotations"]; ok {
		t.Fatal("an empty annotations map must not remain")
	}
	none := deployment("a", 1, nil)
	delete(objOf(none["metadata"]), "annotations")
	if !reflect.DeepEqual(normalizeForCompare(only, false)["metadata"], normalizeForCompare(none, false)["metadata"]) {
		t.Fatal("an object without annotations and one with only noisy ones must compare equal")
	}
	if got := normalizeForCompare(nil, false); len(got) != 0 {
		t.Fatalf("%v", got)
	}
}

func TestCompareYAMLIsSortedAndStable(t *testing.T) {
	a := deployment("api:1", 2, nil)
	b := deployment("api:1", 2, nil)
	first, err := compareYAML(a, false)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 20; i++ {
		again, _ := compareYAML(b, false)
		if again != first {
			t.Fatal("output is not stable")
		}
	}
	if !strings.HasPrefix(first, "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  annotations:\n    team: payments\n  labels:\n    app: api\n    tier: backend\n  name: api\n  namespace: apps\nspec:\n") {
		t.Fatalf("order: %s", first)
	}
	for _, noise := range []string{"uid", "resourceVersion", "managedFields", "status:", "last-applied"} {
		if strings.Contains(first, noise) {
			t.Fatalf("%q in %s", noise, first)
		}
	}
}

func compareFixture(t *testing.T, prod, staging map[string]any, prodErr, stagingErr string) *fixture {
	t.Helper()
	return newFixture(t, func(args []string, _ RunOptions) Result {
		for _, a := range args {
			switch a {
			case "--context=prod":
				if prodErr != "" {
					return Result{Stderr: prodErr, Code: 1}
				}
				return out(prod, 0)
			case "--context=staging":
				if stagingErr != "" {
					return Result{Stderr: stagingErr, Code: 1}
				}
				return out(staging, 0)
			}
		}
		return Result{Stderr: "unexpected " + strings.Join(args, " "), Code: 1}
	})
}

func compareBody(extra map[string]any) map[string]any {
	body := map[string]any{
		"left":  map[string]any{"context": "prod", "namespace": "apps", "resource": "deployments", "name": "api"},
		"right": map[string]any{"context": "staging", "namespace": "apps-stg", "resource": "deployments", "name": "api"},
	}
	for k, v := range extra {
		body[k] = v
	}
	return body
}

func TestCompareReadsBothSidesAndReturnsCleanYAML(t *testing.T) {
	f := compareFixture(t, deployment("api:1.4", 6, nil), deployment("api:1.5", 2, nil), "", "")
	res := f.post("/api/compare", compareBody(nil))
	if res.Status != 200 {
		t.Fatalf("%d %v", res.Status, res.Value)
	}
	left, right := res.Value["left"].(string), res.Value["right"].(string)
	if !strings.Contains(left, "image: api:1.4") || !strings.Contains(left, "replicas: 6") || !strings.Contains(right, "image: api:1.5") || !strings.Contains(right, "replicas: 2") {
		t.Fatalf("left:\n%s\nright:\n%s", left, right)
	}
	for _, noise := range []string{"uid", "managedFields", "resourceVersion", "status:"} {
		if strings.Contains(left+right, noise) {
			t.Fatalf("%q survived", noise)
		}
	}
	wantLeft := map[string]any{"context": "prod", "namespace": "apps", "resource": "deployments", "name": "api"}
	if !reflect.DeepEqual(res.Value["leftMeta"], wantLeft) || res.Value["rightMeta"].(map[string]any)["namespace"] != "apps-stg" || res.Value["leftError"] != nil {
		t.Fatalf("%v", res.Value)
	}
	if len(f.calls) != 2 || !contains(f.calls[0].Args, "get") && !contains(f.calls[1].Args, "get") {
		t.Fatalf("calls %v", f.calls)
	}
	withStatus := f.post("/api/compare", compareBody(map[string]any{"includeStatus": true}))
	if !strings.Contains(withStatus.Value["left"].(string), "availableReplicas: 6") || withStatus.Value["includeStatus"] != true {
		t.Fatalf("%v", withStatus.Value["left"])
	}
}

func TestCompareReportsAFailureOnItsOwnSide(t *testing.T) {
	f := compareFixture(t, deployment("api:1", 1, nil), nil, "", `Error from server (NotFound): deployments.apps "api" not found`)
	res := f.post("/api/compare", compareBody(nil))
	if res.Status != 200 || res.Value["leftError"] != nil || res.Value["left"] == "" || res.Value["right"] != "" || !strings.Contains(res.Value["rightError"].(string), "not found") {
		t.Fatalf("%d %v", res.Status, res.Value)
	}
	both := compareFixture(t, nil, nil, "Unable to connect to the server: getting credentials: exec: executable gke-gcloud-auth-plugin failed with exit code 1", "forbidden")
	res = both.post("/api/compare", compareBody(nil))
	if res.Status != 502 || res.Value["code"] != "credentials" {
		t.Fatalf("both failing is an error: %d %v", res.Status, res.Value)
	}
}

func TestCompareRefusesSecretsAndInvalidInput(t *testing.T) {
	f := compareFixture(t, deployment("a", 1, nil), deployment("a", 1, nil), "", "")
	for _, resource := range []string{"secrets", "secrets.v1", "secret"} {
		body := compareBody(nil)
		body["right"].(map[string]any)["resource"] = resource
		if res := f.post("/api/compare", body); res.Status != 400 || !strings.Contains(res.Value["error"].(string), "Secrets cannot be compared") {
			t.Errorf("%s: %d %v", resource, res.Status, res.Value)
		}
	}
	cases := map[string]func(m map[string]any){
		"no left":       func(m map[string]any) { delete(m, "left") },
		"left not obj":  func(m map[string]any) { m["left"] = "prod" },
		"no context":    func(m map[string]any) { delete(m["right"].(map[string]any), "context") },
		"bad namespace": func(m map[string]any) { m["left"].(map[string]any)["namespace"] = "Bad NS" },
		"bad resource":  func(m map[string]any) { m["left"].(map[string]any)["resource"] = "Pods;rm" },
		"no name":       func(m map[string]any) { delete(m["left"].(map[string]any), "name") },
	}
	for name, mutate := range cases {
		body := compareBody(nil)
		mutate(body)
		if res := f.post("/api/compare", body); res.Status != 400 {
			t.Errorf("%s: %d", name, res.Status)
		}
	}
	if len(f.calls) != 0 {
		t.Fatalf("nothing may run for refused input: %d calls", len(f.calls))
	}
	// A Secret that comes back from a differently named resource is refused too.
	g := compareFixture(t, map[string]any{"kind": "Secret", "metadata": map[string]any{"name": "x"}, "data": map[string]any{"k": "dg=="}}, deployment("a", 1, nil), "", "")
	body := compareBody(nil)
	body["left"].(map[string]any)["resource"] = "opaquethings"
	res := g.post("/api/compare", body)
	if res.Status != 400 || strings.Contains(string(res.Raw), "dg==") {
		t.Fatalf("%d %s", res.Status, res.Raw)
	}
}
