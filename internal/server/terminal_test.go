package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"
)

// --- fakes ----------------------------------------------------------------------------

type fakeProc struct {
	mu     sync.Mutex
	writes []string
	sizes  [][2]int
	out    chan []byte
	exit   chan int
	killed bool
	closed bool
	exited bool
	once   sync.Once
	cOnce  sync.Once
}

func newFakeProc() *fakeProc { return &fakeProc{out: make(chan []byte, 16), exit: make(chan int, 1)} }

func (p *fakeProc) Read(b []byte) (int, error) {
	data, ok := <-p.out
	if !ok {
		return 0, io.EOF
	}
	return copy(b, data), nil
}

func (p *fakeProc) Write(b []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.writes = append(p.writes, string(b))
	return len(b), nil
}

func (p *fakeProc) Resize(cols, rows int) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.sizes = append(p.sizes, [2]int{cols, rows})
	return nil
}

func (p *fakeProc) Wait() (int, error) {
	code := <-p.exit
	p.mu.Lock()
	p.exited = true
	p.mu.Unlock()
	return code, nil
}

func (p *fakeProc) Kill() {
	p.mu.Lock()
	if p.exited {
		p.mu.Unlock()
		return
	}
	p.killed = true
	p.mu.Unlock()
	p.once.Do(func() { p.exit <- -1 })
}

func (p *fakeProc) Close() error {
	p.mu.Lock()
	p.closed = true
	p.mu.Unlock()
	p.cOnce.Do(func() { close(p.out) })
	return nil
}

func (p *fakeProc) state() (writes []string, sizes [][2]int, killed bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.writes...), append([][2]int(nil), p.sizes...), p.killed
}

// fakeSpawner records every spec and hands out fake processes.
type fakeSpawner struct {
	mu      sync.Mutex
	specs   []terminalSpec
	procs   []*fakeProc
	failPTY error
	failAll error
}

func (f *fakeSpawner) start(spec terminalSpec) (terminalProcess, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.specs = append(f.specs, spec)
	if f.failAll != nil || (spec.PTY && f.failPTY != nil) {
		if f.failAll != nil {
			return nil, f.failAll
		}
		return nil, f.failPTY
	}
	p := newFakeProc()
	f.procs = append(f.procs, p)
	return p, nil
}

func (f *fakeSpawner) spec(t *testing.T, i int) terminalSpec {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if i >= len(f.specs) {
		t.Fatalf("spec %d not started (%d specs)", i, len(f.specs))
	}
	return f.specs[i]
}

func (f *fakeSpawner) proc(t *testing.T, i int) *fakeProc {
	t.Helper()
	waitUntil(t, "process "+string(rune('0'+i)), func() bool { f.mu.Lock(); defer f.mu.Unlock(); return len(f.procs) > i })
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.procs[i]
}

func waitUntil(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// termBackend builds a backend whose kubectl calls (config view, delete pod) go to a recording runner.
type termBackend struct {
	t       *testing.T
	b       *Backend
	conn    Connection
	spawner *fakeSpawner
	mu      sync.Mutex
	calls   [][]string
	handler func(args []string) Result
}

func newTermBackend(t *testing.T) *termBackend {
	t.Helper()
	tb := &termBackend{t: t, spawner: &fakeSpawner{}}
	runner := func(_ context.Context, _ string, args []string, _ RunOptions) (Result, error) {
		tb.mu.Lock()
		tb.calls = append(tb.calls, args)
		h := tb.handler
		tb.mu.Unlock()
		if h != nil {
			return h(args), nil
		}
		return Result{}, nil
	}
	tb.b = New(Options{DataDir: filepath.Join(t.TempDir(), "data"), Runner: runner})
	tb.b.term.start = tb.spawner.start
	conn, err := tb.b.Start(0)
	if err != nil {
		t.Fatal(err)
	}
	tb.conn = conn
	t.Cleanup(func() { tb.b.Close() })
	return tb
}

func (tb *termBackend) kubectlCalls() [][]string {
	tb.mu.Lock()
	defer tb.mu.Unlock()
	return append([][]string(nil), tb.calls...)
}

type termClient struct {
	t      *testing.T
	conn   *websocket.Conn
	mu     sync.Mutex
	msgs   []map[string]any
	closed bool
	status websocket.StatusCode
}

func dialTerm(t *testing.T, c Connection, q url.Values) *termClient {
	t.Helper()
	if q == nil {
		q = url.Values{}
	}
	q.Set("token", c.Token)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(c.URL, "http")+"/api/terminal?"+q.Encode(), nil)
	if err != nil {
		t.Fatal(err)
	}
	tc := &termClient{t: t, conn: ws}
	t.Cleanup(func() { ws.CloseNow() })
	go func() {
		for {
			_, data, err := ws.Read(context.Background())
			tc.mu.Lock()
			if err != nil {
				tc.closed, tc.status = true, websocket.CloseStatus(err)
				tc.mu.Unlock()
				return
			}
			var m map[string]any
			if json.Unmarshal(data, &m) == nil {
				tc.msgs = append(tc.msgs, m)
			}
			tc.mu.Unlock()
		}
	}()
	return tc
}

func (tc *termClient) send(v any) {
	tc.t.Helper()
	data, _ := json.Marshal(v)
	if err := tc.conn.Write(context.Background(), websocket.MessageText, data); err != nil {
		tc.t.Fatal(err)
	}
}

func (tc *termClient) messages() []map[string]any {
	tc.mu.Lock()
	defer tc.mu.Unlock()
	return append([]map[string]any(nil), tc.msgs...)
}

func (tc *termClient) find(typ string) map[string]any {
	for _, m := range tc.messages() {
		if m["type"] == typ {
			return m
		}
	}
	return nil
}

func (tc *termClient) await(what string, ok func([]map[string]any) bool) {
	tc.t.Helper()
	waitUntil(tc.t, what, func() bool { return ok(tc.messages()) })
}

func (tc *termClient) awaitType(typ string) map[string]any {
	tc.t.Helper()
	tc.await(typ+" message", func([]map[string]any) bool { return tc.find(typ) != nil })
	return tc.find(typ)
}

func (tc *termClient) output() string {
	var sb strings.Builder
	for _, m := range tc.messages() {
		if m["type"] == "data" {
			sb.WriteString(m["data"].(string))
		}
	}
	return sb.String()
}

func (tc *termClient) awaitOutput(sub string) {
	tc.t.Helper()
	waitUntil(tc.t, "output containing "+sub, func() bool { return strings.Contains(tc.output(), sub) })
}

func (tc *termClient) awaitClose() websocket.StatusCode {
	tc.t.Helper()
	waitUntil(tc.t, "socket close", func() bool { tc.mu.Lock(); defer tc.mu.Unlock(); return tc.closed })
	tc.mu.Lock()
	defer tc.mu.Unlock()
	return tc.status
}

func args(s ...string) []string { return s }

const podShellTail = "if [ -x /bin/bash ]; then exec /bin/bash; else exec /bin/sh; fi"

// --- fake process tests -------------------------------------------------------------------

func TestTerminalPTYSessionForwardsInputResizeAndKillsOnDisconnect(t *testing.T) {
	t.Setenv("RUBBAN_DISABLE_PTY", "")
	tb := newTermBackend(t)
	tc := dialTerm(t, tb.conn, url.Values{"context": {"dev"}, "namespace": {"apps"}, "pod": {"web"}, "container": {"server"}, "cols": {"90"}, "rows": {"25"}})
	status := tc.awaitType("status")
	if status["mode"] != "pty" || status["message"] != "Interactive pod terminal" {
		t.Fatalf("%v", status)
	}
	spec := tb.spawner.spec(t, 0)
	wantArgs := args("--context=dev", "--namespace=apps", "exec", "--stdin=true", "--tty=true", "web", "--container=server", "--", "/bin/sh", "-c", podShellTail)
	if !spec.PTY || !reflect.DeepEqual(spec.Args, wantArgs) || spec.Cols != 90 || spec.Rows != 25 {
		t.Fatalf("spec %+v", spec)
	}
	envSet := strings.Join(spec.Env, "\n")
	if !strings.Contains(envSet, "\nTERM=xterm-256color") && !strings.HasPrefix(envSet, "TERM=xterm-256color") {
		t.Fatal("TERM missing")
	}
	proc := tb.spawner.proc(t, 0)
	tc.send(map[string]any{"type": "input", "data": "ls\n"})
	tc.send(map[string]any{"type": "resize", "cols": 120, "rows": 40})
	waitUntil(t, "input and resize", func() bool { w, s, _ := proc.state(); return len(w) == 1 && len(s) == 1 })
	writes, sizes, _ := proc.state()
	if writes[0] != "ls\n" || sizes[0] != [2]int{120, 40} {
		t.Fatalf("%v %v", writes, sizes)
	}
	proc.out <- []byte("output\n")
	tc.awaitOutput("output\n")
	tc.conn.Close(websocket.StatusNormalClosure, "bye")
	waitUntil(t, "kill on disconnect", func() bool { _, _, k := proc.state(); return k })
	waitUntil(t, "close", func() bool { proc.mu.Lock(); defer proc.mu.Unlock(); return proc.closed })
}

func TestTerminalPipesModeNeverRequestsTTYAndValidatesMessages(t *testing.T) {
	t.Setenv("RUBBAN_DISABLE_PTY", "1")
	tb := newTermBackend(t)
	tc := dialTerm(t, tb.conn, url.Values{"context": {"dev"}, "namespace": {"apps"}, "pod": {"web"}, "attach": {"true"}})
	status := tc.awaitType("status")
	if status["mode"] != "pipes" || !strings.HasPrefix(status["message"].(string), "Command-pipe fallback") {
		t.Fatalf("%v", status)
	}
	spec := tb.spawner.spec(t, 0)
	if spec.PTY || !reflect.DeepEqual(spec.Args, args("--context=dev", "--namespace=apps", "attach", "--stdin=true", "web")) {
		t.Fatalf("spec %+v", spec)
	}
	proc := tb.spawner.proc(t, 0)
	// Invalid messages answer with an error and leave the socket open and usable.
	for _, bad := range []any{
		map[string]any{"type": "resize", "cols": 0, "rows": 30},
		map[string]any{"type": "resize", "cols": 80},
		map[string]any{"type": "input", "data": strings.Repeat("x", 32769)},
		map[string]any{"type": "input", "data": 5},
		map[string]any{"type": "paste"},
		[]any{1},
	} {
		before := countType(tc.messages(), "error")
		tc.send(bad)
		tc.await("error for invalid message", func(m []map[string]any) bool { return countType(m, "error") > before })
	}
	tc.conn.Write(context.Background(), websocket.MessageText, []byte("not json"))
	tc.await("error for non-JSON", func(m []map[string]any) bool { return countType(m, "error") == 7 })
	tc.send(map[string]any{"type": "input", "data": "echo test\n"})
	waitUntil(t, "input", func() bool { w, _, _ := proc.state(); return len(w) == 1 && w[0] == "echo test\n" })
	// Input of exactly 32 KiB is accepted.
	tc.send(map[string]any{"type": "input", "data": strings.Repeat("y", 32768)})
	waitUntil(t, "max input", func() bool { w, _, _ := proc.state(); return len(w) == 2 })
	tc.conn.Close(websocket.StatusNormalClosure, "bye")
	waitUntil(t, "kill", func() bool { _, _, k := proc.state(); return k })
}

func countType(msgs []map[string]any, typ string) int {
	n := 0
	for _, m := range msgs {
		if m["type"] == typ {
			n++
		}
	}
	return n
}

func TestTerminalFallsBackToPipesWhenPTYFails(t *testing.T) {
	t.Setenv("RUBBAN_DISABLE_PTY", "")
	tb := newTermBackend(t)
	tb.spawner.failPTY = errors.New("no ptmx")
	tc := dialTerm(t, tb.conn, url.Values{"context": {"dev"}, "namespace": {"apps"}, "pod": {"web"}})
	tc.await("two statuses", func(m []map[string]any) bool { return countType(m, "status") == 2 })
	st := tc.messages()
	if st[0]["mode"] != "pipes" || st[0]["message"] != "PTY unavailable; using command pipes without terminal resize: no ptmx" {
		t.Fatalf("%v", st[0])
	}
	if st[1]["message"] != "Command-pipe fallback: interactive TTY applications and resize are unavailable." {
		t.Fatalf("%v", st[1])
	}
	if first, second := tb.spawner.spec(t, 0), tb.spawner.spec(t, 1); !first.PTY || second.PTY || containsArg(second.Args, "--tty=true") || !containsArg(first.Args, "--tty=true") {
		t.Fatalf("%+v %+v", first, second)
	}
}

func hasEnvPrefix(env []string, prefix string) bool {
	for _, kv := range env {
		if strings.HasPrefix(kv, prefix) {
			return true
		}
	}
	return false
}

func containsArg(args []string, want string) bool {
	for _, a := range args {
		if a == want {
			return true
		}
	}
	return false
}

func TestTerminalSpawnFailureIs1011AndValidationIs1008(t *testing.T) {
	t.Setenv("RUBBAN_DISABLE_PTY", "1")
	tb := newTermBackend(t)
	tb.spawner.failAll = errors.New("boom")
	tc := dialTerm(t, tb.conn, url.Values{"context": {"dev"}, "pod": {"web"}})
	if msg := tc.awaitType("error"); msg["error"] != "boom" {
		t.Fatalf("%v", msg)
	}
	if code := tc.awaitClose(); code != websocket.StatusInternalError {
		t.Fatalf("close %d", code)
	}
	before := len(tb.spawner.specs)
	for _, q := range []url.Values{
		{"cols": {"10"}, "pod": {"web"}, "context": {"dev"}},
		{"rows": {"999"}},
		{"pod": {"-bad"}, "context": {"dev"}},
		{"pod": {"web"}},
		{"node": {"n1"}},
		{"node": {"n1"}, "context": {"dev"}, "image": {"bad image;"}},
		{"pod": {"web"}, "context": {"dev"}, "namespace": {"*"}},
	} {
		tc := dialTerm(t, tb.conn, q)
		tc.awaitType("error")
		if code := tc.awaitClose(); code != websocket.StatusPolicyViolation {
			t.Fatalf("%v close %d", q, code)
		}
	}
	if len(tb.spawner.specs) != before {
		t.Fatal("invalid requests must not start processes")
	}
}

func TestTerminalReportsExitCodeAndCloses(t *testing.T) {
	t.Setenv("RUBBAN_DISABLE_PTY", "")
	tb := newTermBackend(t)
	tc := dialTerm(t, tb.conn, url.Values{"context": {"dev"}, "pod": {"web"}})
	proc := tb.spawner.proc(t, 0)
	proc.out <- []byte("bye\r\n")
	proc.exit <- 3
	exit := tc.awaitType("exit")
	if exit["code"] != float64(3) {
		t.Fatalf("%v", exit)
	}
	if code := tc.awaitClose(); code != websocket.StatusNormalClosure {
		t.Fatalf("close %d", code)
	}
	// Output printed before the exit arrives before the exit message.
	msgs := tc.messages()
	if msgs[len(msgs)-1]["type"] != "exit" || !strings.Contains(tc.output(), "bye") {
		t.Fatalf("%v", msgs)
	}
	_, _, killed := proc.state()
	if killed {
		t.Fatal("an exited process must not be killed")
	}
}

func TestTerminalNodeShellArgsAndDebugPodCleanup(t *testing.T) {
	t.Setenv("RUBBAN_DISABLE_PTY", "")
	tb := newTermBackend(t)
	tc := dialTerm(t, tb.conn, url.Values{"context": {"dev"}, "node": {"worker-1"}, "namespace": {"ignored"}})
	status := tc.awaitType("status")
	if status["message"] != "Node shell (privileged debug pod in kube-system)" {
		t.Fatalf("%v", status)
	}
	spec := tb.spawner.spec(t, 0)
	want := args("--context=dev", "--namespace=kube-system", "debug", "node/worker-1", "--stdin=true", "--image=busybox:1.36", "--profile=sysadmin", "--tty=true",
		"--", "chroot", "/host", "/bin/sh", "-c", "if [ -x /bin/bash ]; then exec /bin/bash -l; else exec /bin/sh -l; fi")
	if !reflect.DeepEqual(spec.Args, want) {
		t.Fatalf("%q", spec.Args)
	}
	proc := tb.spawner.proc(t, 0)
	// The pod name is split across chunks; a truncated name must not be captured.
	proc.out <- []byte("Creating debugging pod node-debugger-worker-1-ab")
	proc.out <- []byte("cde with container debugger on node worker-1.\r\n")
	tc.awaitOutput("worker-1.\r\n")
	tc.conn.Close(websocket.StatusNormalClosure, "bye")
	waitUntil(t, "debug pod deletion", func() bool {
		for _, c := range tb.kubectlCalls() {
			if containsArg(c, "delete") {
				return true
			}
		}
		return false
	})
	del := tb.kubectlCalls()[0]
	if !reflect.DeepEqual(del, args("--context=dev", "--namespace=kube-system", "delete", "pod", "node-debugger-worker-1-abcde", "--wait=false", "--ignore-not-found=true")) {
		t.Fatalf("%q", del)
	}
}

func TestTerminalNodeShellImageAndNoPodMeansNoDelete(t *testing.T) {
	t.Setenv("RUBBAN_DISABLE_PTY", "1")
	tb := newTermBackend(t)
	tc := dialTerm(t, tb.conn, url.Values{"context": {"dev"}, "node": {"n1"}, "image": {"registry.example.com:5000/dbg@sha256:abc"}})
	tc.awaitType("status")
	spec := tb.spawner.spec(t, 0)
	if !containsArg(spec.Args, "--image=registry.example.com:5000/dbg@sha256:abc") || containsArg(spec.Args, "--tty=true") {
		t.Fatalf("%q", spec.Args)
	}
	proc := tb.spawner.proc(t, 0)
	proc.out <- []byte("no pod name in this output\n")
	proc.exit <- 0
	tc.awaitType("exit")
	tc.awaitClose()
	time.Sleep(100 * time.Millisecond)
	if calls := tb.kubectlCalls(); len(calls) != 0 {
		t.Fatalf("unexpected kubectl calls %q", calls)
	}
}

func TestTerminalDebugPodIsNotDeletedWhenBackendIsClosed(t *testing.T) {
	t.Setenv("RUBBAN_DISABLE_PTY", "")
	tb := newTermBackend(t)
	tc := dialTerm(t, tb.conn, url.Values{"context": {"dev"}, "node": {"n1"}})
	proc := tb.spawner.proc(t, 0)
	proc.out <- []byte("debugging pod node-debugger-n1-xyz12 with\n")
	tc.awaitOutput("xyz12")
	tb.b.Close()
	waitUntil(t, "kill on backend close", func() bool { _, _, k := proc.state(); return k })
	tc.awaitClose()
	time.Sleep(100 * time.Millisecond)
	if calls := tb.kubectlCalls(); len(calls) != 0 {
		t.Fatalf("%q", calls)
	}
}

func TestTerminalScopedKubeconfigForLocalShell(t *testing.T) {
	t.Setenv("RUBBAN_DISABLE_PTY", "")
	t.Setenv("SHELL", "/bin/bash")
	tb := newTermBackend(t)
	tb.handler = func(args []string) Result {
		return out(map[string]any{"apiVersion": "v1", "kind": "Config", "current-context": "dev", "contexts": []any{map[string]any{"name": "dev", "context": map[string]any{"cluster": "c", "user": "u"}}}}, 0)
	}
	tc := dialTerm(t, tb.conn, url.Values{"context": {"dev"}, "namespace": {"apps"}})
	if st := tc.awaitType("status"); st["message"] != "Interactive local terminal" {
		t.Fatalf("%v", st)
	}
	calls := tb.kubectlCalls()
	if !reflect.DeepEqual(calls[0], args("config", "view", "--raw", "--minify", "--flatten", "--context=dev", "--output=json")) {
		t.Fatalf("%q", calls[0])
	}
	spec := tb.spawner.spec(t, 0)
	if runtime.GOOS != "windows" && spec.Command != "/bin/bash" && !strings.HasSuffix(spec.Command, "sh") {
		t.Fatalf("command %q", spec.Command)
	}
	var file string
	for _, kv := range spec.Env {
		if v, ok := strings.CutPrefix(kv, "KUBECONFIG="); ok {
			file = v
		}
	}
	if file == "" || filepath.Dir(file) != filepath.Join(tb.b.dataDir, "terminals") || !strings.HasSuffix(file, ".kubeconfig") {
		t.Fatalf("KUBECONFIG %q", file)
	}
	if !containsArg(spec.Env, "RUBBAN_CONTEXT=dev") {
		t.Fatal("RUBBAN_CONTEXT missing")
	}
	info, err := os.Stat(file)
	if err != nil || (runtime.GOOS != "windows" && info.Mode().Perm() != 0o600) {
		t.Fatalf("%v %v", err, info)
	}
	if dir, _ := os.Stat(filepath.Dir(file)); runtime.GOOS != "windows" && dir.Mode().Perm() != 0o700 {
		t.Fatalf("dir mode %v", dir.Mode())
	}
	data, _ := os.ReadFile(file)
	var config map[string]any
	if err := json.Unmarshal(data, &config); err != nil {
		t.Fatal(err)
	}
	ctxEntry := config["contexts"].([]any)[0].(map[string]any)["context"].(map[string]any)
	if ctxEntry["namespace"] != "apps" || ctxEntry["cluster"] != "c" {
		t.Fatalf("%v", ctxEntry)
	}
	tc.conn.Close(websocket.StatusNormalClosure, "bye")
	waitUntil(t, "kubeconfig removal", func() bool { _, err := os.Stat(file); return os.IsNotExist(err) })
}

func TestTerminalScopedKubeconfigFailureFailsClosed(t *testing.T) {
	t.Setenv("RUBBAN_DISABLE_PTY", "")
	tb := newTermBackend(t)
	tb.handler = func([]string) Result { return Result{Stderr: "error: context \"dev\" does not exist", Code: 1} }
	tc := dialTerm(t, tb.conn, url.Values{"context": {"dev"}})
	msg := tc.awaitType("error")
	if !strings.HasPrefix(msg["error"].(string), "Could not prepare a kubeconfig for dev: ") || !strings.Contains(msg["error"].(string), "does not exist") {
		t.Fatalf("%v", msg)
	}
	if code := tc.awaitClose(); code != websocket.StatusPolicyViolation {
		t.Fatalf("close %d", code)
	}
	if len(tb.spawner.specs) != 0 {
		t.Fatal("no shell may start without its kubeconfig")
	}
	// Invalid JSON is a failure too.
	tb.handler = func([]string) Result { return Result{Stdout: "not json"} }
	tc = dialTerm(t, tb.conn, url.Values{"context": {"dev"}})
	tc.awaitType("error")
	if code := tc.awaitClose(); code != websocket.StatusPolicyViolation {
		t.Fatalf("close %d", code)
	}
}

func TestTerminalUnscopedLocalShellUsesNoKubeconfig(t *testing.T) {
	t.Setenv("RUBBAN_DISABLE_PTY", "")
	t.Setenv("SHELL", "/bin/sh")
	t.Setenv("KUBECONFIG", "/home/someone/.kube/config")
	tb := newTermBackend(t)
	tc := dialTerm(t, tb.conn, nil)
	tc.awaitType("status")
	spec := tb.spawner.spec(t, 0)
	if len(tb.kubectlCalls()) != 0 || hasEnvPrefix(spec.Env, "RUBBAN_CONTEXT=") {
		t.Fatal("an unscoped shell is not scoped")
	}
	if !containsArg(spec.Env, "KUBECONFIG=/home/someone/.kube/config") {
		t.Fatal("the user's own KUBECONFIG is kept")
	}
	if home, _ := os.UserHomeDir(); spec.Dir != home {
		t.Fatalf("dir %q", spec.Dir)
	}
	if spec.Cols != 100 || spec.Rows != 30 {
		t.Fatalf("default size %dx%d", spec.Cols, spec.Rows)
	}
}

func TestTerminalDirectoryIsWipedAtStartAndClose(t *testing.T) {
	dir := t.TempDir()
	stale := filepath.Join(dir, "terminals", "old.kubeconfig")
	if err := os.MkdirAll(filepath.Dir(stale), 0o700); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(stale, []byte("{}"), 0o600)
	b := New(Options{DataDir: dir, Runner: func(context.Context, string, []string, RunOptions) (Result, error) { return Result{}, nil }})
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatal("stale kubeconfig survived start")
	}
	os.MkdirAll(filepath.Dir(stale), 0o700)
	os.WriteFile(stale, []byte("{}"), 0o600)
	b.Close()
	if _, err := os.Stat(filepath.Dir(stale)); !os.IsNotExist(err) {
		t.Fatal("terminals directory survived close")
	}
}

func TestLocalShellSelection(t *testing.T) {
	has := func(files ...string) func(string) bool {
		return func(p string) bool {
			for _, f := range files {
				if f == p {
					return true
				}
			}
			return false
		}
	}
	type result struct {
		cmd  string
		args []string
	}
	for _, tc := range []struct {
		name   string
		goos   string
		shell  string
		scoped bool
		files  []string
		want   result
	}{
		{"login bash", "linux", "/bin/bash", false, []string{"/bin/bash"}, result{"/bin/bash", args("-l")}},
		{"login zsh", "darwin", "/usr/local/bin/zsh", false, []string{"/usr/local/bin/zsh"}, result{"/usr/local/bin/zsh", args("-l")}},
		{"login sh has no -l", "linux", "/bin/sh", false, []string{"/bin/sh"}, result{"/bin/sh", nil}},
		{"missing $SHELL on mac", "darwin", "/gone/fish", false, []string{"/bin/zsh", "/bin/bash"}, result{"/bin/zsh", args("-l")}},
		{"relative $SHELL ignored", "linux", "bash", false, []string{"/bin/bash", "/bin/sh"}, result{"/bin/bash", args("-l")}},
		{"nothing exists", "linux", "", false, nil, result{"/bin/sh", nil}},
		{"scoped bash", "linux", "/bin/bash", true, []string{"/bin/bash"}, result{"/bin/bash", args("--noprofile", "--norc")}},
		{"scoped zsh", "darwin", "/bin/zsh", true, []string{"/bin/zsh"}, result{"/bin/zsh", args("-f")}},
		{"scoped fish", "linux", "/usr/bin/fish", true, []string{"/usr/bin/fish", "/bin/sh"}, result{"/usr/bin/fish", args("--no-config")}},
		{"scoped unknown shell uses sh", "linux", "/usr/bin/nu", true, []string{"/usr/bin/nu", "/bin/sh"}, result{"/bin/sh", nil}},
		{"scoped unknown shell without sh", "linux", "/usr/bin/nu", true, []string{"/usr/bin/nu"}, result{"/usr/bin/nu", nil}},
	} {
		cmd, a := localShell(tc.goos, tc.shell, tc.scoped, has(tc.files...))
		if (result{cmd, a}).cmd != tc.want.cmd || !reflect.DeepEqual(a, tc.want.args) {
			t.Errorf("%s: got %s %q, want %s %q", tc.name, cmd, a, tc.want.cmd, tc.want.args)
		}
	}
	t.Setenv("SystemRoot", `C:\Win`)
	cmd, a := localShell("windows", "", true, has())
	if cmd != `C:\Win\System32\WindowsPowerShell\v1.0\powershell.exe` || !reflect.DeepEqual(a, args("-NoLogo", "-NoProfile")) {
		t.Errorf("windows scoped: %s %q", cmd, a)
	}
	if _, a := localShell("windows", "", false, has()); !reflect.DeepEqual(a, args("-NoLogo")) {
		t.Errorf("windows login: %q", a)
	}
}

func TestUTF8CarryKeepsSplitCharacters(t *testing.T) {
	var c utf8Carry
	euro := []byte("€") // three bytes
	got := c.next([]byte("a")) + c.next(euro[:1]) + c.next(euro[1:2]) + c.next(append(append([]byte{}, euro[2:]...), 'b'))
	if got != "a€b" {
		t.Fatalf("%q", got)
	}
	if c.next([]byte{0xe2}) != "" || c.flush() == "" || c.flush() != "" {
		t.Fatal("an incomplete tail is held back and flushed once")
	}
	if s := c.next([]byte("héllo wörld")); !utf8.ValidString(s) || s != "héllo wörld" {
		t.Fatalf("%q", s)
	}
}

// --- real processes (Linux and macOS) ---------------------------------------------------------

func needSh(t *testing.T) {
	t.Helper()
	if _, err := os.Stat("/bin/sh"); err != nil {
		t.Skip("needs /bin/sh")
	}
}

func realTerminalBackend(t *testing.T) (*Backend, Connection) {
	t.Helper()
	b := New(Options{DataDir: filepath.Join(t.TempDir(), "data")})
	conn, err := b.Start(0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { b.Close() })
	return b, conn
}

func TestTerminalRealPipes(t *testing.T) {
	needSh(t)
	t.Setenv("RUBBAN_DISABLE_PTY", "1")
	t.Setenv("SHELL", "/bin/sh")
	_, conn := realTerminalBackend(t)
	tc := dialTerm(t, conn, nil)
	if st := tc.awaitType("status"); st["mode"] != "pipes" {
		t.Fatalf("%v", st)
	}
	tc.send(map[string]any{"type": "input", "data": "echo out-$((6*7)); echo err-line 1>&2\n"})
	tc.awaitOutput("out-42")
	tc.awaitOutput("err-line")
	tc.send(map[string]any{"type": "resize", "cols": 100, "rows": 30}) // accepted and ignored
	tc.send(map[string]any{"type": "input", "data": "exit 3\n"})
	if exit := tc.awaitType("exit"); exit["code"] != float64(3) {
		t.Fatalf("%v", exit)
	}
	if code := tc.awaitClose(); code != websocket.StatusNormalClosure {
		t.Fatalf("close %d", code)
	}
}

func TestTerminalRealPTY(t *testing.T) {
	needSh(t)
	t.Setenv("RUBBAN_DISABLE_PTY", "")
	t.Setenv("SHELL", "/bin/sh")
	_, conn := realTerminalBackend(t)
	tc := dialTerm(t, conn, url.Values{"cols": {"90"}, "rows": {"25"}})
	if st := tc.awaitType("status"); st["mode"] != "pty" || st["message"] != "Interactive local terminal" {
		t.Fatalf("%v", st)
	}
	tc.send(map[string]any{"type": "input", "data": "stty size; test -t 0 && echo is-a-tty-$TERM\n"})
	tc.awaitOutput("25 90")
	tc.awaitOutput("is-a-tty-xterm-256color")
	tc.send(map[string]any{"type": "resize", "cols": 120, "rows": 40})
	waitUntil(t, "resize applied", func() bool {
		tc.send(map[string]any{"type": "input", "data": "stty size\n"})
		time.Sleep(50 * time.Millisecond)
		return strings.Contains(tc.output(), "40 120")
	})
	tc.send(map[string]any{"type": "input", "data": "printf 'caf\\303\\251\\n'; exit 7\n"})
	if exit := tc.awaitType("exit"); exit["code"] != float64(7) {
		t.Fatalf("%v", exit)
	}
	if !strings.Contains(tc.output(), "café") {
		t.Fatalf("%q", tc.output())
	}
	if code := tc.awaitClose(); code != websocket.StatusNormalClosure {
		t.Fatalf("close %d", code)
	}
}

func shellPID(t *testing.T, tc *termClient) int {
	t.Helper()
	tc.send(map[string]any{"type": "input", "data": "echo pid=$$=\n"})
	var pid int
	waitUntil(t, "shell pid", func() bool {
		out := tc.output()
		i := strings.LastIndex(out, "pid=")
		if i < 0 {
			return false
		}
		rest := out[i+4:]
		j := strings.Index(rest, "=")
		if j <= 0 {
			return false
		}
		n := 0
		for _, c := range rest[:j] {
			if c < '0' || c > '9' {
				return false
			}
			n = n*10 + int(c-'0')
		}
		pid = n
		return n > 0
	})
	return pid
}

func TestTerminalRealProcessesDieWithTheSocketAndTheBackend(t *testing.T) {
	needSh(t)
	t.Setenv("SHELL", "/bin/sh")
	for _, pty := range []string{"", "1"} {
		t.Setenv("RUBBAN_DISABLE_PTY", pty)
		b, conn := realTerminalBackend(t)
		// Closing the socket ends the shell.
		tc := dialTerm(t, conn, nil)
		pid := shellPID(t, tc)
		tc.conn.Close(websocket.StatusNormalClosure, "bye")
		waitUntil(t, "shell killed after disconnect (pty="+pty+")", func() bool { return processGone(pid) })
		// Closing the backend ends it too and empties the registry.
		tc = dialTerm(t, conn, nil)
		pid = shellPID(t, tc)
		b.Close()
		waitUntil(t, "shell killed after Close (pty="+pty+")", func() bool { return processGone(pid) })
		tc.awaitClose()
	}
}

func TestTerminalPTYUnavailableFallsBackToRealPipes(t *testing.T) {
	needSh(t)
	t.Setenv("RUBBAN_DISABLE_PTY", "")
	t.Setenv("SHELL", "/bin/sh")
	// A broken PTY layer is simulated by failing only the PTY start; pipes spawn a real shell.
	b, conn := realTerminalBackend(t)
	b.term.start = func(spec terminalSpec) (terminalProcess, error) {
		if spec.PTY {
			return nil, errors.New("simulated")
		}
		return startPipeProcess(spec, b.procs.track)
	}
	tc := dialTerm(t, conn, nil)
	tc.await("both statuses", func(m []map[string]any) bool { return countType(m, "status") == 2 })
	tc.send(map[string]any{"type": "input", "data": "echo fallback-ok; exit 0\n"})
	tc.awaitOutput("fallback-ok")
	tc.awaitType("exit")
}

func TestTerminalSpawnsThroughRegistryAndFakeKubectl(t *testing.T) {
	needSh(t)
	t.Setenv("RUBBAN_DISABLE_PTY", "1")
	dir := t.TempDir()
	log := filepath.Join(dir, "calls.log")
	script := "#!/bin/sh\necho \"$@\" >> " + log + "\nif [ \"$3\" = \"debug\" ]; then echo 'Creating debugging pod node-debugger-n1-q7x2z with container debugger on node n1.' 1>&2; cat; fi\n"
	kubectl := filepath.Join(dir, "kubectl")
	if err := os.WriteFile(kubectl, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	b := New(Options{DataDir: filepath.Join(dir, "data"), KubectlPath: kubectl})
	conn, err := b.Start(0)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	tc := dialTerm(t, conn, url.Values{"context": {"dev"}, "node": {"n1"}})
	tc.awaitOutput("node-debugger-n1-q7x2z")
	tc.conn.Close(websocket.StatusNormalClosure, "bye")
	waitUntil(t, "pod deletion through kubectl", func() bool {
		data, _ := os.ReadFile(log)
		return strings.Contains(string(data), "--context=dev --namespace=kube-system delete pod node-debugger-n1-q7x2z --wait=false --ignore-not-found=true")
	})
	data, _ := os.ReadFile(log)
	if !strings.Contains(string(data), "--context=dev --namespace=kube-system debug node/n1 --stdin=true --image=busybox:1.36 --profile=sysadmin -- chroot /host /bin/sh -c") {
		t.Fatalf("%s", data)
	}
}
