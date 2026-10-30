// Package updater is the in-app updater: it checks GitHub releases for a newer zip, downloads and
// verifies it, then hands over to a detached helper script that replaces the installation.
// It is a port of desktop/updater.cjs and desktop/update/apply-update.{ps1,sh}.
package updater

import (
	"bytes"
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const (
	checkDelay    = 20 * time.Second
	checkInterval = 6 * time.Hour
	manifestLimit = 4 << 20
	checkTimeout  = 60 * time.Second
	defaultRepo   = "HosHaggag/Rubban"
)

//go:embed scripts/apply-update.ps1 scripts/apply-update.sh
var scripts embed.FS

// Script returns the embedded helper script for a Node-style platform name ("win32" or anything else).
func Script(platform string) (name string, data []byte) {
	name = "apply-update.sh"
	if platform == "win32" {
		name = "apply-update.ps1"
	}
	data, _ = scripts.ReadFile("scripts/" + name)
	return name, data
}

// Status values of State.Status.
const (
	StatusIdle        = "idle"
	StatusChecking    = "checking"
	StatusUpToDate    = "up-to-date"
	StatusAvailable   = "available"
	StatusDownloading = "downloading"
	StatusReady       = "ready"
	StatusInstalling  = "installing"
	StatusError       = "error"
)

// Result is what the helper script left behind in updates/result.json.
type Result struct {
	OK          bool   `json:"ok"`
	Version     string `json:"version"`
	Error       string `json:"error"`
	InstalledTo string `json:"installedTo"`
}

// State is the updater state shown in the UI. The JSON shape matches the Node module.
// CheckError is additive: it carries the failure of a periodic check that did not disturb a
// verified, ready update (A22).
type State struct {
	Status     string  `json:"status"`
	Current    string  `json:"current"`
	Latest     string  `json:"latest"`
	Notes      string  `json:"notes"`
	Progress   float64 `json:"progress"`
	Error      string  `json:"error"`
	CheckError string  `json:"checkError,omitempty"`
	LastCheck  string  `json:"lastCheck"`
	Disabled   bool    `json:"disabled"`
	Result     *Result `json:"result"`
}

// Logger is satisfied by *logging.Logger.
type Logger interface {
	Info(message string, extra map[string]any)
	Warn(message string, extra map[string]any)
	Error(err error, extra map[string]any)
}

// Config wires the updater to its environment. Only DataDir and CurrentVersion are required.
type Config struct {
	DataDir        string
	CurrentVersion string
	IsPackaged     bool
	Repo           string // default HosHaggag/Rubban

	// Platform and Arch use Node's names (win32/darwin/linux, x64/arm64) because they form the
	// manifest key "<platform>-<arch>". Defaults come from the running binary.
	Platform string
	Arch     string

	ExecPath string // default os.Executable()
	TempDir  string // default os.TempDir()
	PID      int    // default os.Getpid()

	HTTPClient *http.Client
	Env        func(string) string // default os.Getenv
	Log        Logger
	OnState    func(State)

	// GetPreferences returns preferences.json; automatic checks run unless updates.auto is false.
	GetPreferences func(context.Context) (map[string]any, error)

	// Spawn starts the helper detached from this process. Default: os/exec with the
	// platform's detach flags.
	Spawn func(command string, args []string) error
	// Quit asks the desktop shell to exit once the helper has been started.
	Quit func()

	// Now and AfterFunc are the clock seam. AfterFunc schedules f after d and returns its stop func.
	Now       func() time.Time
	AfterFunc func(d time.Duration, f func()) (stop func())
}

// Updater is the state machine.
type Updater struct {
	cfg        Config
	updates    string
	statePath  string
	resultPath string
	disabled   bool
	key        string
	header     http.Header

	mu       sync.Mutex
	state    State
	asset    *Asset
	busy     bool
	started  bool
	stops    []func()
	stopping bool
}

// NodePlatform maps runtime.GOOS to the names Node used in manifest keys.
func NodePlatform(goos string) string { return goos }

// NodeArch maps runtime.GOARCH to the names Node used in manifest keys.
func NodeArch(goarch string) string {
	switch goarch {
	case "amd64":
		return "x64"
	case "386":
		return "ia32"
	}
	return goarch
}

// New builds an updater from cfg, filling defaults.
func New(cfg Config) *Updater {
	if cfg.Repo == "" {
		cfg.Repo = defaultRepo
	}
	if cfg.Platform == "" {
		cfg.Platform = NodePlatform(runtime.GOOS)
	}
	if cfg.Arch == "" {
		cfg.Arch = NodeArch(runtime.GOARCH)
	}
	if cfg.ExecPath == "" {
		cfg.ExecPath, _ = os.Executable()
	}
	if cfg.TempDir == "" {
		cfg.TempDir = os.TempDir()
	}
	if cfg.PID == 0 {
		cfg.PID = os.Getpid()
	}
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = &http.Client{}
	}
	if cfg.Env == nil {
		cfg.Env = os.Getenv
	}
	if cfg.Spawn == nil {
		cfg.Spawn = spawnDetached
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.AfterFunc == nil {
		cfg.AfterFunc = func(d time.Duration, f func()) func() {
			t := time.AfterFunc(d, f)
			return func() { t.Stop() }
		}
	}
	u := &Updater{
		cfg:        cfg,
		updates:    filepath.Join(cfg.DataDir, "updates"),
		statePath:  filepath.Join(cfg.DataDir, "update-state.json"),
		resultPath: filepath.Join(cfg.DataDir, "updates", "result.json"),
		disabled:   !cfg.IsPackaged || cfg.Env("RUBBAN_DISABLE_UPDATES") == "1",
		key:        cfg.Platform + "-" + cfg.Arch,
		header:     http.Header{"User-Agent": {"Rubban/" + cfg.CurrentVersion}},
	}
	u.state = State{Status: StatusIdle, Current: cfg.CurrentVersion, Disabled: u.disabled}
	return u
}

func (u *Updater) logInfo(msg string) {
	if u.cfg.Log != nil {
		u.cfg.Log.Info(msg, nil)
	}
}
func (u *Updater) logWarn(msg string) {
	if u.cfg.Log != nil {
		u.cfg.Log.Warn(msg, nil)
	}
}

// update mutates the state under the lock, then reports a copy to the listener outside it.
func (u *Updater) update(patch func(*State)) State {
	u.mu.Lock()
	patch(&u.state)
	snap := u.state
	u.mu.Unlock()
	if u.cfg.OnState != nil {
		func() {
			defer func() { _ = recover() }() // Listener errors must not break updates.
			u.cfg.OnState(snap)
		}()
	}
	return snap
}

// State returns a copy of the current state.
func (u *Updater) State() State {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.state
}

// DismissResult clears the install result after the UI has shown it.
func (u *Updater) DismissResult() State {
	return u.update(func(s *State) { s.Result = nil })
}

func (u *Updater) saved() (s struct {
	LastCheck string `json:"lastCheck"`
}) {
	if data, err := os.ReadFile(u.statePath); err == nil {
		_ = json.Unmarshal(data, &s)
	}
	return s
}

func (u *Updater) persist() {
	st := u.State()
	data, err := json.MarshalIndent(map[string]string{"lastCheck": st.LastCheck, "latest": st.Latest, "notes": st.Notes}, "", "  ")
	if err != nil {
		return
	}
	if os.MkdirAll(u.cfg.DataDir, 0o755) == nil {
		_ = os.WriteFile(u.statePath, data, 0o600) // Not essential.
	}
}

// verifyFile hashes path and checks it against the manifest asset (A3).
func verifyFile(path string, asset *Asset) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	if st, err := f.Stat(); err != nil || !st.Mode().IsRegular() || st.Size() != asset.Size {
		return false
	}
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return false
	}
	return hex.EncodeToString(h.Sum(nil)) == asset.SHA256
}

func (u *Updater) currentAsset() *Asset {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.asset
}

func (u *Updater) setAsset(a *Asset) {
	u.mu.Lock()
	u.asset = a
	u.mu.Unlock()
}

// Check fetches the manifest and updates the state. Callers must branch on the returned
// status: a disabled or busy updater returns the current state unchanged (PLAN.md A27).
func (u *Updater) Check(ctx context.Context) State {
	if u.disabled {
		return u.State()
	}
	u.mu.Lock()
	if u.busy || u.state.Status == StatusDownloading || u.state.Status == StatusInstalling {
		st := u.state
		u.mu.Unlock()
		return st
	}
	u.busy = true
	previous := u.state.Status
	u.mu.Unlock()
	defer func() { u.mu.Lock(); u.busy = false; u.mu.Unlock() }()

	u.update(func(s *State) { s.Status = StatusChecking; s.Error = ""; s.CheckError = "" })
	if err := u.doCheck(ctx); err != nil {
		u.logWarn("Update check failed: " + err.Error())
		now := u.cfg.Now().UTC().Format("2006-01-02T15:04:05.000Z")
		// A22: a failed check must not hide a verified download that is still on disk.
		asset := u.currentAsset()
		if previous == StatusReady && asset != nil && verifyFile(filepath.Join(u.updates, asset.Name), asset) {
			u.update(func(s *State) { s.Status = StatusReady; s.Progress = 1; s.CheckError = err.Error(); s.LastCheck = now })
		} else {
			u.update(func(s *State) { s.Status = StatusError; s.Error = err.Error(); s.LastCheck = now })
		}
	}
	return u.State()
}

func (u *Updater) doCheck(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, checkTimeout)
	defer cancel()
	resp, err := safeFetch(ctx, u.cfg.HTTPClient, "https://github.com/"+u.cfg.Repo+"/releases/latest/download/latest.json", u.header)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("The update server answered %d", resp.StatusCode)
	}
	var manifest Manifest
	if err := json.NewDecoder(io.LimitReader(resp.Body, manifestLimit)).Decode(&manifest); err != nil {
		return errors.New("The update manifest is not valid")
	}
	version, asset, notes, err := ValidateManifest(&manifest, u.key)
	if err != nil {
		return err
	}
	lastCheck := u.cfg.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	cmp, err := CompareVersions(u.cfg.CurrentVersion, version)
	if err != nil {
		return err
	}
	switch {
	case cmp >= 0:
		u.setAsset(nil)
		u.update(func(s *State) { s.Status = StatusUpToDate; s.Latest = version; s.Notes = ""; s.LastCheck = lastCheck })
	case asset == nil:
		u.setAsset(nil)
		u.update(func(s *State) {
			s.Status = StatusError
			s.Latest = version
			s.Notes = notes
			s.LastCheck = lastCheck
			s.Error = fmt.Sprintf("Version %s has no download for %s", version, u.key)
		})
	default:
		u.setAsset(asset)
		zip := filepath.Join(u.updates, asset.Name)
		ready := false
		if _, err := os.Stat(zip); err == nil {
			// A3: only report ready when the file on disk is the verified asset.
			if ready = verifyFile(zip, asset); !ready {
				_ = os.Remove(zip)
			}
		}
		u.update(func(s *State) {
			s.Status = StatusAvailable
			s.Progress = 0
			if ready {
				s.Status = StatusReady
				s.Progress = 1
			}
			s.Latest = version
			s.Notes = notes
			s.LastCheck = lastCheck
		})
	}
	u.persist()
	return nil
}

// Download fetches the available update, verifies size and SHA-256 and leaves it in updates/.
func (u *Updater) Download(ctx context.Context) (State, error) {
	if u.disabled {
		return State{}, errors.New("Updates are disabled in this build")
	}
	u.mu.Lock()
	asset, version, status := u.asset, u.state.Latest, u.state.Status
	u.mu.Unlock()
	if status != StatusAvailable || asset == nil {
		return State{}, errors.New("There is no update to download")
	}
	if err := os.MkdirAll(u.updates, 0o755); err != nil {
		return State{}, err
	}
	partial := filepath.Join(u.updates, asset.Name+".part")
	final := filepath.Join(u.updates, asset.Name)
	u.update(func(s *State) { s.Status = StatusDownloading; s.Progress = 0; s.Error = ""; s.CheckError = "" })
	if err := u.fetchAsset(ctx, asset, version, partial, final); err != nil {
		_ = os.Remove(partial)
		u.logWarn("Update download failed: " + err.Error())
		u.update(func(s *State) { s.Status = StatusError; s.Error = err.Error(); s.Progress = 0 })
	}
	return u.State(), nil
}

func (u *Updater) fetchAsset(ctx context.Context, asset *Asset, version, partial, final string) error {
	resp, err := safeFetch(ctx, u.cfg.HTTPClient, "https://github.com/"+u.cfg.Repo+"/releases/download/v"+version+"/"+asset.Name, u.header)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 || resp.Body == nil {
		return fmt.Errorf("The download failed (%d)", resp.StatusCode)
	}
	hash := sha256.New()
	out, err := os.OpenFile(partial, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	var received int64
	lastPct := 0 // A25: progress is emitted only when the whole percentage changes.
	buf := make([]byte, 64*1024)
	copyErr := func() error {
		for {
			n, rerr := resp.Body.Read(buf)
			if n > 0 {
				received += int64(n)
				if received > MaxDownload || received > asset.Size+1024 {
					return errors.New("The download is larger than expected")
				}
				hash.Write(buf[:n])
				if _, werr := out.Write(buf[:n]); werr != nil {
					return werr
				}
				progress := math.Min(float64(received)/float64(asset.Size), 0.99)
				if pct := int(math.Round(progress * 100)); pct != lastPct {
					lastPct = pct
					u.update(func(s *State) { s.Progress = progress })
				}
			}
			if rerr == io.EOF {
				return nil
			}
			if rerr != nil {
				return rerr
			}
		}
	}()
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if received != asset.Size {
		return errors.New("The download is incomplete")
	}
	if hex.EncodeToString(hash.Sum(nil)) != asset.SHA256 {
		return errors.New("The downloaded update failed its checksum and was discarded")
	}
	if err := os.Rename(partial, final); err != nil {
		return err
	}
	if entries, err := os.ReadDir(u.updates); err == nil {
		for _, e := range entries {
			if e.Name() != asset.Name && e.Name() != "result.json" {
				_ = os.RemoveAll(filepath.Join(u.updates, e.Name()))
			}
		}
	}
	u.update(func(s *State) { s.Status = StatusReady; s.Progress = 1 })
	return nil
}

// resolvePath is filepath.EvalSymlinks that also works for a path that does not exist yet: the
// deepest existing ancestor is resolved and the rest is appended (A4).
func resolvePath(p string) string {
	p = filepath.Clean(p)
	if r, err := filepath.EvalSymlinks(p); err == nil {
		return r
	}
	dir, base := filepath.Split(p)
	if dir == "" || filepath.Clean(dir) == p {
		return p
	}
	return filepath.Join(resolvePath(dir), base)
}

func underDir(path, dir string) bool {
	dir = strings.TrimRight(dir, string(filepath.Separator))
	return strings.HasPrefix(path, dir+string(filepath.Separator))
}

// Install hands over to the detached helper script and asks the shell to quit.
func (u *Updater) Install() (State, error) {
	if u.disabled {
		return State{}, errors.New("Updates are disabled in this build")
	}
	u.mu.Lock()
	asset, version, status := u.asset, u.state.Latest, u.state.Status
	u.mu.Unlock()
	if status != StatusReady || asset == nil {
		return State{}, errors.New("The update has not been downloaded yet")
	}
	exe := resolvePath(u.cfg.ExecPath)
	if strings.HasPrefix(filepath.ToSlash(exe), "/Volumes/") || underDir(exe, resolvePath(u.cfg.TempDir)) {
		return State{}, errors.New("Rubban is running from a mounted disk or a temporary folder. Install it first, then update.")
	}
	zip := filepath.Join(u.updates, asset.Name)
	if _, err := os.Stat(zip); err != nil {
		return State{}, errors.New("The downloaded update is missing; download it again")
	}
	// A3: the zip sits in a user-writable folder; re-verify it right before use.
	if !verifyFile(zip, asset) {
		_ = os.Remove(zip)
		u.update(func(s *State) { s.Status = StatusAvailable; s.Progress = 0 })
		return State{}, errors.New("The downloaded update failed verification; download it again")
	}
	windows := u.cfg.Platform == "win32"
	name, data := Script(u.cfg.Platform)
	script := filepath.Join(u.updates, name)
	mode := os.FileMode(0o644)
	if !windows {
		mode = 0o755
	}
	if err := os.WriteFile(script, data, mode); err != nil {
		return State{}, err
	}
	if !windows {
		_ = os.Chmod(script, 0o755)
	}
	pid := fmt.Sprint(u.cfg.PID)
	var command string
	var args []string
	if windows {
		root := u.cfg.Env("SystemRoot")
		if root == "" {
			root = `C:\Windows`
		}
		command = filepath.Join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
		args = []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script, "-Zip", zip, "-Install", filepath.Dir(u.cfg.ExecPath), "-ProcessId", pid, "-Exe", u.cfg.ExecPath, "-ResultFile", u.resultPath, "-Version", version}
	} else {
		bundle := filepath.Dir(filepath.Dir(filepath.Dir(u.cfg.ExecPath))) // Rubban.app/Contents/MacOS/Rubban
		command = "/bin/bash"
		args = []string{script, zip, bundle, pid, u.resultPath, version}
	}
	u.update(func(s *State) { s.Status = StatusInstalling })
	u.logInfo("Installing update " + version)
	if err := u.cfg.Spawn(command, args); err != nil {
		u.logWarn("Could not start the update helper: " + err.Error())
		u.update(func(s *State) { s.Status = StatusReady })
		return State{}, fmt.Errorf("The update helper could not be started: %w", err)
	}
	if u.cfg.Quit != nil {
		u.cfg.Quit()
	}
	return u.State(), nil
}

// consumeResult reports the helper's result.json once, then deletes it.
func (u *Updater) consumeResult() {
	data, err := os.ReadFile(u.resultPath)
	if err != nil {
		return
	}
	var raw map[string]any
	if json.Unmarshal(bytes.TrimPrefix(data, []byte("\xef\xbb\xbf")), &raw) != nil || raw == nil {
		return
	}
	_ = os.Remove(u.resultPath)
	text := func(k string) string {
		switch v := raw[k].(type) {
		case string:
			return v
		case nil:
			return ""
		case bool:
			if !v {
				return ""
			}
		case float64:
			if v == 0 {
				return ""
			}
		}
		return fmt.Sprint(raw[k])
	}
	ok, _ := raw["ok"].(bool)
	result := Result{OK: ok, Version: text("version"), Error: text("error"), InstalledTo: text("installedTo")}
	if u.cfg.Log != nil {
		if ok {
			u.cfg.Log.Info(strings.TrimSpace("Update installed: "+result.Version+" "+result.Error), nil)
		} else {
			u.cfg.Log.Error(errors.New(strings.TrimSpace("Update failed: "+result.Version+" "+result.Error)), nil)
		}
	}
	u.update(func(s *State) { s.Result = &result })
}

// Start reads the saved state, reports a pending install result and schedules the first check
// 20 s later and then one every 6 h (automatic checks only while updates.auto is not false).
func (u *Updater) Start() {
	prev := u.saved()
	u.update(func(s *State) { s.LastCheck = prev.LastCheck })
	u.consumeResult()
	if u.disabled {
		return
	}
	u.mu.Lock()
	if u.started {
		u.mu.Unlock()
		return
	}
	u.started, u.stopping = true, false
	u.mu.Unlock()
	run := func() {
		auto := true
		if u.cfg.GetPreferences != nil {
			if prefs, err := u.cfg.GetPreferences(context.Background()); err == nil {
				if updates, ok := prefs["updates"].(map[string]any); ok && updates["auto"] == false {
					auto = false
				}
			}
		}
		if auto {
			u.Check(context.Background())
		}
	}
	u.schedule(checkDelay, run)
	var tick func()
	tick = func() {
		u.schedule(checkInterval, tick)
		run()
	}
	u.schedule(checkInterval, tick)
}

func (u *Updater) schedule(d time.Duration, f func()) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.stopping {
		return
	}
	u.stops = append(u.stops, u.cfg.AfterFunc(d, f))
}

// Stop cancels the scheduled checks.
func (u *Updater) Stop() {
	u.mu.Lock()
	stops := u.stops
	u.stops, u.stopping, u.started = nil, true, false
	u.mu.Unlock()
	for _, stop := range stops {
		stop()
	}
}
