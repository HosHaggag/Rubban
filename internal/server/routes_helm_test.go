package server

import (
	"reflect"
	"strings"
	"testing"
)

func helmCalls(x *xfixture, first string) []call {
	return x.find(func(a []string) bool { return len(a) > 0 && a[0] == first })
}

func TestHelmListUsesAllNamespacesAndToleratesAnEmptyRepositoryList(t *testing.T) {
	x := newXFixture(t, func(c call) Result {
		if c.Args[0] == "repo" {
			return Result{Stderr: "no repositories to show", Code: 1}
		}
		return out([]any{map[string]any{"name": "web"}}, 0)
	})
	res := x.get("/api/helm?context=dev&namespace=*")
	if res.Status != 200 {
		t.Fatalf("status %d %s", res.Status, res.Raw)
	}
	if !reflect.DeepEqual(res.Value["releases"], []any{map[string]any{"name": "web"}}) || !reflect.DeepEqual(res.Value["repositories"], []any{}) || !reflect.DeepEqual(res.Value["warnings"], []any{}) {
		t.Fatalf("body %s", res.Raw)
	}
	list := helmCalls(x, "list")
	if len(list) != 1 || !hasArg(list[0].Args, "--all-namespaces") || !hasArg(list[0].Args, "--kube-context=dev") || list[0].Command != "test-helm" {
		t.Fatalf("list call %v", list)
	}
	one := x.get("/api/helm?context=dev&namespace=apps")
	if one.Status != 200 || !hasArg(helmCalls(x, "list")[1].Args, "--namespace=apps") {
		t.Fatalf("namespace list %d %v", one.Status, helmCalls(x, "list"))
	}
}

func TestHelmListFailureAndRepositoryWarning(t *testing.T) {
	x := newXFixture(t, func(c call) Result {
		if c.Args[0] == "list" {
			return fail("Error: Kubernetes cluster unreachable")
		}
		return out([]any{}, 0)
	})
	res := x.get("/api/helm?context=dev")
	if res.Status != 502 || !strings.Contains(res.Value["error"].(string), "cluster unreachable") {
		t.Fatalf("%d %s", res.Status, res.Raw)
	}
	if x.get("/api/helm").Status != 400 {
		t.Fatal("context is required")
	}
}

func TestHelmChartBrowserListsChartsAndReportsAnEmptySetupWithoutFailing(t *testing.T) {
	charts := []any{map[string]any{"name": "bitnami/nginx", "version": "18.1.0", "app_version": "1.27.1", "description": "NGINX Open Source"}}
	x := newXFixture(t, func(c call) Result {
		if c.Args[0] == "search" {
			return out(charts, 0)
		}
		return out([]any{map[string]any{"name": "bitnami", "url": "https://charts.bitnami.com/bitnami"}}, 0)
	})
	res := x.get("/api/helm/charts")
	if res.Status != 200 || !reflect.DeepEqual(res.Value["charts"], charts) {
		t.Fatalf("%d %s", res.Status, res.Raw)
	}
	if res.Value["repositories"].([]any)[0].(map[string]any)["name"] != "bitnami" {
		t.Fatalf("repositories %v", res.Value["repositories"])
	}
	search := helmCalls(x, "search")[0]
	if !reflect.DeepEqual(search.Args, []string{"search", "repo", "--output=json"}) || search.Command != "test-helm" {
		t.Fatalf("search %v", search)
	}

	none := newXFixture(t, func(call) Result { return fail("Error: no repositories configured") })
	empty := none.get("/api/helm/charts")
	if empty.Status != 200 || !reflect.DeepEqual(empty.Value, map[string]any{"charts": []any{}, "repositories": []any{}, "warnings": []any{}}) {
		t.Fatalf("%d %s", empty.Status, empty.Raw)
	}
	broken := newXFixture(t, func(call) Result { return fail("Error: repo index is corrupt") })
	if w := broken.get("/api/helm/charts").Value["warnings"].([]any); len(w) != 2 || w[0] != "Error: repo index is corrupt" {
		t.Fatalf("warnings %v", w)
	}
}

func TestHelmChartDetails(t *testing.T) {
	x := newXFixture(t, func(c call) Result {
		switch c.Args[0] + " " + c.Args[1] {
		case "show readme":
			return Result{Stdout: "# nginx"}
		case "show values":
			return fail("Error: values missing")
		}
		return out([]any{
			map[string]any{"name": "bitnami/nginx", "version": "18.1.0", "app_version": "1.27.1", "description": "NGINX"},
			map[string]any{"name": "bitnami/nginx-ingress", "version": "9.9.9"},
			map[string]any{"name": "bitnami/nginx", "version": "18.0.0"},
		}, 0)
	})
	res := x.get("/api/helm/chart?chart=bitnami/nginx")
	if res.Status != 200 {
		t.Fatalf("%d %s", res.Status, res.Raw)
	}
	if res.Value["version"] != "18.1.0" || res.Value["readme"] != "# nginx" || res.Value["values"] != "" {
		t.Fatalf("body %s", res.Raw)
	}
	versions := res.Value["versions"].([]any)
	if !reflect.DeepEqual(versions[0], map[string]any{"version": "18.1.0", "appVersion": "1.27.1", "description": "NGINX"}) || len(versions) != 2 {
		t.Fatalf("versions %v", versions)
	}
	if w := res.Value["warnings"].([]any); len(w) != 1 || !strings.Contains(w[0].(string), "values missing") {
		t.Fatalf("warnings %v", w)
	}
	show := x.find(func(a []string) bool { return a[0] == "show" && a[1] == "readme" })
	if len(show) != 1 || show[0].Opts.MaxBytes != 4*1024*1024 {
		t.Fatalf("show readme %v", show)
	}
	pinned := x.get("/api/helm/chart?chart=bitnami/nginx&version=17.0.0")
	if pinned.Value["version"] != "17.0.0" {
		t.Fatalf("version %v", pinned.Value["version"])
	}
	if !hasArg(x.find(func(a []string) bool { return a[0] == "show" })[len(x.find(func(a []string) bool { return a[0] == "show" }))-1].Args, "--version=17.0.0") {
		t.Fatal("version flag not passed")
	}
	for _, bad := range []string{"nginx", "../x/y", "a/b/c", "-x/y"} {
		if r := x.get("/api/helm/chart?chart=" + bad); r.Status != 400 {
			t.Fatalf("%s: %d", bad, r.Status)
		}
	}
}

func TestHelmReleaseDetails(t *testing.T) {
	manifest := "---\n# Source: web/templates/svc.yaml\napiVersion: v1\nkind: Service\nmetadata:\n  name: web\n  namespace: apps\n---\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n---\n\n---\nnot: [valid\n---\nkind: Orphan\n"
	x := newXFixture(t, func(c call) Result {
		switch {
		case c.Args[0] == "get" && c.Args[1] == "values" && hasArg(c.Args, "--all"):
			return Result{Stdout: "all: true\n"}
		case c.Args[0] == "get" && c.Args[1] == "values":
			return Result{Stdout: "replicas: 2\n"}
		case c.Args[0] == "get" && c.Args[1] == "notes":
			return Result{Stderr: "Error: no notes", Code: 1}
		case c.Args[0] == "get" && c.Args[1] == "manifest":
			return Result{Stdout: manifest}
		case c.Args[0] == "history":
			return out([]any{map[string]any{"revision": 1}}, 0)
		}
		return fail("unexpected")
	})
	res := x.get("/api/helm/release?context=dev&namespace=apps&name=web")
	if res.Status != 200 {
		t.Fatalf("%d %s", res.Status, res.Raw)
	}
	if res.Value["values"] != "replicas: 2\n" || res.Value["allValues"] != "all: true\n" || res.Value["notes"] != "" {
		t.Fatalf("body %s", res.Raw)
	}
	want := []any{
		map[string]any{"apiVersion": "v1", "kind": "Service", "name": "web", "namespace": "apps"},
		map[string]any{"apiVersion": "apps/v1", "kind": "Deployment", "name": "web", "namespace": ""},
	}
	if !reflect.DeepEqual(res.Value["resources"], want) {
		t.Fatalf("resources %v", res.Value["resources"])
	}
	history := helmCalls(x, "history")[0]
	if !reflect.DeepEqual(history.Args, []string{"history", "web", "--kube-context=dev", "--namespace=apps", "--max=50", "--output=json"}) {
		t.Fatalf("history %v", history.Args)
	}
	manifestCall := x.find(func(a []string) bool { return a[0] == "get" && a[1] == "manifest" })[0]
	if manifestCall.Opts.MaxBytes != 16*1024*1024 {
		t.Fatal("manifest cap")
	}
	if len(helmCalls(x, "get")) != 4 {
		t.Fatalf("get calls %d", len(helmCalls(x, "get")))
	}

	// Only a history failure is fatal.
	failing := newXFixture(t, func(c call) Result {
		if c.Args[0] == "history" {
			return fail("Error: release: not found")
		}
		return fail("other failure")
	})
	if r := failing.get("/api/helm/release?context=dev&namespace=apps&name=web"); r.Status != 502 || !strings.Contains(r.Value["error"].(string), "not found") {
		t.Fatalf("%d %s", r.Status, r.Raw)
	}
	if r := x.get("/api/helm/release?context=dev&namespace=apps&name=-bad"); r.Status != 400 {
		t.Fatalf("bad name %d", r.Status)
	}
}

func TestHelmMutationsValidateActionsAndSendValuesOnStdin(t *testing.T) {
	x := newXFixture(t, func(call) Result { return Result{Stdout: "release updated"} })
	values := "replicaCount: 2\n"
	res := x.post("/api/helm", map[string]any{"action": "upgrade", "context": "dev", "namespace": "apps", "name": "web", "chart": "stable/web", "version": "1.2.3", "values": values})
	if res.Status != 200 || res.Value["output"] != "release updated" {
		t.Fatalf("%d %s", res.Status, res.Raw)
	}
	last := x.last()
	if !reflect.DeepEqual(last.Args, []string{"upgrade", "web", "stable/web", "--kube-context=dev", "--namespace=apps", "--version=1.2.3", "--values=-"}) {
		t.Fatalf("args %v", last.Args)
	}
	if last.Opts.Input != values || last.Opts.Timeout.Seconds() != 300 || last.Command != "test-helm" {
		t.Fatalf("opts %+v", last)
	}
	for name, body := range map[string]map[string]any{
		"unknown action":     {"action": "plugin", "name": "x"},
		"file url":           {"action": "repo-add", "repo": "x", "url": "file:///private/file"},
		"credentials in url": {"action": "repo-add", "repo": "x", "url": "https://user:pass@example.com/"},
		"fragment in url":    {"action": "repo-add", "repo": "x", "url": "https://example.com/#x"},
		"no scheme":          {"action": "repo-add", "repo": "x", "url": "example.com"},
		"chart traversal":    {"action": "install", "context": "dev", "name": "x", "chart": "../private"},
		"bad revision":       {"action": "rollback", "context": "dev", "name": "x", "revision": 0},
		"values not text":    {"action": "install", "context": "dev", "name": "x", "chart": "a/b", "values": 5},
		"values invalid":     {"action": "install", "context": "dev", "name": "x", "chart": "a/b", "values": "a: [b"},
		"missing release":    {"action": "uninstall", "context": "dev"},
	} {
		if r := x.post("/api/helm", body); r.Status != 400 {
			t.Fatalf("%s: status %d %s", name, r.Status, r.Raw)
		}
	}
	before := len(x.commands())
	if r := x.post("/api/helm", map[string]any{"action": "repo-add", "repo": "public", "url": "https://charts.example.com"}); r.Status != 200 {
		t.Fatalf("repo-add %d", r.Status)
	}
	if len(x.commands()) != before+1 || !reflect.DeepEqual(x.last().Args, []string{"repo", "add", "public", "https://charts.example.com/"}) {
		t.Fatalf("repo add args %v", x.last().Args)
	}
	cases := []struct {
		body map[string]any
		want []string
	}{
		{map[string]any{"action": "repo-remove", "repo": "bitnami"}, []string{"repo", "remove", "bitnami"}},
		{map[string]any{"action": "repo-update"}, []string{"repo", "update"}},
		{map[string]any{"action": "repo-update", "repo": "bitnami"}, []string{"repo", "update", "bitnami"}},
		{map[string]any{"action": "uninstall", "context": "dev", "namespace": "apps", "name": "web"}, []string{"uninstall", "web", "--kube-context=dev", "--namespace=apps"}},
		{map[string]any{"action": "rollback", "context": "dev", "namespace": "apps", "name": "web", "revision": "3"}, []string{"rollback", "web", "3", "--kube-context=dev", "--namespace=apps"}},
		{map[string]any{"action": "install", "context": "dev", "name": "web", "chart": "oci://registry.example.com/charts/web"}, []string{"install", "web", "oci://registry.example.com/charts/web", "--kube-context=dev"}},
	}
	for _, c := range cases {
		if r := x.post("/api/helm", c.body); r.Status != 200 {
			t.Fatalf("%v: %d %s", c.body, r.Status, r.Raw)
		}
		if got := x.last().Args; !reflect.DeepEqual(got, c.want) || x.last().Opts.Input != "" {
			t.Fatalf("args %v, want %v", got, c.want)
		}
	}
	// Values are ignored for uninstall and rollback.
	x.post("/api/helm", map[string]any{"action": "uninstall", "context": "dev", "name": "web", "values": 5})
	if hasArg(x.last().Args, "--values=-") {
		t.Fatal("values sent on uninstall")
	}
}

func TestHelmOutputCombinesStdoutAndStderr(t *testing.T) {
	x := newXFixture(t, func(call) Result { return Result{Stdout: "out\n", Stderr: "warn\n"} })
	res := x.post("/api/helm", map[string]any{"action": "uninstall", "context": "dev", "name": "web"})
	if res.Value["output"] != "out\nwarn\n" {
		t.Fatalf("%s", res.Raw)
	}
}
