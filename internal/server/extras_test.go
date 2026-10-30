package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// installFakeCLI puts an executable named name on PATH (the runner is mocked, so its content is irrelevant).
func installFakeCLI(t *testing.T, name string) {
	t.Helper()
	dir := t.TempDir()
	file := name
	if runtime.GOOS == "windows" {
		file += ".exe"
	}
	if err := os.WriteFile(filepath.Join(dir, file), []byte("fixture executable; runner is mocked"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
}

func TestCodexAssistantKeepsReadOnlySandboxAndPromptOnStdin(t *testing.T) {
	installFakeCLI(t, "codex")
	x := newXFixture(t, func(call) Result { return Result{Stdout: "Hello from the fixture"} })
	prompt := "hello --dangerously-bypass-approvals-and-sandbox"
	res := x.post("/api/ai", map[string]any{"command": "codex", "prompt": prompt})
	if res.Status != 200 || res.Value["output"] != "Hello from the fixture" {
		t.Fatalf("%d %s", res.Status, res.Raw)
	}
	c := x.last()
	if strings.TrimSuffix(filepath.Base(c.Command), ".exe") != "codex" {
		t.Fatalf("command %q", c.Command)
	}
	if got := strings.Join(c.Args, " "); got != "exec --skip-git-repo-check --sandbox read-only -" {
		t.Fatalf("args %q", got)
	}
	for _, a := range c.Args {
		if a == prompt {
			t.Fatal("the prompt must not be an argument")
		}
	}
	if !strings.HasSuffix(c.Opts.Input, prompt+"\n") || c.Opts.Timeout != 180*time.Second || c.Opts.MaxBytes != 2*1024*1024 {
		t.Fatalf("opts %+v", c.Opts)
	}
	wantPreamble := "You are helping with Kubernetes. This request comes from Rubban. Do not change any resource or execute mutations without asking the user. Do not read or print credentials or secret values.\n\n" + prompt + "\n"
	if c.Opts.Input != wantPreamble {
		t.Fatalf("input %q", c.Opts.Input)
	}
}

func TestAIAssistantCommandsContextAndValidation(t *testing.T) {
	for _, name := range []string{"claude", "gemini", "opencode"} {
		installFakeCLI(t, name)
		x := newXFixture(t, func(call) Result { return Result{Stderr: "only stderr"} })
		res := x.post("/api/ai", map[string]any{"command": name, "prompt": "  why is it down?  ", "context": "prod-eu: 1"})
		if res.Status != 200 || res.Value["output"] != "only stderr" {
			t.Fatalf("%s: %d %s", name, res.Status, res.Raw)
		}
		want := map[string]string{"claude": "-p", "gemini": "", "opencode": "run"}[name]
		if got := strings.Join(x.last().Args, " "); got != want {
			t.Fatalf("%s args %q", name, got)
		}
		if !strings.Contains(x.last().Opts.Input, "\nSelected Kubernetes context: prod-eu: 1.\n\nwhy is it down?\n") {
			t.Fatalf("input %q", x.last().Opts.Input)
		}
	}
	installFakeCLI(t, "codex")
	x := newXFixture(t, func(call) Result { return Result{Stdout: "ok"} })
	if r := x.post("/api/ai", map[string]any{"prompt": "hi"}); r.Status != 200 || strings.TrimSuffix(filepath.Base(x.last().Command), ".exe") != "codex" {
		t.Fatalf("default command: %d %s", r.Status, r.Raw)
	}
	// The preference decides when the request names no command.
	installFakeCLI(t, "claude")
	x.do("PUT", "/api/preferences", map[string]any{"aiCommand": "claude"}, nil)
	x.post("/api/ai", map[string]any{"prompt": "hi"})
	if got := strings.Join(x.last().Args, " "); got != "-p" {
		t.Fatalf("preferred command args %q", got)
	}
	before := len(x.commands())
	for name, body := range map[string]map[string]any{
		"unknown cli":    {"command": "bash", "prompt": "hi"},
		"inherited name": {"command": "constructor", "prompt": "hi"},
		"no prompt":      {"command": "claude"},
		"blank prompt":   {"command": "claude", "prompt": " \n "},
		"long prompt":    {"command": "claude", "prompt": strings.Repeat("x", 32001)},
		"bad context":    {"command": "claude", "prompt": "hi", "context": "bad\ncontext"},
	} {
		r := x.post("/api/ai", body)
		if r.Status != 500 || r.Value["error"] == "" {
			t.Fatalf("%s: %d %s", name, r.Status, r.Raw)
		}
	}
	if len(x.commands()) != before {
		t.Fatal("rejected requests must not run a CLI")
	}
	t.Setenv("PATH", t.TempDir())
	r := x.post("/api/ai", map[string]any{"command": "claude", "prompt": "hi"})
	if r.Status != 500 || r.Value["error"] != "claude CLI is not installed or is not on PATH. Install it and authenticate with your own account." {
		t.Fatalf("missing CLI: %d %s", r.Status, r.Raw)
	}
}

func TestAICLIFailureIsReported(t *testing.T) {
	installFakeCLI(t, "claude")
	x := newXFixture(t, func(call) Result { return Result{Stderr: "not logged in", Code: 1} })
	r := x.post("/api/ai", map[string]any{"command": "claude", "prompt": "hi"})
	if r.Status != 502 || !strings.Contains(r.Value["error"].(string), "not logged in") {
		t.Fatalf("%d %s", r.Status, r.Raw)
	}
}

func TestServiceURLsRejectEmbeddedPasswordsAndNonWebSchemes(t *testing.T) {
	for _, bad := range []string{"http://user:password@host/", "http://user@host/", "file:///C:/secret", "ftp://host/", "https://host/#frag", "nonsense", ""} {
		if _, err := validateServiceURL(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	u, err := validateServiceURL("https://metrics.example")
	if err != nil || u.Hostname() != "metrics.example" {
		t.Fatalf("%v %v", u, err)
	}
	if _, err := validateServiceURL("http://127.0.0.1:9090/prom/?x=1"); err != nil {
		t.Fatal(err)
	}
}

func prometheusBackend(t *testing.T, endpoint string) *xfixture {
	x := newXFixture(t, func(call) Result { return Result{} })
	if endpoint != "" {
		if r := x.do("PUT", "/api/preferences", map[string]any{"prometheusUrl": endpoint}, nil); r.Status != 200 {
			t.Fatalf("prefs %d", r.Status)
		}
	}
	return x
}

func TestDirectPrometheusQueries(t *testing.T) {
	var mu sync.Mutex
	var seen []string
	prom := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.URL.Path+"?"+r.URL.RawQuery)
		mu.Unlock()
		switch r.URL.Query().Get("query") {
		case "redirect":
			http.Redirect(w, r, "/elsewhere", http.StatusFound)
		case "html":
			_, _ = io.WriteString(w, "<html>")
		case "denied":
			w.WriteHeader(http.StatusForbidden)
			_, _ = io.WriteString(w, `{"error":"forbidden by policy"}`)
		case "teapot":
			w.WriteHeader(http.StatusTeapot)
			_, _ = io.WriteString(w, `{"unrelated":true}`)
		case "huge":
			_, _ = io.WriteString(w, `{"status":"success","pad":"`)
			chunk := strings.Repeat("a", 1024*1024)
			for i := 0; i < 13; i++ {
				_, _ = io.WriteString(w, chunk)
			}
			_, _ = io.WriteString(w, `"}`)
		default:
			_, _ = io.WriteString(w, `{"status":"success","data":{"resultType":"vector","result":[]}}`)
		}
	}))
	defer prom.Close()
	x := prometheusBackend(t, prom.URL+"/prom/")
	res := x.post("/api/prometheus", map[string]any{"query": "up{job=\"a\"}"})
	if res.Status != 200 || res.Value["status"] != "success" {
		t.Fatalf("%d %s", res.Status, res.Raw)
	}
	mu.Lock()
	got := seen[0]
	mu.Unlock()
	if got != "/prom/api/v1/query?query=up%7Bjob%3D%22a%22%7D" {
		t.Fatalf("instant query %q", got)
	}
	x.post("/api/prometheus", map[string]any{"query": "up", "start": 1700000000, "end": 1700003600, "step": 15})
	mu.Lock()
	got = seen[1]
	mu.Unlock()
	if got != "/prom/api/v1/query_range?end=1700003600&query=up&start=1700000000&step=15" {
		t.Fatalf("range query %q", got)
	}
	x.post("/api/prometheus", map[string]any{"query": "up", "start": "1700000000", "end": "1700003600"})
	mu.Lock()
	got = seen[2]
	mu.Unlock()
	if !strings.HasSuffix(got, "step=60") {
		t.Fatalf("default step %q", got)
	}
	for query, want := range map[string]string{
		"redirect": "unexpected redirect",
		"html":     "Service returned non-JSON response (HTTP 200).",
		"denied":   "forbidden by policy",
		"teapot":   "Service returned HTTP 418",
		"huge":     "Service response exceeds 12 MiB.",
	} {
		r := x.post("/api/prometheus", map[string]any{"query": query})
		if r.Status != 500 || !strings.Contains(r.Value["error"].(string), want) {
			t.Fatalf("%s: %d %s", query, r.Status, r.Raw)
		}
	}
	for name, body := range map[string]map[string]any{"missing": {}, "blank": {"query": ""}, "long": {"query": strings.Repeat("x", 16001)}} {
		if r := x.post("/api/prometheus", body); r.Status != 500 || !strings.Contains(r.Value["error"].(string), "PromQL query") {
			t.Fatalf("%s: %d %s", name, r.Status, r.Raw)
		}
	}
}

func TestDirectPrometheusNeedsAValidConfiguredEndpoint(t *testing.T) {
	x := prometheusBackend(t, "")
	if r := x.post("/api/prometheus", map[string]any{"query": "up"}); r.Status != 500 || r.Value["error"] != "Configure your Prometheus endpoint in Settings first." {
		t.Fatalf("%d %s", r.Status, r.Raw)
	}
	for _, endpoint := range []string{"http://user:pw@127.0.0.1:1/", "file:///etc/passwd", "http://127.0.0.1:1/#x"} {
		y := prometheusBackend(t, endpoint)
		if r := y.post("/api/prometheus", map[string]any{"query": "up"}); r.Status != 500 || !strings.Contains(r.Value["error"].(string), "HTTP(S) service URL") {
			t.Fatalf("%s: %d %s", endpoint, r.Status, r.Raw)
		}
	}
}
