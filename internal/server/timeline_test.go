package server

import (
	"encoding/json"
	"strings"
	"testing"
)

func configList(items ...map[string]any) Result { return out(map[string]any{"items": items}, 0) }

func TestTimelineConfigReturnsNamesAndWriteTimesButNeverSecretData(t *testing.T) {
	secret := map[string]any{
		"metadata": map[string]any{"name": "db-credentials", "namespace": "shop", "uid": "u2", "creationTimestamp": "2026-11-06T10:00:00Z",
			"annotations": map[string]any{"kubectl.kubernetes.io/last-applied-configuration": `{"data":{"hunter":"aHVudGVyMg=="}}`},
			"managedFields": []any{
				map[string]any{"manager": "kubectl-edit", "operation": "Update", "time": "2026-11-06T12:00:00Z"},
				map[string]any{"manager": "kubectl-client-side-apply", "operation": "Update", "time": "2026-11-06T10:00:00Z"},
			}},
		"data": map[string]any{"hunter": "aHVudGVyMg=="},
	}
	cm := map[string]any{"metadata": map[string]any{"name": "storefront-config", "namespace": "shop", "creationTimestamp": "2026-11-06T09:00:00Z",
		"ownerReferences": []any{map[string]any{"kind": "HelmRelease", "name": "x"}, map[string]any{"kind": "Application", "name": "shop", "controller": true}},
		"managedFields":   []any{map[string]any{"manager": "argocd-controller", "operation": "Apply", "time": "2026-11-06T11:30:00Z"}, map[string]any{"manager": "no-time"}}}}
	x := newXFixture(t, func(c call) Result {
		switch rawPath(c.Args) {
		case "/api/v1/namespaces/shop/configmaps":
			return configList(cm)
		case "/api/v1/namespaces/shop/secrets":
			return configList(secret)
		}
		return fail("unexpected " + strings.Join(c.Args, " "))
	})
	res := x.get("/api/timeline/config?context=prod&namespace=shop")
	if res.Status != 200 {
		t.Fatalf("status %d %s", res.Status, res.Raw)
	}
	for _, leak := range []string{"aHVudGVyMg", "hunter", "last-applied"} {
		if strings.Contains(string(res.Raw), leak) {
			t.Fatalf("payload leaks %q: %s", leak, res.Raw)
		}
	}
	var body struct {
		Items    []configEntry `json:"items"`
		Warnings []string      `json:"warnings"`
	}
	if err := json.Unmarshal(res.Raw, &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Items) != 2 || len(body.Warnings) != 0 {
		t.Fatalf("items %+v warnings %v", body.Items, body.Warnings)
	}
	gotCM, gotSecret := body.Items[0], body.Items[1]
	if gotCM.Kind != "ConfigMap" || gotCM.Owner != "Application/shop" || len(gotCM.Writes) != 1 || gotCM.Writes[0].Operation != "Apply" || gotCM.Writes[0].Manager != "argocd-controller" {
		t.Fatalf("configmap %+v", gotCM)
	}
	if gotSecret.Kind != "Secret" || gotSecret.Name != "db-credentials" || len(gotSecret.Writes) != 2 || gotSecret.Writes[0].Time != "2026-11-06T10:00:00Z" || gotSecret.Writes[1].Manager != "kubectl-edit" {
		t.Fatalf("secret writes are sorted by time: %+v", gotSecret)
	}
	for _, c := range x.commands() {
		if !hasArg(c.Args, "--context=prod") {
			t.Fatalf("context missing: %v", c.Args)
		}
	}
}

func TestTimelineConfigToleratesAForbiddenSecretListAndValidatesInput(t *testing.T) {
	x := newXFixture(t, func(c call) Result {
		if strings.HasSuffix(rawPath(c.Args), "/secrets") {
			return fail(`Error from server (Forbidden): secrets is forbidden: User "dev" cannot list resource "secrets"`)
		}
		return configList(map[string]any{"metadata": map[string]any{"name": "app", "namespace": "a"}})
	})
	res := x.get("/api/timeline/config?context=dev&namespace=*")
	if res.Status != 200 {
		t.Fatalf("status %d %s", res.Status, res.Raw)
	}
	if items := res.Value["items"].([]any); len(items) != 1 {
		t.Fatalf("items %v", items)
	}
	if w := res.Value["warnings"].([]any); len(w) != 1 || !strings.HasPrefix(w[0].(string), "Secrets: ") {
		t.Fatalf("warnings %v", w)
	}
	if paths := []string{rawPath(x.commands()[0].Args), rawPath(x.commands()[1].Args)}; !(strings.HasPrefix(paths[0], "/api/v1/configmaps") || strings.HasPrefix(paths[1], "/api/v1/configmaps")) {
		t.Fatalf("all namespaces lists the cluster-wide collection: %v", paths)
	}

	down := newXFixture(t, func(call) Result { return fail("Unable to connect to the server") })
	if res := down.get("/api/timeline/config?context=dev&namespace=a"); res.Status < 400 {
		t.Fatalf("both lists failing is an error: %d %s", res.Status, res.Raw)
	}
	for _, route := range []string{"/api/timeline/config", "/api/timeline/config?context=dev&namespace=Bad_NS", "/api/timeline/helm", "/api/timeline/helm?context=dev&namespace=../x"} {
		if res := down.get(route); res.Status != 400 {
			t.Fatalf("%s: %d", route, res.Status)
		}
	}
}

func TestTimelineHelmReadsTheHistoryOfEveryReleaseInScope(t *testing.T) {
	x := newXFixture(t, func(c call) Result {
		switch c.Args[0] {
		case "list":
			return out([]any{
				map[string]any{"name": "search", "namespace": "data", "chart": "shop-search-1.3.0", "status": "deployed", "updated": "2026-11-06 17:16:51.6 +0300 +03"},
				map[string]any{"name": "recommendations", "namespace": "shop", "chart": "shop-search-1.4.0", "status": "deployed", "updated": "2026-11-06 17:20:00.0 +0300 +03"},
				map[string]any{"name": "Bad Name", "namespace": "shop"},
			}, 0)
		case "history":
			if hasArg(c.Args, "recommendations") {
				return out([]any{
					map[string]any{"revision": 1, "updated": "2026-11-06T17:16:52+03:00", "status": "superseded", "chart": "shop-search-1.3.0", "app_version": "2.4.0", "description": "Install complete"},
					map[string]any{"revision": 2, "updated": "2026-11-06T17:20:00+03:00", "status": "deployed", "chart": "shop-search-1.4.0", "app_version": "2.5.0", "description": "Upgrade complete"},
				}, 0)
			}
			return fail("Error: release: not found")
		}
		return fail("unexpected")
	})
	res := x.get("/api/timeline/helm?context=prod&namespace=*")
	if res.Status != 200 {
		t.Fatalf("status %d %s", res.Status, res.Raw)
	}
	var body struct {
		Releases []helmTimelineRelease `json:"releases"`
		Warnings []string              `json:"warnings"`
	}
	if err := json.Unmarshal(res.Raw, &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Releases) != 2 || body.Releases[0].Name != "recommendations" {
		t.Fatalf("newest release first, invalid names skipped: %+v", body.Releases)
	}
	rec := body.Releases[0]
	if len(rec.History) != 2 || rec.History[1].Revision != 2 || rec.History[1].AppVersion != "2.5.0" || rec.History[1].Chart != "shop-search-1.4.0" {
		t.Fatalf("history %+v", rec.History)
	}
	if body.Releases[1].Error == "" || len(body.Warnings) != 1 || !strings.Contains(body.Warnings[0], "data/search") {
		t.Fatalf("a failed history is a warning, not a failure: %+v %v", body.Releases[1], body.Warnings)
	}
	list := helmCalls(x, "list")
	if len(list) != 1 || !hasArg(list[0].Args, "--all-namespaces") || !hasArg(list[0].Args, "--kube-context=prod") {
		t.Fatalf("list %v", list)
	}
	for _, h := range helmCalls(x, "history") {
		if !hasArg(h.Args, "--max=10") || !hasArg(h.Args, "--output=json") || !hasArg(h.Args, "--kube-context=prod") {
			t.Fatalf("history args %v", h.Args)
		}
	}
	if !hasArg(helmCalls(x, "history")[0].Args, "--namespace=shop") && !hasArg(helmCalls(x, "history")[1].Args, "--namespace=shop") {
		t.Fatal("history runs in the release's namespace")
	}
}

func TestTimelineHelmDegradesToAWarning(t *testing.T) {
	x := newXFixture(t, func(call) Result { return fail("Error: Kubernetes cluster unreachable") })
	res := x.get("/api/timeline/helm?context=prod&namespace=shop")
	if res.Status != 200 || len(res.Value["releases"].([]any)) != 0 || !strings.Contains(res.Value["warnings"].([]any)[0].(string), "cluster unreachable") {
		t.Fatalf("%d %s", res.Status, res.Raw)
	}
	if !hasArg(helmCalls(x, "list")[0].Args, "--namespace=shop") {
		t.Fatalf("namespace scope %v", helmCalls(x, "list")[0].Args)
	}
}

func TestInt64OfAny(t *testing.T) {
	for _, c := range []struct {
		in   any
		want int64
	}{{float64(3), 3}, {json.Number("4"), 4}, {"12", 12}, {"x1", 0}, {nil, 0}, {int64(7), 7}} {
		if got := int64OfAny(c.in); got != c.want {
			t.Fatalf("%v: %d", c.in, got)
		}
	}
}
