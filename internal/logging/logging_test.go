package logging

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWritesJSONLines(t *testing.T) {
	dir := t.TempDir()
	l := New(dir, 0, 0)
	l.Info("hello", map[string]any{"route": "/api/x"})
	l.Error(errors.New("boom"), nil)
	data, err := os.ReadFile(filepath.Join(dir, "rubban.log"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 2 || !strings.Contains(lines[0], `"message":"hello"`) || !strings.Contains(lines[0], `"route":"/api/x"`) || !strings.Contains(lines[1], `"level":"error"`) {
		t.Fatalf("unexpected log: %s", data)
	}
	info, _ := os.Stat(filepath.Join(dir, "rubban.log"))
	if runtimeUnix() && info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", info.Mode().Perm())
	}
}

func TestRotates(t *testing.T) {
	dir := t.TempDir()
	l := New(dir, 300, 2)
	for i := 0; i < 20; i++ {
		l.Info(strings.Repeat("x", 80), nil)
	}
	for _, name := range []string{"rubban.log", "rubban.log.1", "rubban.log.2"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Fatalf("missing %s", name)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "rubban.log.3")); err == nil {
		t.Fatal("kept too many files")
	}
}

func TestNilLoggerIsSafe(t *testing.T) {
	var l *Logger
	l.Info("x", nil)
	l.Error(errors.New("x"), nil)
}
