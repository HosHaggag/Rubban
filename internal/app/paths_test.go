package app

import (
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestDataDir(t *testing.T) {
	root := t.TempDir()
	win := filepath.Join(root, "Rubban", "Rubban-Windows")
	_ = os.MkdirAll(win, 0o755)
	exe := filepath.Join(win, "Rubban.exe")
	_ = os.WriteFile(filepath.Join(win, "VERSION"), []byte("0.12.0\n"), 0o644)
	if got := DataDir(exe, "windows", "", "", env(nil)); got != filepath.Join(root, "Rubban", "Rubban-Data") {
		t.Fatalf("packaged windows: %s", got)
	}
	if got := DataDir(exe, "windows", "", "", env(map[string]string{"RUBBAN_DATA_DIR": "/x"})); got != "/x" {
		t.Fatalf("override: %s", got)
	}
	app := filepath.Join(root, "Rubban.app", "Contents", "MacOS")
	_ = os.MkdirAll(filepath.Join(root, "Rubban.app", "Contents", "Resources"), 0o755)
	_ = os.MkdirAll(app, 0o755)
	_ = os.WriteFile(filepath.Join(root, "Rubban.app", "Contents", "Resources", "VERSION"), []byte("0.12.0\n"), 0o644)
	if got := DataDir(filepath.Join(app, "Rubban"), "darwin", "/Users/me", "", env(nil)); got != "/Users/me/Library/Application Support/Rubban" {
		t.Fatalf("packaged mac: %s", got)
	}
	if got := DataDir("/tmp/go-build/exe/rubban", "linux", "/h", "/repo", env(nil)); got != "/repo/data" {
		t.Fatalf("dev: %s", got)
	}
	if got := AppRoot(filepath.Join(app, "Rubban"), "darwin"); !strings.HasSuffix(filepath.Clean(got), filepath.Join("Contents", "Resources")) {
		t.Fatalf("mac root %s", got)
	}
}

func TestBundledTool(t *testing.T) {
	dir := t.TempDir()
	_ = os.MkdirAll(filepath.Join(dir, "tools"), 0o755)
	if BundledTool(dir, "kubectl", "windows") != "" {
		t.Fatal("found a tool that is not there")
	}
	_ = os.WriteFile(filepath.Join(dir, "tools", "kubectl.exe"), []byte("x"), 0o755)
	if BundledTool(dir, "kubectl", "windows") == "" || BundledTool(dir, "kubectl", "darwin") != "" {
		t.Fatal("tool lookup")
	}
}

func TestPersistedPort(t *testing.T) {
	dir := t.TempDir()
	if PreferredPort(dir) != 0 {
		t.Fatal("no port file")
	}
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	port := ln.Addr().(*net.TCPAddr).Port
	WritePort(dir, port)
	if ReadPort(dir) != port {
		t.Fatal("read back")
	}
	if PreferredPort(dir) != 0 {
		t.Fatal("a busy port must not be preferred")
	}
	ln.Close()
	if PreferredPort(dir) != port {
		t.Fatal("a free persisted port should be reused")
	}
	_ = os.WriteFile(filepath.Join(dir, "port"), []byte("80\n"), 0o644)
	if ReadPort(dir) != 0 {
		t.Fatal("privileged ports are ignored")
	}
}

func TestBridgeScript(t *testing.T) {
	out := string(BridgeScript([]byte("p='__RUBBAN_PLATFORM__';s='__RUBBAN_SMOKE__'==='true'"), "windows", true))
	if out != "p='win32';s='true'==='true'" {
		t.Fatal(out)
	}
}

func TestUpdateMessage(t *testing.T) {
	cases := map[string]UpdateSummary{
		"Updates are turned off in this build.":                               {Disabled: true},
		"Could not check for updates: offline":                                {Status: "error", Error: "offline"},
		"You have the latest version (0.12.0).":                               {Status: "up-to-date", Current: "0.12.0"},
		"Version 0.13.0 is available. Open Settings › Updates to install it.": {Status: "downloading", Latest: "0.13.0"},
		"Rubban is still checking for updates. Try again in a moment.":        {Status: "checking"},
	}
	for want, s := range cases {
		if got := UpdateMessage(s); got != want {
			t.Errorf("%+v: %q want %q", s, got, want)
		}
	}
}
