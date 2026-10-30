//go:build windows

package server

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
)

const createNoWindow = 0x08000000

func configureCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}

// killProcess closes the whole process tree with taskkill, falling back to Process.Kill.
func killProcess(p *os.Process) {
	if p == nil {
		return
	}
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	killer := exec.Command(filepath.Join(root, "System32", "taskkill.exe"), "/PID", strconv.Itoa(p.Pid), "/T", "/F")
	configureCommand(killer)
	if err := killer.Run(); err != nil {
		_ = p.Kill()
	}
}
