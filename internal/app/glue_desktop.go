//go:build desktop

package app

import "github.com/HosHaggag/rubban/internal/version"

// importShellEnv reads the login shell's PATH on macOS; replaced once the shell-environment
// importer is merged (internal/server/shellenv.go).
var importShellEnv = func() {}

// newUpdates builds the updater; replaced once internal/updater is merged.
func newUpdates(s *shell, exe string, packaged bool) Updates {
	return disabledUpdates{current: version.Version}
}
