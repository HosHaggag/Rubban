package server

import (
	"context"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"
)

type fakeDesktop struct {
	mu       sync.Mutex
	opened   []string
	theme    string
	saved    []string
	errors   []string
	reports  []map[string]any
	listener func(any)
	state    any
}

func (f *fakeDesktop) OpenExternal(u string) error { f.opened = append(f.opened, u); return nil }
func (f *fakeDesktop) SetTheme(t string) error     { f.theme = t; return nil }
func (f *fakeDesktop) SaveFile(name, text string) (bool, error) {
	f.saved = append(f.saved, name+"="+text)
	return name != "cancel.txt", nil
}
func (f *fakeDesktop) UpdateState() any                { return f.state }
func (f *fakeDesktop) UpdateCheck(context.Context) any { return map[string]any{"status": "checking"} }
func (f *fakeDesktop) UpdateDownload(context.Context) any {
	return map[string]any{"status": "downloading"}
}
func (f *fakeDesktop) UpdateInstall(context.Context) (any, error) {
	return map[string]any{"status": "installing"}, nil
}
func (f *fakeDesktop) UpdateDismiss() any { return map[string]any{"status": "idle"} }
func (f *fakeDesktop) SubscribeUpdates(fn func(any)) func() {
	f.mu.Lock()
	f.listener = fn
	f.mu.Unlock()
	return func() { f.mu.Lock(); f.listener = nil; f.mu.Unlock() }
}
func (f *fakeDesktop) RendererError(m, s string)    { f.errors = append(f.errors, m) }
func (f *fakeDesktop) SmokeReport(r map[string]any) { f.reports = append(f.reports, r) }
func (f *fakeDesktop) push(state any) {
	f.mu.Lock()
	l := f.listener
	f.mu.Unlock()
	if l != nil {
		l(state)
	}
}

func desktopFixture(t *testing.T, smoke bool) (*Backend, Connection, *fakeDesktop) {
	t.Helper()
	d := &fakeDesktop{state: map[string]any{"status": "idle"}}
	b := New(Options{DataDir: filepath.Join(t.TempDir(), "d"), Runner: func(context.Context, string, []string, RunOptions) (Result, error) { return Result{Stdout: "{}"}, nil },
		UI: fstest.MapFS{"index.html": {Data: []byte("x")}}, Desktop: d, Smoke: smoke, DesktopBridge: []byte("window.rubbanDesktop={};")})
	conn, err := b.Start(0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { b.Close() })
	return b, conn, d
}

func TestDesktopRoutes(t *testing.T) {
	_, conn, d := desktopFixture(t, false)
	f := &fixture{t: t, conn: conn}
	if r := f.post("/api/desktop/open-external", map[string]any{"url": "https://example.com/x?y=1"}); r.Status != 200 || d.opened[0] != "https://example.com/x?y=1" {
		t.Fatalf("open %d %v", r.Status, d.opened)
	}
	for _, bad := range []string{"file:///etc/passwd", "javascript:alert(1)", "https://user:pw@example.com/", "ftp://x/", "notaurl", ""} {
		if f.post("/api/desktop/open-external", map[string]any{"url": bad}).Status != 400 {
			t.Fatalf("accepted %q", bad)
		}
	}
	f.post("/api/desktop/theme", map[string]any{"theme": "dark"})
	f.post("/api/desktop/theme", map[string]any{"theme": "neon"})
	if d.theme != "dark" {
		t.Fatalf("theme %q", d.theme)
	}
	if r := f.post("/api/desktop/save-file", map[string]any{"name": "../../etc/pass:wd", "text": "hi"}); r.Status != 200 || r.Value["saved"] != true || d.saved[0] != "passwd=hi" {
		t.Fatalf("save %v %v", r.Value, d.saved)
	}
	if r := f.post("/api/desktop/save-file", map[string]any{"name": "cancel.txt", "text": ""}); r.Value["saved"] != false {
		t.Fatalf("cancel %v", r.Value)
	}
	if f.post("/api/desktop/save-file", map[string]any{"name": "x"}).Status != 400 {
		t.Fatal("missing text accepted")
	}
	if f.get("/api/desktop/updates").Value["status"] != "idle" || f.post("/api/desktop/updates/check", nil).Value["status"] != "checking" ||
		f.post("/api/desktop/updates/install", nil).Value["status"] != "installing" {
		t.Fatal("updater routes")
	}
	// Smoke-only routes are 404 outside smoke mode.
	if f.post("/api/desktop/renderer-error", map[string]any{"message": "boom"}).Status != 404 {
		t.Fatal("renderer-error outside smoke")
	}
}

func TestDesktopRoutesAbsentInWebMode(t *testing.T) {
	f := newFixture(t, nil)
	if f.get("/api/desktop/updates").Status != 404 || f.post("/api/desktop/open-external", map[string]any{"url": "https://x.y"}).Status != 404 {
		t.Fatal("desktop routes exist in web mode")
	}
	r, _ := http.Get(f.conn.URL + "/desktop-bridge.js")
	defer r.Body.Close()
	if r.StatusCode != 200 || r.ContentLength != 0 {
		t.Fatalf("bridge in web mode: %d len %d", r.StatusCode, r.ContentLength)
	}
}

func TestDesktopSmokeRoutesAndBridge(t *testing.T) {
	_, conn, d := desktopFixture(t, true)
	f := &fixture{t: t, conn: conn}
	f.post("/api/desktop/renderer-error", map[string]any{"message": "boom", "stack": "s"})
	f.post("/api/desktop/smoke-report", map[string]any{"title": "Rubban"})
	if len(d.errors) != 1 || d.errors[0] != "boom" || d.reports[0]["title"] != "Rubban" {
		t.Fatalf("smoke %v %v", d.errors, d.reports)
	}
	r, _ := http.Get(conn.URL + "/desktop-bridge.js")
	defer r.Body.Close()
	if r.StatusCode != 200 || !strings.Contains(r.Header.Get("Content-Type"), "javascript") {
		t.Fatalf("bridge %d", r.StatusCode)
	}
}

func TestDesktopEventsStream(t *testing.T) {
	_, conn, d := desktopFixture(t, false)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(conn.URL, "http")+"/api/desktop/events?token="+conn.Token, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	read := func() string {
		_, data, err := c.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}
	if first := read(); !strings.Contains(first, `"type":"update-state"`) || !strings.Contains(first, `"idle"`) {
		t.Fatalf("first %s", first)
	}
	for i := 0; i < 50; i++ { // wait for the subscription to register
		d.mu.Lock()
		ready := d.listener != nil
		d.mu.Unlock()
		if ready {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	d.push(map[string]any{"status": "available"})
	if next := read(); !strings.Contains(next, `"available"`) {
		t.Fatalf("next %s", next)
	}
	// Wrong token is rejected before the upgrade.
	if _, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(conn.URL, "http")+"/api/desktop/events?token="+strings.Repeat("0", 64), nil); err == nil {
		t.Fatal("bad token accepted")
	}
}
