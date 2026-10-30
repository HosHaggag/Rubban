//go:build desktop

package main

import (
	"fmt"
	"os"
)

// runDesktop is replaced by internal/app once the Wails shell lands (phase 5).
func runDesktop(args []string) int {
	fmt.Fprintln(os.Stderr, "desktop shell not implemented yet")
	return 2
}
