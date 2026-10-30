package updater

import "os/exec"

// spawnDetached starts command with no stdio, in its own session or process group, and does not wait.
func spawnDetached(command string, args []string) error {
	cmd := exec.Command(command, args...)
	detach(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}
