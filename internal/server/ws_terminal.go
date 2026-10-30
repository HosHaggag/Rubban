package server

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

const (
	terminalInputLimit = 32 * 1024
	terminalDrainIdle  = 200 * time.Millisecond
	terminalDrainCap   = 2 * time.Second
	terminalCloseWait  = 2 * time.Second
)

// terminalSession is one /api/terminal socket and the command behind it.
type terminalSession struct {
	b      *Backend
	conn   *websocket.Conn
	ctx    context.Context
	cancel context.CancelFunc

	plan     *terminalPlan
	proc     terminalProcess
	pumpDone chan struct{}
	input    chan []byte
	lastData atomic.Int64 // unix nanoseconds of the last output
	closeOne sync.Once

	mu       sync.Mutex
	seen     string // recent output, searched for the node-shell debug pod
	debugPod string
}

func (b *Backend) serveTerminal(w http.ResponseWriter, r *http.Request) {
	conn, err := b.acceptWS(w, r)
	if err != nil {
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	s := &terminalSession{b: b, conn: conn, ctx: ctx, cancel: cancel, pumpDone: make(chan struct{}), input: make(chan []byte, 256)}
	b.term.add(s)
	defer func() {
		cancel()
		s.cleanup()
		b.term.remove(s)
	}()
	if b.isClosed() {
		s.fail(websocket.StatusInternalError, "Terminal failed", problem("Backend is closed", 503))
		return
	}
	query := map[string]string{}
	for k, v := range r.URL.Query() {
		if len(v) > 0 {
			query[k] = v[len(v)-1]
		}
	}
	if code, err := s.open(query); err != nil {
		reason := "Terminal failed"
		if code == websocket.StatusPolicyViolation {
			reason = "Invalid terminal request"
		}
		s.fail(code, reason, err)
		return
	}
	s.interact()
}

func (s *terminalSession) send(v any) { _ = sendWS(s.ctx, s.conn, v) }

func (s *terminalSession) fail(code websocket.StatusCode, reason string, err error) {
	s.send(map[string]any{"type": "error", "error": shortError(err)})
	_ = s.conn.Close(code, reason)
}

// open validates the request and starts the command, falling back to pipes when no PTY is available.
func (s *terminalSession) open(query map[string]string) (websocket.StatusCode, error) {
	cols, err := integer(query["cols"], "terminal columns", 20, 500, fb(100))
	if err != nil {
		return websocket.StatusPolicyViolation, err
	}
	rows, err := integer(query["rows"], "terminal rows", 5, 300, fb(30))
	if err != nil {
		return websocket.StatusPolicyViolation, err
	}
	plan, err := s.b.planTerminal(s.ctx, query)
	if err != nil {
		return websocket.StatusPolicyViolation, err
	}
	s.plan = plan
	spec := terminalSpec{Command: plan.command, Env: s.b.terminalEnv(plan, query["context"]), Dir: plan.dir, Cols: int(cols), Rows: int(rows)}
	if os.Getenv("RUBBAN_DISABLE_PTY") != "1" {
		spec.PTY, spec.Args = true, plan.args(true)
		proc, err := s.b.startTerminalProcess(spec)
		if err == nil {
			s.proc = proc
			s.send(map[string]any{"type": "status", "mode": "pty", "message": plan.statusMessage()})
			return 0, nil
		}
		s.send(map[string]any{"type": "status", "mode": "pipes", "message": "PTY unavailable; using command pipes without terminal resize: " + shortError(err)})
	}
	spec.PTY, spec.Args = false, plan.args(false)
	proc, err := s.b.startTerminalProcess(spec)
	if err != nil {
		return websocket.StatusInternalError, err
	}
	s.proc = proc
	s.send(map[string]any{"type": "status", "mode": "pipes", "message": "Command-pipe fallback: interactive TTY applications and resize are unavailable."})
	return 0, nil
}

func (p *terminalPlan) statusMessage() string {
	switch {
	case p.mode == "node":
		return "Node shell (privileged debug pod in kube-system)"
	case p.mode == "attach":
		return "Attached to container"
	case p.remote:
		return "Interactive pod terminal"
	}
	return "Interactive local terminal"
}

// interact pumps output to the socket and input to the command until either side ends.
func (s *terminalSession) interact() {
	go s.pump()
	go func() {
		code, _ := s.proc.Wait()
		s.finish(code)
	}()
	go s.writeInput()
	for {
		_, data, err := s.conn.Read(s.ctx)
		if err != nil {
			return
		}
		s.handle(data)
	}
}

func (s *terminalSession) pump() {
	defer close(s.pumpDone)
	buf := make([]byte, 32*1024)
	var carry utf8Carry
	for {
		n, err := s.proc.Read(buf)
		if n > 0 {
			s.emit(carry.next(buf[:n]))
		}
		if err != nil {
			s.emit(carry.flush())
			return
		}
	}
}

func (s *terminalSession) emit(text string) {
	if text == "" {
		return
	}
	s.lastData.Store(time.Now().UnixNano())
	if s.plan.mode == "node" {
		s.watchOutput(text)
	}
	if err := sendWS(s.ctx, s.conn, map[string]any{"type": "data", "data": text}); err != nil {
		s.cancel()
	}
}

// watchOutput captures the name of the node-shell debug pod from kubectl's output.
func (s *terminalSession) watchOutput(text string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.debugPod != "" {
		return
	}
	s.seen += text
	if r := []rune(s.seen); len(r) > 2000 {
		s.seen = string(r[len(r)-2000:])
	}
	if m := debugPodRE.FindStringSubmatch(s.seen); m != nil {
		s.debugPod = m[1]
	}
}

func (s *terminalSession) writeInput() {
	for {
		select {
		case <-s.ctx.Done():
			return
		case data := <-s.input:
			_, _ = s.proc.Write(data)
		}
	}
}

func (s *terminalSession) handle(data []byte) {
	var msg map[string]any
	if err := json.Unmarshal(data, &msg); err != nil || msg == nil {
		s.send(map[string]any{"type": "error", "error": "Unsupported terminal message"})
		return
	}
	if err := s.apply(msg); err != nil {
		s.send(map[string]any{"type": "error", "error": shortError(err)})
	}
}

func (s *terminalSession) apply(msg map[string]any) error {
	switch msg["type"] {
	case "input":
		text, ok := msg["data"].(string)
		if !ok || len(text) > terminalInputLimit {
			return problem("Terminal input exceeds 32 KiB", 400)
		}
		select {
		case s.input <- []byte(text):
		default:
			return problem("Terminal input is backed up", 400)
		}
	case "resize":
		cols, err := integer(msg["cols"], "terminal columns", 20, 500, nil)
		if err != nil {
			return err
		}
		rows, err := integer(msg["rows"], "terminal rows", 5, 300, nil)
		if err != nil {
			return err
		}
		return s.proc.Resize(int(cols), int(rows))
	default:
		return problem("Unsupported terminal message", 400)
	}
	return nil
}

// finish reports the command's exit after its remaining output was sent.
func (s *terminalSession) finish(code int) {
	// A ConPTY output pipe, or a background process holding the TTY, only ends when the PTY is closed:
	// give the pump the chance to flush what the command printed last, then close it.
	start := time.Now()
	tick := time.NewTicker(25 * time.Millisecond)
	defer tick.Stop()
drain:
	for {
		select {
		case <-s.pumpDone:
			break drain
		case <-s.ctx.Done():
			return
		case now := <-tick.C:
			quietSince := time.Unix(0, s.lastData.Load())
			if quietSince.Before(start) {
				quietSince = start
			}
			if now.Sub(quietSince) > terminalDrainIdle || now.Sub(start) > terminalDrainCap {
				break drain
			}
		}
	}
	s.closeProc()
	select {
	case <-s.pumpDone:
	case <-time.After(terminalCloseWait):
	}
	if s.ctx.Err() != nil {
		return
	}
	s.send(map[string]any{"type": "exit", "code": code})
	_ = s.conn.Close(websocket.StatusNormalClosure, "Terminal exited")
}

// closeProc closes the PTY or pipes without letting a stuck close hold the session.
func (s *terminalSession) closeProc() {
	s.closeOne.Do(func() {
		done := make(chan struct{})
		go func() { _ = s.proc.Close(); close(done) }()
		select {
		case <-done:
		case <-time.After(terminalCloseWait):
		}
	})
}

// cleanup kills the command, deletes the node-shell debug pod and the scoped kubeconfig.
func (s *terminalSession) cleanup() {
	if s.proc != nil {
		s.proc.Kill()
		s.closeProc()
		select {
		case <-s.pumpDone:
		case <-time.After(terminalCloseWait):
		}
	}
	s.removeDebugPod()
	if s.plan != nil && s.plan.kubeconfig != "" {
		_ = os.Remove(s.plan.kubeconfig)
	}
	_ = s.conn.CloseNow()
}

// removeDebugPod deletes the node-shell pod once the session ends.
func (s *terminalSession) removeDebugPod() {
	s.mu.Lock()
	pod := s.debugPod
	s.debugPod = ""
	s.mu.Unlock()
	if pod == "" || s.b.isClosed() {
		return
	}
	args, err := contextArgs(s.plan.kubeCtx)
	if err != nil {
		return
	}
	args = append(args, "--namespace=kube-system", "delete", "pod", pod, "--wait=false", "--ignore-not-found=true")
	_, _ = s.b.kube(context.Background(), args, RunOptions{Timeout: 30 * time.Second})
}
