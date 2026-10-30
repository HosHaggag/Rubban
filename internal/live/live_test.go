package live

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/HosHaggag/rubban/internal/live/livetest"
)

type fakeProxy struct {
	url     string
	stopped atomic.Int32
	done    chan struct{}
}

func (p *fakeProxy) BaseURL() string       { return p.url }
func (p *fakeProxy) Stop()                 { p.stopped.Add(1) }
func (p *fakeProxy) Done() <-chan struct{} { return p.done }
func (p *fakeProxy) isStopped() bool       { return p.stopped.Load() > 0 }
func newFakeProxy(url string) *fakeProxy   { return &fakeProxy{url: url, done: make(chan struct{})} }

// harness is a Live layer wired to a fake API server through a counting starter.
type harness struct {
	t       *testing.T
	api     *livetest.Server
	live    *Live
	starts  atomic.Int32
	mu      sync.Mutex
	proxies []*fakeProxy
}

func newHarness(t *testing.T, tweak func(*Config)) *harness {
	t.Helper()
	h := &harness{t: t, api: livetest.New()}
	cfg := Config{
		Starter: StarterFunc(func(ctx context.Context, kubeContext string) (Proxy, error) {
			h.starts.Add(1)
			p := newFakeProxy(h.api.BaseURL())
			h.mu.Lock()
			h.proxies = append(h.proxies, p)
			h.mu.Unlock()
			return p, nil
		}),
		StreamIdle:    5 * time.Second,
		FlushInterval: 20 * time.Millisecond,
	}
	if tweak != nil {
		tweak(&cfg)
	}
	h.live = New(cfg)
	t.Cleanup(func() { h.live.Close(); h.api.Close() })
	return h
}

func configMap(name string, data ...string) livetest.Object {
	o := livetest.Object{"kind": "ConfigMap", "metadata": livetest.Object{"name": name, "namespace": "default"}}
	if len(data) == 2 {
		o["data"] = livetest.Object{data[0]: data[1]}
	}
	return o
}

func names(items []Object) []string {
	var out []string
	for _, it := range items {
		out = append(out, strOf(objOf(it["metadata"])["name"]))
	}
	return out
}

func TestResolveResourcePrefersExplicitGroupsThenCoreThenPriority(t *testing.T) {
	resources := []Resource{
		{Name: "events", Kind: "Event", Group: "", Version: "v1", Priority: 0, ShortNames: []string{"ev"}, Singular: "event", Verbs: []string{"list"}},
		{Name: "deployments", Kind: "Deployment", Group: "apps", Version: "v1", Priority: 1, ShortNames: []string{"deploy"}, Singular: "deployment", Verbs: []string{"list"}},
		{Name: "events", Kind: "Event", Group: "events.k8s.io", Version: "v1", Priority: 5, Singular: "event", Verbs: []string{"list"}},
	}
	if g := ResolveResource(resources, "events").Group; g != "" {
		t.Fatalf("events group %q", g)
	}
	if g := ResolveResource(resources, "events.events.k8s.io").Group; g != "events.k8s.io" {
		t.Fatalf("explicit group %q", g)
	}
	if n := ResolveResource(resources, "deploy").Name; n != "deployments" {
		t.Fatalf("short name %q", n)
	}
	if g := ResolveResource(resources, "deployments.v1.apps").Group; g != "apps" {
		t.Fatalf("group.version %q", g)
	}
	if ResolveResource(resources, "events.v1").Group != "" {
		t.Fatal("core name.version")
	}
	if ResolveResource(resources, "Ev").Name != "events" {
		t.Fatal("matching is case-insensitive")
	}
	if ResolveResource(resources, "widgets") != nil {
		t.Fatal("unknown resource should not resolve")
	}
}

func TestSanitize(t *testing.T) {
	secret := Object{"kind": "Secret", "metadata": Object{"name": "s", "managedFields": []any{1},
		"annotations": Object{lastApplied: `{"data":{"p":"x"}}`, "keep": "me"}},
		"data": Object{"b": "1", "a": "2"}, "stringData": Object{"a": "3", "c": "4"}}
	out := Sanitize(secret, true)
	if out["data"] != nil || out["stringData"] != nil {
		t.Fatalf("values leaked: %v", out)
	}
	if keys, _ := json.Marshal(out["dataKeys"]); string(keys) != `["a","b","c"]` {
		t.Fatalf("dataKeys %s", keys)
	}
	meta := objOf(out["metadata"])
	if meta["managedFields"] != nil || objOf(meta["annotations"])[lastApplied] != nil || objOf(meta["annotations"])["keep"] != "me" {
		t.Fatalf("metadata %v", meta)
	}
	if secret["data"] == nil || objOf(secret["metadata"])["managedFields"] == nil {
		t.Fatal("input must not be modified")
	}
	plain := Sanitize(Object{"kind": "ConfigMap", "data": Object{"k": "v"}, "metadata": Object{"managedFields": []any{1}}}, false)
	if plain["data"] == nil || objOf(plain["metadata"])["managedFields"] != nil {
		t.Fatalf("plain %v", plain)
	}
	empty := Sanitize(Object{"kind": "Secret", "metadata": Object{}}, true)
	if _, ok := empty["dataKeys"]; ok {
		t.Fatal("no keys, no dataKeys")
	}
	if ItemKey(Object{"metadata": Object{"uid": "u"}}) != "u" || ItemKey(Object{"metadata": Object{"namespace": "n", "name": "x"}}) != "n/x" {
		t.Fatal("ItemKey")
	}
}

func TestStripManagedFieldsKeepsOrder(t *testing.T) {
	raw := json.RawMessage(`{"kind":"Pod","metadata":{"name":"p","managedFields":[{"a":1}],"uid":"u"},"spec":{"z":1,"a":2}}`)
	got := string(StripManagedFields(raw))
	want := `{"kind":"Pod","metadata":{"name":"p","uid":"u"},"spec":{"z":1,"a":2}}`
	if got != want {
		t.Fatalf("got %s", got)
	}
	if string(StripManagedFields(json.RawMessage(`[1]`))) != `[1]` {
		t.Fatal("non-objects pass through")
	}
}

// ---------------------------------------------------------------------------------------------
// Proxy pool

func TestPoolSharesOneStartAndCountsLeases(t *testing.T) {
	var starts atomic.Int32
	release := make(chan struct{})
	pool := NewPool(StarterFunc(func(ctx context.Context, kc string) (Proxy, error) {
		starts.Add(1)
		<-release
		return newFakeProxy("http://x/" + kc), nil
	}), time.Minute, time.Minute)
	defer pool.Close()
	var wg sync.WaitGroup
	leases := make([]*Lease, 3)
	for i := range leases {
		wg.Add(1)
		go func() {
			defer wg.Done()
			l, err := pool.Acquire(context.Background(), "ctx")
			if err != nil {
				t.Error(err)
				return
			}
			leases[i] = l
		}()
	}
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()
	if starts.Load() != 1 {
		t.Fatalf("starts %d", starts.Load())
	}
	if st := pool.Stats(); len(st) != 1 || st[0].Users != 3 || !st[0].Ready {
		t.Fatalf("stats %+v", st)
	}
	for _, l := range leases {
		l.Release()
		l.Release() // idempotent
	}
	if st := pool.Stats(); st[0].Users != 0 {
		t.Fatalf("users %d", st[0].Users)
	}
	if _, err := pool.Acquire(context.Background(), "other"); err != nil {
		t.Fatal(err)
	}
	if st := pool.Stats(); len(st) != 2 {
		t.Fatal("one proxy per context")
	}
}

func TestPoolIdleSweepStopsUnusedProxiesOnly(t *testing.T) {
	var made []*fakeProxy
	var mu sync.Mutex
	pool := NewPool(StarterFunc(func(ctx context.Context, kc string) (Proxy, error) {
		p := newFakeProxy("http://x/" + kc)
		mu.Lock()
		made = append(made, p)
		mu.Unlock()
		return p, nil
	}), 60*time.Millisecond, time.Minute)
	defer pool.Close()
	busy, err := pool.Acquire(context.Background(), "busy")
	if err != nil {
		t.Fatal(err)
	}
	idle, err := pool.Acquire(context.Background(), "idle")
	if err != nil {
		t.Fatal(err)
	}
	idle.Release()
	waitFor(t, "idle proxy stopped", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return made[1].isStopped()
	})
	mu.Lock()
	if made[0].isStopped() {
		t.Fatal("a leased proxy must not be swept")
	}
	mu.Unlock()
	busy.Release()
	// The next acquire relaunches the swept context.
	if _, err := pool.Acquire(context.Background(), "idle"); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(made) < 3 {
		t.Fatalf("expected a relaunch, %d proxies made", len(made))
	}
}

func TestPoolInvalidateRelaunchesAndProxyExitIsNoticed(t *testing.T) {
	var made []*fakeProxy
	var mu sync.Mutex
	pool := NewPool(StarterFunc(func(ctx context.Context, kc string) (Proxy, error) {
		p := newFakeProxy("http://x/" + kc)
		mu.Lock()
		made = append(made, p)
		mu.Unlock()
		return p, nil
	}), time.Minute, time.Minute)
	defer pool.Close()
	lease, _ := pool.Acquire(context.Background(), "c")
	lease.Invalidate()
	lease.Release()
	mu.Lock()
	if !made[0].isStopped() {
		t.Fatal("invalidate must stop the proxy")
	}
	mu.Unlock()
	lease2, err := pool.Acquire(context.Background(), "c")
	if err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	second := made[1]
	mu.Unlock()
	// A proxy that exits by itself is dropped, so the next acquire starts a new one.
	close(second.done)
	waitFor(t, "exited proxy dropped", func() bool { return len(pool.Stats()) == 0 })
	lease2.Release()
	if _, err := pool.Acquire(context.Background(), "c"); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(made) != 3 {
		t.Fatalf("proxies made %d", len(made))
	}
}

func TestPoolStartFailuresAreMarkedAndNotCached(t *testing.T) {
	var calls atomic.Int32
	pool := NewPool(StarterFunc(func(ctx context.Context, kc string) (Proxy, error) {
		n := calls.Add(1)
		switch {
		case n == 1:
			return nil, errors.New("exec: kubectl not found")
		case n == 2:
			return nil, &Error{Status: 502, Message: "Cluster connection failed: boom"}
		case n == 3:
			<-ctx.Done()
			return nil, ctx.Err()
		}
		return newFakeProxy("http://x"), nil
	}), time.Minute, 80*time.Millisecond)
	defer pool.Close()
	_, err := pool.Acquire(context.Background(), "c")
	e, _ := asError(err)
	if e == nil || !e.ProxyUnavailable || e.Status != 503 || !strings.Contains(e.Message, "kubectl not found") {
		t.Fatalf("spawn failure %#v", err)
	}
	_, err = pool.Acquire(context.Background(), "c")
	if e, _ = asError(err); e == nil || !e.ProxyUnavailable || e.Status != 502 {
		t.Fatalf("exit before ready %#v", err)
	}
	_, err = pool.Acquire(context.Background(), "c")
	if e, _ = asError(err); e == nil || !e.ProxyUnavailable || e.Status != 504 || !strings.Contains(e.Message, "Timed out") {
		t.Fatalf("timeout %#v", err)
	}
	if len(pool.Stats()) != 0 {
		t.Fatal("failed starts must not stay in the pool")
	}
	if _, err = pool.Acquire(context.Background(), "c"); err != nil {
		t.Fatalf("fourth attempt should work: %v", err)
	}
}

func TestPoolAcquireHonoursCancellationAndClose(t *testing.T) {
	block := make(chan struct{})
	var made atomic.Pointer[fakeProxy]
	pool := NewPool(StarterFunc(func(ctx context.Context, kc string) (Proxy, error) {
		<-block
		p := newFakeProxy("http://x")
		made.Store(p)
		return p, nil
	}), time.Minute, time.Minute)
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	_, err := pool.Acquire(ctx, "c")
	if e, _ := asError(err); e == nil || e.Status != 499 || !e.Canceled {
		t.Fatalf("cancel %#v", err)
	}
	if st := pool.Stats(); len(st) != 1 || st[0].Users != 0 {
		t.Fatalf("canceled acquire must drop its lease: %+v", st)
	}
	pool.Close()
	close(block)
	waitFor(t, "late proxy stopped after close", func() bool { p := made.Load(); return p != nil && p.isStopped() })
	_, err = pool.Acquire(context.Background(), "c")
	if e, _ := asError(err); e == nil || e.Status != 503 {
		t.Fatalf("closed pool %#v", err)
	}
}

// ---------------------------------------------------------------------------------------------
// requestJSON semantics

func TestRequestJSONStatusMapping(t *testing.T) {
	var delay atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if d := delay.Load(); d > 0 {
			time.Sleep(time.Duration(d))
		}
		status := map[string]int{"/ok": 200, "/forbidden": 403, "/conflict": 409, "/gone": 410, "/teapot": 418, "/boom": 500, "/bad": 200, "/empty": 200, "/status-text": 503, "/created": 201}[r.URL.Path]
		switch r.URL.Path {
		case "/forbidden", "/conflict", "/gone":
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"kind":"Status","message":"upstream says no","reason":"Forbidden"}`))
		case "/bad":
			_, _ = w.Write([]byte(`<html>`))
		case "/empty":
		case "/status-text":
			w.WriteHeader(status)
			_, _ = w.Write([]byte("  plain text failure  "))
		case "/created":
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"big":12345678901234567890}`))
		default:
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	defer srv.Close()
	tx := newTransport()
	defer tx.close()
	get := func(path string, o reqOpts) (any, *Error) {
		v, err := tx.requestJSON(context.Background(), srv.URL, path, o)
		e, _ := asError(err)
		return v, e
	}
	if v, e := get("/ok", reqOpts{}); e != nil || len(objOf(v)) != 0 {
		t.Fatalf("ok %v %v", v, e)
	}
	if v, e := get("/empty", reqOpts{}); e != nil || objOf(v) == nil {
		t.Fatalf("empty body is {}: %v %v", v, e)
	}
	if v, _ := get("/created", reqOpts{}); v.(map[string]any)["big"].(json.Number).String() != "12345678901234567890" {
		t.Fatal("numbers must stay exact")
	}
	for path, want := range map[string]int{"/forbidden": 403, "/conflict": 409, "/gone": 410} {
		_, e := get(path, reqOpts{})
		if e == nil || e.Status != want || e.Message != "upstream says no" || e.KubeStatus != want {
			t.Fatalf("%s %#v", path, e)
		}
	}
	if _, e := get("/forbidden", reqOpts{}); e.Reason != "Forbidden" {
		t.Fatal("reason")
	}
	for _, path := range []string{"/teapot", "/boom"} {
		if _, e := get(path, reqOpts{}); e == nil || e.Status != 502 {
			t.Fatalf("%s should map to 502: %#v", path, e)
		}
	}
	if _, e := get("/teapot", reqOpts{}); e.KubeStatus != 418 {
		t.Fatalf("teapot %#v", e)
	}
	if _, e := get("/status-text", reqOpts{}); e == nil || e.Message != "plain text failure" || e.Status != 502 {
		t.Fatalf("plain text %#v", e)
	}
	if _, e := get("/bad", reqOpts{}); e == nil || e.Status != 502 || e.Message != "Kubernetes API returned invalid JSON" {
		t.Fatalf("invalid json %#v", e)
	}
	delay.Store(int64(300 * time.Millisecond))
	if _, e := get("/ok", reqOpts{Timeout: 50 * time.Millisecond}); e == nil || e.Status != 504 || !strings.Contains(e.Message, "timed out after 50 ms") {
		t.Fatalf("timeout %#v", e)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err := tx.requestJSON(ctx, srv.URL, "/ok", reqOpts{})
	if e, _ := asError(err); e == nil || e.Status != 499 || !e.Canceled {
		t.Fatalf("cancel %#v", err)
	}
	// A dead proxy is a connection loss the caller must invalidate.
	dead := httptest.NewServer(http.NotFoundHandler())
	deadURL := dead.URL
	dead.Close()
	_, err = tx.requestJSON(context.Background(), deadURL, "/x", reqOpts{})
	if e, _ := asError(err); e == nil || e.Status != 502 || !e.ConnectionLost || !strings.HasPrefix(e.Message, "Cluster connection lost:") {
		t.Fatalf("connection lost %#v", err)
	}
}

func TestRequestRawKeepsBodyAndMethod(t *testing.T) {
	var gotMethod, gotType, gotAccept, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotType, gotAccept = r.Method, r.Header.Get("Content-Type"), r.Header.Get("Accept")
		var sb strings.Builder
		buf := make([]byte, 512)
		for {
			n, err := r.Body.Read(buf)
			sb.Write(buf[:n])
			if err != nil {
				break
			}
		}
		gotBody = sb.String()
		w.WriteHeader(201)
		_, _ = w.Write([]byte(`{"z":1,"a":2}`))
	}))
	defer srv.Close()
	h := newHarness(t, nil)
	h.live.Close()
	l := New(Config{Starter: StarterFunc(func(context.Context, string) (Proxy, error) { return newFakeProxy(srv.URL), nil })})
	defer l.Close()
	raw, status, err := l.Do(context.Background(), "c", http.MethodPost, "/x", []byte(`{"a":1}`), RawOptions{Accept: "text/x"})
	if err != nil || status != 201 || string(raw) != `{"z":1,"a":2}` {
		t.Fatalf("%s %d %v", raw, status, err)
	}
	if gotMethod != "POST" || gotType != "application/json" || gotAccept != "text/x" || gotBody != `{"a":1}` {
		t.Fatalf("request %s %s %s %s", gotMethod, gotType, gotAccept, gotBody)
	}
}

// ---------------------------------------------------------------------------------------------
// Reads

func TestReadsShareOneConnection(t *testing.T) {
	h := newHarness(t, nil)
	for _, n := range []string{"a", "b", "c", "d", "e"} {
		h.api.Put("ADDED", configMap(n))
	}
	h.api.Put("ADDED", livetest.Object{"kind": "Secret", "metadata": livetest.Object{"name": "token", "namespace": "default",
		"annotations": livetest.Object{lastApplied: `{"data":{"password":"c2VjcmV0"}}`}}, "data": livetest.Object{"password": "c2VjcmV0"}})
	ctx := context.Background()

	d, err := h.live.Discover(ctx, "fake", false)
	if err != nil {
		t.Fatal(err)
	}
	var deploy *Resource
	for i := range d.Resources {
		if d.Resources[i].Name == "deployments" {
			deploy = &d.Resources[i]
		}
	}
	if deploy == nil || deploy.Version != "v1" || deploy.Group != "apps" || !deploy.Namespaced || deploy.Singular != "deployment" {
		t.Fatalf("discovery %+v", d.Resources)
	}
	for i := 1; i < len(d.Resources); i++ {
		a, b := d.Resources[i-1], d.Resources[i]
		if a.Group+"/"+a.Name > b.Group+"/"+b.Name {
			t.Fatalf("discovery must be sorted: %v before %v", a, b)
		}
	}

	list, err := h.live.List(ctx, "fake", "configmaps", "default", ListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	items := listOf(list["items"])
	got := names(toObjects(items))
	if strings.Join(got, ",") != "a,b,c,d,e" {
		t.Fatalf("items %v", got)
	}
	first := objOf(items[0])
	if first["kind"] != "ConfigMap" || first["apiVersion"] != "v1" || objOf(first["metadata"])["managedFields"] != nil {
		t.Fatalf("first item %v", first)
	}
	if list["kind"] != "List" || objOf(list["metadata"])["resourceVersion"] == "" {
		t.Fatalf("list envelope %v", list)
	}
	if h.api.Count(func(r string) bool { return strings.Contains(r, "continue=4") }) == 0 {
		t.Fatal("pagination continued to the last page")
	}

	secrets, err := h.live.List(ctx, "fake", "secrets", "*", ListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	text, _ := json.Marshal(secrets)
	if strings.Contains(string(text), "c2VjcmV0") {
		t.Fatalf("secret value leaked: %s", text)
	}
	if keys, _ := json.Marshal(objOf(listOf(secrets["items"])[0])["dataKeys"]); string(keys) != `["password"]` {
		t.Fatalf("dataKeys %s", keys)
	}

	if _, err := h.live.List(ctx, "fake", "events", "default", ListOptions{}); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, r := range h.api.Requests() {
		if r == "/api/v1/namespaces/default/events?limit=500" {
			found = true
		}
	}
	if !found {
		t.Fatalf("bare events resolves to the core API: %v", h.api.Requests())
	}

	// A list with selectors puts them in the query, after limit.
	if _, err := h.live.List(ctx, "fake", "configmaps", "default", ListOptions{LabelSelector: "app=x", FieldSelector: "metadata.name=a"}); err != nil {
		t.Fatal(err)
	}
	if h.api.Count(func(r string) bool {
		return r == "/api/v1/namespaces/default/configmaps?limit=500&labelSelector=app%3Dx&fieldSelector=metadata.name%3Da"
	}) != 1 {
		t.Fatalf("selector query: %v", h.api.Requests())
	}

	obj, err := h.live.Get(ctx, "fake", "configmaps", "default", "a")
	if err != nil || objOf(obj["metadata"])["managedFields"] != nil || objOf(obj["metadata"])["name"] != "a" {
		t.Fatalf("get %v %v", obj, err)
	}
	// Namespaced reads without a namespace use "default"; cluster-scoped ones ignore it.
	if _, err := h.live.Get(ctx, "fake", "configmaps", "", "b"); err != nil {
		t.Fatal(err)
	}
	raw, err := h.live.GetRaw(ctx, "fake", "configmaps", "default", "a")
	if err != nil || strings.Contains(string(raw), "managedFields") || !strings.HasPrefix(string(raw), `{"apiVersion":"v1"`) && !strings.Contains(string(raw), `"name":"a"`) {
		t.Fatalf("getraw %s %v", raw, err)
	}
	// Secret GET keeps its values for the explicit reveal paths.
	secret, err := h.live.Get(ctx, "fake", "secrets", "default", "token")
	if err != nil || objOf(secret["data"])["password"] != "c2VjcmV0" {
		t.Fatalf("secret get %v %v", secret, err)
	}

	_, err = h.live.List(ctx, "fake", "widgets", "*", ListOptions{})
	if e, _ := asError(err); e == nil || e.Status != 404 || e.Message != `This cluster does not serve the resource type "widgets"` {
		t.Fatalf("unknown %#v", err)
	}
	if _, err := h.live.Get(ctx, "fake", "configmaps", "default", "nope"); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("missing object %v", err)
	}
	if h.starts.Load() != 1 {
		t.Fatalf("every read reused one connection, starts=%d", h.starts.Load())
	}
}

func toObjects(items []any) []Object {
	out := make([]Object, len(items))
	for i, it := range items {
		out[i] = objOf(it)
	}
	return out
}

func TestDiscoveryCacheRefreshAndUnknownResource(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	countDiscovery := func() int { return h.api.Count(func(r string) bool { return r == "/api" }) }
	for i := 0; i < 3; i++ {
		if _, err := h.live.Discover(ctx, "fake", false); err != nil {
			t.Fatal(err)
		}
	}
	if countDiscovery() != 1 {
		t.Fatalf("cached discovery fetched %d times", countDiscovery())
	}
	if _, err := h.live.Discover(ctx, "fake", true); err != nil || countDiscovery() != 2 {
		t.Fatalf("refresh=1 refetches: %d %v", countDiscovery(), err)
	}
	// An unknown type refreshes discovery exactly once before answering 404.
	if _, err := h.live.List(ctx, "fake", "gadgets", "*", ListOptions{}); err == nil {
		t.Fatal("expected 404")
	}
	if countDiscovery() != 3 {
		t.Fatalf("unknown resource should refresh once: %d", countDiscovery())
	}
}

func TestDiscoveryExpiresAfterTTL(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.DiscoveryTTL = 40 * time.Millisecond })
	ctx := context.Background()
	_, _ = h.live.Discover(ctx, "fake", false)
	time.Sleep(80 * time.Millisecond)
	_, _ = h.live.Discover(ctx, "fake", false)
	if n := h.api.Count(func(r string) bool { return r == "/api" }); n != 2 {
		t.Fatalf("fetched %d times", n)
	}
}

func TestLegacyDiscoveryFallback(t *testing.T) {
	h := newHarness(t, nil)
	h.api.SetLegacy(true)
	d, err := h.live.Discover(context.Background(), "fake", false)
	if err != nil {
		t.Fatal(err)
	}
	by := map[string]Resource{}
	for _, r := range d.Resources {
		by[r.Group+"/"+r.Name] = r
	}
	if r := by["apps/deployments"]; r.Version != "v1" || r.Singular != "deployment" || len(r.ShortNames) != 1 || !r.Namespaced {
		t.Fatalf("deployments %+v", r)
	}
	if r := by["/pods"]; r.Version != "v1" || r.Group != "" {
		t.Fatalf("pods %+v", r)
	}
	if _, ok := by["/pods/log"]; ok {
		t.Fatal("subresources must be excluded")
	}
	if len(d.Warnings) != 1 || d.Warnings[0] != "Skipped malformed API group version" {
		t.Fatalf("warnings %v", d.Warnings)
	}
	// Priorities follow the order core, then groups.
	if by["/pods"].Priority >= by["apps/deployments"].Priority {
		t.Fatalf("priority order %v %v", by["/pods"].Priority, by["apps/deployments"].Priority)
	}
}

func TestDiscoveryFailureIsReportedAndNotCached(t *testing.T) {
	h := newHarness(t, nil)
	dead := livetest.New()
	url := dead.BaseURL()
	dead.Close()
	var useDead atomic.Bool
	useDead.Store(true)
	l := New(Config{Starter: StarterFunc(func(context.Context, string) (Proxy, error) {
		if useDead.Load() {
			return newFakeProxy(url), nil
		}
		return newFakeProxy(h.api.BaseURL()), nil
	})})
	defer l.Close()
	_, err := l.Discover(context.Background(), "c", false)
	e, _ := asError(err)
	if e == nil || e.Status != 502 || !strings.HasPrefix(e.Message, "Kubernetes discovery unavailable: Core discovery: ") {
		t.Fatalf("discovery error %#v", err)
	}
	useDead.Store(false)
	if _, err := l.Discover(context.Background(), "c", false); err != nil {
		t.Fatalf("failure must not be cached: %v", err)
	}
}

func TestRawAndEviction(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	raw, status, err := h.live.Do(ctx, "fake", "POST", "/api/v1/namespaces/default/pods/web-1/eviction", []byte(`{"kind":"Eviction"}`), RawOptions{})
	if err != nil || status != 201 || !strings.Contains(string(raw), "Success") {
		t.Fatalf("%s %d %v", raw, status, err)
	}
	if posts := h.api.Posts(); len(posts) != 1 || !strings.HasSuffix(posts[0], ` {"kind":"Eviction"}`) {
		t.Fatalf("posts %v", posts)
	}
	h.api.SetEvictStatus(429)
	_, _, err = h.live.Do(ctx, "fake", "POST", "/api/v1/namespaces/default/pods/web-1/eviction", []byte(`{}`), RawOptions{})
	if e, _ := asError(err); e == nil || e.Status != 429 || !strings.Contains(e.Message, "disruption budget") {
		t.Fatalf("PDB rejection passes through: %#v", err)
	}
	v, err := h.live.Raw(ctx, "fake", "/api/v1/namespaces/default/configmaps", RawOptions{Accept: "application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1,application/json"})
	if err != nil || objOf(v)["kind"] != "ConfigMapList" {
		t.Fatalf("raw %v %v", v, err)
	}
}

// ---------------------------------------------------------------------------------------------
// Watches

type event struct {
	kind    string // status | reset | changes | fatal
	status  Status
	items   []Object
	rv      string
	deletes []string
	err     error
}

type recorder struct {
	mu     sync.Mutex
	events []event
}

func (r *recorder) add(e event) { r.mu.Lock(); r.events = append(r.events, e); r.mu.Unlock() }
func (r *recorder) Status(s Status) {
	r.add(event{kind: "status", status: s})
}
func (r *recorder) Reset(items []Object, rv string) {
	r.add(event{kind: "reset", items: items, rv: rv})
}
func (r *recorder) Changes(upserts []Object, deletes []string) {
	r.add(event{kind: "changes", items: upserts, deletes: deletes})
}
func (r *recorder) Fatal(err error) { r.add(event{kind: "fatal", err: err}) }

func (r *recorder) snapshot() []event {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]event(nil), r.events...)
}

func (r *recorder) find(match func(event) bool) (event, bool) {
	for _, e := range r.snapshot() {
		if match(e) {
			return e, true
		}
	}
	return event{}, false
}

// next waits for the first event after position from that matches; it returns the new position.
func (r *recorder) next(t *testing.T, from int, match func(event) bool) (event, int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		all := r.snapshot()
		for i := from; i < len(all); i++ {
			if match(all[i]) {
				return all[i], i + 1
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	var kinds []string
	for _, e := range r.snapshot() {
		kinds = append(kinds, e.kind+":"+e.status.State)
	}
	t.Fatalf("timed out waiting for an event; saw %v", kinds)
	return event{}, 0
}

func (r *recorder) count(kind string) int {
	n := 0
	for _, e := range r.snapshot() {
		if e.kind == kind {
			n++
		}
	}
	return n
}

func isKind(kind string) func(event) bool { return func(e event) bool { return e.kind == kind } }
func isState(state string) func(event) bool {
	return func(e event) bool { return e.kind == "status" && e.status.State == state }
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func (h *harness) watch(resource, namespace string, o WatchOptions) (*recorder, func()) {
	h.t.Helper()
	r := &recorder{}
	unsub, err := h.live.Watch(context.Background(), "fake", resource, namespace, r, o)
	if err != nil {
		h.t.Fatal(err)
	}
	return r, unsub
}

func TestWatchSnapshotThenCoalescedChangesAndSecretRedaction(t *testing.T) {
	h := newHarness(t, nil)
	h.api.Put("ADDED", configMap("existing"))
	rec, _ := h.watch("configmaps", "default", WatchOptions{})
	first := rec.snapshot()[0]
	if first.kind != "status" || first.status.State != "connecting" {
		t.Fatalf("first event %+v", first)
	}
	reset, pos := rec.next(t, 0, isKind("reset"))
	if len(reset.items) != 1 || reset.items[0]["kind"] != "ConfigMap" || objOf(reset.items[0]["metadata"])["managedFields"] != nil || reset.rv == "" {
		t.Fatalf("reset %+v", reset)
	}
	_, pos = rec.next(t, pos, isState("live"))

	h.api.Put("ADDED", configMap("fresh", "v", "1"))
	h.api.Put("MODIFIED", configMap("fresh", "v", "2"))
	added, pos := rec.next(t, pos, isKind("changes"))
	if len(added.items) != 1 || names(added.items)[0] != "fresh" || objOf(added.items[0]["data"])["v"] != "2" {
		t.Fatalf("rapid updates are coalesced: %+v", added)
	}
	h.api.Put("DELETED", configMap("existing"))
	removed, _ := rec.next(t, pos, func(e event) bool { return e.kind == "changes" && len(e.deletes) > 0 })
	if len(removed.deletes) != 1 || removed.deletes[0] != "uid-ConfigMap-existing" {
		t.Fatalf("deletes %v", removed.deletes)
	}

	secrets, _ := h.watch("secrets", "*", WatchOptions{})
	_, spos := secrets.next(t, 0, isKind("reset"))
	_, spos = secrets.next(t, spos, isState("live"))
	h.api.Put("ADDED", livetest.Object{"kind": "Secret", "metadata": livetest.Object{"name": "db", "namespace": "default"},
		"data": livetest.Object{"password": "aHVudGVyMg=="}, "stringData": livetest.Object{"token": "plain"}})
	change, _ := secrets.next(t, spos, isKind("changes"))
	if names(change.items)[0] != "db" || change.items[0]["dataKeys"] == nil {
		t.Fatalf("secret change %+v", change)
	}
	text, _ := json.Marshal(secrets.snapshot())
	for _, leak := range []string{"aHVudGVyMg", "plain", `"data"`, `"stringData"`} {
		if strings.Contains(string(text), leak) {
			t.Fatalf("secret leaked %q: %s", leak, text)
		}
	}
}

func TestWatchRecoversFromGoneWithDiffRelistAndResumesAfterDrops(t *testing.T) {
	h := newHarness(t, nil)
	h.api.Put("ADDED", configMap("one"))
	h.api.Put("ADDED", configMap("two"))
	rec, _ := h.watch("configmaps", "default", WatchOptions{})
	_, pos := rec.next(t, 0, isKind("reset"))
	_, pos = rec.next(t, pos, isState("live"))
	waitFor(t, "watch open", func() bool { return h.api.Watchers() == 1 })

	// A stream drop during which state changes; the next watch is told its version expired.
	h.api.GoneOnNextWatch()
	h.api.DropWatches()
	h.api.Remove("ConfigMap", "default", "one")
	h.api.Put("ADDED", configMap("three"))
	diff, pos := rec.next(t, pos, isKind("changes"))
	if strings.Join(names(diff.items), ",") != "three" || len(diff.deletes) != 1 || diff.deletes[0] != "uid-ConfigMap-one" {
		t.Fatalf("diff %+v", diff)
	}
	if rec.count("reset") != 1 {
		t.Fatal("recovery does not reset the client")
	}

	// A normal stream end resumes from the last seen resourceVersion.
	waitFor(t, "watch reopened", func() bool { return h.api.Watchers() == 1 })
	before := h.api.Count(func(r string) bool { return strings.Contains(r, "watch=1") })
	h.api.DropWatches()
	waitFor(t, "new watch request", func() bool {
		return h.api.Count(func(r string) bool { return strings.Contains(r, "watch=1") }) > before
	})
	var last string
	for _, r := range h.api.Requests() {
		if strings.Contains(r, "watch=1") {
			last = r
		}
	}
	if !strings.Contains(last, "resourceVersion=") || strings.Contains(last, "resourceVersion=&") || !strings.Contains(last, "allowWatchBookmarks=true") || !strings.Contains(last, "timeoutSeconds=290") {
		t.Fatalf("resume request %s", last)
	}
	waitFor(t, "watch reopened", func() bool { return h.api.Watchers() == 1 })
	h.api.Put("ADDED", configMap("four"))
	four, _ := rec.next(t, pos, func(e event) bool { return e.kind == "changes" && len(e.items) > 0 && names(e.items)[0] == "four" })
	if four.items == nil {
		t.Fatal("no change after resume")
	}
}

func TestSharedWatchAndPermissionErrors(t *testing.T) {
	h := newHarness(t, nil)
	h.api.Put("ADDED", configMap("shared"))
	first, _ := h.watch("configmaps", "default", WatchOptions{})
	_, pos := first.next(t, 0, isKind("reset"))
	first.next(t, pos, isState("live"))
	second, _ := h.watch("configmaps", "default", WatchOptions{})
	reset, _ := second.next(t, 0, isKind("reset"))
	if len(reset.items) != 1 {
		t.Fatalf("late subscriber gets the snapshot: %+v", reset)
	}
	waitFor(t, "single watch", func() bool { return h.api.Watchers() == 1 })
	if n := h.api.Count(func(r string) bool { return strings.HasPrefix(r, "/api/v1/namespaces/default/configmaps?watch=1") }); n != 1 {
		t.Fatalf("subscribers share one upstream watch, got %d", n)
	}
	// Both subscribers see later changes from that single stream.
	h.api.Put("ADDED", configMap("later"))
	first.next(t, 0, func(e event) bool { return e.kind == "changes" && names(e.items)[0] == "later" })
	second.next(t, 0, func(e event) bool { return e.kind == "changes" && names(e.items)[0] == "later" })

	h.api.Forbid("secrets", true)
	denied, _ := h.watch("secrets", "*", WatchOptions{})
	fatal, _ := denied.next(t, 0, isKind("fatal"))
	e, _ := asError(fatal.err)
	if e == nil || e.Status != 403 || !strings.Contains(e.Message, "forbidden") {
		t.Fatalf("forbidden list %#v", fatal.err)
	}
	if _, ok := denied.find(isState("error")); !ok {
		t.Fatal("an error status precedes fatal")
	}
	if n := h.live.Stats(); len(n.Watches) != 1 {
		t.Fatalf("a failed watch is dropped: %+v", n.Watches)
	}

	_, err := h.live.Watch(context.Background(), "fake", "widgets", "*", &recorder{}, WatchOptions{})
	if e, _ := asError(err); e == nil || e.Status != 404 {
		t.Fatalf("unknown resource %#v", err)
	}
}

func TestWatchFallsBackToPollingWhenWatchIsForbidden(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.PollInterval = 40 * time.Millisecond })
	h.api.ForbidWatch("configmaps", true)
	h.api.Put("ADDED", configMap("polled"))
	rec, _ := h.watch("configmaps", "default", WatchOptions{})
	_, pos := rec.next(t, 0, isKind("reset"))
	st, pos := rec.next(t, pos, isState("polling"))
	if !strings.Contains(st.status.Message, "not permitted") {
		t.Fatalf("message %q", st.status.Message)
	}
	h.api.Put("ADDED", configMap("second"))
	change, pos := rec.next(t, pos, isKind("changes"))
	if names(change.items)[0] != "second" {
		t.Fatalf("poll diff %+v", change)
	}
	h.api.Remove("ConfigMap", "default", "polled")
	gone, _ := rec.next(t, pos, func(e event) bool { return e.kind == "changes" && len(e.deletes) == 1 })
	if gone.deletes[0] != "uid-ConfigMap-polled" || len(gone.items) != 0 {
		t.Fatalf("poll delete %+v", gone)
	}
}

func TestWatchResyncRelistsAndEmitsDiff(t *testing.T) {
	h := newHarness(t, nil)
	h.api.Put("ADDED", configMap("a"))
	rec, _ := h.watch("configmaps", "default", WatchOptions{})
	_, pos := rec.next(t, 0, isKind("reset"))
	rec.next(t, pos, isState("live"))
	waitFor(t, "watch open", func() bool { return h.api.Watchers() == 1 })
	lists := func() int {
		return h.api.Count(func(r string) bool { return strings.HasPrefix(r, "/api/v1/namespaces/default/configmaps?limit=") })
	}
	if lists() != 1 {
		t.Fatalf("lists %d", lists())
	}
	h.api.Remove("ConfigMap", "default", "a")
	// A second subscriber asking for resync aborts the stream and relists.
	other := &recorder{}
	unsub, err := h.live.Watch(context.Background(), "fake", "configmaps", "default", other, WatchOptions{Resync: true})
	if err != nil {
		t.Fatal(err)
	}
	defer unsub()
	gone, _ := rec.next(t, pos, func(e event) bool { return e.kind == "changes" && len(e.deletes) == 1 })
	if gone.deletes[0] != "uid-ConfigMap-a" {
		t.Fatalf("diff %+v", gone)
	}
	if lists() != 2 {
		t.Fatalf("resync relists, lists=%d", lists())
	}
}

func TestWatchReconnectsAfterProxyDies(t *testing.T) {
	api := livetest.New()
	defer api.Close()
	dead := livetest.New()
	deadURL := dead.BaseURL()
	dead.Close()
	var starts atomic.Int32
	var made []*fakeProxy
	var mu sync.Mutex
	l := New(Config{Starter: StarterFunc(func(context.Context, string) (Proxy, error) {
		n := starts.Add(1)
		url := api.BaseURL()
		if n == 2 { // the second proxy (after discovery) is dead on arrival, like a killed kubectl proxy
			url = deadURL
		}
		p := newFakeProxy(url)
		mu.Lock()
		made = append(made, p)
		mu.Unlock()
		return p, nil
	}), FlushInterval: 20 * time.Millisecond})
	defer l.Close()
	api.Put("ADDED", configMap("x"))
	// Discovery uses the first proxy; invalidate it so the watch gets the dead one first.
	if _, err := l.Discover(context.Background(), "fake", false); err != nil {
		t.Fatal(err)
	}
	lease, _ := l.pool.Acquire(context.Background(), "fake")
	lease.Invalidate()
	lease.Release()
	rec := &recorder{}
	if _, err := l.Watch(context.Background(), "fake", "configmaps", "default", rec, WatchOptions{}); err != nil {
		t.Fatal(err)
	}
	st, pos := rec.next(t, 0, isState("reconnecting"))
	if st.status.Attempt != 1 || !strings.Contains(st.status.Message, "Cluster connection lost") || !strings.Contains(st.status.Message, "Retrying in 1s.") {
		t.Fatalf("reconnecting status %+v", st.status)
	}
	rec.next(t, pos, isKind("reset"))
	if starts.Load() < 3 {
		t.Fatalf("the dead proxy should have been replaced, starts=%d", starts.Load())
	}
	mu.Lock()
	defer mu.Unlock()
	if !made[1].isStopped() {
		t.Fatal("the connection-lost proxy must be stopped")
	}
}

func TestWatchRetriesWithBackoffAndRelistsAfterThreeFailures(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.MaxBackoff = 30 * time.Millisecond })
	h.api.Put("ADDED", configMap("a"))
	rec, _ := h.watch("configmaps", "default", WatchOptions{})
	_, pos := rec.next(t, 0, isKind("reset"))
	rec.next(t, pos, isState("live"))
	waitFor(t, "watch open", func() bool { return h.api.Watchers() == 1 })
	listsBefore := h.api.Count(func(r string) bool { return strings.Contains(r, "?limit=") && strings.Contains(r, "configmaps") })
	// Three failed attempts in a row (the API answers 500 for list and watch) force a full relist.
	h.api.Forbid("configmaps", false)
	h.api.SetFail("configmaps", 500, 3)
	h.api.DropWatches()
	waitFor(t, "recovered", func() bool {
		return h.api.Watchers() == 1 && h.api.Count(func(r string) bool { return strings.Contains(r, "?limit=") && strings.Contains(r, "configmaps") }) > listsBefore
	})
	if _, ok := rec.find(func(e event) bool {
		return e.kind == "status" && e.status.Attempt == 1 && strings.Contains(e.status.Message, "Retrying in")
	}); !ok {
		t.Fatal("first retry status missing")
	}
}

func TestWatchLingersAfterLastSubscriberThenStops(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.WatchLinger = 80 * time.Millisecond })
	h.api.Put("ADDED", configMap("a"))
	rec, unsub := h.watch("configmaps", "default", WatchOptions{})
	_, pos := rec.next(t, 0, isKind("reset"))
	rec.next(t, pos, isState("live"))
	unsub()
	unsub() // idempotent
	// Within the linger window a new subscriber reuses the list and watch.
	again, unsub2 := h.watch("configmaps", "default", WatchOptions{})
	reset, _ := again.next(t, 0, isKind("reset"))
	if len(reset.items) != 1 {
		t.Fatalf("snapshot reuse %+v", reset)
	}
	time.Sleep(150 * time.Millisecond)
	if n := len(h.live.Stats().Watches); n != 1 {
		t.Fatalf("a watched resource stays: %d", n)
	}
	if lists := h.api.Count(func(r string) bool { return strings.Contains(r, "configmaps?limit=") }); lists != 1 {
		t.Fatalf("lingering watch must not list again: %d", lists)
	}
	unsub2()
	waitFor(t, "linger expiry", func() bool { return len(h.live.Stats().Watches) == 0 })
	waitFor(t, "upstream watch closed", func() bool { return h.api.Watchers() == 0 })
}

func TestWatchRestartsASilentStream(t *testing.T) {
	// A stream that stays silent past StreamIdle is restarted from the last resourceVersion. The fake
	// sends a bookmark right away, then nothing.
	h := newHarness(t, func(c *Config) { c.StreamIdle = 150 * time.Millisecond })
	h.api.Put("ADDED", configMap("a"))
	rec, _ := h.watch("configmaps", "default", WatchOptions{})
	rec.next(t, 0, isKind("reset"))
	waitFor(t, "restarted watch", func() bool {
		return h.api.Count(func(r string) bool { return strings.Contains(r, "watch=1") }) >= 3
	})
	if rec.count("reset") != 1 {
		t.Fatal("restarting the stream must not reset the client")
	}
}

func TestWatchKeysAreScopedBySelectorsAndNamespace(t *testing.T) {
	h := newHarness(t, nil)
	h.api.Put("ADDED", configMap("a"))
	_, _ = h.watch("configmaps", "default", WatchOptions{})
	_, _ = h.watch("configmaps", "default", WatchOptions{LabelSelector: "app=x"})
	_, _ = h.watch("configmaps", "*", WatchOptions{})
	_, _ = h.watch("configmaps", "default", WatchOptions{})
	if n := len(h.live.Stats().Watches); n != 3 {
		t.Fatalf("expected three distinct watches, got %d", n)
	}
	waitFor(t, "selector in query", func() bool {
		return h.api.Count(func(r string) bool {
			return strings.Contains(r, "watch=1") && strings.Contains(r, "labelSelector=app%3Dx")
		}) == 1
	})
}

func TestWatchRejectsUnlistableResourcesAndClosedLayer(t *testing.T) {
	h := newHarness(t, nil)
	_, err := h.live.Watch(context.Background(), "fake", "configmaps", "default", &recorder{}, WatchOptions{})
	if err != nil {
		t.Fatal(err)
	}
	h.live.Close()
	_, err = h.live.Watch(context.Background(), "fake", "configmaps", "default", &recorder{}, WatchOptions{})
	if err == nil {
		t.Fatal("closed layer must refuse watches")
	}
	select {
	case <-h.live.Done():
	default:
		t.Fatal("Done must be closed")
	}
}

func TestCloseStopsWatchesAndProxies(t *testing.T) {
	h := newHarness(t, nil)
	h.api.Put("ADDED", configMap("a"))
	rec, _ := h.watch("configmaps", "default", WatchOptions{})
	_, pos := rec.next(t, 0, isKind("reset"))
	rec.next(t, pos, isState("live"))
	waitFor(t, "watch open", func() bool { return h.api.Watchers() == 1 })
	h.live.Close()
	waitFor(t, "upstream watch closed", func() bool { return h.api.Watchers() == 0 })
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.proxies) != 1 || !h.proxies[0].isStopped() {
		t.Fatalf("proxy not stopped: %d", len(h.proxies))
	}
}

func TestListenerPanicDoesNotStopTheStream(t *testing.T) {
	h := newHarness(t, nil)
	h.api.Put("ADDED", configMap("a"))
	_, err := h.live.Watch(context.Background(), "fake", "configmaps", "default", panicListener{}, WatchOptions{})
	if err != nil {
		t.Fatal(err)
	}
	rec, _ := h.watch("configmaps", "default", WatchOptions{})
	_, pos := rec.next(t, 0, isKind("reset"))
	rec.next(t, pos, isState("live"))
}

type panicListener struct{}

func (panicListener) Status(Status)              { panic("boom") }
func (panicListener) Reset([]Object, string)     { panic("boom") }
func (panicListener) Changes([]Object, []string) { panic("boom") }
func (panicListener) Fatal(error)                { panic("boom") }

func TestBackoffGrowsAndIsCapped(t *testing.T) {
	for attempt, base := range map[int]time.Duration{1: time.Second, 2: 2 * time.Second, 3: 4 * time.Second, 6: 30 * time.Second, 40: 30 * time.Second} {
		for i := 0; i < 50; i++ {
			d := backoff(attempt, 30*time.Second)
			if d < time.Duration(float64(base)*0.75) || d >= time.Duration(float64(base)*1.25)+time.Millisecond {
				t.Fatalf("attempt %d: %v outside [0.75,1.25) x %v", attempt, d, base)
			}
		}
	}
}

func TestCollectionPath(t *testing.T) {
	core := Resource{Name: "pods", Version: "v1", Namespaced: true}
	if collectionPath(core, "") != "/api/v1/pods" || collectionPath(core, "a b") != "/api/v1/namespaces/a%20b/pods" {
		t.Fatal(collectionPath(core, "a b"))
	}
	grouped := Resource{Name: "deployments", Group: "apps", Version: "v1", Namespaced: true}
	if collectionPath(grouped, "web") != "/apis/apps/v1/namespaces/web/deployments" {
		t.Fatal(collectionPath(grouped, "web"))
	}
	if collectionPath(Resource{Name: "nodes", Version: "v1"}, "ignored") != "/api/v1/nodes" {
		t.Fatal("cluster scoped ignores namespace")
	}
	if encodeURIComponent("system:node/a b+c") != "system%3Anode%2Fa%20b%2Bc" {
		t.Fatal(encodeURIComponent("system:node/a b+c"))
	}
}
