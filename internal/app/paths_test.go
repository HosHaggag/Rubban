package app

import (
	"encoding/json"
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

// installedLayout makes <root>/Programs/Rubban with Rubban.exe, VERSION and installed.json.
func installedLayout(t *testing.T, root, marker string) string {
	t.Helper()
	dir := filepath.Join(root, "Programs", "Rubban")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(dir, "VERSION"), []byte("0.13.0\n"), 0o644)
	if marker != "" {
		_ = os.WriteFile(filepath.Join(dir, "installed.json"), []byte(marker), 0o644)
	}
	return filepath.Join(dir, "Rubban.exe")
}

func TestDataDirOfAnInstalledBuild(t *testing.T) {
	root := t.TempDir()
	exe := installedLayout(t, root, `{"installer":"inno","version":"0.13.0"}`)
	local := filepath.Join(root, "Local")
	if !Installed(exe) {
		t.Fatal("installed.json marks an installed build")
	}
	if got := DataDir(exe, "windows", "", "", env(map[string]string{"LOCALAPPDATA": local})); got != filepath.Join(local, "Rubban") {
		t.Fatalf("installed: %s", got)
	}
	if got := DataDir(exe, "windows", "", "", env(map[string]string{"LOCALAPPDATA": local, "RUBBAN_DATA_DIR": "/x"})); got != "/x" {
		t.Fatalf("RUBBAN_DATA_DIR wins: %s", got)
	}
	// No LOCALAPPDATA: fall back to the portable layout rather than a relative path.
	if got := DataDir(exe, "windows", "", "", env(nil)); got != filepath.Join(root, "Programs", "Rubban-Data") {
		t.Fatalf("without LOCALAPPDATA: %s", got)
	}
	portable := installedLayout(t, filepath.Join(root, "zip"), "")
	if Installed(portable) {
		t.Fatal("a zip has no marker")
	}
	if got := DataDir(portable, "windows", "", "", env(map[string]string{"LOCALAPPDATA": local})); got != filepath.Join(root, "zip", "Programs", "Rubban-Data") {
		t.Fatalf("portable keeps the folder beside the zip: %s", got)
	}
	// A damaged marker still means installed.
	damaged := installedLayout(t, filepath.Join(root, "damaged"), "{not json")
	if !Installed(damaged) || DataDir(damaged, "windows", "", "", env(map[string]string{"LOCALAPPDATA": local})) != filepath.Join(local, "Rubban") {
		t.Fatal("damaged marker")
	}
}

func writeSettings(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, "kubeconfigs"), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{
		"preferences.json":           `{"theme":"dark"}`,
		"port":                       "54321\n",
		"kubeconfigs/index.json":     `[]`,
		"kubeconfigs/abc.kubeconfig": "apiVersion: v1\n",
		"updates/Rubban-0.12.0.zip":  "big",
		"logs/rubban.log":            "{}",
	} {
		p := filepath.Join(dir, filepath.FromSlash(name))
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestMigrateDataCopiesSettingsOnceAndLeavesTheSource(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "home")
	old := filepath.Join(home, "Rubban", "Rubban-Data")
	writeSettings(t, old)
	exe := installedLayout(t, root, "{}")
	data := filepath.Join(root, "Local", "Rubban")

	from, err := MigrateData(exe, data, home)
	if err != nil || from != old {
		t.Fatalf("from %q, %v", from, err)
	}
	for _, name := range []string{"preferences.json", "port", "kubeconfigs/index.json", "kubeconfigs/abc.kubeconfig", "migrated-from.txt"} {
		if _, err := os.Stat(filepath.Join(data, filepath.FromSlash(name))); err != nil {
			t.Errorf("%s was not copied: %v", name, err)
		}
	}
	for _, name := range []string{"updates", "logs"} {
		if _, err := os.Stat(filepath.Join(data, name)); err == nil {
			t.Errorf("%s must not be copied", name)
		}
	}
	if note, _ := os.ReadFile(filepath.Join(data, "migrated-from.txt")); strings.TrimSpace(string(note)) != old {
		t.Errorf("note %q", note)
	}
	if _, err := os.Stat(filepath.Join(old, "preferences.json")); err != nil {
		t.Fatal("the source must stay in place")
	}

	// The new folder now has settings: a second launch copies nothing, even over changed prefs.
	_ = os.WriteFile(filepath.Join(data, "preferences.json"), []byte(`{"theme":"light"}`), 0o600)
	if from, err := MigrateData(exe, data, home); err != nil || from != "" {
		t.Fatalf("second run %q %v", from, err)
	}
	if got, _ := os.ReadFile(filepath.Join(data, "preferences.json")); string(got) != `{"theme":"light"}` {
		t.Fatalf("settings overwritten: %s", got)
	}
}

func TestMigrateDataSourcesAndGuards(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "home")
	downloads := filepath.Join(root, "Downloads", "Rubban-Data")
	writeSettings(t, downloads)
	marker := `{"installer":"inno","version":"0.13.0","migratedFrom":` + strconvQuote(downloads) + `}`
	exe := installedLayout(t, root, marker)

	// Only the recorded folder exists: it is used.
	data := filepath.Join(root, "Local", "Rubban")
	if from, err := MigrateData(exe, data, home); err != nil || from != downloads {
		t.Fatalf("recorded folder: %q %v", from, err)
	}
	// When both exist the Install-Rubban.ps1 folder comes first.
	old := filepath.Join(home, "Rubban", "Rubban-Data")
	writeSettings(t, old)
	data2 := filepath.Join(root, "Local2", "Rubban")
	if from, _ := MigrateData(exe, data2, home); from != old {
		t.Fatalf("order: %q", from)
	}
	// A portable build, or a folder without settings, copies nothing.
	portable := installedLayout(t, filepath.Join(root, "zip"), "")
	if from, _ := MigrateData(portable, filepath.Join(root, "Local3"), home); from != "" {
		t.Fatalf("portable: %q", from)
	}
	empty := filepath.Join(root, "empty")
	_ = os.MkdirAll(empty, 0o755)
	exe2 := installedLayout(t, filepath.Join(root, "other"), `{"migratedFrom":`+strconvQuote(empty)+`}`)
	if from, _ := MigrateData(exe2, filepath.Join(root, "Local4"), filepath.Join(root, "nohome")); from != "" {
		t.Fatalf("no settings to copy: %q", from)
	}
	// The data folder is never its own source.
	if from, _ := MigrateData(exe, downloads, home); from != "" {
		t.Fatalf("self: %q", from)
	}
}

func strconvQuote(s string) string { b, _ := json.Marshal(s); return string(b) }
