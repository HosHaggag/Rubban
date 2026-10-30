//go:build !(darwin || dragonfly || freebsd || linux || netbsd || openbsd || solaris || windows)

package server

import (
	"errors"
	"os"
)

// No pseudo-terminal support on this platform: sessions fall back to command pipes.
func startPTYProcess(terminalSpec, func(*os.Process) func()) (terminalProcess, error) {
	return nil, errors.New("pseudo-terminals are not supported on this platform")
}
