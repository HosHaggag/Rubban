// Package logging writes JSON-lines logs with size-based rotation.
package logging

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

const (
	DefaultMaxBytes = 5 * 1024 * 1024
	DefaultKeep     = 3
)

// Logger appends JSON lines to <dir>/rubban.log and rotates at MaxBytes.
// A nil *Logger is valid and discards everything.
type Logger struct {
	File string
	Dir  string

	mu       sync.Mutex
	size     int64
	maxBytes int64
	keep     int
}

// New creates a logger. maxBytes and keep fall back to 5 MiB and 3 when zero.
func New(dir string, maxBytes int64, keep int) *Logger {
	if maxBytes <= 0 {
		maxBytes = DefaultMaxBytes
	}
	if keep <= 0 {
		keep = DefaultKeep
	}
	l := &Logger{Dir: dir, File: filepath.Join(dir, "rubban.log"), maxBytes: maxBytes, keep: keep}
	if err := os.MkdirAll(dir, 0o755); err == nil {
		if st, err := os.Stat(l.File); err == nil {
			l.size = st.Size()
		}
	}
	return l
}

func (l *Logger) rotate() {
	_ = os.Remove(l.File + "." + strconv.Itoa(l.keep))
	for i := l.keep - 1; i >= 1; i-- {
		from := l.File + "." + strconv.Itoa(i)
		if _, err := os.Stat(from); err == nil {
			_ = os.Rename(from, l.File+"."+strconv.Itoa(i+1))
		}
	}
	_ = os.Rename(l.File, l.File+".1")
	l.size = 0
}

func (l *Logger) write(level, message, stack string, extra map[string]any) {
	if l == nil {
		return
	}
	entry := map[string]any{}
	for k, v := range extra {
		entry[k] = v
	}
	entry["time"] = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	entry["level"] = level
	entry["message"] = message
	if stack != "" {
		entry["stack"] = stack
	}
	data, err := json.Marshal(entry)
	if err != nil {
		return
	}
	data = append(data, '\n')
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.size+int64(len(data)) > l.maxBytes {
		l.rotate()
	}
	f, err := os.OpenFile(l.File, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	if n, err := f.Write(data); err == nil {
		l.size += int64(n)
	}
}

func (l *Logger) Info(message string, extra map[string]any) { l.write("info", message, "", extra) }
func (l *Logger) Warn(message string, extra map[string]any) { l.write("warn", message, "", extra) }

// Error logs err (with an optional stack) at error level.
func (l *Logger) Error(err error, extra map[string]any) {
	if err == nil {
		return
	}
	l.write("error", err.Error(), "", extra)
}

// ErrorStack logs a message with a stack trace, used for recovered panics.
func (l *Logger) ErrorStack(message, stack string, extra map[string]any) {
	l.write("error", message, stack, extra)
}
