//go:build desktop

package app

import (
	"github.com/HosHaggag/rubban/internal/server"
	"github.com/HosHaggag/rubban/internal/version"
)

// importShellEnv reads the login shell's PATH on macOS (a no-op on Windows and with
// RUBBAN_SKIP_SHELL_ENV=1); app launches do not inherit it.
func importShellEnv() { server.ApplyShellEnvironment() }

// newUpdates builds the updater; installing quits the app so the helper can swap the files.
func newUpdates(s *shell, exe string, packaged bool) Updates {
	return newUpdaterAdapter(s.dataDir, version.Version, exe, packaged, s.logger, func() { s.app.Quit() })
}
