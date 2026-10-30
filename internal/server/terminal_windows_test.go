//go:build windows

package server

// The real-process terminal tests need /bin/sh and skip themselves on Windows.
func processGone(int) bool { return true }
