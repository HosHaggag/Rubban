// Package app is the Rubban desktop shell. The window code needs Wails and is built with -tags
// desktop; the helpers in this file are plain Go so they can be tested everywhere.
package app

import (
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// installedMarker is written next to Rubban.exe by the Windows installer.
const installedMarker = "installed.json"

// installedInfo is the content of installed.json.
type installedInfo struct {
	Installer    string `json:"installer"`
	Version      string `json:"version"`
	MigratedFrom string `json:"migratedFrom"`
}

func readInstalled(exe string) (installedInfo, bool) {
	data, err := os.ReadFile(filepath.Join(filepath.Dir(exe), installedMarker))
	if err != nil {
		return installedInfo{}, false
	}
	var info installedInfo
	_ = json.Unmarshal(data, &info) // a damaged marker still means "installed"
	return info, true
}

// Installed reports whether the executable was put in place by the Windows installer.
func Installed(exe string) bool {
	_, ok := readInstalled(exe)
	return ok
}

// Packaged reports whether the executable sits in a release layout: a VERSION file next to it
// (Windows) or in Contents/Resources (macOS).
func Packaged(exe string) bool {
	dir := filepath.Dir(exe)
	if _, err := os.Stat(filepath.Join(dir, "VERSION")); err == nil {
		return true
	}
	if _, err := os.Stat(filepath.Join(dir, "..", "Resources", "VERSION")); err == nil {
		return true
	}
	return false
}

// AppRoot is where bundled files live: the exe folder on Windows, Contents/Resources on macOS.
func AppRoot(exe, goos string) string {
	dir := filepath.Dir(exe)
	if goos == "darwin" {
		return filepath.Join(dir, "..", "Resources")
	}
	return dir
}

// DataDir resolves the data folder: RUBBAN_DATA_DIR; %LOCALAPPDATA%\Rubban for a Windows build put
// in place by the installer (Local, not Roaming: it holds kubeconfig copies and logs); the folder
// beside the extracted zip (Windows portable) or Application Support (macOS); ./data from source.
func DataDir(exe, goos, home, cwd string, env func(string) string) string {
	if d := env("RUBBAN_DATA_DIR"); d != "" {
		return d
	}
	if goos == "windows" && Installed(exe) {
		if local := env("LOCALAPPDATA"); local != "" {
			return filepath.Join(local, "Rubban")
		}
	}
	if Packaged(exe) {
		if goos == "darwin" {
			return filepath.Join(home, "Library", "Application Support", "Rubban")
		}
		return filepath.Join(filepath.Dir(filepath.Dir(exe)), "Rubban-Data")
	}
	return filepath.Join(cwd, "data")
}

// BundledTool returns <appRoot>/tools/<name>[.exe] when it exists, else "".
func BundledTool(appRoot, name, goos string) string {
	if goos == "windows" {
		name += ".exe"
	}
	p := filepath.Join(appRoot, "tools", name)
	if st, err := os.Stat(p); err == nil && st.Mode().IsRegular() {
		return p
	}
	return ""
}

// ReadPort returns the persisted loopback port, or 0.
func ReadPort(dataDir string) int {
	data, err := os.ReadFile(filepath.Join(dataDir, "port"))
	if err != nil {
		return 0
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || n < 1024 || n > 65535 {
		return 0
	}
	return n
}

// WritePort remembers the port so the page keeps one origin (and its localStorage) across launches.
func WritePort(dataDir string, port int) {
	_ = os.MkdirAll(dataDir, 0o755)
	_ = os.WriteFile(filepath.Join(dataDir, "port"), []byte(strconv.Itoa(port)+"\n"), 0o644)
}

// PortFree reports whether 127.0.0.1:port can be bound right now.
func PortFree(port int) bool {
	ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		return false
	}
	_ = ln.Close()
	return true
}

// PreferredPort is the persisted port when it is still free, else 0 (let the system choose).
func PreferredPort(dataDir string) int {
	if p := ReadPort(dataDir); p != 0 && PortFree(p) {
		return p
	}
	return 0
}

// NodePlatform maps GOOS to the names the UI and the update manifest use.
func NodePlatform(goos string) string {
	if goos == "windows" {
		return "win32"
	}
	return goos
}

// BridgeScript fills the placeholders in ui/desktop-bridge.js.
func BridgeScript(source []byte, goos string, smoke bool) []byte {
	out := strings.ReplaceAll(string(source), "__RUBBAN_PLATFORM__", NodePlatform(goos))
	out = strings.ReplaceAll(out, "__RUBBAN_SMOKE__", strconv.FormatBool(smoke))
	return []byte(out)
}

// migrationSources lists, in order, the folders an installed build looks in for settings from an
// earlier layout: the Install-Rubban.ps1 data folder, and the Rubban-Data next to the place the
// installer was started from (recorded in installed.json as migratedFrom).
func migrationSources(exe, home string) []string {
	var out []string
	if home != "" {
		out = append(out, filepath.Join(home, "Rubban", "Rubban-Data"))
	}
	if info, ok := readInstalled(exe); ok && info.MigratedFrom != "" {
		out = append(out, info.MigratedFrom)
	}
	return out
}

func isDir(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

func hasSettings(dir string) bool {
	for _, name := range []string{"preferences.json", filepath.Join("kubeconfigs", "index.json")} {
		if st, err := os.Stat(filepath.Join(dir, name)); err == nil && !st.IsDir() {
			return true
		}
	}
	return false
}

// MigrateData copies settings from an earlier data folder into the data folder of a build put in
// place by the installer. It does nothing when the build was not installed or the new folder already
// has settings, never moves or deletes anything, skips the updates folder, and returns the folder it
// copied from ("" when it copied nothing).
func MigrateData(exe, dataDir, home string) (string, error) {
	if !Installed(exe) || hasSettings(dataDir) {
		return "", nil
	}
	for _, source := range migrationSources(exe, home) {
		if filepath.Clean(source) == filepath.Clean(dataDir) || !isDir(source) || !hasSettings(source) {
			continue
		}
		if err := os.MkdirAll(dataDir, 0o700); err != nil {
			return "", err
		}
		for _, name := range []string{"preferences.json", "forwards.json", "port"} {
			if err := copyIfPresent(filepath.Join(source, name), filepath.Join(dataDir, name)); err != nil {
				return "", err
			}
		}
		if err := copyTree(filepath.Join(source, "kubeconfigs"), filepath.Join(dataDir, "kubeconfigs")); err != nil {
			return "", err
		}
		if err := os.WriteFile(filepath.Join(dataDir, "migrated-from.txt"), []byte(source+"\n"), 0o600); err != nil {
			return "", err
		}
		return source, nil
	}
	return "", nil
}

func copyIfPresent(from, to string) error {
	in, err := os.Open(from)
	if err != nil {
		return nil
	}
	defer in.Close()
	out, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func copyTree(from, to string) error {
	if !isDir(from) {
		return nil
	}
	if err := os.MkdirAll(to, 0o700); err != nil {
		return err
	}
	entries, err := os.ReadDir(from)
	if err != nil {
		return err
	}
	for _, e := range entries {
		src, dst := filepath.Join(from, e.Name()), filepath.Join(to, e.Name())
		if e.IsDir() {
			if err := copyTree(src, dst); err != nil {
				return err
			}
		} else if e.Type().IsRegular() {
			if err := copyIfPresent(src, dst); err != nil {
				return err
			}
		}
	}
	return nil
}
