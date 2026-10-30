package server

import (
	"errors"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

func TestResourceActionsBuildExactKubectlArguments(t *testing.T) {
	x := newXFixture(t, func(call) Result { return Result{Stdout: "done\n"} })
	post := func(route string, body map[string]any) response { return x.post(route, body) }
	want := func(args ...string) {
		t.Helper()
		if got := x.last().Args; !reflect.DeepEqual(got, args) {
			t.Fatalf("args %v, want %v", got, args)
		}
	}
	res := post("/api/node", map[string]any{"context": "dev", "name": "node-a", "action": "drain", "timeoutSeconds": 120, "ignoreDaemonsets": true, "deleteEmptyDirData": false, "force": false, "gracePeriodSeconds": "30"})
	if res.Status != 200 || res.Value["output"] != "done" {
		t.Fatalf("%d %s", res.Status, res.Raw)
	}
	want("--context=dev", "drain", "node-a", "--timeout=120s", "--ignore-daemonsets=true", "--delete-emptydir-data=false", "--force=false", "--grace-period=30")
	if x.last().Opts.Timeout.Seconds() != 150 {
		t.Fatalf("drain timeout %v", x.last().Opts.Timeout)
	}
	post("/api/node", map[string]any{"context": "dev", "name": "node-a", "action": "drain"})
	want("--context=dev", "drain", "node-a", "--timeout=300s", "--ignore-daemonsets=true", "--delete-emptydir-data=true", "--force=false")
	post("/api/node", map[string]any{"context": "dev", "name": "node-a", "action": "drain", "force": true, "ignoreDaemonsets": false})
	want("--context=dev", "drain", "node-a", "--timeout=300s", "--ignore-daemonsets=false", "--delete-emptydir-data=true", "--force=true")
	post("/api/node", map[string]any{"context": "dev", "name": "node-a", "action": "cordon"})
	want("--context=dev", "cordon", "node-a")
	post("/api/node", map[string]any{"context": "dev", "name": "node-a", "action": "uncordon"})
	want("--context=dev", "uncordon", "node-a")
	if post("/api/node", map[string]any{"context": "dev", "name": "node-a", "action": "reboot"}).Status != 400 {
		t.Fatal("unknown node action")
	}
	if post("/api/node", map[string]any{"context": "dev", "name": "node-a", "action": "drain", "timeoutSeconds": 5}).Status != 400 {
		t.Fatal("drain timeout lower bound")
	}
	// Negative sentinels are accepted where the range allows them.
	post("/api/node", map[string]any{"context": "dev", "name": "node-a", "action": "drain", "timeoutSeconds": 60, "gracePeriodSeconds": "-1"})
	if !hasArg(x.last().Args, "--grace-period=-1") {
		t.Fatalf("args %v", x.last().Args)
	}
	if post("/api/node", map[string]any{"context": "dev", "name": "node-a", "action": "drain", "timeoutSeconds": 60, "gracePeriodSeconds": "-2"}).Status != 400 {
		t.Fatal("grace period below -1")
	}

	if post("/api/cronjob", map[string]any{"context": "dev", "namespace": "apps", "name": "backup", "action": "suspend"}).Status != 200 {
		t.Fatal("suspend")
	}
	want("--context=dev", "--namespace=apps", "patch", "cronjob", "backup", "--type=merge", `--patch={"spec":{"suspend":true}}`)
	post("/api/cronjob", map[string]any{"context": "dev", "namespace": "apps", "name": "backup", "action": "resume"})
	want("--context=dev", "--namespace=apps", "patch", "cronjob", "backup", "--type=merge", `--patch={"spec":{"suspend":false}}`)
	post("/api/cronjob", map[string]any{"context": "dev", "namespace": "apps", "name": "backup", "action": "trigger"})
	if !regexp.MustCompile(`^--context=dev --namespace=apps create job backup-manual-[0-9a-f]{6} --from=cronjob/backup$`).MatchString(strings.Join(x.last().Args, " ")) {
		t.Fatalf("trigger args %v", x.last().Args)
	}
	long := strings.Repeat("a", 60) + ".b"
	post("/api/cronjob", map[string]any{"context": "dev", "namespace": "apps", "name": long, "action": "trigger"})
	job := x.last().Args[4]
	if len(job) != 44+len("-manual-")+6 || strings.Contains(job, ".") {
		t.Fatalf("job name %q", job)
	}
	post("/api/cronjob", map[string]any{"context": "dev", "namespace": "apps", "name": "a.b", "action": "trigger"})
	if !strings.HasPrefix(x.last().Args[4], "a-b-manual-") {
		t.Fatalf("dots become dashes: %v", x.last().Args)
	}
	if post("/api/cronjob", map[string]any{"context": "dev", "namespace": "apps", "name": "backup", "action": "delete"}).Status != 400 {
		t.Fatal("unknown cronjob action")
	}

	post("/api/rollout-undo", map[string]any{"context": "dev", "namespace": "apps", "resource": "deployments", "name": "web", "revision": 3})
	want("--context=dev", "--namespace=apps", "rollout", "undo", "deployments/web", "--to-revision=3")
	if post("/api/rollout-undo", map[string]any{"context": "dev", "namespace": "apps", "resource": "pods", "name": "web", "revision": 3}).Status != 400 {
		t.Fatal("rollout undo on pods")
	}
	if post("/api/rollout-undo", map[string]any{"context": "dev", "namespace": "apps", "resource": "deployments", "name": "web", "revision": 0}).Status != 400 {
		t.Fatal("revision lower bound")
	}

	post("/api/patch", map[string]any{"context": "dev", "namespace": "apps", "resource": "configmaps", "name": "cfg", "type": "merge", "patch": map[string]any{"data": map[string]any{"a": "b", "old": nil}}})
	want("--context=dev", "--namespace=apps", "patch", "configmaps", "cfg", "--type=merge", `--patch={"data":{"a":"b","old":null}}`)
	post("/api/patch", map[string]any{"context": "dev", "resource": "nodes", "name": "n1", "type": "json", "patch": []any{map[string]any{"op": "add", "path": "/x", "value": "<&>"}}})
	want("--context=dev", "patch", "nodes", "n1", "--type=json", `--patch=[{"op":"add","path":"/x","value":"<&>"}]`)
	post("/api/patch", map[string]any{"context": "dev", "resource": "nodes", "name": "n1", "type": "bogus", "patch": map[string]any{}})
	want("--context=dev", "patch", "nodes", "n1", "--type=merge", `--patch={}`)
	for _, patch := range []any{"x", nil, 5, true} {
		if post("/api/patch", map[string]any{"context": "dev", "namespace": "apps", "resource": "configmaps", "name": "cfg", "patch": patch}).Status != 400 {
			t.Fatalf("patch %v accepted", patch)
		}
	}
	big := post("/api/patch", map[string]any{"context": "dev", "resource": "configmaps", "name": "cfg", "patch": map[string]any{"data": strings.Repeat("x", 1024*1024)}})
	if big.Status != 413 {
		t.Fatalf("large patch %d", big.Status)
	}
	if post("/api/patch", map[string]any{"context": "dev", "resource": "Bad", "name": "cfg", "patch": map[string]any{}}).Status != 400 {
		t.Fatal("resource validation")
	}
}

func TestEvictionNeedsTheLiveConnection(t *testing.T) {
	x := newXFixture(t, func(call) Result { return Result{} })
	if got := x.post("/api/evict", map[string]any{"context": "dev", "namespace": "apps", "name": "web-1"}).Status; got != 503 {
		t.Fatalf("status %d", got)
	}
	if got := x.post("/api/default-class", map[string]any{"context": "dev", "kind": "nodes", "name": "x"}).Status; got != 400 {
		t.Fatalf("default-class kind %d", got)
	}
	if len(x.commands()) != 0 {
		t.Fatalf("commands %v", x.commands())
	}
}

func TestPodEvictionSendsPolicyV1AndPreservesDisruptionBudgetErrors(t *testing.T) {
	type sent struct {
		method, path string
		body         any
	}
	var requests []sent
	status := 201
	withLive(t, func(kubeContext, method, apiPath string, body any) (int, string, error) {
		requests = append(requests, sent{method, apiPath, body})
		if status == 429 {
			return 429, `{"kind":"Status","reason":"TooManyRequests","message":"Cannot evict pod as it would violate the disruption budget."}`, nil
		}
		return 201, `{"kind":"Status","status":"Success"}`, nil
	})
	x := newXFixture(t, func(call) Result { return Result{} })
	res := x.post("/api/evict", map[string]any{"context": "dev", "namespace": "apps", "name": "debug-shell"})
	if res.Status != 200 || res.Value["output"] != "pod/debug-shell evicted" {
		t.Fatalf("%d %s", res.Status, res.Raw)
	}
	wantBody := map[string]any{"apiVersion": "policy/v1", "kind": "Eviction", "metadata": map[string]any{"name": "debug-shell", "namespace": "apps"}}
	if !reflect.DeepEqual(requests, []sent{{"POST", "/api/v1/namespaces/apps/pods/debug-shell/eviction", wantBody}}) {
		t.Fatalf("requests %v", requests)
	}
	if len(x.commands()) != 0 {
		t.Fatal("eviction must not run kubectl")
	}
	status = 429
	refused := x.post("/api/evict", map[string]any{"context": "dev", "namespace": "apps", "name": "protected"})
	if refused.Status != 429 || !strings.Contains(refused.Value["error"].(string), "disruption budget") {
		t.Fatalf("%d %s", refused.Status, refused.Raw)
	}
	requests = nil
	if x.post("/api/evict", map[string]any{"context": "dev", "namespace": "apps", "name": "-bad"}).Status != 400 || len(requests) != 0 {
		t.Fatal("malformed names must not reach the cluster")
	}
	if x.post("/api/evict", map[string]any{"context": "dev", "namespace": "*", "name": "x"}).Status != 400 {
		t.Fatal("wildcard namespace")
	}
	withLive(t, func(string, string, string, any) (int, string, error) { return 0, "", errors.New("connection lost") })
	if got := x.post("/api/evict", map[string]any{"context": "dev", "namespace": "apps", "name": "x"}).Status; got != 500 {
		t.Fatalf("transport error %d", got)
	}
}

// classCluster serves IngressClass or StorageClass lists to the default-class routes.
func classCluster(t *testing.T, kind string, items []any, rejectAnnotation bool) *xfixture {
	return newXFixture(t, func(c call) Result {
		if hasArg(c.Args, "get") && hasArg(c.Args, kind) {
			return out(map[string]any{"kind": "List", "items": items}, 0)
		}
		if hasArg(c.Args, "annotate") && rejectAnnotation {
			return fail("annotation forbidden")
		}
		return Result{Stdout: c.Args[3] + " annotated"}
	})
}

func annotateCalls(x *xfixture) [][]string {
	var calls [][]string
	for _, c := range x.find(func(a []string) bool { return hasArg(a, "annotate") }) {
		calls = append(calls, c.Args)
	}
	return calls
}

func class(name string, annotations map[string]any) map[string]any {
	meta := map[string]any{"name": name}
	if annotations != nil {
		meta["annotations"] = annotations
	}
	return map[string]any{"metadata": meta}
}

const (
	storageDefault = "storageclass.kubernetes.io/is-default-class"
	storageBeta    = "storageclass.beta.kubernetes.io/is-default-class"
	ingressDefault = "ingressclass.kubernetes.io/is-default-class"
)

func TestSettingAStorageDefaultEnablesTheTargetBeforeClearingCurrentAndLegacyDefaults(t *testing.T) {
	x := classCluster(t, "storageclasses", []any{
		class("old", map[string]any{storageDefault: "true"}),
		class("legacy", map[string]any{storageBeta: "true"}),
		class("fast", nil),
		class("unused", nil),
	}, false)
	res := x.post("/api/default-class", map[string]any{"context": "dev", "kind": "storageclasses", "name": "fast"})
	if res.Status != 200 {
		t.Fatalf("%d %s", res.Status, res.Raw)
	}
	want := [][]string{
		{"--context=dev", "annotate", "storageclasses", "fast", storageDefault + "=true", "--overwrite"},
		{"--context=dev", "annotate", "storageclasses", "old", storageDefault + "=false", "--overwrite"},
		{"--context=dev", "annotate", "storageclasses", "legacy", storageDefault + "=false", "--overwrite", storageBeta + "-"},
	}
	if got := annotateCalls(x); !reflect.DeepEqual(got, want) {
		t.Fatalf("annotations %v", got)
	}
	if res.Value["output"] != "fast annotated\nold annotated\nlegacy annotated" {
		t.Fatalf("output %v", res.Value["output"])
	}
}

func TestARejectedNewDefaultNeverClearsTheOldDefault(t *testing.T) {
	x := classCluster(t, "storageclasses", []any{class("old", map[string]any{storageDefault: "true"}), class("fast", nil)}, true)
	res := x.post("/api/default-class", map[string]any{"context": "dev", "kind": "storageclasses", "name": "fast"})
	if res.Status != 502 || !strings.Contains(res.Value["error"].(string), "annotation forbidden") {
		t.Fatalf("%d %s", res.Status, res.Raw)
	}
	calls := annotateCalls(x)
	if len(calls) != 1 || calls[0][3] != "fast" {
		t.Fatalf("annotations %v", calls)
	}
}

func TestAMissingDefaultTargetMakesNoWritesAndAnExistingSoleDefaultIsANoop(t *testing.T) {
	x := classCluster(t, "storageclasses", []any{class("fast", map[string]any{storageDefault: "true"})}, false)
	if got := x.post("/api/default-class", map[string]any{"context": "dev", "kind": "storageclasses", "name": "missing"}).Status; got != 404 {
		t.Fatalf("missing target %d", got)
	}
	res := x.post("/api/default-class", map[string]any{"context": "dev", "kind": "storageclasses", "name": "fast"})
	if res.Status != 200 || !strings.Contains(res.Value["output"].(string), "already the default") {
		t.Fatalf("%d %s", res.Status, res.Raw)
	}
	if len(annotateCalls(x)) != 0 {
		t.Fatal("writes made")
	}
}

func TestIngressClassDefaultsUseTheirOwnAnnotationIncludingTheLegacyEndpoint(t *testing.T) {
	for _, route := range []string{"/api/default-class", "/api/ingressclass-default"} {
		x := classCluster(t, "ingressclasses", []any{class("public", nil)}, false)
		body := map[string]any{"context": "dev", "name": "public"}
		if route == "/api/default-class" {
			body["kind"] = "ingressclasses"
		}
		if res := x.post(route, body); res.Status != 200 {
			t.Fatalf("%s: %d %s", route, res.Status, res.Raw)
		}
		want := [][]string{{"--context=dev", "annotate", "ingressclasses", "public", ingressDefault + "=true", "--overwrite"}}
		if got := annotateCalls(x); !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: %v", route, got)
		}
	}
}

func TestSecretDataRevealsOneSecretOnRequest(t *testing.T) {
	x := newXFixture(t, func(c call) Result {
		if rawPath(c.Args) == "/api/v1/namespaces/apps/secrets/db" {
			return out(map[string]any{"type": "kubernetes.io/basic-auth", "data": map[string]any{"password": "c2VjcmV0"}, "metadata": map[string]any{"resourceVersion": "42"}}, 0)
		}
		if rawPath(c.Args) == "/api/v1/namespaces/apps/secrets/bare" {
			return out(map[string]any{"metadata": map[string]any{}}, 0)
		}
		return fail("Error from server (NotFound): secrets not found")
	})
	res := x.get("/api/secret-data?context=dev&namespace=apps&name=db")
	if res.Status != 200 || !reflect.DeepEqual(res.Value, map[string]any{"type": "kubernetes.io/basic-auth", "data": map[string]any{"password": "c2VjcmV0"}, "resourceVersion": "42"}) {
		t.Fatalf("%d %s", res.Status, res.Raw)
	}
	bare := x.get("/api/secret-data?context=dev&namespace=apps&name=bare")
	if !reflect.DeepEqual(bare.Value, map[string]any{"type": "Opaque", "data": map[string]any{}, "resourceVersion": ""}) {
		t.Fatalf("%s", bare.Raw)
	}
	if x.get("/api/secret-data?context=dev&namespace=apps&name=missing").Status != 502 {
		t.Fatal("missing secret")
	}
	if x.get("/api/secret-data?context=dev&namespace=apps&name=-x").Status != 400 || x.get("/api/secret-data?namespace=apps&name=db").Status != 400 {
		t.Fatal("validation")
	}
}

func TestServiceAccountKubeconfig(t *testing.T) {
	token := strings.Repeat("eyJhbGciOiJSUzI1NiJ9.", 12) + "sig"
	x := newXFixture(t, func(c call) Result {
		if hasArg(c.Args, "create") {
			return Result{Stdout: token + "\n"}
		}
		return out(map[string]any{"clusters": []any{map[string]any{"name": "prod", "cluster": map[string]any{
			"server": "https://10.0.0.1:6443", "certificate-authority-data": "Q0E=", "insecure-skip-tls-verify": true, "tls-server-name": "kube.example", "ignored": "x"}}}}, 0)
	})
	res := x.post("/api/serviceaccount-kubeconfig", map[string]any{"context": "dev", "namespace": "apps", "name": "deployer", "hours": 48})
	if res.Status != 200 || res.Value["expiresInHours"] != float64(48) {
		t.Fatalf("%d %s", res.Status, res.Raw)
	}
	want := "apiVersion: v1\nkind: Config\npreferences: {}\nclusters:\n" +
		"  - name: prod\n    cluster:\n      server: https://10.0.0.1:6443\n      certificate-authority-data: Q0E=\n      insecure-skip-tls-verify: true\n      tls-server-name: kube.example\n" +
		"users:\n  - name: deployer@apps\n    user:\n      token: " + token + "\n" +
		"contexts:\n  - name: deployer@apps-prod\n    context:\n      cluster: prod\n      user: deployer@apps\n      namespace: apps\n" +
		"current-context: deployer@apps-prod\n"
	if res.Value["kubeconfig"] != want {
		t.Fatalf("kubeconfig:\n%v\nwant:\n%s", res.Value["kubeconfig"], want)
	}
	create := x.find(func(a []string) bool { return hasArg(a, "create") })[0]
	if !reflect.DeepEqual(create.Args, []string{"--context=dev", "--namespace=apps", "create", "token", "deployer", "--duration=48h"}) {
		t.Fatalf("create %v", create.Args)
	}
	view := x.find(func(a []string) bool { return hasArg(a, "config") })[0]
	if !reflect.DeepEqual(view.Args, []string{"config", "view", "--raw", "--minify", "--flatten", "--context=dev", "--output=json"}) {
		t.Fatalf("view %v", view.Args)
	}
	x.post("/api/serviceaccount-kubeconfig", map[string]any{"context": "dev", "namespace": "apps", "name": "deployer"})
	if !hasArg(x.find(func(a []string) bool { return hasArg(a, "create") })[1].Args, "--duration=24h") {
		t.Fatal("default lifetime is 24 hours")
	}
	for _, hours := range []any{0, 8761, "abc"} {
		if x.post("/api/serviceaccount-kubeconfig", map[string]any{"context": "dev", "namespace": "apps", "name": "deployer", "hours": hours}).Status != 400 {
			t.Fatalf("hours %v accepted", hours)
		}
	}
	noServer := newXFixture(t, func(c call) Result {
		if hasArg(c.Args, "create") {
			return Result{Stdout: "t"}
		}
		return out(map[string]any{"clusters": []any{}}, 0)
	})
	if r := noServer.post("/api/serviceaccount-kubeconfig", map[string]any{"context": "dev", "namespace": "apps", "name": "deployer"}); r.Status != 502 {
		t.Fatalf("%d %s", r.Status, r.Raw)
	}
	denied := newXFixture(t, func(c call) Result {
		if hasArg(c.Args, "create") {
			return fail("forbidden: cannot create serviceaccounts/token")
		}
		return out(map[string]any{}, 0)
	})
	if r := denied.post("/api/serviceaccount-kubeconfig", map[string]any{"context": "dev", "namespace": "apps", "name": "deployer"}); r.Status != 502 || !strings.Contains(r.Value["error"].(string), "forbidden") {
		t.Fatalf("%d %s", r.Status, r.Raw)
	}
}
