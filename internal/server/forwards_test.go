package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// fwdFakeChild stands in for one `kubectl port-forward` process.
type fwdFakeChild struct {
	args      []string
	hooks     childHooks
	mu        sync.Mutex
	killed    bool
	killCalls int
}

func (c *fwdFakeChild) kill() {
	c.mu.Lock()
	c.killCalls++
	already := c.killed
	c.killed = true
	c.mu.Unlock()
	if !already {
		go c.hooks.exited(-1)
	}
}

func (c *fwdFakeChild) wasKilled() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.killed
}

// say writes to the child's stdout.
func (c *fwdFakeChild) say(text string) { c.hooks.output(text) }

// exit ends the child on its own, as kubectl does when the connection to the pod is lost.
func (c *fwdFakeChild) exit(code int) { c.hooks.exited(code) }

// fwdFakeSpawner records every child the forward code starts.
type fwdFakeSpawner struct {
	mu       sync.Mutex
	children []*fwdFakeChild
	command  string
}

func (s *fwdFakeSpawner) spawn(command string, args, env []string, hooks childHooks) (childProc, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	child := &fwdFakeChild{args: args, hooks: hooks}
	s.children = append(s.children, child)
	s.command = command
	return child, nil
}

func (s *fwdFakeSpawner) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.children)
}

func (s *fwdFakeSpawner) child(i int) *fwdFakeChild {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.children[i]
}

// waitFor polls a condition for up to two seconds.
func fwdWaitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func fwdFixture(t *testing.T, handler func(args []string, opts RunOptions) Result) (*fixture, *fwdFakeSpawner) {
	t.Helper()
	f := newFixture(t, handler)
	spawner := &fwdFakeSpawner{}
	fwdStateOf(f.b).spawn = spawner.spawn
	return f, spawner
}

func TestForwardsBindLoopbackDetectReadinessPreventDuplicatePortsAndStop(t *testing.T) {
	f, spawner := fwdFixture(t, nil)
	body := map[string]any{"context": "dev", "namespace": "apps", "resource": "services", "name": "web", "localPort": 18080, "remotePort": 80}
	created := f.post("/api/forwards", body)
	if created.Status != 201 || created.Value["status"] != "starting" {
		t.Fatalf("create %d %v", created.Status, created.Value)
	}
	child := spawner.child(0)
	if !slices.Contains(child.args, "--address=127.0.0.1") || spawner.command != "test-kubectl" {
		t.Fatalf("spawn %s %v", spawner.command, child.args)
	}
	want := []string{"--context=dev", "--namespace=apps", "port-forward", "services/web", "18080:80", "--address=127.0.0.1"}
	if !reflect.DeepEqual(child.args, want) {
		t.Fatalf("args %v", child.args)
	}
	child.say("Forwarding from 127.0.0.1:18080 -> 80\n")
	list := f.get("/api/forwards").Value["items"].([]any)
	if list[0].(map[string]any)["status"] != "ready" {
		t.Fatalf("list %v", list)
	}
	if r := f.post("/api/forwards", body); r.Status != 409 {
		t.Fatalf("duplicate port %d", r.Status)
	}
	if r := f.do("DELETE", "/api/forwards/"+created.Value["id"].(string), nil, nil); r.Status != 200 || r.Value["ok"] != true {
		t.Fatalf("delete %d %v", r.Status, r.Value)
	}
	if !child.wasKilled() {
		t.Fatal("kubectl was not killed")
	}
	if items := f.get("/api/forwards").Value["items"].([]any); len(items) != 0 {
		t.Fatalf("after delete %v", items)
	}
	if r := f.do("DELETE", "/api/forwards/"+created.Value["id"].(string), nil, nil); r.Status != 404 {
		t.Fatalf("second delete %d", r.Status)
	}
}

func TestForwardsLetKubectlChooseTheLocalPort(t *testing.T) {
	f, spawner := fwdFixture(t, func([]string, RunOptions) Result { return out("", 0) })
	created := f.post("/api/forwards", map[string]any{"context": "dev", "namespace": "apps", "resource": "services", "name": "web", "remotePort": 80})
	if created.Status != 201 {
		t.Fatalf("create %d %v", created.Status, created.Value)
	}
	child := spawner.child(spawner.count() - 1)
	if got := child.args[len(child.args)-3:]; !reflect.DeepEqual(got, []string{"services/web", ":80", "--address=127.0.0.1"}) {
		t.Fatalf("args %v", child.args)
	}
	child.say("Forwarding from 127.0.0.1:43123 -> 80\n")
	item := f.get("/api/forwards").Value["items"].([]any)[0].(map[string]any)
	if item["localPort"] != 43123.0 || item["status"] != "ready" {
		t.Fatalf("item %v", item)
	}
	// Output that arrives in pieces is still recognised, and IPv6 loopback counts.
	other := f.post("/api/forwards", map[string]any{"context": "dev", "resource": "pods", "name": "p", "remotePort": 8080})
	child2 := spawner.child(spawner.count() - 1)
	child2.say("Forwarding from [::1]:")
	child2.say("5555 -> 8080\n")
	items := f.get("/api/forwards").Value["items"].([]any)
	if items[1].(map[string]any)["localPort"] != 5555.0 || other.Value["namespace"] != "" {
		t.Fatalf("pieces %v", items)
	}
}

func TestForwardsValidateAndReportFailures(t *testing.T) {
	f, spawner := fwdFixture(t, nil)
	good := map[string]any{"context": "dev", "namespace": "apps", "resource": "services", "name": "web", "remotePort": 80}
	with := func(k string, v any) map[string]any {
		out := map[string]any{}
		for key, val := range good {
			out[key] = val
		}
		out[k] = v
		return out
	}
	for _, body := range []map[string]any{with("resource", "Services"), with("name", "-x"), with("remotePort", 0), with("remotePort", 70000), with("localPort", -1), with("namespace", "*"), with("context", "")} {
		if r := f.post("/api/forwards", body); r.Status != 400 {
			t.Fatalf("%v: %d", body, r.Status)
		}
	}
	if spawner.count() != 0 {
		t.Fatal("invalid request started kubectl")
	}
	// A forward that exits with an error keeps kubectl's message.
	f.post("/api/forwards", good)
	child := spawner.child(0)
	child.say("error: unable to forward port\n")
	child.exit(1)
	item := f.get("/api/forwards").Value["items"].([]any)[0].(map[string]any)
	if item["status"] != "error" || !strings.Contains(item["error"].(string), "unable to forward port") {
		t.Fatalf("error item %v", item)
	}
	// A clean exit is a stopped forward.
	f.post("/api/forwards", with("name", "other"))
	spawner.child(1).exit(0)
	if status := f.get("/api/forwards").Value["items"].([]any)[1].(map[string]any)["status"]; status != "stopped" {
		t.Fatalf("status %v", status)
	}
	// An exit without output still says why.
	f.post("/api/forwards", with("name", "silent"))
	spawner.child(2).exit(3)
	if msg := f.get("/api/forwards").Value["items"].([]any)[2].(map[string]any)["error"]; msg != "kubectl port-forward exited with code 3" {
		t.Fatalf("message %v", msg)
	}
}

func TestForwardsStopWhenTheBackendCloses(t *testing.T) {
	f, spawner := fwdFixture(t, nil)
	f.post("/api/forwards", map[string]any{"context": "dev", "namespace": "apps", "resource": "pods", "name": "web", "localPort": 18081, "remotePort": 80})
	if spawner.count() != 1 {
		t.Fatal("forward not started")
	}
	_ = f.b.Close()
	fwdWaitFor(t, "kubectl to be killed", spawner.child(0).wasKilled)
	if _, err := fwdStateOf(f.b).create(map[string]any{"context": "dev", "resource": "pods", "name": "web", "remotePort": 80}); statusOf(err) != 503 {
		t.Fatalf("forward after close: %v", err)
	}
}

func TestForwardsNeedKubectl(t *testing.T) {
	f := newFixture(t, nil)
	f.b.tools["kubectl"] = ToolInfo{}
	if r := f.post("/api/forwards", map[string]any{"context": "dev", "resource": "pods", "name": "web", "remotePort": 80}); r.Status != 503 {
		t.Fatalf("no kubectl %d", r.Status)
	}
}

func TestEmbeddedConsoleOutlivesItsPortForward(t *testing.T) {
	services := obj{"items": []any{obj{"metadata": obj{"name": "orders", "namespace": "mq"}, "spec": obj{"selector": obj{"app": "orders"}, "ports": []any{obj{"name": "management", "port": 15672}}}}}}
	mqPod := obj{"metadata": obj{"name": "orders-0", "namespace": "mq", "labels": obj{"app": "orders"}}, "spec": obj{"containers": []any{obj{"name": "rabbitmq", "image": "rabbitmq:4.1-management"}}}, "status": obj{"phase": "Running", "conditions": []any{obj{"type": "Ready", "status": "True"}}}}
	f, spawner := fwdFixture(t, func(args []string, _ RunOptions) Result {
		switch {
		case args[0] == "get" && args[1] == "services":
			return out(services, 0)
		case args[0] == "get" && args[1] == "pods":
			return out(obj{"items": []any{mqPod}}, 0)
		}
		return out(obj{"items": []any{}}, 0)
	})
	// Stands in for the management console at the forward's local port.
	var mu sync.Mutex
	hits := 0
	mgmt := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits++
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(mgmt.Close)
	mgmtPort := embedPortOf(t, mgmt.URL)
	ready := func(c *fwdFakeChild) { c.say(fmt.Sprintf("Forwarding from 127.0.0.1:%d -> 15672\n", mgmtPort)) }
	hitCount := func() int {
		mu.Lock()
		defer mu.Unlock()
		return hits
	}

	opening := make(chan response, 1)
	go func() {
		opening <- f.post("/api/rabbitmq/open", map[string]any{"context": "dev", "namespace": "mq", "service": "orders"})
	}()
	fwdWaitFor(t, "kubectl port-forward started", func() bool { return spawner.count() == 1 })
	ready(spawner.child(0))
	opened := <-opening
	if opened.Status != 200 {
		t.Fatalf("open %d %v", opened.Status, opened.Value)
	}
	consoleURL := opened.Value["url"].(string)
	if opened.Value["origin"] != strings.TrimSuffix(consoleURL, "/") || opened.Value["localPort"] != float64(mgmtPort) {
		t.Fatalf("opened %v", opened.Value)
	}
	get := func() int {
		res, err := http.Get(consoleURL + "api/overview")
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	if get() != 200 || hitCount() != 1 {
		t.Fatalf("first poll hits=%d", hitCount())
	}

	// kubectl gives up ("lost connection to pod"). The console's next poll restarts the forward and
	// is answered once it is ready; the proxy's port, the iframe's origin, is unchanged.
	spawner.child(0).say("error: lost connection to pod\n")
	spawner.child(0).exit(1)
	polled := make(chan int, 1)
	go func() { polled <- get() }()
	fwdWaitFor(t, "kubectl port-forward restarted", func() bool { return spawner.count() == 2 })
	if got := spawner.child(1).args; !reflect.DeepEqual(got[len(got)-3:], []string{"services/orders", ":15672", "--address=127.0.0.1"}) {
		t.Fatalf("restart args %v", got)
	}
	ready(spawner.child(1))
	if status := <-polled; status != 200 || hitCount() != 2 {
		t.Fatalf("restarted poll status=%d hits=%d", status, hitCount())
	}
	items := f.get("/api/forwards").Value["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("forwards %v", items)
	}
	forward := items[0].(map[string]any)
	if forward["status"] != "ready" || fmt.Sprintf("http://127.0.0.1:%d/", int(forward["embedPort"].(float64))) != consoleURL {
		t.Fatalf("forward %v", forward)
	}
	// Opening the console again reuses the proxy and the restarted forward.
	reopened := f.post("/api/rabbitmq/open", map[string]any{"context": "dev", "namespace": "mq", "service": "orders"})
	if reopened.Value["url"] != consoleURL || reopened.Value["forwardId"] != forward["id"] || spawner.count() != 2 {
		t.Fatalf("reopened %v children=%d", reopened.Value, spawner.count())
	}

	// Stopping the forward from Port Forwarding closes the console with it.
	if r := f.do("DELETE", "/api/forwards/"+forward["id"].(string), nil, nil); r.Status != 200 {
		t.Fatalf("delete %d", r.Status)
	}
	if res, err := http.Get(consoleURL + "api/overview"); err == nil {
		res.Body.Close()
		t.Fatalf("console still answers with %d", res.StatusCode)
	}
}

func TestRealChildProcessOutputAndKill(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/sh")
	}
	b := New(Options{DataDir: t.TempDir(), Runner: func(context.Context, string, []string, RunOptions) (Result, error) { return Result{}, nil }})
	t.Cleanup(func() { b.Close() })
	var mu sync.Mutex
	var output strings.Builder
	exited := make(chan int, 1)
	child, err := b.spawnChild("/bin/sh", []string{"-c", "echo Forwarding from 127.0.0.1:7777 '->' 80; echo oops >&2; sleep 30"}, nil, childHooks{
		output: func(chunk string) {
			mu.Lock()
			output.WriteString(chunk)
			mu.Unlock()
		},
		exited: func(code int) { exited <- code },
	})
	if err != nil {
		t.Fatal(err)
	}
	fwdWaitFor(t, "output from both streams", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return strings.Contains(output.String(), "7777") && strings.Contains(output.String(), "oops")
	})
	child.kill()
	child.kill() // once only
	select {
	case code := <-exited:
		if code == 0 {
			t.Fatalf("killed child exited %d", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("child did not exit")
	}
	if _, err := b.spawnChild("/nonexistent/kubectl", nil, nil, childHooks{}); err == nil {
		t.Fatal("missing program started")
	}
	if _, err := b.spawnChild("/bin/sh", []string{"a\x00b"}, nil, childHooks{}); statusOf(err) != 400 {
		t.Fatalf("NUL argument: %v", err)
	}
}

func TestEmbeddedConsoleReportsAForwardThatDoesNotStart(t *testing.T) {
	services := obj{"items": []any{obj{"metadata": obj{"name": "orders", "namespace": "mq"}, "spec": obj{"selector": obj{"app": "orders"}, "ports": []any{obj{"name": "management", "port": 15672}}}}}}
	f, spawner := fwdFixture(t, func(args []string, _ RunOptions) Result {
		if args[0] == "get" && args[1] == "services" {
			return out(services, 0)
		}
		return out(obj{"items": []any{}}, 0)
	})
	opening := make(chan response, 1)
	go func() {
		opening <- f.post("/api/rabbitmq/open", map[string]any{"context": "dev", "namespace": "mq", "service": "orders"})
	}()
	fwdWaitFor(t, "kubectl port-forward started", func() bool { return spawner.count() == 1 })
	spawner.child(0).say("error: pods \"orders-0\" not found\nsecond line\n")
	spawner.child(0).exit(1)
	r := <-opening
	if r.Status != 502 || !strings.Contains(r.Value["error"].(string), `did not start: error: pods "orders-0" not found`) || strings.Contains(r.Value["error"].(string), "second line") {
		t.Fatalf("open %d %v", r.Status, r.Value)
	}
	// The failed forward does not linger in Port Forwarding.
	if items := f.get("/api/forwards").Value["items"].([]any); len(items) != 0 {
		t.Fatalf("lingering %v", items)
	}
}

// --- persistence and self-healing ----------------------------------------------------------

func fwdFast(f *fixture) *fwdState {
	s := fwdStateOf(f.b)
	s.backoff = func(int) time.Duration { return time.Millisecond }
	s.portFree = func(int) bool { return true }
	return s
}

func fwdSavedList(t *testing.T, f *fixture) []map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(f.b.dataDir, "forwards.json"))
	if err != nil {
		t.Fatal(err)
	}
	var saved []map[string]any
	if err := json.Unmarshal(data, &saved); err != nil {
		t.Fatal(err)
	}
	return saved
}

func fwdItem(t *testing.T, f *fixture, id string) map[string]any {
	t.Helper()
	for _, it := range f.get("/api/forwards").Value["items"].([]any) {
		if m := it.(map[string]any); m["id"] == id {
			return m
		}
	}
	t.Fatalf("forward %s not listed", id)
	return nil
}

func TestForwardIsRestartedWithTheSameArgsAndLearnedPort(t *testing.T) {
	f, spawner := fwdFixture(t, nil)
	fwdFast(f)
	created := f.post("/api/forwards", map[string]any{"context": "dev", "namespace": "apps", "resource": "pods", "name": "db-0", "remotePort": 5432})
	id := created.Value["id"].(string)
	first := spawner.child(0)
	if !slices.Contains(first.args, ":5432") {
		t.Fatalf("first args %v", first.args)
	}
	first.say("Forwarding from 127.0.0.1:41234 -> 5432\n")
	fwdWaitFor(t, "the learned port to be saved", func() bool { s := fwdSavedList(t, f); return len(s) == 1 && s[0]["localPort"] == float64(41234) })
	first.say("error: lost connection to pod\n")
	first.exit(1)
	fwdWaitFor(t, "the respawn", func() bool { return spawner.count() == 2 })
	second := spawner.child(1)
	if want := []string{"--context=dev", "--namespace=apps", "port-forward", "pods/db-0", "41234:5432", "--address=127.0.0.1"}; !reflect.DeepEqual(second.args, want) {
		t.Fatalf("restart args %v", second.args)
	}
	second.say("Forwarding from 127.0.0.1:41234 -> 5432\n")
	item := fwdItem(t, f, id)
	if item["status"] != "ready" || item["restarts"] != float64(1) || item["localPort"] != float64(41234) || item["keep"] != true {
		t.Fatalf("%v", item)
	}
}

func TestForwardShowsTheErrorUntilItIsRestarted(t *testing.T) {
	f, spawner := fwdFixture(t, nil)
	s := fwdStateOf(f.b)
	s.backoff = func(int) time.Duration { return time.Hour }
	s.portFree = func(int) bool { return true }
	id := f.post("/api/forwards", map[string]any{"context": "dev", "namespace": "apps", "resource": "pods", "name": "db-0", "localPort": 15432, "remotePort": 5432}).Value["id"].(string)
	child := spawner.child(0)
	child.say("Forwarding from 127.0.0.1:15432 -> 5432\n")
	child.say("E0101 portforward.go: lost connection to pod\n")
	child.exit(1)
	fwdWaitFor(t, "error status", func() bool { return fwdItem(t, f, id)["status"] == "error" })
	item := fwdItem(t, f, id)
	if item["lastError"] != "E0101 portforward.go: lost connection to pod" || item["retrying"] != true {
		t.Fatalf("%v", item)
	}
	// The user does not wait for the backoff.
	restarted := f.post("/api/forwards/"+id+"/restart", nil)
	if restarted.Status != 200 || restarted.Value["status"] != "starting" || restarted.Value["restarts"] != float64(1) || restarted.Value["retrying"] != nil {
		t.Fatalf("restart %d %v", restarted.Status, restarted.Value)
	}
	if spawner.count() != 2 || !slices.Contains(spawner.child(1).args, "15432:5432") {
		t.Fatalf("children %d", spawner.count())
	}
	if f.post("/api/forwards/nope/restart", nil).Status != 404 {
		t.Fatal("unknown forward")
	}
}

func TestForwardRestartKillsTheRunningChildFirst(t *testing.T) {
	f, spawner := fwdFixture(t, nil)
	fwdFast(f)
	id := f.post("/api/forwards", map[string]any{"context": "dev", "resource": "pods", "name": "p", "localPort": 15433, "remotePort": 80}).Value["id"].(string)
	first := spawner.child(0)
	first.say("Forwarding from 127.0.0.1:15433 -> 80\n")
	if r := f.post("/api/forwards/"+id+"/restart", nil); r.Status != 200 {
		t.Fatalf("%d %v", r.Status, r.Value)
	}
	if !first.wasKilled() || spawner.count() != 2 {
		t.Fatalf("killed=%v children=%d", first.wasKilled(), spawner.count())
	}
	// The old child's exit must not start a third one.
	time.Sleep(50 * time.Millisecond)
	if spawner.count() != 2 {
		t.Fatalf("children %d", spawner.count())
	}
}

func TestForwardGivesUpAfterTenConsecutiveFailures(t *testing.T) {
	f, spawner := fwdFixture(t, nil)
	fwdFast(f)
	id := f.post("/api/forwards", map[string]any{"context": "dev", "resource": "pods", "name": "p", "localPort": 15434, "remotePort": 80}).Value["id"].(string)
	for i := 0; i < 10; i++ {
		fwdWaitFor(t, fmt.Sprintf("child %d", i), func() bool { return spawner.count() > i })
		spawner.child(i).say(fmt.Sprintf("failure %d\n", i))
		spawner.child(i).exit(1)
	}
	fwdWaitFor(t, "the final error", func() bool { item := fwdItem(t, f, id); return item["status"] == "error" && item["retrying"] == nil })
	time.Sleep(40 * time.Millisecond)
	item := fwdItem(t, f, id)
	if spawner.count() != 10 || item["lastError"] != "failure 9" || item["restarts"] != float64(9) {
		t.Fatalf("children=%d %v", spawner.count(), item)
	}
}

func TestForwardFailureCountResetsAfterAStableMinute(t *testing.T) {
	f, spawner := fwdFixture(t, nil)
	s := fwdFast(f)
	id := f.post("/api/forwards", map[string]any{"context": "dev", "resource": "pods", "name": "p", "localPort": 15435, "remotePort": 80}).Value["id"].(string)
	s.mu.Lock()
	fw := s.findLocked(id)
	fw.fails = 8
	s.mu.Unlock()
	spawner.child(0).say("Forwarding from 127.0.0.1:15435 -> 80\n")
	s.mu.Lock()
	fw.readyAt = time.Now().Add(-2 * time.Minute)
	s.mu.Unlock()
	spawner.child(0).exit(1)
	fwdWaitFor(t, "a restart instead of giving up", func() bool { return spawner.count() == 2 })
	s.mu.Lock()
	fails := fw.fails
	s.mu.Unlock()
	if fails != 1 {
		t.Fatalf("fails %d", fails)
	}
}

func TestForwardBackoffDoublesUpToThirtySeconds(t *testing.T) {
	var got []time.Duration
	for n := 1; n <= 9; n++ {
		got = append(got, fwdBackoff(n))
	}
	want := []time.Duration{1, 2, 4, 8, 16, 30, 30, 30, 30}
	for i := range want {
		if got[i] != want[i]*time.Second {
			t.Fatalf("backoff %v", got)
		}
	}
}

func TestForwardsAreSavedRestoredAndForgotten(t *testing.T) {
	f, spawner := fwdFixture(t, nil)
	fwdFast(f)
	id := f.post("/api/forwards", map[string]any{"context": "dev", "namespace": "apps", "resource": "services", "name": "web", "localPort": 18081, "remotePort": 80}).Value["id"].(string)
	saved := fwdSavedList(t, f)
	want := map[string]any{"id": id, "context": "dev", "namespace": "apps", "resource": "services", "name": "web", "localPort": float64(18081), "remotePort": float64(80)}
	if len(saved) != 1 || !reflect.DeepEqual(saved[0], want) {
		t.Fatalf("saved %v", saved)
	}
	// A console forward is never written.
	s := fwdStateOf(f.b)
	if _, err := s.start(fwdSpec{context: "dev", namespace: "apps", resource: "services", name: "console", remotePort: 15672}, 0, false); err != nil {
		t.Fatal(err)
	}
	s.persist()
	if saved := fwdSavedList(t, f); len(saved) != 1 {
		t.Fatalf("console forward saved: %v", saved)
	}

	// A second run of Rubban in the same data folder restores the forward on its port.
	data, _ := os.ReadFile(filepath.Join(f.b.dataDir, "forwards.json"))
	g, spawner2 := fwdFixture(t, nil)
	fwdFast(g)
	_ = os.MkdirAll(g.b.dataDir, 0o700)
	if err := os.WriteFile(filepath.Join(g.b.dataDir, "forwards.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	fwdStateOf(g.b).restore()
	if spawner2.count() != 1 || !reflect.DeepEqual(spawner2.child(0).args, []string{"--context=dev", "--namespace=apps", "port-forward", "services/web", "18081:80", "--address=127.0.0.1"}) {
		t.Fatalf("restore spawned %d", spawner2.count())
	}
	if item := fwdItem(t, g, id); item["keep"] != true || item["status"] != "starting" {
		t.Fatalf("%v", item)
	}
	if r := g.do("DELETE", "/api/forwards/"+id, nil, nil); r.Status != 200 {
		t.Fatalf("%d", r.Status)
	}
	if saved := fwdSavedList(t, g); len(saved) != 0 {
		t.Fatalf("still saved: %v", saved)
	}
	_ = spawner
}

func TestForwardRestoreKeepsAForwardWhosePortIsBusy(t *testing.T) {
	f, spawner := fwdFixture(t, nil)
	s := fwdStateOf(f.b)
	s.portFree = func(port int) bool { return port != 5432 }
	s.backoff = func(int) time.Duration { return time.Hour }
	file := `[{"id":"aaaa","context":"dev","namespace":"apps","resource":"pods","name":"db-0","localPort":5432,"remotePort":5432},
	 {"id":"bbbb","context":"dev","namespace":"apps","resource":"pods","name":"web-0","localPort":8080,"remotePort":80},
	 {"id":"cccc","context":"dev --bad","namespace":"Apps","resource":"pods","name":"x","localPort":1,"remotePort":0}]`
	_ = os.MkdirAll(f.b.dataDir, 0o700)
	if err := os.WriteFile(filepath.Join(f.b.dataDir, "forwards.json"), []byte(file), 0o600); err != nil {
		t.Fatal(err)
	}
	s.restore()
	busy := fwdItem(t, f, "aaaa")
	if busy["status"] != "error" || busy["lastError"] != "local port 5432 is in use" || busy["localPort"] != float64(5432) {
		t.Fatalf("%v", busy)
	}
	if spawner.count() != 1 || !slices.Contains(spawner.child(0).args, "8080:80") {
		t.Fatalf("only the free port may start, got %d", spawner.count())
	}
	if len(f.get("/api/forwards").Value["items"].([]any)) != 2 {
		t.Fatal("an invalid saved entry must be skipped")
	}
}

func TestClosingTheBackendKeepsTheSavedForwards(t *testing.T) {
	f, _ := fwdFixture(t, nil)
	f.post("/api/forwards", map[string]any{"context": "dev", "resource": "pods", "name": "p", "localPort": 18082, "remotePort": 80})
	f.b.Close()
	if saved := fwdSavedList(t, f); len(saved) != 1 {
		t.Fatalf("saved %v", saved)
	}
}

func TestConcurrentForwardRestartsStartOnlyOneNewChild(t *testing.T) {
	f, spawner := fwdFixture(t, nil)
	fwdFast(f)
	id := f.post("/api/forwards", map[string]any{"context": "dev", "resource": "pods", "name": "p", "localPort": 15440, "remotePort": 80}).Value["id"].(string)
	spawner.child(0).say("Forwarding from 127.0.0.1:15440 -> 80\n")
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); f.post("/api/forwards/"+id+"/restart", nil) }()
	}
	wg.Wait()
	time.Sleep(50 * time.Millisecond)
	alive := 0
	for i := 0; i < spawner.count(); i++ {
		if !spawner.child(i).wasKilled() {
			alive++
		}
	}
	if alive != 1 {
		t.Fatalf("%d kubectl children left running of %d started", alive, spawner.count())
	}
}
