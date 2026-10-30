package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/HosHaggag/rubban/internal/mcp"
)

// runMCP is `rubban mcp [--connection-file PATH]`: the stdio MCP bridge.
func runMCP(args []string) int {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return mcp.Run(ctx, args, os.Stdin, os.Stdout, os.Stderr, os.Getenv)
}
