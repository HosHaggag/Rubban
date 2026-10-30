// Command rubban is the Rubban desktop app, web server and MCP bridge.
package main

import (
	"fmt"
	"os"

	"github.com/HosHaggag/rubban/internal/version"
)

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) == 0 {
		return runDesktop(args)
	}
	switch args[0] {
	case "version", "--version":
		fmt.Println(version.Version)
		return 0
	case "web":
		return runWeb(args[1:])
	case "--smoke-test":
		return runDesktop(args)
	default:
		fmt.Fprintf(os.Stderr, "rubban: unknown command %q\n", args[0])
		return 2
	}
}
