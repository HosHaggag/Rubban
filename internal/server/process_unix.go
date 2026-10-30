//go:build !windows

package server

import (
	"os"
	"os/exec"
	"syscall"
)

func configureCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killProcess terminates the child's process group, falling back to the process itself.
func killProcess(p *os.Process) {
	if p == nil {
		return
	}
	if err := syscall.Kill(-p.Pid, syscall.SIGTERM); err == nil {
		return
	}
	_ = p.Kill()
}
