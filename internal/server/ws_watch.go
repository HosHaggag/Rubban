package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"sync"

	"github.com/coder/websocket"

	"github.com/HosHaggag/rubban/internal/live"
)

const (
	watchChunk    = 250
	watchQueueMax = 5000
)

// watchSession is one /api/watch socket. Messages are queued and written one at a time, so a large
// initial list applies socket backpressure instead of buffering unboundedly; more than watchQueueMax
// queued messages means the client cannot keep up and the socket is terminated.
type watchSession struct {
	conn   *websocket.Conn
	ctx    context.Context
	cancel context.CancelFunc

	mu               sync.Mutex
	queue            []any
	notify           chan struct{}
	closed           bool
	closeWhenDrained bool
}

func (s *watchSession) send(message any) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	if len(s.queue) > watchQueueMax {
		s.closed = true
		s.queue = nil
		s.mu.Unlock()
		_ = s.conn.CloseNow()
		s.cancel()
		return
	}
	s.queue = append(s.queue, message)
	s.mu.Unlock()
	select {
	case s.notify <- struct{}{}:
	default:
	}
}

// end sends a final message; the socket closes once the queue has drained.
func (s *watchSession) end(message any) {
	s.send(message)
	s.mu.Lock()
	s.closeWhenDrained = true
	s.mu.Unlock()
	select {
	case s.notify <- struct{}{}:
	default:
	}
}

func (s *watchSession) markClosed() {
	s.mu.Lock()
	s.closed = true
	s.queue = nil
	s.mu.Unlock()
}

func isClosed(s *watchSession) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}

func encodeMessage(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// writer sends queued messages, one in flight at a time.
func (s *watchSession) writer() {
	for {
		s.mu.Lock()
		if s.closed {
			s.mu.Unlock()
			return
		}
		if len(s.queue) == 0 {
			if s.closeWhenDrained {
				s.closed = true
				s.mu.Unlock()
				_ = s.conn.Close(websocket.StatusNormalClosure, "Watch ended")
				s.cancel()
				return
			}
			s.mu.Unlock()
			select {
			case <-s.notify:
			case <-s.ctx.Done():
				return
			}
			continue
		}
		next := s.queue[0]
		s.queue[0] = nil
		s.queue = s.queue[1:]
		s.mu.Unlock()
		data, err := encodeMessage(next)
		if err == nil {
			err = s.conn.Write(s.ctx, websocket.MessageText, data)
		}
		if err != nil {
			s.markClosed()
			_ = s.conn.CloseNow()
			s.cancel()
			return
		}
	}
}

// watchListener adapts a live watch to the socket protocol.
type watchListener struct{ s *watchSession }

func (l watchListener) Status(st live.Status) {
	m := obj{"type": "status", "state": st.State, "message": st.Message}
	if st.Attempt > 0 {
		m["attempt"] = st.Attempt
	}
	l.s.send(m)
}

func chunked(items []live.Object) [][]live.Object {
	var parts [][]live.Object
	for i := 0; i < len(items); i += watchChunk {
		end := i + watchChunk
		if end > len(items) {
			end = len(items)
		}
		parts = append(parts, items[i:end])
	}
	return parts
}

func (l watchListener) Reset(items []live.Object, resourceVersion string) {
	l.s.send(obj{"type": "reset"})
	for _, part := range chunked(items) {
		l.s.send(obj{"type": "items", "items": part})
	}
	l.s.send(obj{"type": "synced", "resourceVersion": resourceVersion, "count": len(items)})
}

func (l watchListener) Changes(upserts []live.Object, deletes []string) {
	parts := chunked(upserts)
	if len(parts) == 0 {
		parts = append(parts, []live.Object{})
	}
	if deletes == nil {
		deletes = []string{}
	}
	for i, part := range parts {
		d := []string{}
		if i == 0 {
			d = deletes
		}
		l.s.send(obj{"type": "changes", "upserts": part, "deletes": d})
	}
}

func (l watchListener) Fatal(err error) { l.s.end(watchError(err, 502)) }

func watchError(err error, fallbackStatus int) obj {
	err = liveProblem(err)
	status := statusOf(err)
	if status == 500 {
		status = fallbackStatus
	}
	return obj{"type": "error", "error": shortError(err), "status": status}
}

// serveWatch streams a resource: {type:'status'|'reset'|'items'|'synced'|'changes'|'error'|'unavailable'}.
func (b *Backend) serveWatch(w http.ResponseWriter, r *http.Request) {
	conn, err := b.acceptWS(w, r)
	if err != nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := &watchSession{conn: conn, ctx: ctx, cancel: cancel, notify: make(chan struct{}, 1)}
	go s.writer()

	var unsubscribe func()
	var unsubMu sync.Mutex
	defer func() {
		s.markClosed()
		unsubMu.Lock()
		if unsubscribe != nil {
			unsubscribe()
			unsubscribe = nil
		}
		unsubMu.Unlock()
	}()

	if b.live == nil {
		s.end(obj{"type": "unavailable", "message": "Live updates are not available in this mode; showing a snapshot."})
	} else if err := b.startWatch(ctx, s, r, func(stop func()) {
		unsubMu.Lock()
		defer unsubMu.Unlock()
		if isClosed(s) {
			stop()
			return
		}
		unsubscribe = stop
	}); err != nil {
		s.end(watchError(err, 400))
	}
	if b.live != nil {
		go func() {
			select {
			case <-b.live.Done():
				_ = conn.CloseNow()
				cancel()
			case <-ctx.Done():
			}
		}()
	}
	// Client messages are ignored; reading drives close detection.
	for {
		if _, _, err := conn.Read(ctx); err != nil {
			return
		}
	}
}

// startWatch validates the request and subscribes asynchronously (discovery may take a moment).
func (b *Backend) startWatch(ctx context.Context, s *watchSession, r *http.Request, attach func(stop func())) error {
	query := r.URL.Query()
	get := func(key string) any {
		if v, ok := query[key]; ok && len(v) > 0 {
			return v[len(v)-1]
		}
		return nil
	}
	kubeContext, err := validateText(get("context"), "context")
	if err != nil {
		return err
	}
	resource, err := validateResource(get("resource"))
	if err != nil {
		return err
	}
	namespace, err := validateNamespace(get("namespace"), true)
	if err != nil {
		return err
	}
	var opts live.WatchOptions
	opts.Resync = query.Get("resync") == "1"
	if query.Get("labelSelector") != "" {
		if opts.LabelSelector, err = validateSelector(query.Get("labelSelector"), "label selector"); err != nil {
			return err
		}
	}
	if query.Get("fieldSelector") != "" {
		if opts.FieldSelector, err = validateSelector(query.Get("fieldSelector"), "field selector"); err != nil {
			return err
		}
	}
	go func() {
		stop, err := b.live.Watch(ctx, kubeContext, resource, namespace, watchListener{s}, opts)
		if err != nil {
			if ctx.Err() == nil {
				s.end(watchError(err, 502))
			}
			return
		}
		attach(stop)
	}()
	return nil
}
