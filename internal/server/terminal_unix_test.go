//go:build !windows

package server

import "syscall"

// processGone reports whether no process (not even a zombie) has this pid.
func processGone(pid int) bool { return syscall.Kill(pid, 0) == syscall.ESRCH }
