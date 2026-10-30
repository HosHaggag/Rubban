// Package app is the Rubban desktop shell. The window code needs Wails and is built with -tags
// desktop; the helpers in this file are plain Go so they can be tested everywhere.
package app

import (
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

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

// DataDir resolves the data folder (PLAN-GO.md §4.20).
func DataDir(exe, goos, home, cwd string, env func(string) string) string {
	if d := env("RUBBAN_DATA_DIR"); d != "" {
		return d
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
