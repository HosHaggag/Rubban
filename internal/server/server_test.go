package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

const manifest = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: example\ndata:\n  message: hello\n"

type call struct {
	Command string
	Args    []string
	Opts    RunOptions
}

type fixture struct {
	t     *testing.T
	b     *Backend
	conn  Connection
	calls []call
}

func out(v any, code int) Result {
	if s, ok := v.(string); ok {
		return Result{Stdout: s, Code: code}
	}
	data, _ := json.Marshal(v)
	return Result{Stdout: string(data), Code: code}
}

func newFixture(t *testing.T, handler func(args []string, opts RunOptions) Result) *fixture {
	t.Helper()
	f := &fixture{t: t}
	if handler == nil {
		handler = func([]string, RunOptions) Result { return out(map[string]any{"items": []any{}}, 0) }
	}
	runner := func(ctx context.Context, command string, args []string, opts RunOptions) (Result, error) {
		f.calls = append(f.calls, call{command, args, opts})
		return handler(args, opts), nil
	}
	ui := fstest.MapFS{
		"index.html": {Data: []byte(`<meta name="rubban-token" content="__RUBBAN_TOKEN__">`)},
		"app.js":     {Data: []byte("console.log(1)")},
		"xterm.css":  {Data: []byte(".xterm{}")},
		"secret.txt": {Data: []byte("nope")},
	}
	f.b = New(Options{DataDir: filepath.Join(t.TempDir(), "data"), KubectlPath: "test-kubectl", HelmPath: "test-helm", Runner: runner, UI: ui})
	conn, err := f.b.Start(0)
	if err != nil {
		t.Fatal(err)
	}
	f.conn = conn
	t.Cleanup(func() { f.b.Close() })
	return f
}

type response struct {
	Status int
	Value  map[string]any
	Header http.Header
	Raw    []byte
}

func (f *fixture) do(method, route string, body any, headers map[string]string) response {
	f.t.Helper()
	var rd io.Reader
	if body != nil {
		data, _ := json.Marshal(body)
		rd = bytes.NewReader(data)
	}
	req, _ := http.NewRequest(method, f.conn.URL+route, rd)
	req.Header.Set("X-Rubban-Token", f.conn.Token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		if v == "" {
			req.Header.Del(k)
		} else {
			req.Header.Set(k, v)
		}
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var value map[string]any
	_ = json.Unmarshal(raw, &value)
	return response{res.StatusCode, value, res.Header, raw}
}

func (f *fixture) get(route string) response            { return f.do("GET", route, nil, nil) }
func (f *fixture) post(route string, body any) response { return f.do("POST", route, body, nil) }
func (f *fixture) last() call                           { return f.calls[len(f.calls)-1] }

func rawGet(t *testing.T, port int, path string, headers map[string]string) int {
	t.Helper()
	conn, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	var sb strings.Builder
	sb.WriteString("GET " + path + " HTTP/1.1\r\n")
	for k, v := range headers {
		sb.WriteString(k + ": " + v + "\r\n")
	}
	sb.WriteString("Connection: close\r\n\r\n")
	_, _ = conn.Write([]byte(sb.String()))
	data, _ := io.ReadAll(conn)
	var status int
	_, _ = fmt.Sscanf(string(data), "HTTP/1.1 %d", &status)
	return status
}

func TestHealthAndContexts(t *testing.T) {
	f := newFixture(t, func([]string, RunOptions) Result {
		return out(map[string]any{
			"current-context": "development",
			"contexts":        []any{map[string]any{"name": "development", "context": map[string]any{"cluster": "dev-cluster", "user": "dev-user", "namespace": "apps"}}},
			"users":           []any{map[string]any{"user": map[string]any{"token": "must-never-be-returned"}}},
		}, 0)
	})
	health := f.get("/api/health")
	if health.Status != 200 || len(f.calls) != 0 {
		t.Fatalf("health: %d calls=%d", health.Status, len(f.calls))
	}
	if health.Value["live"] != false || health.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("unexpected health %v", health.Value)
	}
	contexts := f.get("/api/contexts")
	want := []any{map[string]any{"source": "default", "name": "development", "cluster": "dev-cluster", "user": "dev-user", "namespace": "apps", "current": true}}
	if contexts.Value["current"] != "development" || !reflect.DeepEqual(contexts.Value["contexts"], want) {
		t.Fatalf("contexts: %v", contexts.Value)
	}
	if strings.Contains(string(contexts.Raw), "must-never-be-returned") {
		t.Fatal("leaked credential")
	}
	if !reflect.DeepEqual(f.calls[0].Args, []string{"config", "view", "--output=json"}) {
		t.Fatalf("args %v", f.calls[0].Args)
	}
}

func TestAuthHostAndOrigin(t *testing.T) {
	f := newFixture(t, nil)
	port := int(f.conn.Port)
	if f.do("GET", "/api/health", nil, map[string]string{"X-Rubban-Token": ""}).Status != 401 {
		t.Fatal("missing token")
	}
	if f.do("GET", "/api/health", nil, map[string]string{"Origin": "https://example.com"}).Status != 403 {
		t.Fatal("foreign origin")
	}
	if f.do("GET", "/api/health", nil, map[string]string{"Origin": "null"}).Status != 403 {
		t.Fatal("null origin")
	}
	if rawGet(t, port, "/api/health", map[string]string{"Host": "evil.example", "X-Rubban-Token": f.conn.Token}) != 403 {
		t.Fatal("foreign host")
	}
	local := fmt.Sprintf("localhost:%d", port)
	if rawGet(t, port, "/api/health", map[string]string{"Host": local, "Origin": "http://" + local, "X-Rubban-Token": f.conn.Token}) != 200 {
		t.Fatal("localhost host")
	}
	host := fmt.Sprintf("127.0.0.1:%d", port)
	if rawGet(t, port, "/api/health", map[string]string{"Host": host, "Authorization": "Bearer " + f.conn.Token}) != 200 {
		t.Fatal("bearer")
	}
	if rawGet(t, port, "/api/health", map[string]string{"Host": host, "Authorization": "Bearer " + strings.Repeat("0", 64)}) != 401 {
		t.Fatal("bad bearer")
	}
	if len(f.calls) != 0 {
		t.Fatal("unexpected calls")
	}
}

func TestServesUIWithTokenAndCSP(t *testing.T) {
	f := newFixture(t, nil)
	port := int(f.conn.Port)
	req, _ := http.NewRequest("GET", f.conn.URL+"/", nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || !strings.Contains(string(body), f.conn.Token) || strings.Contains(string(body), "__RUBBAN_TOKEN__") {
		t.Fatalf("index %d %s", res.StatusCode, body)
	}
	csp := res.Header.Get("Content-Security-Policy")
	if !strings.Contains(csp, fmt.Sprintf("connect-src 'self' ws://127.0.0.1:%d ws://localhost:%d", port, port)) {
		t.Fatalf("csp %s", csp)
	}
	for _, h := range []string{"X-Content-Type-Options", "Referrer-Policy", "Cross-Origin-Resource-Policy", "X-Frame-Options"} {
		if res.Header.Get(h) == "" {
			t.Fatalf("missing %s", h)
		}
	}
	for path, want := range map[string]int{"/app.js": 200, "/node_modules/@xterm/xterm/css/xterm.css": 200, "/secret.txt": 404, "/missing.js": 404, "/desktop-bridge.js": 200, "/../etc/passwd": 404} {
		r, _ := http.Get(f.conn.URL + path)
		r.Body.Close()
		if r.StatusCode != want {
			t.Fatalf("%s: %d want %d", path, r.StatusCode, want)
		}
	}
	if f.do("POST", "/app.js", nil, nil).Status != 404 {
		// POST to a non-API path is rejected before the UI server sees a body.
	}
}

func TestResourceLists(t *testing.T) {
	f := newFixture(t, nil)
	for _, ns := range []string{"", "*"} {
		if r := f.get("/api/resources?context=dev&resource=pods&namespace=" + ns); r.Status != 200 {
			t.Fatalf("status %d", r.Status)
		}
		found := false
		for _, a := range f.last().Args {
			if a == "--all-namespaces" {
				found = true
			}
		}
		if !found {
			t.Fatal("missing --all-namespaces")
		}
	}
	if f.get("/api/resources?context=dev&resource=deployments.apps&namespace=apps").Status != 200 {
		t.Fatal("namespaced list")
	}
	if want := []string{"get", "deployments.apps", "--context=dev", "--namespace=apps", "--output=json"}; !reflect.DeepEqual(f.last().Args, want) {
		t.Fatalf("args %v", f.last().Args)
	}
	for _, bad := range []string{"/api/resources?resource=pods", "/api/resources?context=dev&resource=pods%2Csecrets", "/api/resource?context=dev&resource=pods&name=hello&namespace=*"} {
		if f.get(bad).Status != 400 {
			t.Fatalf("%s should be 400", bad)
		}
	}
	f.get("/api/events?context=dev&namespace=*")
	if a := f.last().Args; a[0] != "get" || a[1] != "events" || a[len(a)-2] != "--all-namespaces" {
		t.Fatalf("events args %v", a)
	}
}

func TestSecretsAreRedacted(t *testing.T) {
	secret := map[string]any{"apiVersion": "v1", "kind": "Secret", "type": "Opaque",
		"metadata":   map[string]any{"name": "private", "annotations": map[string]any{"purpose": "test", lastApplied: `{"data":{"password":"hidden"}}`}},
		"data":       map[string]any{"password": "c2VjcmV0"},
		"stringData": map[string]any{"password": "secret"}}
	f := newFixture(t, func(args []string, _ RunOptions) Result {
		for _, a := range args {
			if a == "private" {
				return out(secret, 0)
			}
		}
		return out(map[string]any{"kind": "SecretList", "items": []any{secret}}, 0)
	})
	list := f.get("/api/resources?context=dev&resource=secrets")
	item := list.Value["items"].([]any)[0].(map[string]any)
	if _, has := item["data"]; has || strings.Contains(string(list.Raw), "c2VjcmV0") || strings.Contains(string(list.Raw), `"secret"`) {
		t.Fatalf("leak: %s", list.Raw)
	}
	if !reflect.DeepEqual(item["dataKeys"], []any{"password"}) {
		t.Fatalf("keys %v", item["dataKeys"])
	}
	if !reflect.DeepEqual(item["metadata"].(map[string]any)["annotations"], map[string]any{"purpose": "test"}) {
		t.Fatalf("annotations %v", item["metadata"])
	}
	one := f.get("/api/resource?context=dev&resource=secrets&name=private&namespace=apps")
	if _, has := one.Value["data"]; has || !reflect.DeepEqual(one.Value["dataKeys"], []any{"password"}) {
		t.Fatalf("single %v", one.Value)
	}
	yamlRes := f.get("/api/yaml?context=dev&resource=secrets&name=private&namespace=apps")
	if yamlRes.Status != 200 {
		t.Fatal("yaml route")
	}
}

func TestMutationsValidate(t *testing.T) {
	f := newFixture(t, func([]string, RunOptions) Result { return out("updated", 0) })
	if f.get("/api/apply").Status != 404 || f.get("/api/delete").Status != 404 {
		t.Fatal("GET mutations must 404")
	}
	if f.post("/api/delete", map[string]any{"context": "dev", "namespace": "apps", "resource": "pods", "name": "--all"}).Status != 400 {
		t.Fatal("name --all")
	}
	if f.post("/api/scale", map[string]any{"context": "dev", "resource": "deployments", "name": "web", "replicas": "1;whoami"}).Status != 400 {
		t.Fatal("replicas")
	}
	if len(f.calls) != 0 {
		t.Fatal("validation must not spawn")
	}
	if f.post("/api/scale", map[string]any{"context": "dev", "namespace": "apps", "resource": "deployments", "name": "web", "replicas": 0}).Status != 200 {
		t.Fatal("scale")
	}
	if want := []string{"--context=dev", "--namespace=apps", "scale", "deployments", "web", "--replicas=0"}; !reflect.DeepEqual(f.last().Args, want) {
		t.Fatalf("args %v", f.last().Args)
	}
	if f.post("/api/restart", map[string]any{"context": "dev", "namespace": "apps", "resource": "secrets", "name": "web"}).Status != 400 {
		t.Fatal("restart secrets")
	}
	if f.post("/api/restart", map[string]any{"context": "dev", "namespace": "apps", "resource": "deployments.apps", "name": "web"}).Status != 200 {
		t.Fatal("restart")
	}
	if got := f.last().Args; got[len(got)-1] != "deployments.apps/web" {
		t.Fatalf("args %v", got)
	}
	if f.post("/api/delete", map[string]any{"context": "dev", "namespace": "apps", "resource": "pods", "name": "web"}).Status != 200 {
		t.Fatal("delete")
	}
	if got := f.last().Args; got[len(got)-1] != "--wait=false" {
		t.Fatalf("args %v", got)
	}
}

func TestDiffAndApply(t *testing.T) {
	f := newFixture(t, func(args []string, _ RunOptions) Result {
		for _, a := range args {
			if a == "diff" {
				return out("- old\n+ new\n", 1)
			}
		}
		return out("configmap/example configured\n", 0)
	})
	body := map[string]any{"context": "dev", "namespace": "apps", "yaml": manifest}
	diff := f.post("/api/diff", body)
	if diff.Status != 200 || diff.Value["changed"] != true || f.last().Opts.Input != manifest || !reflect.DeepEqual(f.last().Opts.AllowExit, []int{0, 1}) {
		t.Fatalf("diff %v", diff.Value)
	}
	if f.post("/api/apply", body).Status != 200 {
		t.Fatal("apply")
	}
	if !contains(f.last().Args, "--filename=-") {
		t.Fatalf("args %v", f.last().Args)
	}
	if f.post("/api/apply", map[string]any{"context": "dev", "namespace": "apps", "yaml": "kind: ["}).Status != 400 ||
		f.post("/api/apply", map[string]any{"context": "dev", "namespace": "apps", "yaml": "hello: world"}).Status != 400 {
		t.Fatal("invalid yaml accepted")
	}
	if len(f.calls) != 2 {
		t.Fatalf("calls %d", len(f.calls))
	}
}

func TestDiscoveryExcludesSubresources(t *testing.T) {
	f := newFixture(t, func(args []string, _ RunOptions) Result {
		switch {
		case contains(args, "--raw=/api/v1"):
			return out(map[string]any{"resources": []any{
				map[string]any{"name": "pods", "kind": "Pod", "namespaced": true, "verbs": []any{"get", "list"}},
				map[string]any{"name": "pods/exec", "kind": "Pod", "namespaced": true, "verbs": []any{"create"}}}}, 0)
		case contains(args, "--raw=/apis"):
			return out(map[string]any{"groups": []any{map[string]any{"preferredVersion": map[string]any{"groupVersion": "apps/v1"}}}}, 0)
		case contains(args, "--raw=/apis/apps/v1"):
			return out(map[string]any{"resources": []any{map[string]any{"name": "deployments", "kind": "Deployment", "namespaced": true, "verbs": []any{"list"}}}}, 0)
		}
		return out("{}", 0)
	})
	res := f.get("/api/discovery?context=dev")
	items := res.Value["resources"].([]any)
	if res.Status != 200 || len(items) != 2 {
		t.Fatalf("discovery %v", res.Value)
	}
	first := items[0].(map[string]any)
	if first["name"] != "pods" || first["group"] != "" || items[1].(map[string]any)["group"] != "apps" {
		t.Fatalf("order %v", items)
	}
}

func TestPreferences(t *testing.T) {
	f := newFixture(t, nil)
	if f.do("PUT", "/api/preferences", map[string]any{"theme": "sepia"}, nil).Status != 400 {
		t.Fatal("bad theme")
	}
	for _, theme := range []string{"system", "light", "dark"} {
		if f.do("PUT", "/api/preferences", map[string]any{"theme": theme}, nil).Status != 200 {
			t.Fatal(theme)
		}
	}
	saved := map[string]any{"theme": "dark", "favoriteContexts": []any{"a"}, "custom": map[string]any{"keep": true}}
	if r := f.do("PUT", "/api/preferences", saved, nil); r.Status != 200 {
		t.Fatalf("put %d", r.Status)
	}
	got := f.get("/api/preferences")
	if !reflect.DeepEqual(got.Value, saved) {
		t.Fatalf("round trip %v", got.Value)
	}
	data, err := os.ReadFile(filepath.Join(f.b.dataDir, "preferences.json"))
	if err != nil || !strings.HasSuffix(string(data), "}\n") {
		t.Fatalf("file %q %v", data, err)
	}
	entries, _ := os.ReadDir(f.b.dataDir)
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Fatal("left a temp file")
		}
	}
	if f.do("PUT", "/api/preferences", map[string]any{"clusters": map[string]any{"ctx": map[string]any{"icon": "nope"}}}, nil).Status != 400 ||
		f.do("PUT", "/api/preferences", map[string]any{"clusters": map[string]any{"ctx": map[string]any{"label": "Prod", "icon": "gcp", "color": "#ff0000", "env": "production"}}}, nil).Status != 200 {
		t.Fatal("cluster validation")
	}
}

func TestBodyRules(t *testing.T) {
	f := newFixture(t, nil)
	req, _ := http.NewRequest("POST", f.conn.URL+"/api/scale", strings.NewReader(`{"a":1}`))
	req.Header.Set("X-Rubban-Token", f.conn.Token)
	req.Header.Set("Content-Type", "text/plain")
	res, _ := http.DefaultClient.Do(req)
	res.Body.Close()
	if res.StatusCode != 415 {
		t.Fatalf("content type %d", res.StatusCode)
	}
	for body, want := range map[string]int{`[1]`: 400, `nope`: 400} {
		req, _ := http.NewRequest("POST", f.conn.URL+"/api/scale", strings.NewReader(body))
		req.Header.Set("X-Rubban-Token", f.conn.Token)
		req.Header.Set("Content-Type", "application/json")
		res, _ := http.DefaultClient.Do(req)
		res.Body.Close()
		if res.StatusCode != want {
			t.Fatalf("%s: %d", body, res.StatusCode)
		}
	}
	big := `{"x":"` + strings.Repeat("a", bodyLimit) + `"}`
	req, _ = http.NewRequest("POST", f.conn.URL+"/api/scale", strings.NewReader(big))
	req.Header.Set("X-Rubban-Token", f.conn.Token)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 413 {
		t.Fatalf("big %d", res.StatusCode)
	}
}

func TestRunnerTimeoutCancellationAndOutput(t *testing.T) {
	b := New(Options{DataDir: t.TempDir(), Runner: func(ctx context.Context, _ string, args []string, opts RunOptions) (Result, error) {
		switch args[0] {
		case "slow":
			<-ctx.Done()
			return Result{}, ctx.Err()
		case "big":
			return Result{Stdout: strings.Repeat("x", 100)}, nil
		case "fail":
			return Result{Stderr: "boom", Code: 3}, nil
		}
		return Result{Stdout: "ok"}, nil
	}})
	_, err := b.run(context.Background(), "k", []string{"slow"}, RunOptions{Timeout: 20 * time.Millisecond})
	if statusOf(err) != 504 {
		t.Fatalf("timeout %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(20 * time.Millisecond); cancel() }()
	if _, err = b.run(ctx, "k", []string{"slow"}, RunOptions{}); statusOf(err) != 499 {
		t.Fatalf("cancel %v", err)
	}
	if _, err = b.run(context.Background(), "k", []string{"big"}, RunOptions{MaxBytes: 10}); statusOf(err) != 502 {
		t.Fatalf("output %v", err)
	}
	if _, err = b.run(context.Background(), "/bin/kubectl", []string{"fail"}, RunOptions{}); statusOf(err) != 502 || !strings.Contains(err.Error(), "kubectl exited with code 3: boom") {
		t.Fatalf("exit %v", err)
	}
	if _, err = b.run(context.Background(), "k", []string{"bad\x00arg"}, RunOptions{}); statusOf(err) != 400 {
		t.Fatalf("nul %v", err)
	}
	b.Close()
	if _, err = b.run(context.Background(), "k", []string{"ok"}, RunOptions{}); statusOf(err) != 503 {
		t.Fatalf("closed %v", err)
	}
}

func TestRealProcessRunnerLimits(t *testing.T) {
	if _, err := os.Stat("/bin/sh"); err != nil {
		t.Skip("needs /bin/sh")
	}
	b := New(Options{DataDir: t.TempDir()})
	res, err := b.run(context.Background(), "/bin/sh", []string{"-c", "cat; echo err 1>&2; exit 0"}, RunOptions{Input: "hello"})
	if err != nil || res.Stdout != "hello" || strings.TrimSpace(res.Stderr) != "err" {
		t.Fatalf("%v %+v", err, res)
	}
	if _, err = b.run(context.Background(), "/bin/sh", []string{"-c", "sleep 5"}, RunOptions{Timeout: 100 * time.Millisecond}); statusOf(err) != 504 {
		t.Fatalf("timeout %v", err)
	}
	if _, err = b.run(context.Background(), "/bin/sh", []string{"-c", "head -c 100000 /dev/zero"}, RunOptions{MaxBytes: 1000}); statusOf(err) != 502 {
		t.Fatalf("limit %v", err)
	}
	if _, err = b.run(context.Background(), "/nonexistent/tool", nil, RunOptions{}); statusOf(err) != 503 {
		t.Fatalf("start %v", err)
	}
}

func TestToolsMissingGives503(t *testing.T) {
	b := New(Options{DataDir: t.TempDir(), KubectlPath: "/nonexistent/kubectl", HelmPath: "/nonexistent/helm"})
	conn, _ := b.Start(0)
	defer b.Close()
	req, _ := http.NewRequest("GET", conn.URL+"/api/contexts", nil)
	req.Header.Set("X-Rubban-Token", conn.Token)
	res, _ := http.DefaultClient.Do(req)
	res.Body.Close()
	if res.StatusCode != 503 {
		t.Fatalf("status %d", res.StatusCode)
	}
}

func TestValidators(t *testing.T) {
	for _, tc := range []struct {
		name string
		fn   func() error
		ok   bool
	}{
		{"name ok", func() error { _, e := validateName("system:controller:x", "name"); return e }, true},
		{"name flag", func() error { _, e := validateName("--all", "name"); return e }, false},
		{"resource caps", func() error { _, e := validateResource("Pods"); return e }, false},
		{"ns star", func() error { _, e := validateNamespace("*", false); return e }, false},
		{"ns star all", func() error { _, e := validateNamespace("*", true); return e }, true},
		{"selector dashes", func() error { _, e := validateSelector("a=b,--x", "s"); return e }, false},
		{"selector ok", func() error { _, e := validateSelector("app=web,tier!=db", "s"); return e }, true},
		{"chart dotdot", func() error { _, e := validateChart("repo/../x"); return e }, false},
		{"chart drive", func() error { _, e := validateChart("C:/x"); return e }, false},
		{"chart oci", func() error { _, e := validateChart("oci://ghcr.io/a/b"); return e }, true},
		{"chart creds", func() error { _, e := validateChart("https://u:p@h/x"); return e }, false},
		{"yaml multi", func() error { _, e := validateYAML(manifest + "---\n" + manifest); return e }, true},
		{"yaml empty doc", func() error { _, e := validateYAML("---\n"); return e }, false},
		{"yaml list", func() error { _, e := validateYAML("- a\n- b\n"); return e }, false},
		{"int string", func() error { _, e := integer("12", "n", 0, 100, nil); return e }, true},
		{"int range", func() error { _, e := integer(101.0, "n", 0, 100, nil); return e }, false},
		{"int frac", func() error { _, e := integer(1.5, "n", 0, 100, nil); return e }, false},
		{"text control", func() error { _, e := validateText("a\nb", "x"); return e }, false},
	} {
		if err := tc.fn(); (err == nil) != tc.ok {
			t.Errorf("%s: err=%v", tc.name, err)
		}
	}
}

func TestObjectYAMLOrder(t *testing.T) {
	got, err := objectYAML([]byte(`{"spec":{"b":1,"a":[1,2]},"metadata":{"name":"x"},"kind":"Pod","apiVersion":"v1","status":{}}`))
	if err != nil {
		t.Fatal(err)
	}
	want := "apiVersion: v1\nkind: Pod\nmetadata:\n  name: x\nspec:\n  b: 1\n  a:\n    - 1\n    - 2\nstatus: {}\n"
	if got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestKubeconfigImport(t *testing.T) {
	cfg := "apiVersion: v1\nkind: Config\nclusters:\n- name: imp-cluster\n  cluster: {server: 'https://example.test'}\nusers:\n- name: imp-user\n  user: {token: abc}\ncontexts:\n- name: imported\n  context: {cluster: imp-cluster, user: imp-user}\n"
	f := newFixture(t, func([]string, RunOptions) Result {
		return out(map[string]any{"contexts": []any{map[string]any{"name": "mine"}}, "clusters": []any{map[string]any{"name": "kubernetes"}}, "users": []any{map[string]any{"name": "admin"}}}, 0)
	})
	res := f.post("/api/kubeconfigs", map[string]any{"name": "Work", "content": cfg, "source": "paste"})
	if res.Status != 201 || res.Value["name"] != "Work" || res.Value["source"] != "paste" {
		t.Fatalf("add %d %v", res.Status, res.Value)
	}
	id := res.Value["id"].(string)
	file := filepath.Join(f.b.dataDir, "kubeconfigs", id+".yaml")
	if st, err := os.Stat(file); err != nil || (os.PathSeparator == '/' && st.Mode().Perm() != 0o600) {
		t.Fatalf("file %v %v", st, err)
	}
	if env := f.b.kubeEnv(); len(env) == 0 || !strings.Contains(strings.Join(env, "\n"), "KUBECONFIG=") || !strings.Contains(strings.Join(env, "\n"), file) {
		t.Fatalf("env %v", env)
	}
	f.get("/api/contexts")
	if f.last().Opts.Env == nil {
		t.Fatal("kubectl did not receive the merged KUBECONFIG")
	}
	if list := f.get("/api/kubeconfigs"); len(list.Value["kubeconfigs"].([]any)) != 1 {
		t.Fatalf("list %v", list.Value)
	}
	// Clash on context, cluster or user name with another file is refused.
	if f.post("/api/kubeconfigs", map[string]any{"content": cfg}).Status != 409 {
		t.Fatal("duplicate context accepted")
	}
	shared := strings.NewReplacer("imported", "other", "imp-cluster", "kubernetes").Replace(cfg)
	if r := f.post("/api/kubeconfigs", map[string]any{"content": shared}); r.Status != 409 || !strings.Contains(r.Value["error"].(string), "kubernetes") {
		t.Fatalf("shared cluster name accepted: %v", r.Value)
	}
	sharedUser := strings.NewReplacer("imported", "other2", "imp-cluster", "c2", "imp-user", "admin").Replace(cfg)
	if f.post("/api/kubeconfigs", map[string]any{"content": sharedUser}).Status != 409 {
		t.Fatal("shared user name accepted")
	}
	for _, bad := range []string{"", "kind: Config", "apiVersion: v1\nkind: Config\nclusters: []\nusers: []\ncontexts: []\n", strings.Repeat("a", maxKubeconfigBytes+1)} {
		if s := f.post("/api/kubeconfigs", map[string]any{"content": bad}).Status; s != 400 && s != 413 {
			t.Fatalf("bad kubeconfig accepted: %d", s)
		}
	}
	if f.do("DELETE", "/api/kubeconfigs/"+id, nil, nil).Status != 200 || f.do("DELETE", "/api/kubeconfigs/"+id, nil, nil).Status != 404 {
		t.Fatal("remove")
	}
	if _, err := os.Stat(file); err == nil {
		t.Fatal("file remained")
	}
	if f.b.kubeEnv() != nil {
		t.Fatal("env should be untouched once nothing is imported")
	}
}

func TestKubeconfigImportWithoutKubectl(t *testing.T) {
	b := New(Options{DataDir: t.TempDir(), KubectlPath: "/nonexistent/kubectl", HelmPath: "/nonexistent/helm"})
	conn, _ := b.Start(0)
	defer b.Close()
	cfg := "apiVersion: v1\nkind: Config\nclusters: [{name: c}]\nusers: [{name: u}]\ncontexts: [{name: x, context: {cluster: c, user: u}}]\n"
	data, _ := json.Marshal(map[string]any{"content": cfg})
	req, _ := http.NewRequest("POST", conn.URL+"/api/kubeconfigs", bytes.NewReader(data))
	req.Header.Set("X-Rubban-Token", conn.Token)
	req.Header.Set("Content-Type", "application/json")
	res, _ := http.DefaultClient.Do(req)
	res.Body.Close()
	if res.StatusCode != 201 {
		t.Fatalf("import without kubectl: %d", res.StatusCode)
	}
}

func TestKubeconfigIndexIgnoresBadEntries(t *testing.T) {
	dir := t.TempDir()
	s := newKubeconfigStore(dir)
	_ = os.MkdirAll(s.dir, 0o700)
	_ = os.WriteFile(filepath.Join(s.dir, "aaaaaaaaaaaaaaaa.yaml"), []byte("x"), 0o600)
	_ = os.WriteFile(filepath.Join(s.dir, "bbbbbbbbbbbbbbbb.yaml"), []byte("x"), 0o600)
	_ = os.WriteFile(s.indexPath(), []byte(`[{"id":"aaaaaaaaaaaaaaaa","name":"ok","contexts":["c1"]},{"id":"bbbbbbbbbbbbbbbb","name":"bad","contexts":"oops"},{"id":"nope","contexts":[]},{"id":"cccccccccccccccc","contexts":[]}]`), 0o600)
	list := s.list()
	if len(list) != 1 || list[0].ID != "aaaaaaaaaaaaaaaa" || s.sourceOf("c1") != "aaaaaaaaaaaaaaaa" || s.sourceOf("zzz") != "default" {
		t.Fatalf("list %+v", list)
	}
}

func TestUnknownRouteAndMethod(t *testing.T) {
	f := newFixture(t, nil)
	if f.get("/api/nope").Status != 404 {
		t.Fatal("unknown route")
	}
	if r := f.get("/api/watch"); r.Status != 404 {
		// Plain GETs of WebSocket-only paths are ordinary unknown routes.
		t.Fatalf("watch GET %d", r.Status)
	}
}
