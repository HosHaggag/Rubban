// Package mcp is the stdio Model Context Protocol bridge behind `rubban mcp`: read-only access to
// the locally running Rubban backend.
package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sync"
)

const (
	maxLine     = 64 * 1024
	maxInFlight = 8
)

// Run is `rubban mcp`: it reads newline-delimited JSON-RPC from in until EOF (or ctx is done) and
// writes replies to out. Only protocol messages go to out; diagnostics go to errOut. It returns the
// process exit code.
func Run(ctx context.Context, args []string, in io.Reader, out io.Writer, errOut io.Writer, env func(string) string) int {
	if env == nil {
		env = func(string) string { return "" }
	}
	conn, err := LoadConnection(args, env)
	if err != nil {
		fmt.Fprintln(errOut, err.Error())
		return 1
	}
	Serve(ctx, NewBridge(conn, nil), in, out)
	return 0
}

// Serve runs the stdio loop for an already-built bridge.
func Serve(ctx context.Context, b *Bridge, in io.Reader, out io.Writer) {
	var writeMu sync.Mutex
	send := func(r *response) {
		if r == nil {
			return
		}
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		enc.SetEscapeHTML(false)
		if enc.Encode(r) != nil {
			return
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		_, _ = out.Write(buf.Bytes()) // Encode already appended the newline.
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var (
		wg      sync.WaitGroup
		stateMu sync.Mutex
		active  int
	)
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		reader := bufio.NewReaderSize(in, 16*1024)
		var line []byte
		for {
			chunk, err := reader.ReadSlice('\n')
			line = append(line, chunk...)
			if err == bufio.ErrBufferFull {
				if len(line) > maxLine {
					send(errorResponse(nil, -32600, "Message exceeds 64 KiB"))
					return
				}
				continue
			}
			if err != nil {
				return // EOF: an unterminated last line is not a message.
			}
			text := line[:len(line)-1]
			line = nil
			if len(text) > maxLine {
				send(errorResponse(nil, -32600, "Message exceeds 64 KiB"))
				return
			}
			if len(bytes.TrimSpace(text)) == 0 {
				continue
			}
			var raw json.RawMessage
			if json.Unmarshal(text, &raw) != nil {
				send(errorResponse(nil, -32700, "Parse error"))
				continue
			}
			var msg map[string]json.RawMessage
			if json.Unmarshal(raw, &msg) != nil {
				msg = nil
			}
			stateMu.Lock()
			busy := active >= maxInFlight
			stateMu.Unlock()
			if busy {
				if id, has := msg["id"]; has {
					send(errorResponse(id, -32000, "Too many outstanding requests"))
				}
				continue
			}
			immediate, async := dispatch(b, msg)
			send(immediate)
			if async != nil {
				stateMu.Lock()
				active++
				stateMu.Unlock()
				wg.Add(1)
				go func() {
					defer wg.Done()
					defer func() { stateMu.Lock(); active--; stateMu.Unlock() }()
					defer func() {
						if recover() != nil {
							send(errorResponse(msg["id"], -32603, "Internal error"))
						}
					}()
					send(async(ctx))
				}()
			}
		}
	}()

	select {
	case <-finished:
	case <-ctx.Done():
	}
	wg.Wait()
}

// dispatch runs the synchronous half of handle, turning a panic into -32603.
func dispatch(b *Bridge, msg map[string]json.RawMessage) (immediate *response, async func(context.Context) *response) {
	defer func() {
		if recover() != nil {
			immediate, async = errorResponse(msg["id"], -32603, "Internal error"), nil
		}
	}()
	return b.handle(msg)
}
