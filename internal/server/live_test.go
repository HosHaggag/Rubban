package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"

	"github.com/HosHaggag/rubban/internal/live"
	"github.com/HosHaggag/rubban/internal/live/livetest"
)

// lvProxy is a proxy that points at the fake API server.
type lvProxy struct {
	url     string
	stopped atomic.Int32
	done    chan struct{}
}

func (p *lvProxy) BaseURL() string       { return p.url }
func (p *lvProxy) Stop()                 { p.stopped.Add(1) }
func (p *lvProxy) Done() <-chan struct{} { return p.done }

// lvHarness is a backend whose live layer talks to a fake API server through a counting starter.
type lvHarness struct {
	t       *testing.T
	api     *livetest.Server
	b       *Backend
	conn    Connection
	starts  atomic.Int32
	mu      sync.Mutex
	proxies []*lvProxy
	calls   []call
}

type lvOptions struct {
	runner  func(args []string) Result // inject a kubectl runner (enables the fallback path)
	starter func(h *lvHarness) live.ProxyStarter
	config  live.Config
}

func newLVHarness(t *testing.T, tweak func(*lvOptions)) *lvHarness {
	t.Helper()
	h := &lvHarness{t: t, api: livetest.New()}
	var lo lvOptions
	if tweak != nil {
		tweak(&lo)
	}
	opts := Options{DataDir: filepath.Join(t.TempDir(), "data"), LiveConfig: lo.config,
		UI: fstest.MapFS{"index.html": {Data: []byte("x")}}}
	opts.LiveConfig.FlushInterval = 20 * time.Millisecond
	if lo.starter != nil {
		opts.ProxyStarter = lo.starter(h)
	} else {
		opts.ProxyStarter = live.StarterFunc(func(ctx context.Context, kubeContext string) (live.Proxy, error) {
			h.starts.Add(1)
			p := &lvProxy{url: h.api.BaseURL(), done: make(chan struct{})}
			h.mu.Lock()
			h.proxies = append(h.proxies, p)
			h.mu.Unlock()
			return p, nil
		})
	}
	if lo.runner != nil {
		opts.KubectlPath, opts.HelmPath = "test-kubectl", "test-helm"
		opts.Runner = func(ctx context.Context, command string, args []string, ro RunOptions) (Result, error) {
			h.mu.Lock()
			h.calls = append(h.calls, call{command, args, ro})
			h.mu.Unlock()
			return lo.runner(args), nil
		}
	}
	h.b = New(opts)
	conn, err := h.b.Start(0)
	if err != nil {
		t.Fatal(err)
	}
	h.conn = conn
	t.Cleanup(func() { _ = h.b.Close(); h.api.Close() })
	return h
}

func (h *lvHarness) get(route string) response {
	h.t.Helper()
	req, _ := http.NewRequest("GET", h.conn.URL+route, nil)
	req.Header.Set("X-Rubban-Token", h.conn.Token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var value map[string]any
	_ = json.Unmarshal(raw, &value)
	return response{res.StatusCode, value, res.Header, raw}
}

func (h *lvHarness) runnerCalls() []call {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]call(nil), h.calls...)
}

func lvConfigMap(name string, data ...string) livetest.Object {
	o := livetest.Object{"kind": "ConfigMap", "metadata": livetest.Object{"name": name, "namespace": "default"}}
	if len(data) == 2 {
		o["data"] = livetest.Object{data[0]: data[1]}
	}
	return o
}

func lvItemNames(items []any) []string {
	var out []string
	for _, it := range items {
		out = append(out, it.(map[string]any)["metadata"].(map[string]any)["name"].(string))
	}
	return out
}

// lvSocket is a /api/watch client that records every message.
type lvSocket struct {
	t        *testing.T
	conn     *websocket.Conn
	mu       sync.Mutex
	messages []map[string]any
	closed   chan websocket.StatusCode
}

func (h *lvHarness) watch(query map[string]string) *lvSocket {
	h.t.Helper()
	return h.dialWatch(h.conn.Token, query)
}

func (h *lvHarness) dialWatch(token string, query map[string]string) *lvSocket {
	h.t.Helper()
	url := fmt.Sprintf("ws://127.0.0.1:%d/api/watch?context=fake&token=%s", h.conn.Port, token)
	for k, v := range query {
		url += "&" + k + "=" + v
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		h.t.Fatal(err)
	}
	conn.SetReadLimit(64 * 1024 * 1024)
	s := &lvSocket{t: h.t, conn: conn, closed: make(chan websocket.StatusCode, 1)}
	h.t.Cleanup(func() { _ = conn.CloseNow() })
	go func() {
		for {
			_, data, err := conn.Read(context.Background())
			if err != nil {
				s.closed <- websocket.CloseStatus(err)
				return
			}
			var m map[string]any
			_ = json.Unmarshal(data, &m)
			s.mu.Lock()
			s.messages = append(s.messages, m)
			s.mu.Unlock()
		}
	}()
	return s
}

func (s *lvSocket) all() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]map[string]any(nil), s.messages...)
}

// next returns the first message at or after position from that matches, and the next position.
func (s *lvSocket) next(from int, match func(map[string]any) bool) (map[string]any, int) {
	s.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		all := s.all()
		for i := from; i < len(all); i++ {
			if match(all[i]) {
				return all[i], i + 1
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	var kinds []string
	for _, m := range s.all() {
		kinds = append(kinds, fmt.Sprint(m["type"]))
	}
	s.t.Fatalf("timed out waiting for a watch message; saw %v", kinds)
	return nil, 0
}

func lvType(t string) func(map[string]any) bool {
	return func(m map[string]any) bool { return m["type"] == t }
}
func lvState(state string) func(map[string]any) bool {
	return func(m map[string]any) bool { return m["type"] == "status" && m["state"] == state }
}

func lvWait(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func lvTypes(ms []map[string]any, t string) []map[string]any {
	var out []map[string]any
	for _, m := range ms {
		if m["type"] == t {
			out = append(out, m)
		}
	}
	return out
}

func TestLiveReadsUseTheSharedConnection(t *testing.T) {
	h := newLVHarness(t, nil)
	for _, name := range []string{"a", "b", "c", "d", "e"} {
		h.api.Put("ADDED", lvConfigMap(name))
	}
	h.api.Put("ADDED", livetest.Object{"kind": "Secret", "metadata": livetest.Object{"name": "token", "namespace": "default",
		"annotations": livetest.Object{lastApplied: `{"data":{"password":"c2VjcmV0"}}`}}, "data": livetest.Object{"password": "c2VjcmV0"}})

	if health := h.get("/api/health"); health.Value["live"] != true {
		t.Fatalf("health %v", health.Value)
	}
	disc := h.get("/api/discovery?context=fake")
	if disc.Status != 200 {
		t.Fatalf("discovery %d %s", disc.Status, disc.Raw)
	}
	var deployVersion string
	for _, r := range disc.Value["resources"].([]any) {
		if m := r.(map[string]any); m["name"] == "deployments" {
			deployVersion = m["version"].(string)
		}
	}
	if deployVersion != "v1" {
		t.Fatalf("discovery %s", disc.Raw)
	}
	if _, ok := disc.Value["warnings"].([]any); !ok {
		t.Fatalf("warnings must be an array: %s", disc.Raw)
	}
	before := h.api.Count(func(r string) bool { return r == "/api" })
	h.get("/api/discovery?context=fake")
	if h.api.Count(func(r string) bool { return r == "/api" }) != before {
		t.Fatal("discovery is cached")
	}
	h.get("/api/discovery?context=fake&refresh=1")
	if h.api.Count(func(r string) bool { return r == "/api" }) != before+1 {
		t.Fatal("refresh=1 refetches discovery")
	}

	list := h.get("/api/resources?context=fake&namespace=default&resource=configmaps")
	if list.Status != 200 {
		t.Fatalf("list %d %s", list.Status, list.Raw)
	}
	items := list.Value["items"].([]any)
	if strings.Join(lvItemNames(items), ",") != "a,b,c,d,e" {
		t.Fatalf("items %v", lvItemNames(items))
	}
	first := items[0].(map[string]any)
	if first["kind"] != "ConfigMap" || first["metadata"].(map[string]any)["managedFields"] != nil {
		t.Fatalf("first %v", first)
	}
	if h.api.Count(func(r string) bool { return strings.Contains(r, "continue=4") }) == 0 {
		t.Fatal("pagination continued to the last page")
	}

	secrets := h.get("/api/resources?context=fake&namespace=*&resource=secrets")
	if strings.Contains(string(secrets.Raw), "c2VjcmV0") {
		t.Fatalf("secret leaked: %s", secrets.Raw)
	}
	if keys := secrets.Value["items"].([]any)[0].(map[string]any)["dataKeys"]; fmt.Sprint(keys) != "[password]" {
		t.Fatalf("dataKeys %v", keys)
	}
	// A single secret is redacted too; only YAML reveals values.
	one := h.get("/api/resource?context=fake&namespace=default&resource=secrets&name=token")
	if one.Status != 200 || strings.Contains(string(one.Raw), "c2VjcmV0") || one.Value["dataKeys"] == nil {
		t.Fatalf("resource %s", one.Raw)
	}
	revealed := h.get("/api/yaml?context=fake&namespace=default&resource=secrets&name=token")
	if !strings.Contains(revealed.Value["yaml"].(string), "password: c2VjcmV0") {
		t.Fatalf("yaml reveal %s", revealed.Raw)
	}

	yaml := h.get("/api/yaml?context=fake&namespace=default&resource=configmaps&name=a")
	text, _ := yaml.Value["yaml"].(string)
	if !strings.HasPrefix(text, "apiVersion: v1\nkind: ConfigMap\nmetadata:\n") || !strings.Contains(text, "\n  name: a\n") || strings.Contains(text, "managedFields") {
		t.Fatalf("yaml %q", text)
	}
	res := h.get("/api/resource?context=fake&namespace=default&resource=configmaps&name=a")
	if res.Status != 200 || res.Value["metadata"].(map[string]any)["name"] != "a" {
		t.Fatalf("resource %s", res.Raw)
	}

	if ev := h.get("/api/events?context=fake&namespace=default"); ev.Status != 200 {
		t.Fatalf("events %d", ev.Status)
	}
	if h.api.Count(func(r string) bool { return r == "/api/v1/namespaces/default/events?limit=500" }) != 1 {
		t.Fatalf("bare events resolves to the core API: %v", h.api.Requests())
	}
	h.api.Put("ADDED", livetest.Object{"kind": "Namespace", "metadata": livetest.Object{"name": "default"}})
	if ns := h.get("/api/namespaces?context=fake"); ns.Status != 200 || len(ns.Value["items"].([]any)) != 1 {
		t.Fatalf("namespaces %s", ns.Raw)
	}

	missing := h.get("/api/resources?context=fake&namespace=*&resource=widgets")
	if missing.Status != 404 || !strings.Contains(missing.Value["error"].(string), `does not serve the resource type "widgets"`) {
		t.Fatalf("missing %d %s", missing.Status, missing.Raw)
	}
	if forbidden := h.get("/api/resources?context=fake&resource=pods%2Csecrets"); forbidden.Status != 400 {
		t.Fatalf("validation %d", forbidden.Status)
	}
	if h.starts.Load() != 1 {
		t.Fatalf("every read reused one connection, starts=%d", h.starts.Load())
	}
}

func TestLiveWatchSnapshotThenCoalescedChangesAndSecretRedaction(t *testing.T) {
	h := newLVHarness(t, nil)
	h.api.Put("ADDED", lvConfigMap("existing"))
	stream := h.watch(map[string]string{"namespace": "default", "resource": "configmaps"})
	synced, pos := stream.next(0, lvType("synced"))
	if synced["count"] != float64(1) || synced["resourceVersion"] == "" {
		t.Fatalf("synced %v", synced)
	}
	var items []any
	for _, m := range lvTypes(stream.all(), "items") {
		items = append(items, m["items"].([]any)...)
	}
	first := items[0].(map[string]any)
	if first["kind"] != "ConfigMap" || first["metadata"].(map[string]any)["managedFields"] != nil {
		t.Fatalf("item %v", first)
	}
	if st := stream.all()[0]; st["type"] != "status" || st["state"] != "connecting" {
		t.Fatalf("first message %v", st)
	}
	order := []string{}
	for _, m := range stream.all() {
		if m["type"] != "status" {
			order = append(order, m["type"].(string))
		}
	}
	if strings.Join(order, ",") != "reset,items,synced" {
		t.Fatalf("order %v", order)
	}
	_, pos = stream.next(pos, lvState("live"))

	h.api.Put("ADDED", lvConfigMap("fresh", "v", "1"))
	h.api.Put("MODIFIED", lvConfigMap("fresh", "v", "2"))
	added, pos := stream.next(pos, lvType("changes"))
	ups := added["upserts"].([]any)
	if len(ups) != 1 || ups[0].(map[string]any)["data"].(map[string]any)["v"] != "2" {
		t.Fatalf("rapid updates are coalesced: %v", added)
	}
	if added["deletes"] == nil || len(added["deletes"].([]any)) != 0 {
		t.Fatalf("deletes must be an array: %v", added)
	}
	h.api.Put("DELETED", lvConfigMap("existing"))
	removed, _ := stream.next(pos, func(m map[string]any) bool {
		return m["type"] == "changes" && len(m["deletes"].([]any)) > 0
	})
	if fmt.Sprint(removed["deletes"]) != "[uid-ConfigMap-existing]" {
		t.Fatalf("deletes %v", removed["deletes"])
	}

	secrets := h.watch(map[string]string{"namespace": "*", "resource": "secrets"})
	_, spos := secrets.next(0, lvType("synced"))
	_, spos = secrets.next(spos, lvState("live"))
	h.api.Put("ADDED", livetest.Object{"kind": "Secret", "metadata": livetest.Object{"name": "db", "namespace": "default"},
		"data": livetest.Object{"password": "aHVudGVyMg=="}, "stringData": livetest.Object{"token": "plain"}})
	change, _ := secrets.next(spos, lvType("changes"))
	if change["upserts"].([]any)[0].(map[string]any)["metadata"].(map[string]any)["name"] != "db" {
		t.Fatalf("change %v", change)
	}
	raw, _ := json.Marshal(secrets.all())
	for _, leak := range []string{"aHVudGVyMg", "plain", `"data"`, `"stringData"`} {
		if strings.Contains(string(raw), leak) {
			t.Fatalf("secret leaked %q in %s", leak, raw)
		}
	}
}

func TestLiveWatchRecoversFromGoneAndResumesAfterDrops(t *testing.T) {
	h := newLVHarness(t, nil)
	h.api.Put("ADDED", lvConfigMap("one"))
	h.api.Put("ADDED", lvConfigMap("two"))
	stream := h.watch(map[string]string{"namespace": "default", "resource": "configmaps"})
	_, pos := stream.next(0, lvType("synced"))
	_, pos = stream.next(pos, lvState("live"))
	lvWait(t, "watch open", func() bool { return h.api.Watchers() == 1 })

	h.api.GoneOnNextWatch()
	h.api.DropWatches()
	h.api.Remove("ConfigMap", "default", "one")
	h.api.Put("ADDED", lvConfigMap("three"))
	diff, pos := stream.next(pos, lvType("changes"))
	if got := strings.Join(lvItemNames(diff["upserts"].([]any)), ","); got != "three" || fmt.Sprint(diff["deletes"]) != "[uid-ConfigMap-one]" {
		t.Fatalf("diff %v", diff)
	}
	if len(lvTypes(stream.all(), "reset")) != 1 {
		t.Fatal("recovery does not reset the client")
	}

	lvWait(t, "watch reopened", func() bool { return h.api.Watchers() == 1 })
	before := h.api.Count(func(r string) bool { return strings.Contains(r, "watch=1") })
	h.api.DropWatches()
	lvWait(t, "new watch request", func() bool {
		return h.api.Count(func(r string) bool { return strings.Contains(r, "watch=1") }) > before
	})
	lvWait(t, "watch reopened", func() bool { return h.api.Watchers() == 1 })
	h.api.Put("ADDED", lvConfigMap("four"))
	stream.next(pos, func(m map[string]any) bool {
		return m["type"] == "changes" && strings.Contains(fmt.Sprint(lvItemNames(m["upserts"].([]any))), "four")
	})
}

func TestLiveWatchSharedAndPermissionErrors(t *testing.T) {
	h := newLVHarness(t, nil)
	h.api.Put("ADDED", lvConfigMap("shared"))
	first := h.watch(map[string]string{"namespace": "default", "resource": "configmaps"})
	_, pos := first.next(0, lvType("synced"))
	first.next(pos, lvState("live"))
	second := h.watch(map[string]string{"namespace": "default", "resource": "configmaps"})
	synced, _ := second.next(0, lvType("synced"))
	if synced["count"] != float64(1) {
		t.Fatalf("synced %v", synced)
	}
	lvWait(t, "single watch", func() bool { return h.api.Watchers() == 1 })
	if n := h.api.Count(func(r string) bool { return strings.HasPrefix(r, "/api/v1/namespaces/default/configmaps?watch=1") }); n != 1 {
		t.Fatalf("subscribers share one upstream watch, got %d", n)
	}

	h.api.Forbid("secrets", true)
	denied := h.watch(map[string]string{"namespace": "*", "resource": "secrets"})
	msg, _ := denied.next(0, lvType("error"))
	if msg["status"] != float64(403) || !strings.Contains(msg["error"].(string), "forbidden") {
		t.Fatalf("error %v", msg)
	}
	select {
	case code := <-denied.closed:
		if code != websocket.StatusNormalClosure {
			t.Fatalf("close code %d", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the socket should close after the error")
	}

	unknown := h.watch(map[string]string{"namespace": "*", "resource": "widgets"})
	if m, _ := unknown.next(0, lvType("error")); m["status"] != float64(404) {
		t.Fatalf("unknown %v", m)
	}
	bad := h.watch(map[string]string{"namespace": "*", "resource": "pods%2Csecrets"})
	if m, _ := bad.next(0, lvType("error")); m["status"] != float64(400) {
		t.Fatalf("validation %v", m)
	}
	selector := h.watch(map[string]string{"namespace": "default", "resource": "configmaps", "labelSelector": "app%3Dx"})
	selector.next(0, lvType("synced"))
	lvWait(t, "selector watch", func() bool {
		return h.api.Count(func(r string) bool {
			return strings.Contains(r, "watch=1") && strings.Contains(r, "labelSelector=app%3Dx")
		}) > 0
	})
}

func TestLiveWatchRequiresTokenAndReportsUnavailableWithoutLive(t *testing.T) {
	h := newLVHarness(t, nil)
	url := fmt.Sprintf("ws://127.0.0.1:%d/api/watch?context=fake&resource=configmaps&token=%s", h.conn.Port, strings.Repeat("0", 64))
	_, res, err := websocket.Dial(context.Background(), url, nil)
	if err == nil || res == nil || res.StatusCode != 401 {
		t.Fatalf("expected a 401 rejection, got %v %v", res, err)
	}

	f := newFixture(t, nil) // an injected runner without a proxy starter: no live layer
	if f.get("/api/health").Value["live"] != false {
		t.Fatal("health.live must be false without the live layer")
	}
	conn, _, err := websocket.Dial(context.Background(), fmt.Sprintf("ws://127.0.0.1:%d/api/watch?context=x&resource=pods&token=%s", f.conn.Port, f.conn.Token), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	_, data, err := conn.Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	_ = json.Unmarshal(data, &m)
	if m["type"] != "unavailable" {
		t.Fatalf("message %v", m)
	}
	if _, _, err := conn.Read(context.Background()); websocket.CloseStatus(err) != websocket.StatusNormalClosure {
		t.Fatalf("the socket closes after unavailable: %v", err)
	}
}

func TestLiveCloseStopsWatchesAndProxy(t *testing.T) {
	h := newLVHarness(t, nil)
	stream := h.watch(map[string]string{"namespace": "default", "resource": "configmaps"})
	_, pos := stream.next(0, lvType("synced"))
	stream.next(pos, lvState("live"))
	lvWait(t, "watch open", func() bool { return h.api.Watchers() == 1 })
	_ = h.b.Close()
	lvWait(t, "upstream watch closed", func() bool { return h.api.Watchers() == 0 })
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.proxies) != 1 || h.proxies[0].stopped.Load() == 0 {
		t.Fatalf("proxy not stopped: %d proxies", len(h.proxies))
	}
	select {
	case <-stream.closed:
	case <-time.After(5 * time.Second):
		t.Fatal("the watch socket should close when the backend closes")
	}
}

func TestLiveWatchChunksLargeListsAndDeletesGoInTheFirstChunk(t *testing.T) {
	h := newLVHarness(t, func(o *lvOptions) {})
	h.api.SetPageSize(500)
	for i := 0; i < 600; i++ {
		h.api.Put("ADDED", lvConfigMap(fmt.Sprintf("cm-%03d", i)))
	}
	stream := h.watch(map[string]string{"namespace": "default", "resource": "configmaps"})
	synced, pos := stream.next(0, lvType("synced"))
	if synced["count"] != float64(600) {
		t.Fatalf("synced %v", synced)
	}
	var sizes []int
	for _, m := range lvTypes(stream.all(), "items") {
		sizes = append(sizes, len(m["items"].([]any)))
	}
	if fmt.Sprint(sizes) != "[250 250 100]" {
		t.Fatalf("chunks %v", sizes)
	}
	_, pos = stream.next(pos, lvState("live"))
	// 300 changes in one flush window become two upsert chunks; deletes ride in the first.
	for i := 0; i < 300; i++ {
		h.api.Put("MODIFIED", lvConfigMap(fmt.Sprintf("cm-%03d", i), "v", "2"))
	}
	h.api.Put("DELETED", lvConfigMap("cm-599"))
	var got []map[string]any
	lvWait(t, "all changes", func() bool {
		got = lvTypes(stream.all()[pos:], "changes")
		n := 0
		for _, m := range got {
			n += len(m["upserts"].([]any))
		}
		return n == 300 && func() bool {
			d := 0
			for _, m := range got {
				d += len(m["deletes"].([]any))
			}
			return d == 1
		}()
	})
	for _, m := range got {
		if len(m["upserts"].([]any)) > 250 {
			t.Fatalf("changes chunk too big: %d", len(m["upserts"].([]any)))
		}
	}
}

func TestLiveSessionTerminatesWhenTheQueueOverflows(t *testing.T) {
	h := newLVHarness(t, nil)
	var sess *watchSession
	ready := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := h.b.acceptWS(w, r)
		if err != nil {
			return
		}
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		sess = &watchSession{conn: conn, ctx: ctx, cancel: cancel, notify: make(chan struct{}, 1)}
		close(ready)
		<-ctx.Done()
	}))
	defer srv.Close()
	conn, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	<-ready
	for i := 0; i < watchQueueMax+3; i++ {
		sess.send(obj{"type": "items", "items": []any{}})
	}
	sess.mu.Lock()
	closed, queued := sess.closed, len(sess.queue)
	sess.mu.Unlock()
	if !closed || queued != 0 {
		t.Fatalf("closed=%v queued=%d", closed, queued)
	}
	if _, _, err := conn.Read(context.Background()); err == nil {
		t.Fatal("the client should see the connection terminated")
	}
}

// ---------------------------------------------------------------------------------------------
// Fallback to kubectl

func TestLiveFallsBackToKubectlOnlyWhenTheProxyCannotStart(t *testing.T) {
	var mode atomic.Value
	mode.Store("503")
	runner := func(args []string) Result {
		joined := strings.Join(args, " ")
		switch {
		case strings.Contains(joined, "--raw=/api/v1"):
			return out(map[string]any{"resources": []any{map[string]any{"name": "pods", "kind": "Pod", "namespaced": true, "verbs": []any{"get", "list"}}}}, 0)
		case strings.Contains(joined, "--raw=/apis"):
			return out(map[string]any{"groups": []any{}}, 0)
		case contains(args, "namespaces"):
			return out(map[string]any{"kind": "NamespaceList", "items": []any{}}, 0)
		case contains(args, "--output=yaml"):
			return out("apiVersion: v1\nkind: Pod\n", 0)
		case contains(args, "pods") && contains(args, "get") && contains(args, "web"):
			return out(map[string]any{"kind": "Pod", "metadata": map[string]any{"name": "web"}}, 0)
		}
		return out(map[string]any{"kind": "PodList", "items": []any{}}, 0)
	}
	h := newLVHarness(t, func(o *lvOptions) {
		o.runner = runner
		o.starter = func(*lvHarness) live.ProxyStarter {
			return live.StarterFunc(func(ctx context.Context, kc string) (live.Proxy, error) {
				switch mode.Load() {
				case "503":
					return nil, &live.Error{Status: 503, Message: "Unable to start kubectl proxy: spawn failed"}
				case "504":
					return nil, &live.Error{Status: 504, Message: "Timed out starting the cluster connection"}
				}
				return nil, &live.Error{Status: 502, Message: "Cluster connection failed: Unable to connect to the server"}
			})
		}
	})
	routes := []string{
		"/api/resources?context=dev&namespace=*&resource=pods",
		"/api/events?context=dev&namespace=default",
		"/api/namespaces?context=dev",
		"/api/resource?context=dev&namespace=default&resource=pods&name=web",
		"/api/yaml?context=dev&namespace=default&resource=pods&name=web",
		"/api/discovery?context=dev",
	}
	for _, status := range []string{"503", "504"} {
		mode.Store(status)
		for _, route := range routes {
			before := len(h.runnerCalls())
			if res := h.get(route); res.Status != 200 {
				t.Fatalf("%s via %s: %d %s", route, status, res.Status, res.Raw)
			}
			if len(h.runnerCalls()) == before {
				t.Fatalf("%s should have fallen back to kubectl when the proxy start failed with %s", route, status)
			}
		}
	}
	// The kubectl arguments of the fallback keep the order kubectl needs.
	h.get("/api/resources?context=dev&namespace=*&resource=pods&labelSelector=app%3Dweb")
	last := h.runnerCalls()
	want := []string{"get", "pods", "--context=dev", "--all-namespaces", "--selector=app=web", "--output=json"}
	if fmt.Sprint(last[len(last)-1].Args) != fmt.Sprint(want) {
		t.Fatalf("fallback args %v", last[len(last)-1].Args)
	}

	// A proxy that started and then failed its handshake is an error, not a reason to bypass it.
	mode.Store("502")
	for _, route := range routes {
		before := len(h.runnerCalls())
		res := h.get(route)
		if res.Status != 502 || !strings.Contains(res.Value["error"].(string), "Cluster connection failed") {
			t.Fatalf("%s: %d %s", route, res.Status, res.Raw)
		}
		if len(h.runnerCalls()) != before {
			t.Fatalf("%s must not fall back to kubectl on 502", route)
		}
	}
}

func TestLiveAccessHelpers(t *testing.T) {
	h := newLVHarness(t, nil)
	h.api.Put("ADDED", livetest.Object{"kind": "Secret", "metadata": livetest.Object{"name": "db", "namespace": "default"}, "type": "Opaque",
		"data": livetest.Object{"password": "cGFzcw=="}})
	h.api.Put("ADDED", lvConfigMap("a"))
	ctx := context.Background()
	if !h.b.liveAvailable() {
		t.Fatal("liveAvailable")
	}
	list, err := h.b.listObjects(ctx, "fake", "configmaps", "default", ListOptions{})
	if err != nil || len(list["items"].([]any)) != 1 {
		t.Fatalf("list %v %v", list, err)
	}
	if _, err := h.b.listObjects(ctx, "fake", "configmaps", "Bad NS", ListOptions{}); statusOf(err) != 400 {
		t.Fatalf("namespace validation: %v", err)
	}
	object, err := h.b.getObject(ctx, "fake", "configmaps", "default", "a")
	if err != nil || object["kind"] != "ConfigMap" && object["metadata"] == nil {
		t.Fatalf("get %v %v", object, err)
	}
	if _, err := h.b.getObject(ctx, "fake", "configmaps", "default", "missing"); statusOf(err) != 404 {
		t.Fatalf("missing object should be 404: %v", err)
	}
	data, err := h.b.readSecretData(ctx, "fake", "default", "db")
	if err != nil || data["password"] != "cGFzcw==" {
		t.Fatalf("secret data %v %v", data, err)
	}
	if h.api.Count(func(r string) bool { return r == "/api/v1/namespaces/default/secrets/db" }) != 1 {
		t.Fatal("readSecretData uses a direct raw GET")
	}
	v, err := h.b.rawGet(ctx, "fake", "/api/v1/namespaces/default/configmaps", RawOptions{Accept: "application/json", TimeoutMs: 5000})
	if err != nil || v.(map[string]any)["kind"] != "ConfigMapList" {
		t.Fatalf("rawGet %v %v", v, err)
	}
	if _, err := h.b.rawGet(ctx, "fake", "no-slash", RawOptions{}); statusOf(err) != 400 {
		t.Fatalf("raw path validation: %v", err)
	}

	body := map[string]any{"apiVersion": "policy/v1", "kind": "Eviction", "metadata": map[string]any{"name": "web", "namespace": "default"}}
	raw, status, err := h.b.liveRequest(ctx, "fake", "POST", "/api/v1/namespaces/default/pods/web/eviction", body, RawOptions{})
	if err != nil || status != 201 || !strings.Contains(string(raw), "Success") {
		t.Fatalf("eviction %s %d %v", raw, status, err)
	}
	if posts := h.api.Posts(); len(posts) != 1 || !strings.Contains(posts[0], `"kind":"Eviction"`) {
		t.Fatalf("posts %v", posts)
	}
	h.api.SetEvictStatus(429)
	_, _, err = h.b.liveRequest(ctx, "fake", "POST", "/api/v1/namespaces/default/pods/web/eviction", body, RawOptions{})
	if statusOf(err) != 429 || !strings.Contains(err.Error(), "disruption budget") {
		t.Fatalf("PDB rejections pass through as 429: %v", err)
	}
}

func TestLiveHelpersWithoutLiveLayerUseKubectl(t *testing.T) {
	f := newFixture(t, func(args []string, _ RunOptions) Result {
		if contains(args, "secret") {
			return out(map[string]any{"kind": "Secret", "data": map[string]any{"k": "dg=="}}, 0)
		}
		return out(map[string]any{"kind": "Thing"}, 0)
	})
	if f.b.liveAvailable() {
		t.Fatal("no live layer with an injected runner")
	}
	if _, _, err := f.b.liveRequest(context.Background(), "x", "POST", "/api", nil, RawOptions{}); statusOf(err) != 503 {
		t.Fatalf("liveRequest needs the live layer: %v", err)
	}
	data, err := f.b.readSecretData(context.Background(), "x", "default", "s")
	if err != nil || data["k"] != "dg==" {
		t.Fatalf("%v %v", data, err)
	}
	want := []string{"--context=x", "--namespace=default", "get", "secret", "s", "--output=json"}
	if fmt.Sprint(f.last().Args) != fmt.Sprint(want) {
		t.Fatalf("args %v", f.last().Args)
	}
	if _, err := f.b.rawGet(context.Background(), "x", "/api/v1", RawOptions{TimeoutMs: 8000}); err != nil {
		t.Fatal(err)
	}
	want = []string{"--context=x", "get", "--raw=/api/v1", "--request-timeout=8s"}
	if fmt.Sprint(f.last().Args) != fmt.Sprint(want) {
		t.Fatalf("args %v", f.last().Args)
	}
}

func TestDisableLiveOption(t *testing.T) {
	b := New(Options{DataDir: t.TempDir(), DisableLive: true})
	defer b.Close()
	if b.live != nil || b.liveAvailable() {
		t.Fatal("DisableLive must keep the live layer off")
	}
	b2 := New(Options{DataDir: t.TempDir()})
	defer b2.Close()
	if b2.live == nil {
		t.Fatal("the live layer is on by default")
	}
}
