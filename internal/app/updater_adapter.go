package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/HosHaggag/rubban/internal/logging"
	"github.com/HosHaggag/rubban/internal/updater"
)

// updaterAdapter lets the desktop shell drive internal/updater through the Updates interface and
// fans state changes out to every page subscribed over /api/desktop/events.
type updaterAdapter struct {
	u    *updater.Updater
	mu   sync.Mutex
	subs map[int]func(any)
	next int
}

// newUpdaterAdapter builds the updater. quit asks the shell to exit once the install helper runs.
func newUpdaterAdapter(dataDir, version, exe string, packaged bool, log *logging.Logger, quit func()) *updaterAdapter {
	a := &updaterAdapter{subs: map[int]func(any){}}
	a.u = updater.New(updater.Config{
		DataDir:        dataDir,
		CurrentVersion: version,
		IsPackaged:     packaged,
		ExecPath:       exe,
		Log:            log,
		OnState:        a.broadcast,
		Quit:           quit,
		GetPreferences: func(context.Context) (map[string]any, error) {
			data, err := os.ReadFile(filepath.Join(dataDir, "preferences.json"))
			if err != nil {
				return map[string]any{}, nil
			}
			var prefs map[string]any
			if json.Unmarshal(data, &prefs) != nil || prefs == nil {
				return map[string]any{}, nil
			}
			return prefs, nil
		},
	})
	return a
}

func (a *updaterAdapter) broadcast(s updater.State) {
	a.mu.Lock()
	fns := make([]func(any), 0, len(a.subs))
	for _, f := range a.subs {
		fns = append(fns, f)
	}
	a.mu.Unlock()
	for _, f := range fns {
		f(s)
	}
}

func (a *updaterAdapter) State() any { return a.u.State() }
func (a *updaterAdapter) Summary() UpdateSummary {
	s := a.u.State()
	return UpdateSummary{Status: s.Status, Current: s.Current, Latest: s.Latest, Error: s.Error, Disabled: s.Disabled}
}
func (a *updaterAdapter) Check(ctx context.Context) any { return a.u.Check(ctx) }
func (a *updaterAdapter) Download(ctx context.Context) any {
	s, _ := a.u.Download(ctx) // failures are reported through the state's error field
	return s
}
func (a *updaterAdapter) Install(context.Context) (any, error) { return a.u.Install() }
func (a *updaterAdapter) Dismiss() any                         { return a.u.DismissResult() }
func (a *updaterAdapter) Start()                               { a.u.Start() }
func (a *updaterAdapter) Stop()                                { a.u.Stop() }
func (a *updaterAdapter) Subscribe(fn func(any)) func() {
	a.mu.Lock()
	id := a.next
	a.next++
	a.subs[id] = fn
	a.mu.Unlock()
	return func() { a.mu.Lock(); delete(a.subs, id); a.mu.Unlock() }
}
