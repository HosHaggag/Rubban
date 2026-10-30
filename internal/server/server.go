// Package server is the Rubban backend: an HTTP and WebSocket API on 127.0.0.1 that drives kubectl and helm.
package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/HosHaggag/rubban/internal/live"
	"github.com/HosHaggag/rubban/internal/logging"
	"github.com/HosHaggag/rubban/internal/version"
)

const bodyLimit = 2 * 1024 * 1024

// Options configure a Backend.
type Options struct {
	DataDir     string
	KubectlPath string
	HelmPath    string
	// Runner replaces process spawning (tests). When set, kubectl and helm count as installed.
	Runner CommandRunner
	Logger *logging.Logger
	// UI is the file system served at /. Nil serves no UI.
	UI fs.FS
	// DesktopBridge is served at /desktop-bridge.js (empty in web mode).
	DesktopBridge []byte
	// Desktop enables the /api/desktop/* routes (desktop app only).
	Desktop DesktopHooks
	// Smoke enables the smoke-test reporting routes.
	Smoke   bool
	Version string
	// DisableLive turns the live layer off, leaving one-shot kubectl only.
	DisableLive bool
	// ProxyStarter replaces `kubectl proxy` (tests). Setting it keeps the live layer on even with an
	// injected Runner, which otherwise disables it.
	ProxyStarter live.ProxyStarter
	// LiveConfig tunes the live layer's timings (tests). Its Starter field is ignored.
	LiveConfig live.Config
}

// Connection describes a started backend.
type Connection struct {
	URL   string `json:"url"`
	Port  int    `json:"port"`
	Token string `json:"token"`
}

// Backend serves the API.
type Backend struct {
	opts     Options
	dataDir  string
	token    string
	version  string
	tools    map[string]ToolInfo
	toolPath map[string]string
	runner   CommandRunner
	procs    processes
	logger   *logging.Logger
	kubecfgs *kubeconfigStore
	term     terminalState
	live     *live.Live // nil when the live layer is off

	port     atomic.Int64
	closed   atomic.Bool
	srv      *http.Server
	listener net.Listener

	runMu   sync.Mutex
	runs    map[int]context.CancelFunc
	nextRun int
}

// New creates a Backend. Call Start to listen.
func New(opts Options) *Backend {
	dataDir := opts.DataDir
	if dataDir == "" {
		dataDir = filepath.Join(os.TempDir(), "rubban")
	}
	if abs, err := filepath.Abs(dataDir); err == nil {
		dataDir = abs
	}
	tokenBytes := make([]byte, 32)
	_, _ = rand.Read(tokenBytes)
	b := &Backend{opts: opts, dataDir: dataDir, token: hex.EncodeToString(tokenBytes), logger: opts.Logger, runs: map[int]context.CancelFunc{}}
	b.version = opts.Version
	if b.version == "" {
		b.version = version.Version
	}
	b.tools = map[string]ToolInfo{}
	b.toolPath = map[string]string{}
	for _, name := range []string{"kubectl", "helm"} {
		p, info := resolveTool(opts, name)
		b.tools[name], b.toolPath[name] = info, p
	}
	b.runner = opts.Runner
	if b.runner == nil {
		b.runner = b.execRunner
	}
	b.kubecfgs = newKubeconfigStore(dataDir)
	b.wipeTerminals()
	b.initLive()
	return b
}

func (b *Backend) isClosed() bool { return b.closed.Load() }

func (b *Backend) trackRun(cancel context.CancelFunc) func() {
	b.runMu.Lock()
	b.nextRun++
	id := b.nextRun
	b.runs[id] = cancel
	b.runMu.Unlock()
	return func() {
		b.runMu.Lock()
		delete(b.runs, id)
		b.runMu.Unlock()
	}
}

// kubeEnv is the environment for kubectl and helm: the user's kubeconfig plus imported ones.
// It returns nil (inherit) while nothing is imported.
func (b *Backend) kubeEnv() []string {
	variable := b.kubecfgs.variable()
	if variable == "" {
		return nil
	}
	env := make([]string, 0, len(os.Environ())+1)
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(kv), "KUBECONFIG=") {
			env = append(env, kv)
		}
	}
	return append(env, "KUBECONFIG="+variable)
}

func (b *Backend) kube(ctx context.Context, args []string, opts RunOptions) (Result, error) {
	tool, err := b.requireTool("kubectl")
	if err != nil {
		return Result{}, err
	}
	return b.run(ctx, tool, args, opts)
}

func (b *Backend) helm(ctx context.Context, args []string, opts RunOptions) (Result, error) {
	tool, err := b.requireTool("helm")
	if err != nil {
		return Result{}, err
	}
	return b.run(ctx, tool, args, opts)
}

// Start listens on 127.0.0.1:port (0 picks a free port).
func (b *Backend) Start(port int) (Connection, error) {
	if b.isClosed() {
		return Connection{}, problem("Backend is closed", 503)
	}
	if b.listener != nil {
		return b.connection(), nil
	}
	if port < 0 || port > 65535 {
		return Connection{}, bad("Invalid port")
	}
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return Connection{}, err
	}
	b.listener = ln
	b.port.Store(int64(ln.Addr().(*net.TCPAddr).Port))
	b.srv = &http.Server{
		Handler:           b,
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       5 * time.Second,
		MaxHeaderBytes:    64 * 1024,
	}
	go func() { _ = b.srv.Serve(ln) }()
	return b.connection(), nil
}

func (b *Backend) connection() Connection {
	p := int(b.port.Load())
	return Connection{URL: fmt.Sprintf("http://127.0.0.1:%d", p), Port: p, Token: b.token}
}

// Close stops the listener and every child process.
func (b *Backend) Close() error {
	if !b.closed.CompareAndSwap(false, true) {
		return nil
	}
	b.runMu.Lock()
	for _, cancel := range b.runs {
		cancel()
	}
	b.runMu.Unlock()
	b.live.Close()
	b.procs.killAll()
	b.closeTerminals()
	if b.srv != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if err := b.srv.Shutdown(ctx); err != nil {
			_ = b.srv.Close()
		}
	}
	return nil
}

// --- request handling ------------------------------------------------------------------

func (b *Backend) authorize(r *http.Request, websocket bool) error {
	port := b.port.Load()
	if port == 0 {
		return problem("Invalid local Host header", 403)
	}
	host := r.Host
	if host != fmt.Sprintf("127.0.0.1:%d", port) && host != fmt.Sprintf("localhost:%d", port) {
		return problem("Invalid local Host header", 403)
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		if origin != fmt.Sprintf("http://127.0.0.1:%d", port) && origin != fmt.Sprintf("http://localhost:%d", port) {
			return problem("Invalid local Origin", 403)
		}
	}
	if strings.HasPrefix(r.URL.Path, "/api/") {
		var supplied string
		if websocket {
			supplied = r.URL.Query().Get("token")
		} else {
			supplied = r.Header.Get("X-Rubban-Token")
			if supplied == "" {
				if m := bearerRE.FindStringSubmatch(r.Header.Get("Authorization")); m != nil {
					supplied = m[1]
				}
			}
		}
		if !tokenRE.MatchString(supplied) || subtle.ConstantTimeCompare([]byte(supplied), []byte(b.token)) != 1 {
			return problem("Unauthorized", 401)
		}
	}
	return nil
}

var (
	bearerRE = regexp.MustCompile(`^Bearer ([a-f0-9]{64})$`)
	tokenRE  = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

func setSecurityHeaders(h http.Header) {
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Cross-Origin-Resource-Policy", "same-origin")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Cache-Control", "no-store")
}

func writeJSON(w http.ResponseWriter, v any, status int) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		buf.Reset()
		buf.WriteString(`{"error":"Unable to encode response"}`)
		status = 500
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(bytes.TrimRight(buf.Bytes(), "\n"))
}

func isWebSocket(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
}

// rejectUpgrade answers a refused WebSocket upgrade with a bare status line.
func rejectUpgrade(w http.ResponseWriter, status int) {
	hj, ok := w.(http.Hijacker)
	if !ok {
		w.WriteHeader(status)
		return
	}
	conn, _, err := hj.Hijack()
	if err != nil {
		return
	}
	_, _ = fmt.Fprintf(conn, "HTTP/1.1 %d Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", status)
	_ = conn.Close()
}

// request is the parsed view of an API call handed to route handlers.
type request struct {
	ctx    context.Context
	method string
	route  string
	query  map[string]string
	body   map[string]any
	r      *http.Request
}

func (q *request) q(key string) any {
	if v, ok := q.query[key]; ok {
		return v
	}
	return nil
}

func (b *Backend) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	setSecurityHeaders(w.Header())
	if isWebSocket(r) {
		b.serveWebSocket(w, r)
		return
	}
	ctx := r.Context()
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Now().Add(30 * time.Second))
	defer func() {
		if rec := recover(); rec != nil {
			err := fmt.Errorf("panic: %v", rec)
			b.logger.Error(err, map[string]any{"route": r.URL.Path})
			writeJSON(w, map[string]string{"error": "Internal error"}, 500)
		}
	}()
	if err := b.authorize(r, false); err != nil {
		writeJSON(w, map[string]string{"error": err.Error()}, statusOf(err))
		return
	}
	if !strings.HasPrefix(r.URL.Path, "/api/") {
		if err := b.serveUI(w, r); err != nil {
			writeJSON(w, map[string]string{"error": err.Error()}, statusOf(err))
		}
		return
	}
	var body map[string]any
	method := r.Method
	hasBody := method == http.MethodPost || method == http.MethodPut || method == http.MethodPatch ||
		(method == http.MethodDelete && (r.ContentLength > 0 || len(r.TransferEncoding) > 0))
	if hasBody {
		var err error
		if body, err = readJSONBody(r); err != nil {
			writeJSON(w, map[string]string{"error": shortError(err)}, statusOf(err))
			return
		}
	}
	if body == nil {
		body = map[string]any{}
	}
	query := map[string]string{}
	for k, v := range r.URL.Query() {
		if len(v) > 0 {
			query[k] = v[len(v)-1]
		}
	}
	req := &request{ctx: ctx, method: method, route: r.URL.Path, query: query, body: body, r: r}
	result, status, err := b.dispatch(req)
	if err != nil {
		if statusOf(err) >= 500 {
			b.logger.Error(err, map[string]any{"route": r.URL.Path})
		}
		if ctx.Err() != nil {
			return
		}
		writeJSON(w, map[string]string{"error": shortError(err)}, statusOf(err))
		return
	}
	if ctx.Err() != nil {
		return
	}
	writeJSON(w, result, status)
}

func readJSONBody(r *http.Request) (map[string]any, error) {
	if r.ContentLength > bodyLimit {
		_, _ = io.Copy(io.Discard, io.LimitReader(r.Body, bodyLimit))
		return nil, problem("Request body is too large", 413)
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, bodyLimit+1))
	if err != nil {
		return nil, problem("Request aborted", 400)
	}
	if len(data) > bodyLimit {
		return nil, problem("Request body is too large", 413)
	}
	if len(data) == 0 {
		return map[string]any{}, nil
	}
	ct := strings.ToLower(strings.TrimSpace(strings.SplitN(r.Header.Get("Content-Type"), ";", 2)[0]))
	if ct != "application/json" && !jsonTypeRE.MatchString(ct) {
		return nil, problem("Use application/json for request bodies", 415)
	}
	var out map[string]any
	dec := json.NewDecoder(bytes.NewReader(data))
	if err := dec.Decode(&out); err != nil || out == nil || dec.More() {
		return nil, bad("Invalid JSON object")
	}
	return out, nil
}

var jsonTypeRE = regexp.MustCompile(`^application/[\w.+-]+\+json$`)

var contentTypes = map[string]string{
	".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
	".png": "image/png", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
}

func (b *Backend) csp() string {
	p := b.port.Load()
	return fmt.Sprintf("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:%d ws://localhost:%d; frame-src http://127.0.0.1:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'", p, p)
}

func (b *Backend) serveUI(w http.ResponseWriter, r *http.Request) error {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return problem("Method not allowed", 405)
	}
	name := r.URL.Path
	if strings.ContainsRune(name, 0) || strings.Contains(name, `\`) {
		return bad("Invalid request path")
	}
	var contents []byte
	ext := strings.ToLower(path.Ext(name))
	if name == "/" {
		ext = ".html"
	}
	switch {
	case name == "/desktop-bridge.js":
		contents, ext = b.opts.DesktopBridge, ".js"
	case b.opts.UI == nil:
		return problem("File not found", 404)
	default:
		file := "index.html"
		if name == "/node_modules/@xterm/xterm/css/xterm.css" {
			file, ext = "xterm.css", ".css"
		} else if name != "/" {
			file = strings.TrimPrefix(path.Clean(name), "/")
		}
		if _, ok := contentTypes[ext]; !ok || !fs.ValidPath(file) {
			return problem("File not found", 404)
		}
		data, err := fs.ReadFile(b.opts.UI, file)
		if err != nil || len(data) > 15*1024*1024 {
			return problem("File not found", 404)
		}
		contents = data
	}
	if _, ok := contentTypes[ext]; !ok {
		return problem("File not found", 404)
	}
	w.Header().Set("Content-Security-Policy", b.csp())
	if ext == ".html" {
		contents = bytes.ReplaceAll(contents, []byte("__RUBBAN_TOKEN__"), []byte(b.token))
	}
	w.Header().Set("Content-Type", contentTypes[ext]+"; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(contents)))
	w.WriteHeader(200)
	if r.Method != http.MethodHead {
		_, _ = w.Write(contents)
	}
	return nil
}

func (b *Backend) serveWebSocket(w http.ResponseWriter, r *http.Request) {
	if err := b.authorize(r, true); err != nil {
		rejectUpgrade(w, statusOf(err))
		return
	}
	switch r.URL.Path {
	case "/api/watch", "/api/logs", "/api/terminal":
	case "/api/desktop/events":
		if b.opts.Desktop == nil {
			rejectUpgrade(w, 404)
			return
		}
		b.serveDesktopEvents(w, r)
		return
	default:
		rejectUpgrade(w, 404)
		return
	}
	b.handleStream(w, r)
}

var errNotFound = errors.New("API route not found")
