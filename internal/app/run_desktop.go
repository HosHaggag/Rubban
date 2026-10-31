//go:build desktop

package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/HosHaggag/rubban/internal/logging"
	"github.com/HosHaggag/rubban/internal/server"
	"github.com/HosHaggag/rubban/internal/version"
)

// Config carries what the command needs to hand to the shell.
type Config struct {
	Args []string
	UI   fs.FS
	Icon []byte
}

type shell struct {
	cfg      Config
	smoke    bool
	dataDir  string
	logger   *logging.Logger
	backend  *server.Backend
	conn     server.Connection
	app      *application.App
	window   *application.WebviewWindow
	updates  Updates
	connFile string

	mu             sync.Mutex
	rendererErrors []string
	smokeDone      chan struct{}
	exitCode       int
	crashShown     bool
	closed         bool
}

// Run starts the desktop app and returns the process exit code.
func Run(cfg Config) int {
	s := &shell{cfg: cfg, smoke: slices.Contains(cfg.Args, "--smoke-test"), smokeDone: make(chan struct{})}
	return s.run()
}

func (s *shell) fatal(err error) int {
	fmt.Fprintln(os.Stderr, err)
	if s.logger != nil {
		s.logger.Error(err, map[string]any{"kind": "fatal"})
	}
	s.cleanup()
	if !s.smoke {
		showFatal("Rubban could not start", err.Error())
	}
	return 1
}

func (s *shell) cleanup() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	s.mu.Unlock()
	if s.updates != nil {
		s.updates.Stop()
	}
	if s.backend != nil {
		_ = s.backend.Close()
	}
	if s.connFile != "" {
		_ = os.Remove(s.connFile)
	}
}

func (s *shell) run() int {
	importShellEnv()
	exe, err := os.Executable()
	if err != nil {
		return s.fatal(err)
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	home, _ := os.UserHomeDir()
	cwd, _ := os.Getwd()
	s.dataDir = DataDir(exe, runtime.GOOS, home, cwd, os.Getenv)
	if err := os.MkdirAll(s.dataDir, 0o755); err != nil {
		return s.fatal(err)
	}
	// A build put in place by the installer starts with the settings of the layout it replaces.
	migratedFrom, migrateErr := MigrateData(exe, s.dataDir, home)
	s.logger = logging.New(filepath.Join(s.dataDir, "logs"), 0, 0)
	if migrateErr != nil {
		s.logger.Warn("Could not copy settings from an earlier install: "+migrateErr.Error(), nil)
	} else if migratedFrom != "" {
		s.logger.Info("Copied settings from "+migratedFrom, nil)
	}
	appRoot := AppRoot(exe, runtime.GOOS)
	packaged := Packaged(exe)

	bridgeSource, err := fs.ReadFile(s.cfg.UI, "desktop-bridge.js")
	if err != nil {
		return s.fatal(err)
	}
	s.updates = newUpdates(s, exe, packaged)
	opts := server.Options{
		DataDir:       s.dataDir,
		KubectlPath:   BundledTool(appRoot, "kubectl", runtime.GOOS),
		HelmPath:      BundledTool(appRoot, "helm", runtime.GOOS),
		Logger:        s.logger,
		UI:            s.cfg.UI,
		DesktopBridge: BridgeScript(bridgeSource, runtime.GOOS, s.smoke),
		Desktop:       &hooks{s: s},
		Smoke:         s.smoke,
		MigratedFrom:  migratedFrom,
	}
	s.backend = server.New(opts)
	s.conn, err = s.backend.Start(PreferredPort(s.dataDir))
	if err != nil {
		// The remembered port may have been taken between the check and the bind.
		if s.conn, err = s.backend.Start(0); err != nil {
			return s.fatal(err)
		}
	}
	WritePort(s.dataDir, s.conn.Port)
	s.connFile, err = writeConnection(s.dataDir, s.conn)
	if err != nil {
		return s.fatal(err)
	}

	s.app = application.New(application.Options{
		Name:        "Rubban",
		Description: "Rubban Kubernetes Workbench",
		Icon:        s.cfg.Icon,
		Mac:         application.MacOptions{ApplicationShouldTerminateAfterLastWindowClosed: true},
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID:               "dev.rubban.desktop",
			OnSecondInstanceLaunch: func(application.SecondInstanceData) { s.focus() },
		},
		PanicHandler: s.panicked,
		OnShutdown:   s.cleanup,
	})
	s.buildMenu()
	s.createWindow()
	s.updates.Start()
	if s.smoke {
		go s.watchSmoke()
	}
	if err := s.app.Run(); err != nil {
		s.logger.Error(err, map[string]any{"kind": "run"})
		s.cleanup()
		return 1
	}
	s.cleanup()
	return s.exitCode
}

func writeConnection(dataDir string, conn server.Connection) (string, error) {
	file := filepath.Join(dataDir, "connection.json")
	data, err := json.MarshalIndent(map[string]any{"url": conn.URL, "port": conn.Port, "token": conn.Token, "pid": os.Getpid()}, "", "  ")
	if err != nil {
		return "", err
	}
	return file, os.WriteFile(file, data, 0o600)
}

// storedTheme reads the theme preference before the window exists so an explicit Light or Dark
// choice does not flash the wrong colour on launch.
func (s *shell) storedTheme() string {
	data, err := os.ReadFile(filepath.Join(s.dataDir, "preferences.json"))
	if err != nil {
		return "system"
	}
	var prefs struct {
		Theme string `json:"theme"`
	}
	if json.Unmarshal(data, &prefs) != nil || (prefs.Theme != "light" && prefs.Theme != "dark") {
		return "system"
	}
	return prefs.Theme
}

func (s *shell) backgroundFor(theme string) application.RGBA {
	dark := theme == "dark"
	if theme == "system" && s.app != nil {
		dark = s.app.Env.IsDarkMode()
	}
	if dark {
		return application.NewRGBA(0x1f, 0x21, 0x23, 255)
	}
	return application.NewRGBA(0xff, 0xff, 0xff, 255)
}

func (s *shell) createWindow() {
	theme := s.storedTheme()
	winTheme, macAppearance := application.SystemDefault, application.DefaultAppearance
	switch theme {
	case "dark":
		winTheme, macAppearance = application.Dark, application.NSAppearanceNameDarkAqua
	case "light":
		winTheme, macAppearance = application.Light, application.NSAppearanceNameAqua
	}
	deny := application.PermissionDeny
	s.window = s.app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             "main",
		Title:            "Rubban · رُبّان",
		Width:            1540,
		Height:           970,
		MinWidth:         1050,
		MinHeight:        700,
		URL:              s.conn.URL,
		Hidden:           s.smoke,
		BackgroundColour: s.backgroundFor(theme),
		DevToolsEnabled:  true,
		// Nothing the page asks for is granted: no camera, microphone or similar.
		Permissions: map[application.PermissionType]application.Permission{
			application.PermissionCamera:     deny,
			application.PermissionMicrophone: deny,
		},
		Windows: application.WindowsWindow{Theme: winTheme},
		Mac:     application.MacWindow{Appearance: macAppearance},
	})
}

func (s *shell) focus() {
	if s.window == nil {
		return
	}
	if s.window.IsMinimised() {
		s.window.Restore()
	}
	s.window.Show()
	s.window.Focus()
}

// panicked logs a recovered panic and shows the unexpected-error dialog once.
func (s *shell) panicked(details *application.PanicDetails) {
	msg := "panic"
	if details != nil && details.Error != nil {
		msg = details.Error.Error()
	}
	stack := ""
	if details != nil {
		stack = details.StackTrace
	}
	s.logger.ErrorStack(msg, stack, map[string]any{"kind": "panic"})
	s.mu.Lock()
	show := !s.crashShown && !s.smoke
	s.crashShown = true
	s.mu.Unlock()
	if show {
		go showFatal("Rubban hit an unexpected error", msg+"\n\nDetails are in "+s.logger.File)
	}
}

// --- smoke test ----------------------------------------------------------------------------

func (s *shell) watchSmoke() {
	select {
	case <-s.smokeDone:
	case <-time.After(30 * time.Second):
		s.finishSmoke(map[string]any{"title": "", "ready": "timeout", "bodyLength": 0, "body": ""}, "the page never reported (timeout)")
	}
}

func (s *shell) finishSmoke(report map[string]any, extraError string) {
	s.mu.Lock()
	select {
	case <-s.smokeDone:
		s.mu.Unlock()
		return
	default:
	}
	close(s.smokeDone)
	errs := append([]string{}, s.rendererErrors...)
	s.mu.Unlock()
	if extraError != "" {
		errs = append(errs, extraError)
	}
	result := map[string]any{"title": report["title"], "ready": report["ready"], "bodyLength": report["bodyLength"], "body": report["body"], "rendererErrors": errs}
	if dir := os.Getenv("RUBBAN_SMOKE_DIR"); dir != "" {
		if os.MkdirAll(dir, 0o755) == nil {
			data, _ := json.MarshalIndent(result, "", "  ")
			_ = os.WriteFile(filepath.Join(dir, "desktop-smoke.json"), data, 0o644)
		}
	}
	line, _ := json.Marshal(map[string]any{"smoke": true, "title": report["title"], "ready": report["ready"], "bodyLength": report["bodyLength"], "rendererErrors": errs})
	fmt.Println(string(line))
	if len(errs) == 0 {
		s.app.Quit()
		return
	}
	s.cleanup()
	os.Exit(1)
}

// --- server.DesktopHooks --------------------------------------------------------------------

type hooks struct{ s *shell }

func (h *hooks) OpenExternal(url string) error { return h.s.app.Browser.OpenURL(url) }

func (h *hooks) SetTheme(theme string) error {
	// The page themes itself; the window background follows so resizing never shows the old colour.
	h.s.window.SetBackgroundColour(h.s.backgroundFor(theme))
	return nil
}

func (h *hooks) SaveFile(name, text string) (bool, error) {
	path, err := h.s.app.Dialog.SaveFile().AttachToWindow(h.s.window).SetFilename(name).PromptForSingleSelection()
	if err != nil || path == "" {
		return false, nil // cancelled
	}
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		return false, err
	}
	return true, nil
}

func (h *hooks) UpdateState() any                       { return h.s.updates.State() }
func (h *hooks) UpdateCheck(ctx context.Context) any    { return h.s.updates.Check(ctx) }
func (h *hooks) UpdateDownload(ctx context.Context) any { return h.s.updates.Download(ctx) }
func (h *hooks) UpdateDismiss() any                     { return h.s.updates.Dismiss() }
func (h *hooks) SubscribeUpdates(fn func(any)) func()   { return h.s.updates.Subscribe(fn) }
func (h *hooks) UpdateInstall(ctx context.Context) (any, error) {
	state, err := h.s.updates.Install(ctx)
	return state, err
}

func (h *hooks) RendererError(message, stack string) {
	h.s.mu.Lock()
	h.s.rendererErrors = append(h.s.rendererErrors, message)
	h.s.mu.Unlock()
	h.s.logger.Error(fmt.Errorf("%s", message), map[string]any{"kind": "renderer", "stack": stack})
}

func (h *hooks) SmokeReport(report map[string]any) { go h.s.finishSmoke(report, "") }

var _ = version.Version
