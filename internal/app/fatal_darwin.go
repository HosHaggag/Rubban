//go:build darwin

package app

import (
	"os/exec"
	"strings"
)

func showFatal(title, message string) {
	esc := func(s string) string { return strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) }
	_ = exec.Command("osascript", "-e", `display dialog "`+esc(message)+`" with title "`+esc(title)+`" buttons {"OK"} with icon stop`).Run()
}
