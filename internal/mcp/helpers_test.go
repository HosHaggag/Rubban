package mcp

import (
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

func newPipe() (*io.PipeReader, *io.PipeWriter) { return io.Pipe() }

// safeBuffer is a bytes.Buffer that can be read while the bridge is still writing.
type safeBuffer struct {
	mu sync.Mutex
	sb strings.Builder
}

func (b *safeBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.sb.Write(p)
}

func (b *safeBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.sb.String()
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		for !cond() {
			time.Sleep(5 * time.Millisecond)
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("condition not reached in time")
	}
}
