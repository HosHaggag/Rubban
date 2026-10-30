//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd || solaris

package server

import (
	"os"
	"syscall"

	gopty "github.com/aymanbagabas/go-pty"
)

// releaseSlave closes this process's copy of the TTY once the child holds its own, so reading the
// master ends with EIO when the child and its descendants are gone instead of blocking forever.
func releaseSlave(p gopty.Pty) {
	if u, ok := p.(gopty.UnixPty); ok {
		_ = u.Slave().Close()
	}
}

// hangupProcess sends SIGHUP to the session's process group, falling back to the process itself.
func hangupProcess(p *os.Process) {
	if p == nil {
		return
	}
	if err := syscall.Kill(-p.Pid, syscall.SIGHUP); err != nil {
		_ = p.Signal(syscall.SIGHUP)
	}
}
