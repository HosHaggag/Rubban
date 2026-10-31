package server

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Selector logs follow every pod of a workload at once, like stern: one `kubectl logs` per container,
// every line prefixed with [pod/container], and pods that appear or disappear while the dock is open
// are picked up or dropped. Log text goes out as text frames; the control messages the UI needs
// ({"type":"pods"} and {"type":"reader"}) go out as binary frames, which cannot be mistaken for a log
// line.

// defaultLogPoll is how often the pod list of a selector is read again (Backend.logPoll overrides it in tests).
const defaultLogPoll = 10 * time.Second

// restartSince is how many seconds back a reader looks when it is started again after its kubectl ended
// while the pod was still running.
const restartSince = 5

type multiLog struct {
	context, namespace, selector string
	container                    string // "" or "*": every container; otherwise that container
	follow, timestamps, previous bool
	tail                         int64
	since                        int64
	maxReaders                   int
}

func parseMultiLog(query map[string]string) (multiLog, error) {
	get := func(k string) any {
		if v, ok := query[k]; ok {
			return v
		}
		return nil
	}
	var m multiLog
	var err error
	if m.context, err = validateText(get("context"), "context"); err != nil {
		return m, err
	}
	if m.namespace, err = validateNamespace(get("namespace"), false); err != nil {
		return m, err
	}
	if m.namespace == "" {
		return m, bad("Choose one namespace for pod logs")
	}
	sel, err := validateTextOpt(query["selector"], "selector", true, 2000)
	if err != nil {
		return m, err
	}
	if !selectorRE.MatchString(sel) || strings.Contains(sel, "--") {
		return m, bad("Invalid label selector")
	}
	m.selector = sel
	switch c := query["container"]; c {
	case "", "*":
		m.container = ""
	default:
		if m.container, err = validateName(c, "container"); err != nil {
			return m, err
		}
	}
	m.follow = query["follow"] != "false"
	m.timestamps = query["timestamps"] == "true"
	if p := query["previous"]; p == "true" {
		m.previous, m.follow = true, false
	} else if p != "" && p != "false" {
		return m, bad("Invalid previous-log flag")
	}
	if m.tail, err = integer(get("tail"), "tail lines", -1, 100000, fb(100)); err != nil {
		return m, err
	}
	if query["since"] != "" {
		if m.since, err = integer(get("since"), "since seconds", 1, 30*86400, nil); err != nil {
			return m, err
		}
	}
	max, err := integer(get("maxRequests"), "max log requests", 1, 50, fb(20))
	if err != nil {
		return m, err
	}
	m.maxReaders = int(max)
	return m, nil
}

// readerArgs is the kubectl command line of one container's reader. A restarted reader asks for the
// last few seconds instead of the tail, so the lines it already sent are not repeated.
func (m multiLog) readerArgs(pod, container string, restarted bool) []string {
	args := []string{"--context=" + m.context, "--namespace=" + m.namespace, "logs", pod, "--container=" + container, fmt.Sprintf("--follow=%t", m.follow)}
	if restarted {
		args = append(args, fmt.Sprintf("--since=%ds", restartSince))
	} else {
		args = append(args, fmt.Sprintf("--tail=%d", m.tail))
		if m.since > 0 {
			args = append(args, fmt.Sprintf("--since=%ds", m.since))
		}
	}
	if m.timestamps {
		args = append(args, "--timestamps=true")
	}
	if m.previous {
		args = append(args, "--previous=true")
	}
	return args
}

type logPod struct {
	Pod        string   `json:"pod"`
	Containers []string `json:"containers"`
	Phase      string   `json:"phase"`
}

type logReader struct {
	pod, container string
	child          childProc
	buf            string
	restarted      bool
	stopped        bool // killed on purpose: no restart
	gen            int
}

type multiLogSession struct {
	b      *Backend
	conn   *websocket.Conn
	ctx    context.Context
	cancel context.CancelFunc
	req    multiLog
	tool   string

	wmu sync.Mutex // one websocket write at a time

	mu      sync.Mutex
	pods    map[string]logPod
	readers map[string]*logReader // pod/container
	live    int                   // readers that have not ended
	warned  bool
	started bool
	idle    chan struct{} // signalled when a reader ends (follow=false sessions finish with the last one)
}

func (s *multiLogSession) writeText(text string) bool {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	return s.conn.Write(s.ctx, websocket.MessageText, []byte(text)) == nil
}

func (s *multiLogSession) control(v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	s.wmu.Lock()
	defer s.wmu.Unlock()
	if s.conn.Write(s.ctx, websocket.MessageBinary, data) != nil {
		s.cancel()
	}
}

func (b *Backend) spawnLogChild(command string, args, env []string, hooks childHooks) (childProc, error) {
	if b.childSpawn != nil {
		return b.childSpawn(command, args, env, hooks)
	}
	return b.spawnChild(command, args, env, hooks)
}

// emit prefixes complete lines of a reader's output and keeps the unfinished line for the next chunk.
func (s *multiLogSession) emit(r *logReader, gen int, chunk string, flush bool) {
	s.mu.Lock()
	if r.gen != gen {
		s.mu.Unlock()
		return
	}
	r.buf += chunk
	var out strings.Builder
	prefix := "[" + r.pod + "/" + r.container + "] "
	for {
		i := strings.IndexByte(r.buf, '\n')
		if i < 0 {
			break
		}
		out.WriteString(prefix + strings.TrimSuffix(r.buf[:i], "\r") + "\n")
		r.buf = r.buf[i+1:]
	}
	if flush && r.buf != "" {
		out.WriteString(prefix + r.buf + "\n")
		r.buf = ""
	}
	s.mu.Unlock()
	if out.Len() > 0 && !s.writeText(out.String()) {
		s.cancel()
	}
}

// startReader launches kubectl logs for one container (requires s.mu is NOT held).
func (s *multiLogSession) startReader(pod, container string, restarted bool) {
	key := pod + "/" + container
	s.mu.Lock()
	if s.ctx.Err() != nil {
		s.mu.Unlock()
		return
	}
	r := s.readers[key]
	if r == nil {
		if len(s.readers) >= s.req.maxReaders {
			warn := !s.warned
			s.warned = true
			s.mu.Unlock()
			if warn {
				s.writeText(fmt.Sprintf("[rubban] Following the first %d containers; the others are not shown.\n", s.req.maxReaders))
			}
			return
		}
		r = &logReader{pod: pod, container: container}
		s.readers[key] = r
	}
	r.gen++
	gen := r.gen
	r.restarted, r.stopped, r.buf = restarted, false, ""
	s.live++
	s.mu.Unlock()
	hooks := childHooks{
		output: func(chunk string) { s.emit(r, gen, chunk, false) },
		exited: func(code int) { s.readerExited(r, gen, code) },
	}
	child, err := s.b.spawnLogChild(s.tool, s.req.readerArgs(pod, container, restarted), s.b.kubeEnv(), hooks)
	if err != nil {
		s.writeText(fmt.Sprintf("[%s/%s] could not start kubectl logs: %s\n", pod, container, shortError(err)))
		s.mu.Lock()
		s.live--
		delete(s.readers, key)
		s.mu.Unlock()
		s.signalIdle()
		return
	}
	s.mu.Lock()
	r.child = child
	stopped := r.stopped || s.ctx.Err() != nil
	s.mu.Unlock()
	if stopped {
		child.kill()
	}
	s.control(map[string]any{"type": "reader", "pod": pod, "container": container, "state": "started"})
}

func (s *multiLogSession) readerExited(r *logReader, gen int, code int) {
	s.emit(r, gen, "", true)
	s.mu.Lock()
	if r.gen != gen {
		s.mu.Unlock()
		return
	}
	pod, running := s.pods[r.pod]
	again := s.req.follow && !r.stopped && !r.restarted && s.ctx.Err() == nil && running && pod.Phase == "Running"
	s.live-- // a restart is counted again by startReader
	s.mu.Unlock()
	s.control(map[string]any{"type": "reader", "pod": r.pod, "container": r.container, "state": "ended", "code": code})
	if again {
		s.startReader(r.pod, r.container, true)
		return
	}
	s.signalIdle()
}

func (s *multiLogSession) signalIdle() {
	select {
	case s.idle <- struct{}{}:
	default:
	}
}

func podsOf(doc obj) []logPod {
	var out []logPod
	for _, it := range listOf(doc["items"]) {
		item := objOf(it)
		meta := objOf(item["metadata"])
		name := strOf(meta["name"])
		if name == "" {
			continue
		}
		containers := []string{}
		for _, c := range listOf(objOf(item["spec"])["containers"]) {
			if n := strOf(objOf(c)["name"]); n != "" {
				containers = append(containers, n)
			}
		}
		out = append(out, logPod{Pod: name, Containers: containers, Phase: strOf(objOf(item["status"])["phase"])})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Pod < out[j].Pod })
	return out
}

// sync reads the pod list and starts readers for new pods and containers and stops readers of pods that
// are gone. It reports whether the list could be read.
func (s *multiLogSession) sync() error {
	doc, err := s.b.listObjects(s.ctx, s.req.context, "pods", s.req.namespace, ListOptions{LabelSelector: s.req.selector})
	if err != nil {
		return err
	}
	pods := podsOf(doc)
	byName := map[string]logPod{}
	for _, p := range pods {
		byName[p.Pod] = p
	}
	s.mu.Lock()
	changed := len(byName) != len(s.pods)
	for name, p := range byName {
		if old, ok := s.pods[name]; !ok || old.Phase != p.Phase || strings.Join(old.Containers, ",") != strings.Join(p.Containers, ",") {
			changed = true
		}
	}
	s.pods = byName
	var gone []childProc
	for key, r := range s.readers {
		if _, ok := byName[r.pod]; !ok {
			r.stopped = true
			if r.child != nil {
				gone = append(gone, r.child)
			}
			delete(s.readers, key)
		}
	}
	s.mu.Unlock()
	for _, child := range gone {
		child.kill()
	}
	if changed || !s.started {
		items := pods
		if items == nil {
			items = []logPod{}
		}
		s.control(map[string]any{"type": "pods", "items": items})
	}
	s.started = true
	for _, p := range pods {
		// Pods that have not started have no log yet; finished pods are read once, from the tail.
		if p.Phase == "Pending" || p.Phase == "" {
			continue
		}
		for _, c := range p.Containers {
			if s.req.container != "" && c != s.req.container {
				continue
			}
			s.mu.Lock()
			_, known := s.readers[p.Pod+"/"+c]
			s.mu.Unlock()
			if !known {
				s.startReader(p.Pod, c, false)
			}
		}
	}
	return nil
}

// run drives the session until the socket closes, or (follow=false) until every reader ended.
func (s *multiLogSession) run() error {
	if err := s.sync(); err != nil {
		return err
	}
	if !s.req.follow {
		for {
			s.mu.Lock()
			done := s.live <= 0
			s.mu.Unlock()
			if done {
				return nil
			}
			select {
			case <-s.idle:
			case <-s.ctx.Done():
				return nil
			}
		}
	}
	interval := s.b.logPoll
	if interval <= 0 {
		interval = defaultLogPoll
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return nil
		case <-ticker.C:
			// A failed poll is retried on the next tick; the readers keep running.
			_ = s.sync()
		}
	}
}

func (s *multiLogSession) killAll() {
	s.mu.Lock()
	var children []childProc
	for _, r := range s.readers {
		r.stopped = true
		if r.child != nil {
			children = append(children, r.child)
		}
	}
	s.mu.Unlock()
	for _, c := range children {
		c.kill()
	}
}

func (b *Backend) serveMultiLogs(conn *websocket.Conn, ctx context.Context, cancel context.CancelFunc, query map[string]string) {
	fail := func(code websocket.StatusCode, reason string, err error) {
		_ = conn.Write(ctx, websocket.MessageText, []byte("[error] "+shortError(err)+"\n"))
		_ = conn.Close(code, reason)
	}
	req, err := parseMultiLog(query)
	if err != nil {
		fail(websocket.StatusPolicyViolation, "Invalid log request", err)
		return
	}
	tool, err := b.requireTool("kubectl")
	if err != nil {
		fail(websocket.StatusPolicyViolation, "Invalid log request", err)
		return
	}
	s := &multiLogSession{b: b, conn: conn, ctx: ctx, cancel: cancel, req: req, tool: tool, pods: map[string]logPod{}, readers: map[string]*logReader{}, idle: make(chan struct{}, 1)}
	// Reading drives close detection; closing the socket ends every reader.
	go func() {
		for {
			if _, _, err := conn.Read(ctx); err != nil {
				cancel()
				return
			}
		}
	}()
	defer s.killAll()
	if err := s.run(); err != nil {
		if ctx.Err() == nil {
			b.noteLogAuth(err, req.context)
			fail(websocket.StatusInternalError, "Log command failed", err)
		}
		return
	}
	if ctx.Err() != nil {
		_ = conn.CloseNow()
		return
	}
	_ = conn.Close(websocket.StatusNormalClosure, "Log stream ended")
}

// noteLogAuth records expired credentials found while listing pods for a log stream.
func (b *Backend) noteLogAuth(err error, kubeContext string) {
	b.tagCredentials(liveProblem(err), kubeContext)
}
