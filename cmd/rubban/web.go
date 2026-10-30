package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"

	rubban "github.com/HosHaggag/rubban"
	"github.com/HosHaggag/rubban/internal/logging"
	"github.com/HosHaggag/rubban/internal/server"
)

// webDataDir is RUBBAN_DATA_DIR, else ./data.
func webDataDir() string {
	if dir := os.Getenv("RUBBAN_DATA_DIR"); dir != "" {
		return dir
	}
	cwd, _ := os.Getwd()
	return filepath.Join(cwd, "data")
}

// writeConnectionFile publishes the backend URL and token for the MCP bridge (mode 0600).
func writeConnectionFile(dataDir string, conn server.Connection) (string, error) {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return "", err
	}
	file := filepath.Join(dataDir, "connection.json")
	data, err := json.MarshalIndent(map[string]any{"url": conn.URL, "port": conn.Port, "token": conn.Token, "pid": os.Getpid()}, "", "  ")
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(file, data, 0o600); err != nil {
		return "", err
	}
	return file, nil
}

// runWeb is `rubban web`: the backend and UI in a browser, no desktop shell.
func runWeb(args []string) int {
	fs := flag.NewFlagSet("web", flag.ContinueOnError)
	logDir := fs.String("log", "", "write a log file in this directory")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	dataDir := webDataDir()
	var logger *logging.Logger
	if *logDir != "" {
		logger = logging.New(*logDir, 0, 0)
	}
	backend := server.New(server.Options{DataDir: dataDir, Logger: logger, UI: rubban.UI()})
	port := 0
	if v := os.Getenv("RUBBAN_PORT"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			fmt.Fprintln(os.Stderr, "RUBBAN_PORT must be a number")
			return 1
		}
		port = n
	}
	conn, err := backend.Start(port)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	file, err := writeConnectionFile(dataDir, conn)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		_ = backend.Close()
		return 1
	}
	fmt.Printf("Rubban web interface: %s\n", conn.URL)
	fmt.Printf("Local MCP connection file: %s\n", file)
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	_ = backend.Close()
	_ = os.Remove(file)
	return 0
}
