package server

import (
	"context"
	"encoding/json"
	"net/url"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// logBackend is a backend whose pod lists come from the test and whose log readers are fakes.
type logBackend struct {
	t       *testing.T
	b       *Backend
	conn    Connection
	spawner *fwdFakeSpawner

	mu   sync.Mutex
	pods []map[string]any
	fail string
}

func pod(name, phase string, containers ...string) map[string]any {
	var cs []any
	for _, c := range containers {
		cs = append(cs, map[string]any{"name": c})
	}
	return map[string]any{"metadata": map[string]any{"name": name, "namespace": "apps"}, "spec": map[string]any{"containers": cs}, "status": map[string]any{"phase": phase}}
}

func newLogBackend(t *testing.T, pods ...map[string]any) *logBackend {
	t.Helper()
	lb := &logBackend{t: t, pods: pods, spawner: &fwdFakeSpawner{}}
	runner := func(_ context.Context, _ string, args []string, _ RunOptions) (Result, error) {
		lb.mu.Lock()
		defer lb.mu.Unlock()
		if lb.fail != "" {
			return Result{Stderr: lb.fail, Code: 1}, nil
		}
		items := make([]any, len(lb.pods))
		for i, p := range lb.pods {
			items[i] = p
		}
		return out(map[string]any{"items": items}, 0), nil
	}
	lb.b = New(Options{DataDir: filepath.Join(t.TempDir(), "data"), KubectlPath: "test-kubectl", Runner: runner})
	lb.b.childSpawn = lb.spawner.spawn
	lb.b.logPoll = 25 * time.Millisecond
	lb.b.logRestartDelay = func(int) time.Duration { return 5 * time.Millisecond }
	conn, err := lb.b.Start(0)
	if err != nil {
		t.Fatal(err)
	}
	lb.conn = conn
	t.Cleanup(func() { lb.b.Close() })
	return lb
}

func (lb *logBackend) setPods(pods ...map[string]any) { lb.mu.Lock(); lb.pods = pods; lb.mu.Unlock() }

type logClient struct {
	t       *testing.T
	ws      *websocket.Conn
	mu      sync.Mutex
	text    []string
	control []map[string]any
	closed  bool
	status  websocket.StatusCode
}

func (lb *logBackend) dial(q url.Values) *logClient {
	lb.t.Helper()
	q.Set("token", lb.conn.Token)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(lb.conn.URL, "http")+"/api/logs?"+q.Encode(), nil)
	if err != nil {
		lb.t.Fatal(err)
	}
	lc := &logClient{t: lb.t, ws: ws}
	lb.t.Cleanup(func() { ws.CloseNow() })
	go func() {
		for {
			kind, data, err := ws.Read(context.Background())
			lc.mu.Lock()
			if err != nil {
				lc.closed, lc.status = true, websocket.CloseStatus(err)
				lc.mu.Unlock()
				return
			}
			if kind == websocket.MessageBinary {
				var m map[string]any
				if json.Unmarshal(data, &m) == nil {
					lc.control = append(lc.control, m)
				}
			} else {
				lc.text = append(lc.text, string(data))
			}
			lc.mu.Unlock()
		}
	}()
	return lc
}

func (lc *logClient) all() string {
	lc.mu.Lock()
	defer lc.mu.Unlock()
	return strings.Join(lc.text, "")
}
func (lc *logClient) controls(kind string) []map[string]any {
	lc.mu.Lock()
	defer lc.mu.Unlock()
	var out []map[string]any
	for _, m := range lc.control {
		if m["type"] == kind {
			out = append(out, m)
		}
	}
	return out
}
func (lc *logClient) isClosed() (bool, websocket.StatusCode) {
	lc.mu.Lock()
	defer lc.mu.Unlock()
	return lc.closed, lc.status
}

func logQuery(extra ...string) url.Values {
	q := url.Values{"context": {"dev"}, "namespace": {"apps"}, "selector": {"app=web"}, "tail": {"50"}}
	for i := 0; i+1 < len(extra); i += 2 {
		q.Set(extra[i], extra[i+1])
	}
	return q
}

func TestMultiLogsStartAReaderPerPodAndPrefixEveryLine(t *testing.T) {
	lb := newLogBackend(t, pod("web-1", "Running", "app"), pod("web-2", "Running", "app"))
	lc := lb.dial(logQuery())
	fwdWaitFor(t, "two readers", func() bool { return lb.spawner.count() == 2 })
	args := map[string][]string{}
	for i := 0; i < 2; i++ {
		c := lb.spawner.child(i)
		args[c.args[3]] = c.args
	}
	want := []string{"--context=dev", "--namespace=apps", "logs", "web-1", "--container=app", "--follow=true", "--tail=50"}
	if !reflect.DeepEqual(args["web-1"], want) || args["web-2"][3] != "web-2" || lb.spawner.command != "test-kubectl" {
		t.Fatalf("args %v", args)
	}
	for i := 0; i < 2; i++ {
		c := lb.spawner.child(i)
		name := c.args[3]
		c.say("hello from " + name + "\npartial ")
		c.say("line\r\nnext")
	}
	fwdWaitFor(t, "prefixed lines", func() bool {
		return strings.Contains(lc.all(), "[web-1/app] hello from web-1\n") && strings.Contains(lc.all(), "[web-2/app] partial line\n")
	})
	if strings.Contains(lc.all(), "next") {
		t.Fatalf("an unfinished line waits for its newline: %q", lc.all())
	}
	lb.spawner.child(0).exit(0)
	fwdWaitFor(t, "flush on exit", func() bool {
		return strings.Contains(lc.all(), "[web-1/app] next\n") || strings.Contains(lc.all(), "[web-2/app] next\n")
	})
}

func TestMultiLogsSendBinaryControlFramesForPodsAndReaders(t *testing.T) {
	lb := newLogBackend(t, pod("web-1", "Running", "app", "sidecar"), pod("web-2", "Pending", "app"))
	lc := lb.dial(logQuery())
	fwdWaitFor(t, "pods frame", func() bool { return len(lc.controls("pods")) >= 1 })
	frame := lc.controls("pods")[0]
	want := []any{
		map[string]any{"pod": "web-1", "containers": []any{"app", "sidecar"}, "phase": "Running"},
		map[string]any{"pod": "web-2", "containers": []any{"app"}, "phase": "Pending"},
	}
	if !reflect.DeepEqual(frame["items"], want) {
		t.Fatalf("items %v", frame["items"])
	}
	// One reader per container of running pods; the pending pod has no log yet.
	fwdWaitFor(t, "two readers", func() bool { return lb.spawner.count() == 2 })
	fwdWaitFor(t, "reader frames", func() bool { return len(lc.controls("reader")) == 2 })
	for _, m := range lc.controls("reader") {
		if m["state"] != "started" || m["pod"] != "web-1" {
			t.Fatalf("%v", m)
		}
	}
	// Control frames are not log text.
	if strings.Contains(lc.all(), `"type"`) {
		t.Fatalf("control leaked into the log: %q", lc.all())
	}
	lb.spawner.child(0).exit(0)
	fwdWaitFor(t, "ended frame", func() bool {
		for _, m := range lc.controls("reader") {
			if m["state"] == "ended" {
				return m["code"] == float64(0)
			}
		}
		return false
	})
	// The pending pod starts running: a new pods frame and a reader.
	lb.setPods(pod("web-1", "Running", "app", "sidecar"), pod("web-2", "Running", "app"))
	fwdWaitFor(t, "reader for the pod that started", func() bool { return lb.spawner.count() == 3 })
	fwdWaitFor(t, "second pods frame", func() bool { return len(lc.controls("pods")) >= 2 })
}

func TestMultiLogsPickUpNewPodsAndStopDeletedOnes(t *testing.T) {
	lb := newLogBackend(t, pod("web-1", "Running", "app"))
	lc := lb.dial(logQuery())
	fwdWaitFor(t, "first reader", func() bool { return lb.spawner.count() == 1 })
	lb.setPods(pod("web-1", "Running", "app"), pod("web-3", "Running", "app"))
	fwdWaitFor(t, "reader for the new pod", func() bool { return lb.spawner.count() == 2 })
	if got := lb.spawner.child(1).args[3]; got != "web-3" {
		t.Fatalf("new reader for %s", got)
	}
	lb.spawner.child(1).say("scaled up\n")
	fwdWaitFor(t, "new pod's lines", func() bool { return strings.Contains(lc.all(), "[web-3/app] scaled up\n") })
	// web-1 is deleted: its reader is killed, web-3 keeps going.
	lb.setPods(pod("web-3", "Running", "app"))
	fwdWaitFor(t, "deleted pod's reader killed", func() bool { return lb.spawner.child(0).wasKilled() })
	if lb.spawner.child(1).wasKilled() {
		t.Fatal("the other reader must keep running")
	}
	// A deleted pod is not restarted by the exit its kill causes.
	time.Sleep(80 * time.Millisecond)
	if lb.spawner.count() != 2 {
		t.Fatalf("readers %d", lb.spawner.count())
	}
}

func TestMultiLogsRestartAReaderWhileThePodRunsAndGiveUpAfterFive(t *testing.T) {
	lb := newLogBackend(t, pod("web-1", "Running", "app"))
	lc := lb.dial(logQuery())
	fwdWaitFor(t, "reader", func() bool { return lb.spawner.count() == 1 })
	lb.spawner.child(0).exit(0) // the container restarted: kubectl logs ended
	fwdWaitFor(t, "restart", func() bool { return lb.spawner.count() == 2 })
	again := lb.spawner.child(1).args
	if !reflect.DeepEqual(again, []string{"--context=dev", "--namespace=apps", "logs", "web-1", "--container=app", "--follow=true", "--since=5s"}) {
		t.Fatalf("restart args %v", again)
	}
	// A crash loop: every restart ends at once. Five restarts, then it stops trying.
	for i := 1; i < 6; i++ {
		i := i
		fwdWaitFor(t, "child", func() bool { return lb.spawner.count() > i })
		lb.spawner.child(i).exit(1)
	}
	time.Sleep(150 * time.Millisecond)
	if lb.spawner.count() != 6 {
		t.Fatalf("1 start + 5 restarts expected, got %d", lb.spawner.count())
	}
	_ = lc
}

func TestMultiLogsRestartCountStartsOverOnceTheReaderProducesOutput(t *testing.T) {
	lb := newLogBackend(t, pod("web-1", "Running", "app"))
	lb.dial(logQuery())
	fwdWaitFor(t, "reader", func() bool { return lb.spawner.count() == 1 })
	for i := 0; i < 8; i++ {
		i := i
		fwdWaitFor(t, "child", func() bool { return lb.spawner.count() > i })
		lb.spawner.child(i).say("alive\n")
		lb.spawner.child(i).exit(0)
	}
	fwdWaitFor(t, "still restarting after eight healthy runs", func() bool { return lb.spawner.count() >= 9 })
}

func TestMultiLogsDoNotRestartAReaderOfAPodThatStoppedRunning(t *testing.T) {
	lb := newLogBackend(t, pod("web-1", "Running", "app"))
	lb.b.logRestartDelay = func(int) time.Duration { return 120 * time.Millisecond }
	lb.dial(logQuery())
	fwdWaitFor(t, "reader", func() bool { return lb.spawner.count() == 1 })
	lb.spawner.child(0).exit(0)
	lb.setPods(pod("web-1", "Failed", "app")) // the pod is gone by the time the delay is over
	time.Sleep(300 * time.Millisecond)
	if lb.spawner.count() != 1 {
		t.Fatalf("readers %d", lb.spawner.count())
	}
}

func TestMultiLogsHonourContainerFilterFlagsAndLimit(t *testing.T) {
	lb := newLogBackend(t, pod("web-1", "Running", "app", "sidecar"), pod("web-2", "Running", "app", "sidecar"))
	lc := lb.dial(logQuery("container", "sidecar", "timestamps", "true", "since", "300", "maxRequests", "1"))
	fwdWaitFor(t, "reader", func() bool { return lb.spawner.count() >= 1 })
	time.Sleep(60 * time.Millisecond)
	if lb.spawner.count() != 1 {
		t.Fatalf("maxRequests=1 allows one reader, got %d", lb.spawner.count())
	}
	args := lb.spawner.child(0).args
	for _, want := range []string{"--container=sidecar", "--timestamps=true", "--since=300s", "--tail=50"} {
		if !contains(args, want) {
			t.Errorf("missing %s in %v", want, args)
		}
	}
	fwdWaitFor(t, "limit notice", func() bool { return strings.Contains(lc.all(), "[rubban] Following the first 1 containers") })
}

func TestMultiLogsWithoutFollowEndWhenEveryReaderEnded(t *testing.T) {
	lb := newLogBackend(t, pod("job-1", "Succeeded", "main"), pod("job-2", "Failed", "main"))
	lc := lb.dial(logQuery("follow", "false", "previous", "false"))
	fwdWaitFor(t, "readers for finished pods too", func() bool { return lb.spawner.count() == 2 })
	if !contains(lb.spawner.child(0).args, "--follow=false") {
		t.Fatalf("%v", lb.spawner.child(0).args)
	}
	lb.spawner.child(0).say("done\n")
	lb.spawner.child(0).exit(0)
	lb.spawner.child(1).exit(0)
	fwdWaitFor(t, "session end", func() bool { closed, _ := lc.isClosed(); return closed })
	if _, status := lc.isClosed(); status != websocket.StatusNormalClosure || !strings.Contains(lc.all(), "[job-1/main] done\n") {
		t.Fatalf("status %d %q", status, lc.all())
	}
	if lb.spawner.count() != 2 {
		t.Fatal("no restarts without follow")
	}
}

func TestMultiLogsKillEveryReaderWhenTheSocketCloses(t *testing.T) {
	lb := newLogBackend(t, pod("web-1", "Running", "app"), pod("web-2", "Running", "app"))
	lc := lb.dial(logQuery())
	fwdWaitFor(t, "readers", func() bool { return lb.spawner.count() == 2 })
	lc.ws.Close(websocket.StatusNormalClosure, "bye")
	fwdWaitFor(t, "readers killed", func() bool { return lb.spawner.child(0).wasKilled() && lb.spawner.child(1).wasKilled() })
}

func TestMultiLogsRejectBadRequestsWithoutStartingKubectl(t *testing.T) {
	lb := newLogBackend(t, pod("web-1", "Running", "app"))
	for name, q := range map[string]url.Values{
		"bad selector":   logQuery("selector", "app=web --all"),
		"no namespace":   {"context": {"dev"}, "selector": {"app=web"}},
		"bad namespace":  logQuery("namespace", "Bad NS"),
		"bad container":  logQuery("container", "-x;y"),
		"bad tail":       logQuery("tail", "lots"),
		"bad since":      logQuery("since", "0"),
		"bad previous":   logQuery("previous", "maybe"),
		"too many reads": logQuery("maxRequests", "51"),
		"no context":     {"namespace": {"apps"}, "selector": {"app=web"}},
	} {
		lc := lb.dial(q)
		fwdWaitFor(t, name+" closed", func() bool { closed, _ := lc.isClosed(); return closed })
		if _, status := lc.isClosed(); status != websocket.StatusPolicyViolation || !strings.Contains(lc.all(), "[error]") {
			t.Errorf("%s: status %d text %q", name, status, lc.all())
		}
	}
	if lb.spawner.count() != 0 {
		t.Fatal("nothing may start for an invalid request")
	}
}

func TestMultiLogsReportAFailedPodListAndMarkExpiredCredentials(t *testing.T) {
	lb := newLogBackend(t)
	lb.fail = "Unable to connect to the server: getting credentials: exec: executable gke-gcloud-auth-plugin failed with exit code 1"
	lc := lb.dial(logQuery())
	fwdWaitFor(t, "closed", func() bool { closed, _ := lc.isClosed(); return closed })
	if _, status := lc.isClosed(); status != websocket.StatusInternalError || !strings.Contains(lc.all(), "[error]") {
		t.Fatalf("status %d %q", status, lc.all())
	}
	if lb.b.authOf("dev").Status != "expired" {
		t.Fatalf("auth %+v", lb.b.authOf("dev"))
	}
}

func TestSinglePodLogsKeepTheirOwnPath(t *testing.T) {
	args, err := logArgs(map[string]string{"context": "dev", "namespace": "apps", "pod": "web-1", "container": "app", "tail": "10"})
	if err != nil || !reflect.DeepEqual(args, []string{"--context=dev", "--namespace=apps", "logs", "web-1", "--follow=true", "--tail=10", "--container=app"}) {
		t.Fatalf("%v %v", args, err)
	}
}
