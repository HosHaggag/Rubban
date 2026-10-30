//go:build !desktop

package main

import (
	"fmt"
	"os"
)

func runDesktop(args []string) int {
	fmt.Fprintln(os.Stderr, "desktop support not built in; use `rubban web`")
	return 2
}
