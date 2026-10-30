//go:build windows

package app

import (
	"syscall"
	"unsafe"
)

// showFatal shows a native error box; the GUI executable has no console.
func showFatal(title, message string) {
	user32 := syscall.NewLazyDLL("user32.dll")
	proc := user32.NewProc("MessageBoxW")
	t, _ := syscall.UTF16PtrFromString(title)
	m, _ := syscall.UTF16PtrFromString(message)
	const mbOK, mbIconError = 0x0, 0x10
	_, _, _ = proc.Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), mbOK|mbIconError)
}
