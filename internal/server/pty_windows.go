//go:build windows

package server

import (
	"os"

	gopty "github.com/aymanbagabas/go-pty"
)

// ConPTY has no slave end to release. Its output pipe only ends when the pseudo console is closed,
// so a finished session closes the PTY after draining (see terminalSession.finish).
func releaseSlave(gopty.Pty) {}

// hangupProcess has no Windows equivalent; killProcess ends the tree with taskkill.
func hangupProcess(*os.Process) {}
