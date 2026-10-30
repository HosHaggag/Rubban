package server

import (
	"context"
	"crypto/rand"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Port forwards are `kubectl port-forward` children. An embedded console (see embedproxy.go) sits
// in front of one: the proxy keeps its port - the iframe's origin - for as long as the console is
// open, while the kubectl behind it is restarted on the next request when it dies (kubectl exits
// with "lost connection to pod" when the API server stalls), so the page keeps working instead of
// needing a reconnect.
//
// Backend has no field for this state, so it lives in fwdState, found through fwdStateOf. The state
// registers a hook with Backend.trackRun, which Backend.Close calls, so Close also stops the forwards
// and closes the consoles.

var fwdReadyRE = regexp.MustCompile(`Forwarding from (?:127\.0\.0\.1|\[::1\]):(\d+)`)

// childHooks receive what a spawned child does. output is called for every chunk of stdout and
// stderr; exited is called once, after the output has ended.
type childHooks struct {
	output func(chunk string)
	exited func(code int)
}

// childProc is a running child process.
type childProc interface{ kill() }

// childSpawner starts a child process. Tests inject one to fake `kubectl port-forward`.
type childSpawner func(command string, args, env []string, hooks childHooks) (childProc, error)

type execChild struct {
	proc *os.Process
	once sync.Once
}

func (c *execChild) kill() { c.once.Do(func() { killProcess(c.proc) }) }

// spawnChild is the real spawner: no shell, own process group, tracked so Backend.Close kills it.
func (b *Backend) spawnChild(command string, args, env []string, hooks childHooks) (childProc, error) {
	if b.isClosed() {
		return nil, problem("Backend is closed", 503)
	}
	for _, a := range append([]string{command}, args...) {
		if strings.ContainsRune(a, 0) {
			return nil, bad("Invalid process arguments")
		}
	}
	cmd := exec.Command(command, args...)
	configureCommand(cmd)
	cmd.Env = env
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	b.procs.add(cmd.Process)
	var readers sync.WaitGroup
	for _, stream := range []interface{ Read([]byte) (int, error) }{stdout, stderr} {
		readers.Add(1)
		go func() {
			defer readers.Done()
			buf := make([]byte, 4096)
			for {
				n, err := stream.Read(buf)
				if n > 0 {
					hooks.output(string(buf[:n]))
				}
				if err != nil {
					return
				}
			}
		}()
	}
	go func() {
		readers.Wait()
		code := 0
		if err := cmd.Wait(); err != nil {
			code = -1
			if ee, ok := err.(*exec.ExitError); ok {
				code = ee.ExitCode()
			}
		}
		b.procs.remove(cmd.Process)
		hooks.exited(code)
	}()
	return &execChild{proc: cmd.Process}, nil
}

// fwdSpec identifies the forwarded target.
type fwdSpec struct {
	context, namespace, resource, name string
	remotePort                         int
}

// portForward is one kubectl port-forward. Fields are guarded by fwdState.mu.
type portForward struct {
	id         string
	spec       fwdSpec
	localPort  int
	status     string // starting, ready, error, stopped
	err        string
	createdAt  string
	child      childProc
	log        string
	done       chan struct{} // closed once the child has exited (or never started)
	doneClosed bool
}

func (f *portForward) active() bool { return f.status == "starting" || f.status == "ready" }

// fwdConsole is one embedded console and the forward behind it.
type fwdConsole struct {
	forward    *portForward
	embed      *embedProxy
	restarting *fwdRestart
}

// fwdRestart lets every request that arrives while a forward is being restarted share that restart.
type fwdRestart struct {
	done chan struct{}
	port int
	err  error
}

type fwdState struct {
	b       *Backend
	mu      sync.Mutex
	list    []*portForward
	console map[string]*fwdConsole
	closed  bool
	// spawn replaces process spawning (tests); nil uses the real kubectl.
	spawn childSpawner
}

var fwdStates sync.Map // *Backend -> *fwdState

// fwdStateOf returns the backend's forward state, creating it on first use.
func fwdStateOf(b *Backend) *fwdState {
	if v, ok := fwdStates.Load(b); ok {
		return v.(*fwdState)
	}
	s := &fwdState{b: b, console: map[string]*fwdConsole{}}
	if actual, loaded := fwdStates.LoadOrStore(b, s); loaded {
		return actual.(*fwdState)
	}
	// Backend.Close cancels every tracked run; this one shuts the forwards down.
	b.trackRun(s.shutdown)
	return s
}

// shutdown marks every forward stopped, kills its kubectl and closes every console.
func (s *fwdState) shutdown() {
	s.mu.Lock()
	s.closed = true
	forwards := s.list
	consoles := s.console
	s.list, s.console = nil, map[string]*fwdConsole{}
	for _, f := range forwards {
		f.status = "stopped"
	}
	s.mu.Unlock()
	fwdStates.Delete(s.b)
	for _, f := range forwards {
		if f.child != nil {
			f.child.kill()
		}
	}
	for _, c := range consoles {
		c.embed.close()
	}
}

func fwdNewID() string {
	raw := make([]byte, 16)
	_, _ = rand.Read(raw)
	raw[6] = raw[6]&0x0f | 0x40
	raw[8] = raw[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16])
}

type fwdView struct {
	ID         string `json:"id"`
	Context    string `json:"context"`
	Namespace  string `json:"namespace"`
	Resource   string `json:"resource"`
	Name       string `json:"name"`
	LocalPort  int    `json:"localPort"`
	RemotePort int    `json:"remotePort"`
	Status     string `json:"status"`
	Error      string `json:"error,omitempty"`
	CreatedAt  string `json:"createdAt"`
	EmbedPort  int    `json:"embedPort,omitempty"`
}

// viewLocked requires s.mu.
func (s *fwdState) viewLocked(f *portForward) fwdView {
	v := fwdView{ID: f.id, Context: f.spec.context, Namespace: f.spec.namespace, Resource: f.spec.resource, Name: f.spec.name,
		LocalPort: f.localPort, RemotePort: f.spec.remotePort, Status: f.status, Error: f.err, CreatedAt: f.createdAt}
	for _, c := range s.console {
		if c.forward.id == f.id {
			v.EmbedPort = c.embed.port
			break
		}
	}
	return v
}

func (s *fwdState) views() []fwdView {
	s.mu.Lock()
	defer s.mu.Unlock()
	views := make([]fwdView, 0, len(s.list))
	for _, f := range s.list {
		views = append(views, s.viewLocked(f))
	}
	return views
}

func (s *fwdState) findLocked(id string) *portForward {
	for _, f := range s.list {
		if f.id == id {
			return f
		}
	}
	return nil
}

func (s *fwdState) removeLocked(id string) {
	for i, f := range s.list {
		if f.id == id {
			s.list = append(s.list[:i:i], s.list[i+1:]...)
			return
		}
	}
}

func (f *portForward) finish() {
	if !f.doneClosed {
		f.doneClosed = true
		close(f.done)
	}
}

// start spawns kubectl port-forward. localPort 0 lets kubectl choose a free port; the chosen port is
// read from its output.
func (s *fwdState) start(spec fwdSpec, localPort int) (*portForward, error) {
	b := s.b
	if b.isClosed() {
		return nil, problem("Backend is closed", 503)
	}
	tool, err := b.requireTool("kubectl")
	if err != nil {
		return nil, err
	}
	args := []string{"--context=" + spec.context}
	if spec.namespace != "" {
		args = append(args, "--namespace="+spec.namespace)
	}
	target := ""
	if localPort != 0 {
		target = fmt.Sprint(localPort)
	}
	args = append(args, "port-forward", spec.resource+"/"+spec.name, fmt.Sprintf("%s:%d", target, spec.remotePort), "--address=127.0.0.1")
	f := &portForward{id: fwdNewID(), spec: spec, localPort: localPort, status: "starting", createdAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), done: make(chan struct{})}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, problem("Backend is closed", 503)
	}
	if localPort != 0 {
		for _, other := range s.list {
			if other.localPort == localPort && other.active() {
				return nil, problem("This local port already has a Rubban forward", 409)
			}
		}
	}
	hooks := childHooks{
		output: func(chunk string) { s.output(f, chunk) },
		exited: func(code int) { s.exited(f, code) },
	}
	spawn := s.spawn
	if spawn == nil {
		spawn = b.spawnChild
	}
	child, err := spawn(tool, args, b.kubeEnv(), hooks)
	s.list = append(s.list, f)
	if err != nil {
		f.status, f.err = "error", shortError(err)
		f.finish()
		return f, nil
	}
	f.child = child
	return f, nil
}

func (s *fwdState) output(f *portForward, chunk string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	log := f.log + chunk
	if len(log) > 8000 {
		log = log[len(log)-8000:]
	}
	f.log = log
	if m := fwdReadyRE.FindStringSubmatch(log); m != nil && f.status == "starting" {
		f.status = "ready"
		if f.localPort == 0 {
			fmt.Sscan(m[1], &f.localPort)
		}
	}
}

func (s *fwdState) exited(f *portForward, code int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	defer f.finish()
	if f.status == "stopped" {
		return
	}
	if code == 0 {
		f.status = "stopped"
		return
	}
	f.status = "error"
	f.err = strings.TrimSpace(strings.ToValidUTF8(f.log, ""))
	if f.err == "" {
		f.err = fmt.Sprintf("kubectl port-forward exited with code %d", code)
	}
}

// create handles POST /api/forwards.
func (s *fwdState) create(body map[string]any) (fwdView, error) {
	var spec fwdSpec
	var err error
	if spec.context, err = validateText(body["context"], "context"); err != nil {
		return fwdView{}, err
	}
	if spec.namespace, err = validateNamespace(body["namespace"], false); err != nil {
		return fwdView{}, err
	}
	if spec.resource, err = validateResource(body["resource"]); err != nil {
		return fwdView{}, err
	}
	if spec.name, err = validateName(body["name"], "name"); err != nil {
		return fwdView{}, err
	}
	local, err := integer(body["localPort"], "local port", 0, 65535, fb(0))
	if err != nil {
		return fwdView{}, err
	}
	remote, err := integer(body["remotePort"], "remote port", 1, 65535, nil)
	if err != nil {
		return fwdView{}, err
	}
	spec.remotePort = int(remote)
	f, err := s.start(spec, int(local))
	if err != nil {
		return fwdView{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.viewLocked(f), nil
}

// stop handles DELETE /api/forwards/:id.
func (s *fwdState) stop(ctx context.Context, id string) error {
	s.mu.Lock()
	f := s.findLocked(id)
	if f == nil {
		s.mu.Unlock()
		return problem("Port forward not found", 404)
	}
	f.status = "stopped"
	child := f.child
	s.removeLocked(id)
	s.mu.Unlock()
	if child != nil {
		child.kill()
	}
	s.closeConsoleOf(id)
	// Answer after kubectl has released the local port, so a restart can reuse it.
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	select {
	case <-f.done:
	case <-timer.C:
	case <-ctx.Done():
	}
	return nil
}

func (s *fwdState) closeConsoleOf(forwardID string) {
	s.mu.Lock()
	var closing []*fwdConsole
	for key, c := range s.console {
		if c.forward.id == forwardID {
			delete(s.console, key)
			closing = append(closing, c)
		}
	}
	s.mu.Unlock()
	for _, c := range closing {
		c.embed.close()
	}
}

func (s *fwdState) statusOf(f *portForward) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return f.status
}

// ready returns a ready forward for the target: an existing live one, or a new kubectl started now.
func (s *fwdState) ready(ctx context.Context, spec fwdSpec) (*portForward, error) {
	s.mu.Lock()
	var f *portForward
	for _, item := range s.list {
		if item.spec == spec && item.active() {
			f = item
			break
		}
	}
	s.mu.Unlock()
	if f == nil {
		var err error
		if f, err = s.start(spec, 0); err != nil {
			return nil, err
		}
	}
	deadline := time.Now().Add(25 * time.Second)
	for s.statusOf(f) == "starting" && time.Now().Before(deadline) && ctx.Err() == nil && !s.b.isClosed() {
		select {
		case <-time.After(150 * time.Millisecond):
		case <-ctx.Done():
		}
	}
	s.mu.Lock()
	status, reason, child := f.status, f.err, f.child
	if status != "ready" {
		// Do not leave a failed console forward behind in Port Forwarding.
		f.status = "stopped"
		s.removeLocked(f.id)
	}
	s.mu.Unlock()
	if status != "ready" {
		if child != nil {
			child.kill()
		}
		why := ""
		if reason != "" {
			why = ": " + strings.SplitN(reason, "\n", 2)[0]
		} else if status == "starting" {
			why = " within 25 seconds"
		}
		return nil, problem(fmt.Sprintf("The port forward to %s/%s:%d did not start%s", spec.resource, spec.name, spec.remotePort, why), 502)
	}
	return f, nil
}

// fwdConsoleSpec describes a console to open.
type fwdConsoleSpec struct {
	fwdSpec
	scheme      string
	credentials func(ctx context.Context) (any, error)
}

func (s *fwdState) consoleKey(spec fwdSpec) string {
	return fmt.Sprintf("%q|%q|%q|%q|%d", spec.context, spec.namespace, spec.resource, spec.name, spec.remotePort)
}

// target is asked by the proxy on every request: the live forward's port, or a restarted one. One
// restart serves every request that arrives while it is in progress.
func (s *fwdState) target(ctx context.Context, entry *fwdConsole, spec fwdSpec) (int, error) {
	s.mu.Lock()
	if entry.forward.status == "ready" {
		port := entry.forward.localPort
		s.mu.Unlock()
		return port, nil
	}
	if entry.restarting == nil {
		restart := &fwdRestart{done: make(chan struct{})}
		entry.restarting = restart
		go func() {
			next, err := s.ready(context.Background(), spec)
			s.mu.Lock()
			if err == nil {
				if next != entry.forward {
					s.removeLocked(entry.forward.id) // the dead one leaves Port Forwarding
				}
				entry.forward = next
				restart.port = next.localPort
			}
			restart.err = err
			entry.restarting = nil
			s.mu.Unlock()
			close(restart.done)
		}()
	}
	restart := entry.restarting
	s.mu.Unlock()
	select {
	case <-restart.done:
		return restart.port, restart.err
	case <-ctx.Done():
		return 0, ctx.Err()
	}
}

type fwdOpened struct {
	ForwardID string `json:"forwardId"`
	LocalPort int    `json:"localPort"`
	URL       string `json:"url"`
	Origin    string `json:"origin"`
}

// fwdOpenEmbedded opens (or reuses) the console for one forwarded service: one console per
// [context, namespace, resource, name, remotePort].
func (b *Backend) fwdOpenEmbedded(ctx context.Context, c fwdConsoleSpec) (fwdOpened, error) {
	s := fwdStateOf(b)
	key := s.consoleKey(c.fwdSpec)
	s.mu.Lock()
	entry := s.console[key]
	s.mu.Unlock()
	if entry == nil {
		forward, err := s.ready(ctx, c.fwdSpec)
		if err != nil {
			return fwdOpened{}, err
		}
		s.mu.Lock()
		if s.closed {
			s.mu.Unlock()
			return fwdOpened{}, problem("Backend is closed", 503)
		}
		entry = s.console[key]
		if entry == nil {
			created := &fwdConsole{forward: forward}
			origins := []string{fmt.Sprintf("http://127.0.0.1:%d", b.port.Load()), fmt.Sprintf("http://localhost:%d", b.port.Load())}
			embed, err := newEmbedProxy(embedProxyOptions{
				target:        func(ctx context.Context) (int, error) { return s.target(ctx, created, c.fwdSpec) },
				parentOrigins: origins,
				upstreamTLS:   c.scheme == "https",
				credentials:   c.credentials,
				log:           func(message string) { b.logger.Warn(message, nil) },
			})
			if err != nil {
				s.mu.Unlock()
				return fwdOpened{}, err
			}
			created.embed = embed
			s.console[key] = created
			entry = created
		}
		s.mu.Unlock()
	} else if _, err := s.target(ctx, entry, c.fwdSpec); err != nil {
		return fwdOpened{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	port := entry.embed.port
	return fwdOpened{ForwardID: entry.forward.id, LocalPort: entry.forward.localPort, URL: fmt.Sprintf("http://127.0.0.1:%d/", port), Origin: fmt.Sprintf("http://127.0.0.1:%d", port)}, nil
}

func init() {
	registerRoutes(func(b *Backend, q *request) (any, int, bool, error) {
		switch {
		case q.method == "GET" && q.route == "/api/forwards":
			return obj{"items": fwdStateOf(b).views()}, 200, true, nil
		case q.method == "POST" && q.route == "/api/forwards":
			view, err := fwdStateOf(b).create(q.body)
			return view, 201, true, err
		case q.method == "DELETE" && strings.HasPrefix(q.route, "/api/forwards/"):
			if err := fwdStateOf(b).stop(q.ctx, strings.TrimPrefix(q.route, "/api/forwards/")); err != nil {
				return nil, 0, true, err
			}
			return obj{"ok": true}, 200, true, nil
		}
		return nil, 0, false, nil
	})
}
