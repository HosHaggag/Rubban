package updater

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func sha(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// chunkReader returns the payload in fixed-size pieces so progress callbacks fire many times.
type chunkReader struct {
	data  []byte
	chunk int
}

func (c *chunkReader) Read(p []byte) (int, error) {
	if len(c.data) == 0 {
		return 0, io.EOF
	}
	n := c.chunk
	if n > len(c.data) {
		n = len(c.data)
	}
	if n > len(p) {
		n = len(p)
	}
	copy(p, c.data[:n])
	c.data = c.data[n:]
	return n, nil
}

type harness struct {
	t        *testing.T
	u        *Updater
	dataDir  string
	name     string
	payload  []byte
	latest   string
	manifest map[string]any

	mu        sync.Mutex
	requests  []*http.Request
	states    []State
	spawned   [][]string
	quit      int
	failCheck bool
	tamper    bool
	chunk     int
	redirect  string // when set, the download first redirects here
	timers    []timer
	prefs     map[string]any
}

type timer struct {
	d       time.Duration
	f       func()
	stopped *bool
}

type opts struct {
	version  string
	latest   string
	payload  []byte
	tamper   bool
	packaged *bool
	platform string
	env      map[string]string
	exec     string
	tempDir  string
}

func setup(t *testing.T, o opts) *harness {
	t.Helper()
	if o.version == "" {
		o.version = "0.10.0"
	}
	if o.latest == "" {
		o.latest = "0.11.0"
	}
	if o.payload == nil {
		o.payload = []byte("zip-bytes")
	}
	if o.platform == "" {
		o.platform = "win32"
	}
	packaged := true
	if o.packaged != nil {
		packaged = *o.packaged
	}
	h := &harness{t: t, dataDir: t.TempDir(), payload: o.payload, latest: o.latest, tamper: o.tamper, chunk: 3}
	h.name = "Rubban-" + o.latest + "-Windows-x64.zip"
	key := o.platform + "-x64"
	h.manifest = map[string]any{"version": o.latest, "notes": "- better", "assets": map[string]any{key: map[string]any{"name": h.name, "sha256": sha(o.payload), "size": len(o.payload)}}}
	client := &http.Client{Transport: roundTrip(h.serve)}
	exe := o.exec
	if exe == "" {
		exe = filepath.Join(h.dataDir, "Rubban", "Rubban.exe")
	}
	tempDir := o.tempDir
	if tempDir == "" {
		tempDir = filepath.Join(os.TempDir(), "not-the-data-dir")
	}
	env := o.env
	h.u = New(Config{
		DataDir: h.dataDir, CurrentVersion: o.version, IsPackaged: packaged, Platform: o.platform, Arch: "x64",
		ExecPath: exe, TempDir: tempDir, PID: 4242, HTTPClient: client,
		Env:     func(k string) string { return env[k] },
		OnState: func(s State) { h.mu.Lock(); h.states = append(h.states, s); h.mu.Unlock() },
		Spawn:   func(c string, a []string) error { h.spawned = append(h.spawned, append([]string{c}, a...)); return nil },
		Quit:    func() { h.quit++ },
		GetPreferences: func(context.Context) (map[string]any, error) {
			return h.prefs, nil
		},
		AfterFunc: func(d time.Duration, f func()) func() {
			stopped := false
			h.timers = append(h.timers, timer{d, f, &stopped})
			return func() { stopped = true }
		},
	})
	return h
}

func (h *harness) serve(r *http.Request) (*http.Response, error) {
	h.mu.Lock()
	h.requests = append(h.requests, r)
	h.mu.Unlock()
	resp := func(status int, body io.Reader, hdr http.Header) (*http.Response, error) {
		if hdr == nil {
			hdr = http.Header{}
		}
		return &http.Response{StatusCode: status, Header: hdr, Body: io.NopCloser(body), Request: r}, nil
	}
	if strings.HasSuffix(r.URL.Path, "/latest.json") {
		if h.failCheck {
			return resp(500, strings.NewReader("boom"), nil)
		}
		data, _ := json.Marshal(h.manifest)
		return resp(200, bytes.NewReader(data), nil)
	}
	if r.URL.Host == "github.com" && h.redirect != "" {
		return resp(302, strings.NewReader(""), http.Header{"Location": {h.redirect}})
	}
	body := h.payload
	if h.tamper {
		body = bytes.Repeat([]byte("X"), len(h.payload))
	}
	return resp(200, &chunkReader{data: append([]byte(nil), body...), chunk: h.chunk}, nil)
}

func (h *harness) statuses() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []string
	for _, s := range h.states {
		out = append(out, s.Status)
	}
	return out
}

func (h *harness) zipPath() string { return filepath.Join(h.dataDir, "updates", h.name) }

func (h *harness) readyUpdate() {
	h.t.Helper()
	if st := h.u.Check(context.Background()); st.Status != StatusAvailable {
		h.t.Fatalf("check: %+v", st)
	}
	st, err := h.u.Download(context.Background())
	if err != nil || st.Status != StatusReady {
		h.t.Fatalf("download: %+v %v", st, err)
	}
}

func TestVersionsCompareLikeSemver(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want int
	}{
		{"0.10.7", "0.11.0", -1}, {"0.11.0", "0.11.0", 0}, {"1.0.0", "0.99.99", 1},
		{"1.0.0-rc.1", "1.0.0", -1}, {"1.0.0-rc.2", "1.0.0-rc.10", -1}, {"1.0.0-alpha", "1.0.0-beta", -1},
		{"v1.2.3", "1.2.3", 0}, {"1.0.0-1", "1.0.0-alpha", -1}, {"1.0.0-rc", "1.0.0-rc.1", -1},
		{"99999999999999999999.0.0", "99999999999999999998.0.0", 1},
	} {
		got, err := CompareVersions(c.a, c.b)
		if err != nil || got != c.want {
			t.Errorf("CompareVersions(%q,%q) = %d, %v; want %d", c.a, c.b, got, err, c.want)
		}
	}
	if _, err := CompareVersions("nope", "1.0.0"); err == nil || !strings.Contains(err.Error(), "Invalid version") {
		t.Errorf("expected Invalid version, got %v", err)
	}
}

func TestOnlyGitHubReleaseHostsOverHTTPSAreAllowed(t *testing.T) {
	for url, want := range map[string]bool{
		"https://github.com/a/b/releases/download/v1/x.zip": true,
		"https://objects.githubusercontent.com/x":           true,
		"https://release-assets.githubusercontent.com/x":    true,
		"http://github.com/x":                               false,
		"https://evil.example/x":                            false,
		"https://user:pw@github.com/x":                      false,
		"not a url":                                         false,
	} {
		if got := AllowedURL(url); got != want {
			t.Errorf("AllowedURL(%q) = %v, want %v", url, got, want)
		}
	}
	bad := &Manifest{Version: "1.0.0", Assets: map[string]*manifestAsset{"win32-x64": {Name: "../x.zip", SHA256: strings.Repeat("a", 64), Size: float64(1)}}}
	if _, _, _, err := ValidateManifest(bad, "win32-x64"); err == nil || !strings.Contains(err.Error(), "invalid file") {
		t.Errorf("expected invalid file, got %v", err)
	}
	for _, tc := range []struct {
		a    manifestAsset
		want string
	}{
		{manifestAsset{"Rubban-1.0.0.zip", "xyz", float64(1)}, "invalid checksum"},
		{manifestAsset{"Rubban-1.0.0.zip", strings.Repeat("a", 64), float64(0)}, "invalid size"},
		{manifestAsset{"Rubban-1.0.0.zip", strings.Repeat("a", 64), float64(MaxDownload + 1)}, "invalid size"},
		{manifestAsset{"Rubban-1.0.0.zip", strings.Repeat("a", 64), 1.5}, "invalid size"},
	} {
		a := tc.a
		_, _, _, err := ValidateManifest(&Manifest{Version: "1.0.0", Assets: map[string]*manifestAsset{"k": &a}}, "k")
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%+v: got %v, want %s", tc.a, err, tc.want)
		}
	}
	long := &Manifest{Version: "v1.0.0", Notes: strings.Repeat("n", 30000)}
	v, asset, notes, err := ValidateManifest(long, "k")
	if err != nil || v != "1.0.0" || asset != nil || len(notes) != 20000 {
		t.Errorf("long notes: %q %v %d %v", v, asset, len(notes), err)
	}
	if _, _, _, err := ValidateManifest(&Manifest{Version: 5}, "k"); err == nil {
		t.Error("numeric version must be rejected")
	}
}

func TestNewerManifestMakesUpdateAvailableAndSameVersionIsUpToDate(t *testing.T) {
	h := setup(t, opts{})
	if st := h.u.Check(context.Background()); st.Status != StatusAvailable || st.Latest != "0.11.0" || st.Notes != "- better" {
		t.Fatalf("state %+v", st)
	}
	r := h.requests[0]
	if r.URL.String() != "https://github.com/HosHaggag/Rubban/releases/latest/download/latest.json" {
		t.Errorf("url %s", r.URL)
	}
	if ua := r.Header.Get("User-Agent"); !strings.HasPrefix(ua, "Rubban/") {
		t.Errorf("user agent %q", ua)
	}
	saved, _ := os.ReadFile(filepath.Join(h.dataDir, "update-state.json"))
	if !strings.Contains(string(saved), `"latest": "0.11.0"`) {
		t.Errorf("update-state.json: %s", saved)
	}
	same := setup(t, opts{version: "0.11.0"})
	if st := same.u.Check(context.Background()); st.Status != StatusUpToDate {
		t.Errorf("state %+v", st)
	}
	missing := setup(t, opts{platform: "darwin"})
	missing.u.cfg.Platform = "linux"
	missing.u.key = "linux-x64"
	if st := missing.u.Check(context.Background()); st.Status != StatusError || !strings.Contains(st.Error, "no download for linux-x64") {
		t.Errorf("state %+v", st)
	}
}

func TestDownloadVerifiesChecksum(t *testing.T) {
	good := setup(t, opts{})
	good.readyUpdate()
	if data, err := os.ReadFile(good.zipPath()); err != nil || string(data) != "zip-bytes" {
		t.Fatalf("zip: %q %v", data, err)
	}
	if _, err := os.Stat(good.zipPath() + ".part"); !os.IsNotExist(err) {
		t.Error("partial file left behind")
	}
	if !strings.HasSuffix(good.requests[1].URL.Path, "/releases/download/v0.11.0/Rubban-0.11.0-Windows-x64.zip") {
		t.Errorf("download url %s", good.requests[1].URL)
	}
	if st, _ := os.Stat(good.zipPath()); st.Mode().Perm()&0o077 != 0 && runtime.GOOS != "windows" {
		t.Errorf("mode %v", st.Mode())
	}

	bad := setup(t, opts{tamper: true})
	bad.u.Check(context.Background())
	st, err := bad.u.Download(context.Background())
	if err != nil || st.Status != StatusError || !strings.Contains(st.Error, "checksum") {
		t.Fatalf("state %+v %v", st, err)
	}
	if entries, _ := os.ReadDir(filepath.Join(bad.dataDir, "updates")); len(entries) != 0 {
		t.Errorf("updates not empty: %v", entries)
	}
}

func TestDownloadRejectsOversizeAndShortBodiesAndOtherFilesAreRemoved(t *testing.T) {
	h := setup(t, opts{})
	h.u.Check(context.Background())
	h.payload = append(h.payload, bytes.Repeat([]byte("y"), 2000)...) // longer than size+1024
	if st, _ := h.u.Download(context.Background()); !strings.Contains(st.Error, "larger than expected") {
		t.Errorf("state %+v", st)
	}
	h2 := setup(t, opts{})
	h2.u.Check(context.Background())
	h2.payload = h2.payload[:4]
	if st, _ := h2.u.Download(context.Background()); !strings.Contains(st.Error, "incomplete") {
		t.Errorf("state %+v", st)
	}
	h3 := setup(t, opts{})
	updates := filepath.Join(h3.dataDir, "updates")
	_ = os.MkdirAll(filepath.Join(updates, "old-dir"), 0o755)
	_ = os.WriteFile(filepath.Join(updates, "Rubban-0.9.0.zip"), []byte("old"), 0o600)
	_ = os.WriteFile(filepath.Join(updates, "result.json"), []byte("{}"), 0o600)
	h3.readyUpdate()
	var names []string
	entries, _ := os.ReadDir(updates)
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if strings.Join(names, ",") != h3.name+",result.json" {
		t.Errorf("updates contains %v", names)
	}
}

func TestDownloadFollowsGitHubRedirectsOnly(t *testing.T) {
	h := setup(t, opts{})
	h.redirect = "https://objects.githubusercontent.com/blob/abc"
	h.readyUpdate()
	if got := h.requests[len(h.requests)-1].URL.Host; got != "objects.githubusercontent.com" {
		t.Errorf("last host %s", got)
	}
	evil := setup(t, opts{})
	evil.redirect = "https://evil.example/x.zip"
	evil.u.Check(context.Background())
	st, _ := evil.u.Download(context.Background())
	if st.Status != StatusError || !strings.Contains(st.Error, "Blocked download from evil.example") {
		t.Errorf("state %+v", st)
	}
	for _, r := range evil.requests {
		if r.URL.Host == "evil.example" {
			t.Error("request reached the blocked host")
		}
	}
}

func TestInstallHandsOverToDetachedHelperAndQuits(t *testing.T) {
	no := false
	source := setup(t, opts{packaged: &no})
	if st := source.u.Check(context.Background()); !st.Disabled {
		t.Error("source runs must be disabled")
	}
	if _, err := source.u.Install(); err == nil || !strings.Contains(err.Error(), "disabled") {
		t.Errorf("install: %v", err)
	}
	if _, err := source.u.Download(context.Background()); err == nil {
		t.Error("download must be refused")
	}
	if len(source.requests) != 0 {
		t.Error("a disabled updater must not touch the network")
	}
	envOff := setup(t, opts{env: map[string]string{"RUBBAN_DISABLE_UPDATES": "1"}})
	if !envOff.u.State().Disabled {
		t.Error("RUBBAN_DISABLE_UPDATES=1 must disable")
	}

	ready := setup(t, opts{})
	if _, err := ready.u.Install(); err == nil || !strings.Contains(err.Error(), "not been downloaded") {
		t.Errorf("install: %v", err)
	}
	ready.readyUpdate()
	if _, err := ready.u.Install(); err != nil {
		t.Fatal(err)
	}
	if ready.quit != 1 || len(ready.spawned) != 1 {
		t.Fatalf("quit=%d spawned=%d", ready.quit, len(ready.spawned))
	}
	call := ready.spawned[0]
	if !strings.HasSuffix(call[0], "powershell.exe") {
		t.Errorf("command %s", call[0])
	}
	args := strings.Join(call[1:], "|")
	for _, want := range []string{"-NoProfile|-ExecutionPolicy|Bypass|-WindowStyle|Hidden|-File", "-Zip|" + ready.zipPath(), "-Install|" + filepath.Dir(ready.u.cfg.ExecPath), "-ProcessId|4242", "-Exe|" + ready.u.cfg.ExecPath, "-Version|0.11.0"} {
		if !strings.Contains(args, want) {
			t.Errorf("args %s missing %s", args, want)
		}
	}
	if _, err := os.Stat(filepath.Join(ready.dataDir, "updates", "apply-update.ps1")); err != nil {
		t.Error("helper script not copied")
	}
	if ready.u.State().Status != StatusInstalling {
		t.Errorf("status %s", ready.u.State().Status)
	}
}

func TestInstallOnMacRunsBashWithBundleRoot(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("macOS path layout")
	}
	h := setup(t, opts{platform: "darwin", exec: "/Applications/Rubban.app/Contents/MacOS/Rubban"})
	h.readyUpdate()
	if _, err := h.u.Install(); err != nil {
		t.Fatal(err)
	}
	want := []string{"/bin/bash", filepath.Join(h.dataDir, "updates", "apply-update.sh"), h.zipPath(), "/Applications/Rubban.app", "4242", filepath.Join(h.dataDir, "updates", "result.json"), "0.11.0"}
	if strings.Join(h.spawned[0], "|") != strings.Join(want, "|") {
		t.Errorf("spawned %v\nwant %v", h.spawned[0], want)
	}
	if runtime.GOOS != "windows" {
		if st, _ := os.Stat(want[1]); st.Mode().Perm() != 0o755 {
			t.Errorf("script mode %v", st.Mode())
		}
	}
}

func TestInstallRefusesVolumesAndTempAndStartFailureKeepsReady(t *testing.T) {
	vol := setup(t, opts{platform: "darwin", exec: "/Volumes/Rubban/Rubban.app/Contents/MacOS/Rubban"})
	vol.readyUpdate()
	if _, err := vol.u.Install(); err == nil || !strings.Contains(err.Error(), "mounted disk") {
		t.Errorf("install: %v", err)
	}
	if vol.quit != 0 || len(vol.spawned) != 0 {
		t.Error("must not spawn or quit")
	}

	h := setup(t, opts{})
	h.readyUpdate()
	h.u.cfg.Spawn = func(string, []string) error { return errors.New("no powershell") }
	if _, err := h.u.Install(); err == nil || !strings.Contains(err.Error(), "could not be started") {
		t.Errorf("install: %v", err)
	}
	if h.quit != 0 || h.u.State().Status != StatusReady {
		t.Errorf("quit=%d status=%s", h.quit, h.u.State().Status)
	}
}

// A4: both sides of the temp-folder comparison go through EvalSymlinks (macOS /var vs /private/var).
func TestInstallComparesResolvedPathsA4(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	root := t.TempDir()
	real := filepath.Join(root, "real")
	link := filepath.Join(root, "link")
	if err := os.MkdirAll(filepath.Join(real, "app"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(real, "app", "Rubban") // does not need to exist
	for name, c := range map[string]struct{ exec, temp string }{
		"exe real, temp via link": {exe, link},
		"exe via link, temp real": {filepath.Join(link, "app", "Rubban"), real},
		"both via link":           {filepath.Join(link, "app", "Rubban"), link},
	} {
		h := setup(t, opts{platform: "linux", exec: c.exec, tempDir: c.temp})
		h.readyUpdate()
		if _, err := h.u.Install(); err == nil || !strings.Contains(err.Error(), "temporary folder") {
			t.Errorf("%s: expected refusal, got %v", name, err)
		}
	}
	// A sibling whose name merely starts with the temp folder's name is not "inside" it.
	h := setup(t, opts{platform: "linux", exec: filepath.Join(root, "real-sibling", "a", "b", "Rubban"), tempDir: real})
	h.readyUpdate()
	if _, err := h.u.Install(); err != nil {
		t.Errorf("sibling folder refused: %v", err)
	}
}

// A3: a zip that changed on disk since it was verified is never reported as ready or installed.
func TestZipIsRehashedBeforeReadyAndInstallA3(t *testing.T) {
	h := setup(t, opts{})
	h.readyUpdate()
	// Same size, different content.
	if err := os.WriteFile(h.zipPath(), bytes.Repeat([]byte("Z"), len(h.payload)), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := h.u.Install()
	if err == nil || !strings.Contains(err.Error(), "failed verification") {
		t.Fatalf("install: %v", err)
	}
	if h.quit != 0 || len(h.spawned) != 0 {
		t.Error("tampered zip must not be installed")
	}
	if _, statErr := os.Stat(h.zipPath()); !os.IsNotExist(statErr) {
		t.Error("tampered zip should be deleted")
	}
	if st := h.u.State(); st.Status != StatusAvailable {
		t.Errorf("status %s", st.Status)
	}

	// check(): an existing but wrong file means "available", and a good file means "ready".
	h2 := setup(t, opts{})
	_ = os.MkdirAll(filepath.Join(h2.dataDir, "updates"), 0o755)
	_ = os.WriteFile(h2.zipPath(), []byte("planted"), 0o600)
	if st := h2.u.Check(context.Background()); st.Status != StatusAvailable || st.Progress != 0 {
		t.Errorf("planted file: %+v", st)
	}
	if _, err := os.Stat(h2.zipPath()); !os.IsNotExist(err) {
		t.Error("planted zip should be deleted")
	}
	h3 := setup(t, opts{})
	_ = os.MkdirAll(filepath.Join(h3.dataDir, "updates"), 0o755)
	_ = os.WriteFile(h3.zipPath(), h3.payload, 0o600)
	if st := h3.u.Check(context.Background()); st.Status != StatusReady || st.Progress != 1 {
		t.Errorf("verified file: %+v", st)
	}
}

// A22: a failed periodic check keeps `ready` while the verified zip is on disk.
func TestFailedCheckKeepsReadyA22(t *testing.T) {
	h := setup(t, opts{})
	h.readyUpdate()
	h.failCheck = true
	st := h.u.Check(context.Background())
	if st.Status != StatusReady || st.Error != "" || !strings.Contains(st.CheckError, "500") {
		t.Fatalf("state %+v", st)
	}
	if _, err := h.u.Install(); err != nil {
		t.Errorf("install after failed check: %v", err)
	}
	// Without a ready download the failure is a normal error.
	plain := setup(t, opts{})
	plain.failCheck = true
	if st := plain.u.Check(context.Background()); st.Status != StatusError || !strings.Contains(st.Error, "500") {
		t.Errorf("state %+v", st)
	}
	// If the zip is gone the error shows.
	gone := setup(t, opts{})
	gone.readyUpdate()
	_ = os.Remove(gone.zipPath())
	gone.failCheck = true
	if st := gone.u.Check(context.Background()); st.Status != StatusError {
		t.Errorf("state %+v", st)
	}
}

// A25: progress is emitted only when the whole percentage changes.
func TestProgressEmittedOnWholePercentChangesA25(t *testing.T) {
	payload := bytes.Repeat([]byte("p"), 100000)
	h := setup(t, opts{payload: payload})
	h.chunk = 10 // 10000 reads
	h.u.Check(context.Background())
	h.mu.Lock()
	h.states = nil
	h.mu.Unlock()
	if st, err := h.u.Download(context.Background()); err != nil || st.Status != StatusReady {
		t.Fatalf("%+v %v", st, err)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	last := -1
	downloading := 0
	for _, s := range h.states {
		if s.Status != StatusDownloading {
			continue
		}
		downloading++
		pct := int(s.Progress*100 + 0.5)
		if pct <= last && downloading > 1 {
			t.Fatalf("percentage did not advance: %d after %d", pct, last)
		}
		last = pct
	}
	if downloading > 101 || downloading < 50 {
		t.Errorf("%d downloading emissions for 10000 chunks", downloading)
	}
	if last != 99 {
		t.Errorf("last progress %d%%", last)
	}
}

func TestResultLeftByHelperIsReportedOnce(t *testing.T) {
	h := setup(t, opts{})
	updates := filepath.Join(h.dataDir, "updates")
	_ = os.MkdirAll(updates, 0o755)
	_ = os.WriteFile(filepath.Join(updates, "result.json"), append([]byte("\xef\xbb\xbf"), `{"ok":true,"version":"0.11.0"}`...), 0o600)
	h.u.Start()
	h.u.Stop()
	want := Result{OK: true, Version: "0.11.0"}
	if got := h.u.State().Result; got == nil || *got != want {
		t.Errorf("result %+v", got)
	}
	if _, err := os.Stat(filepath.Join(updates, "result.json")); !os.IsNotExist(err) {
		t.Error("result.json should be deleted")
	}
	h.u.DismissResult()
	if h.u.State().Result != nil {
		t.Error("dismiss should clear the result")
	}
	failed := setup(t, opts{})
	_ = os.MkdirAll(filepath.Join(failed.dataDir, "updates"), 0o755)
	_ = os.WriteFile(filepath.Join(failed.dataDir, "updates", "result.json"), []byte(`{"ok":false,"version":"0.11.1","error":"boom","installedTo":"/x"}`), 0o600)
	failed.u.Start()
	failed.u.Stop()
	if got := failed.u.State().Result; got == nil || got.OK || got.Error != "boom" || got.InstalledTo != "/x" {
		t.Errorf("result %+v", got)
	}
}

func TestStartSchedulesChecksHonouringPreferences(t *testing.T) {
	h := setup(t, opts{})
	_ = os.WriteFile(filepath.Join(h.dataDir, "update-state.json"), []byte(`{"lastCheck":"2026-01-01T00:00:00.000Z"}`), 0o600)
	h.u.Start()
	if got := h.u.State().LastCheck; got != "2026-01-01T00:00:00.000Z" {
		t.Errorf("lastCheck %q", got)
	}
	if len(h.timers) != 2 || h.timers[0].d != 20*time.Second || h.timers[1].d != 6*time.Hour {
		t.Fatalf("timers %+v", h.timers)
	}
	h.timers[0].f()
	if st := h.u.State(); st.Status != StatusAvailable {
		t.Errorf("first check: %+v", st)
	}
	n := len(h.requests)
	h.prefs = map[string]any{"updates": map[string]any{"auto": false}}
	h.timers[1].f() // interval tick re-arms and runs, but auto is off
	if len(h.requests) != n {
		t.Error("auto=false must skip the check")
	}
	if len(h.timers) != 3 || h.timers[2].d != 6*time.Hour {
		t.Errorf("interval was not re-armed: %+v", h.timers)
	}
	h.u.Stop()
	for i, tm := range h.timers {
		if !*tm.stopped {
			t.Errorf("timer %d not stopped", i)
		}
	}

	no := false
	off := setup(t, opts{packaged: &no})
	off.u.Start()
	if len(off.timers) != 0 {
		t.Error("a disabled updater must not schedule checks")
	}
}

func TestCheckIsSkippedWhileBusyOrDownloading(t *testing.T) {
	h := setup(t, opts{})
	h.u.Check(context.Background())
	h.u.update(func(s *State) { s.Status = StatusDownloading })
	n := len(h.requests)
	if st := h.u.Check(context.Background()); st.Status != StatusDownloading || len(h.requests) != n {
		t.Errorf("state %+v", st)
	}
}

// ---- Helper scripts ----------------------------------------------------------------------------

func writeZip(t *testing.T, path string, files map[string]string) {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(content))
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

func fakeBuild(t *testing.T, root, label string) {
	t.Helper()
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "marker.txt"), []byte(label), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func writeScript(t *testing.T, platform string) string {
	t.Helper()
	name, data := Script(platform)
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, data, 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func runSh(t *testing.T, script, home string, args ...string) (string, error) {
	t.Helper()
	cmd := exec.Command("bash", append([]string{script}, args...)...)
	cmd.Env = append(os.Environ(), "HOME="+home, "RUBBAN_NO_START=1")
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func needShell(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("apply-update.sh is for macOS")
	}
	for _, bin := range []string{"bash", "unzip", "sed", "tr"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skipf("%s is not available", bin)
		}
	}
}

func TestApplyUpdateShReplacesBundleAndWritesResult(t *testing.T) {
	needShell(t)
	work, home := t.TempDir(), t.TempDir()
	script := writeScript(t, "darwin")
	bundle := filepath.Join(work, "apps", "Rubban.app")
	fakeBuild(t, bundle, "old")
	updates := filepath.Join(work, "updates")
	_ = os.MkdirAll(updates, 0o755)
	zipPath := filepath.Join(updates, "Rubban-0.11.0-macOS-arm64.zip")
	writeZip(t, zipPath, map[string]string{"Rubban-0.11.0-macOS-arm64/Rubban.app/marker.txt": "new"})
	result := filepath.Join(updates, "result.json")
	if out, err := runSh(t, script, home, zipPath, bundle, "999999", result, "0.11.0"); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if got := readFile(t, filepath.Join(bundle, "marker.txt")); got != "new" {
		t.Errorf("marker %q", got)
	}
	if _, err := os.Stat(bundle + ".old"); !os.IsNotExist(err) {
		t.Error("backup left behind")
	}
	var report Result
	if err := json.Unmarshal([]byte(readFile(t, result)), &report); err != nil {
		t.Fatal(err)
	}
	if want := (Result{OK: true, Version: "0.11.0", InstalledTo: bundle}); report != want {
		t.Errorf("report %+v, want %+v", report, want)
	}
	// A zip that is not a zip leaves the old version and reports the error.
	_ = os.WriteFile(zipPath, []byte("not a zip"), 0o644)
	if out, err := runSh(t, script, home, zipPath, bundle, "999999", result, "0.11.1"); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	_ = json.Unmarshal([]byte(readFile(t, result)), &report)
	if report.OK || report.Error == "" {
		t.Errorf("report %+v", report)
	}
	if got := readFile(t, filepath.Join(bundle, "marker.txt")); got != "new" {
		t.Errorf("marker %q", got)
	}
}

// A5: installedTo (and version) are escaped like the message, so result.json stays valid JSON.
func TestApplyUpdateShEscapesInstalledToA5(t *testing.T) {
	needShell(t)
	work, home := t.TempDir(), t.TempDir()
	script := writeScript(t, "darwin")
	bundle := filepath.Join(work, `we"ird\dir`, "Rubban.app")
	fakeBuild(t, bundle, "old")
	updates := filepath.Join(work, "updates")
	_ = os.MkdirAll(updates, 0o755)
	zipPath := filepath.Join(updates, "Rubban-0.11.0-macOS-arm64.zip")
	writeZip(t, zipPath, map[string]string{"Rubban.app/marker.txt": "new"})
	result := filepath.Join(updates, "result.json")
	if out, err := runSh(t, script, home, zipPath, bundle, "999999", result, `0.11.0"x`); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	var report Result
	if err := json.Unmarshal([]byte(readFile(t, result)), &report); err != nil {
		t.Fatalf("result.json is not valid JSON: %v\n%s", err, readFile(t, result))
	}
	if !report.OK || report.InstalledTo != bundle || report.Version != `0.11.0"x` {
		t.Errorf("report %+v", report)
	}
	// And on the failure path with the same awkward path.
	_ = os.WriteFile(zipPath, []byte("not a zip"), 0o644)
	if out, err := runSh(t, script, home, zipPath, bundle, "999999", result, "0.11.1"); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if err := json.Unmarshal([]byte(readFile(t, result)), &report); err != nil || report.OK || report.InstalledTo != bundle {
		t.Errorf("failure report %+v err=%v", report, err)
	}
}

// The real installer also writes Start menu shortcuts, so the test zip carries a stub installer with the same parameters.
func TestApplyUpdatePs1ReplacesInstallFolderAndRestoresOnFailure(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("apply-update.ps1 runs on Windows only")
	}
	if _, err := exec.LookPath("powershell.exe"); err != nil {
		t.Skip("powershell.exe is not available")
	}
	script := writeScript(t, "win32")
	work := t.TempDir()
	stub := func(fail bool) string {
		body := "Remove-Item (Join-Path $Destination '*') -Recurse -Force; Get-ChildItem $Source | Where-Object { $_.Name -ne 'Install-Rubban.ps1' } | Copy-Item -Destination $Destination -Recurse -Force"
		if fail {
			body = "throw 'installer failed'"
		}
		return "param([string]$Source, [string]$Destination, [switch]$NoStart)\n" + body + "\n"
	}
	attempt := func(label string, fail bool) (string, Result) {
		install := filepath.Join(work, label, "Rubban-Windows")
		fakeBuild(t, install, "old")
		_ = os.WriteFile(filepath.Join(install, "Rubban.exe"), []byte("exe-old"), 0o644)
		updates := filepath.Join(work, label, "updates")
		_ = os.MkdirAll(updates, 0o755)
		zipPath := filepath.Join(updates, "Rubban-0.11.0-Windows-x64.zip")
		writeZip(t, zipPath, map[string]string{
			"Rubban-0.11.0-Windows-x64/marker.txt":         "new",
			"Rubban-0.11.0-Windows-x64/Rubban.exe":         "exe-new",
			"Rubban-0.11.0-Windows-x64/Install-Rubban.ps1": stub(fail),
		})
		result := filepath.Join(updates, "result.json")
		cmd := exec.Command("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Zip", zipPath, "-Install", install, "-ProcessId", "999999", "-Exe", filepath.Join(install, "Rubban.exe"), "-ResultFile", result, "-Version", "0.11.0", "-NoStart")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v: %s", err, out)
		}
		var report Result
		if err := json.Unmarshal([]byte(strings.TrimPrefix(readFile(t, result), "\xef\xbb\xbf")), &report); err != nil {
			t.Fatal(err)
		}
		return install, report
	}
	install, report := attempt("good", false)
	if !report.OK || readFile(t, filepath.Join(install, "marker.txt")) != "new" {
		t.Errorf("good: %+v", report)
	}
	install, report = attempt("bad", true)
	if report.OK || !regexp.MustCompile(`installer failed`).MatchString(report.Error) {
		t.Errorf("bad: %+v", report)
	}
	if readFile(t, filepath.Join(install, "marker.txt")) != "old" || readFile(t, filepath.Join(install, "Rubban.exe")) != "exe-old" {
		t.Error("previous version was not restored")
	}
}
