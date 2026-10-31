package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// A loopback reverse proxy in front of a port forward, so a web console (the RabbitMQ management
// UI) can be shown inside Rubban:
//   - it runs on its own port, so the console is a different origin from Rubban and cannot reach
//     Rubban's API token or DOM;
//   - only Rubban's window may frame it (frame-ancestors), and X-Frame-Options is dropped;
//   - a small bridge script is added to the console's HTML page. It accepts one message from the
//     Rubban window (checked by origin) carrying the login, and fills the console's own login form,
//     so credentials never appear in a URL;
//   - request paths are forwarded byte for byte (RabbitMQ encodes the default vhost as %2F);
//   - the Host header must name this proxy, which blocks DNS-rebinding pages.

const embedBridgePath = "/__rubban/bridge.js"

// embedBridgeTemplate is the page-side bridge script injected into the console; only the
// two placeholders are filled in.
const embedBridgeTemplate = `(() => {
  const PARENTS = @PARENTS@;
  const LOGIN_TOKEN = @TOKEN@;
  if (window.parent === window) return;
  let used = false;
  let parent = null;
  const tell = type => { for (const origin of parent ? [parent] : PARENTS) window.parent.postMessage({ type }, origin); };
  const signIn = data => {
    if (used) return;
    used = true;
    const until = Date.now() + 20000;

    const attempt = () => {
      const user = document.querySelector('input[name="username"]');
      const pass = document.querySelector('input[name="password"]');
      if (user && pass && user.form) {
        user.value = String(data.username ?? '');
        pass.value = String(data.password ?? '');
        const submit = user.form.querySelector('input[type="submit"], button[type="submit"], button:not([type])');
        if (submit) submit.click(); else if (user.form.requestSubmit) user.form.requestSubmit();
        tell('rubban:login-sent');
        const verify = () => {
          const failure = document.querySelector('#login-status');
          if (failure && /failed|not authorized|invalid/i.test(failure.textContent)) { tell('rubban:login-failed'); return; }
          if (!document.querySelector('input[name="password"]') && document.querySelector('#logout, a[href="#/logout"]')) { tell('rubban:authenticated'); return; }
          if (Date.now() < until) setTimeout(verify, 150); else tell('rubban:login-timeout');
        };
        setTimeout(verify, 150);
        return;
      }
      // Loading text is not evidence of an authenticated session. RabbitMQ may take
      // several seconds to load its templates, especially over a cluster tunnel.
      if (document.querySelector('#logout, a[href="#/logout"]')) { tell('rubban:authenticated'); return; }
      if (Date.now() < until) setTimeout(attempt, 150);
      else tell('rubban:login-timeout');
    };
    attempt();
  };
  window.addEventListener('message', event => {
    if (event.source !== window.parent || !PARENTS.includes(event.origin)) return;
    parent = event.origin;
    const data = event.data || {};
    if (data.type === 'rubban:connect') { tell('rubban:ready'); return; }
    if (!LOGIN_TOKEN && data.type === 'rubban:login') signIn(data);
  });
  if (LOGIN_TOKEN) fetch('/__rubban/login', { headers: { 'X-Rubban-Embed-Token': LOGIN_TOKEN }, cache: 'no-store' })
    .then(response => { if (!response.ok) throw new Error('Secret could not be read'); return response.json(); })
    .then(signIn).catch(() => tell('rubban:credentials-unavailable'));
  tell('rubban:ready');
})();
`

func embedJSON(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	return strings.TrimRight(buf.String(), "\n")
}

func embedBridgeScript(parentOrigins []string, loginToken string) string {
	if parentOrigins == nil {
		parentOrigins = []string{}
	}
	return strings.NewReplacer("@PARENTS@", embedJSON(parentOrigins), "@TOKEN@", embedJSON(loginToken)).Replace(embedBridgeTemplate)
}

var embedHopHeaders = []string{"Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization", "Proxy-Connection", "Te", "Trailer", "Transfer-Encoding", "Upgrade"}

// embedFrameHeaders replaces any frame-ancestors directive with one that admits only the Rubban window.
func embedFrameHeaders(headers http.Header, parentOrigins []string) http.Header {
	result := headers.Clone()
	if result == nil {
		result = http.Header{}
	}
	result.Del("X-Frame-Options")
	var policies []string
	for _, value := range result.Values("Content-Security-Policy") {
		var kept []string
		for _, part := range strings.Split(value, ";") {
			part = strings.TrimSpace(part)
			if part != "" && !embedFrameAncestorsRE.MatchString(part) {
				kept = append(kept, part)
			}
		}
		policies = append(policies, strings.Join(kept, "; "))
	}
	if len(policies) == 0 {
		policies = []string{""}
	}
	result.Del("Content-Security-Policy")
	for _, policy := range policies {
		if policy != "" {
			policy += "; "
		}
		result.Add("Content-Security-Policy", policy+"frame-ancestors "+strings.Join(parentOrigins, " "))
	}
	return result
}

var (
	embedFrameAncestorsRE = regexp.MustCompile(`(?i)^frame-ancestors\b`)
	embedHeadCloseRE      = regexp.MustCompile(`(?i)</head>`)
	embedBodyOpenRE       = regexp.MustCompile(`(?i)<body[^>]*>`)
	embedHTMLTypeRE       = regexp.MustCompile(`(?i)^text/html`)
	embedTokenRE          = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

func embedInjectBridge(html []byte) []byte {
	tag := []byte(`<script src="` + embedBridgePath + `"></script>`)
	splice := func(at int) []byte {
		out := make([]byte, 0, len(html)+len(tag))
		return append(append(append(out, html[:at]...), tag...), html[at:]...)
	}
	if loc := embedHeadCloseRE.FindIndex(html); loc != nil {
		return splice(loc[0])
	}
	if loc := embedBodyOpenRE.FindIndex(html); loc != nil {
		return splice(loc[1])
	}
	return append(append([]byte{}, tag...), html...)
}

type embedProxyOptions struct {
	// target returns the upstream port. It is asked on every request: the console's port forward can
	// die and be restarted underneath the proxy, whose own port (the iframe's origin) never changes.
	target        func(ctx context.Context) (int, error)
	targetPort    int // used when target is nil
	parentOrigins []string
	upstreamTLS   bool
	maxHTMLBytes  int
	// credentials, when set, enables /__rubban/login for the page's bridge.
	credentials func(ctx context.Context) (any, error)
	// log receives one line per failed request.
	log func(message string)
}

type embedProxy struct {
	opts       embedProxyOptions
	port       int
	loginToken string
	srv        *http.Server
	transport  *http.Transport
}

func newEmbedProxy(opts embedProxyOptions) (*embedProxy, error) {
	if opts.target == nil {
		fixed := opts.targetPort
		opts.target = func(context.Context) (int, error) { return fixed, nil }
	}
	if opts.maxHTMLBytes <= 0 {
		opts.maxHTMLBytes = 2 * 1024 * 1024
	}
	p := &embedProxy{opts: opts}
	if opts.credentials != nil {
		raw := make([]byte, 32)
		_, _ = rand.Read(raw)
		p.loginToken = hex.EncodeToString(raw)
	}
	// Connections to the tunnel are kept alive: every new one is a new stream in kubectl's port
	// forward, and creating streams is what times out when the API server connection is flaky.
	// An HTTPS console's certificate names the cluster service, not 127.0.0.1, so it is not verified.
	p.transport = &http.Transport{
		MaxConnsPerHost:     6,
		MaxIdleConnsPerHost: 6,
		IdleConnTimeout:     90 * time.Second,
		DisableCompression:  true,
		DialContext:         (&net.Dialer{Timeout: 30 * time.Second}).DialContext,
	}
	if opts.upstreamTLS {
		p.transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS12} // #nosec G402 -- the tunnel ends at 127.0.0.1; the console certificate names the cluster service
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	p.port = ln.Addr().(*net.TCPAddr).Port
	p.srv = &http.Server{Handler: http.HandlerFunc(p.serve), ReadHeaderTimeout: 15 * time.Second}
	go func() { _ = p.srv.Serve(ln) }()
	return p, nil
}

func (p *embedProxy) close() {
	p.transport.CloseIdleConnections()
	_ = p.srv.Close()
	p.transport.CloseIdleConnections()
}

// embedWriter remembers whether the response has started, so a failure after that point can only
// abort the connection.
type embedWriter struct {
	http.ResponseWriter
	started bool
}

func (w *embedWriter) WriteHeader(status int) {
	w.started = true
	w.ResponseWriter.WriteHeader(status)
}

func (w *embedWriter) Write(data []byte) (int, error) {
	w.started = true
	return w.ResponseWriter.Write(data)
}

func (w *embedWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (p *embedProxy) serve(rw http.ResponseWriter, r *http.Request) {
	w := &embedWriter{ResponseWriter: rw}
	host := strings.ToLower(r.Host)
	if host != fmt.Sprintf("127.0.0.1:%d", p.port) && host != fmt.Sprintf("localhost:%d", p.port) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(403)
		_, _ = w.Write([]byte("Invalid Host header"))
		return
	}
	switch r.RequestURI {
	case "/__rubban/login":
		p.serveLogin(w, r)
		return
	case embedBridgePath:
		body := embedBridgeScript(p.opts.parentOrigins, p.loginToken)
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		w.WriteHeader(200)
		_, _ = w.Write([]byte(body))
		return
	}
	p.forward(w, r)
}

func (p *embedProxy) serveLogin(w *embedWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Type", "application/json")
	supplied := r.Header.Get("X-Rubban-Embed-Token")
	if r.Method != http.MethodGet || p.loginToken == "" || !embedTokenRE.MatchString(supplied) || subtle.ConstantTimeCompare([]byte(supplied), []byte(p.loginToken)) != 1 {
		w.WriteHeader(403)
		_, _ = w.Write([]byte(`{"error":"Unauthorized"}`))
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != fmt.Sprintf("http://127.0.0.1:%d", p.port) && origin != fmt.Sprintf("http://localhost:%d", p.port) {
		w.WriteHeader(403)
		_, _ = w.Write([]byte(`{"error":"Invalid origin"}`))
		return
	}
	value, err := p.opts.credentials(r.Context())
	if err != nil {
		w.WriteHeader(502)
		_, _ = w.Write([]byte(`{"error":"The Kubernetes Secret could not be read"}`))
		return
	}
	_, _ = w.Write([]byte(embedJSON(value)))
}

func (p *embedProxy) fail(w *embedWriter, r *http.Request, err error) {
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		err = urlErr.Err
	}
	if p.opts.log != nil {
		p.opts.log(fmt.Sprintf("Console request %s %s failed: %s", r.Method, r.RequestURI, err.Error()))
	}
	if w.started {
		panic(http.ErrAbortHandler)
	}
	w.Header().Set("Content-Type", "text/plain")
	w.WriteHeader(502)
	_, _ = w.Write([]byte("The port forward is not answering: " + err.Error()))
}

// forward sends the request upstream with its path untouched. A request without a body is sent once
// more, over a fresh connection to whatever target names by then, when nothing answered at all: a
// kept-alive socket the console closed just now, or a forward that died.
func (p *embedProxy) forward(w *embedWriter, r *http.Request) {
	idempotent := r.Method == http.MethodGet || r.Method == http.MethodHead
	if !strings.HasPrefix(r.RequestURI, "/") {
		w.WriteHeader(400)
		return
	}
	pathPart, query, hasQuery := strings.Cut(r.RequestURI, "?")
	header := r.Header.Clone()
	for _, name := range embedHopHeaders {
		header.Del(name)
	}
	header.Set("Accept-Encoding", "identity")
	scheme := "http"
	if p.opts.upstreamTLS {
		scheme = "https"
	}
	for attempt := 0; ; attempt++ {
		port, err := p.opts.target(r.Context())
		if err != nil {
			p.fail(w, r, err)
			return
		}
		out := &http.Request{
			Method: r.Method,
			URL:    &url.URL{Scheme: scheme, Host: net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), Opaque: pathPart, RawQuery: query, ForceQuery: hasQuery && query == ""},
			Host:   r.Host,
			Header: header,
			Proto:  "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1,
		}
		out = out.WithContext(r.Context())
		if idempotent {
			out.Body = http.NoBody
		} else {
			out.Body = r.Body
			out.ContentLength = r.ContentLength
		}
		resp, err := p.transport.RoundTrip(out)
		if err != nil {
			if idempotent && attempt == 0 && !w.started && r.Context().Err() == nil {
				continue
			}
			p.fail(w, r, err)
			return
		}
		p.respond(w, r, resp)
		return
	}
}

func (p *embedProxy) respond(w *embedWriter, r *http.Request, resp *http.Response) {
	defer resp.Body.Close()
	out := embedFrameHeaders(resp.Header, p.opts.parentOrigins)
	for _, name := range embedHopHeaders {
		out.Del(name)
	}
	dst := w.Header()
	for k, v := range out {
		dst[k] = v
	}
	if !embedHTMLTypeRE.MatchString(resp.Header.Get("Content-Type")) || r.Method == http.MethodHead || resp.StatusCode == http.StatusNotModified {
		w.WriteHeader(resp.StatusCode)
		p.stream(w, resp.Body)
		return
	}
	page, err := io.ReadAll(io.LimitReader(resp.Body, int64(p.opts.maxHTMLBytes)+1))
	if err != nil {
		p.fail(w, r, err)
		return
	}
	if len(page) > p.opts.maxHTMLBytes {
		for k := range dst {
			delete(dst, k)
		}
		dst.Set("Content-Type", "text/plain")
		w.WriteHeader(502)
		_, _ = w.Write([]byte("Console page is too large to embed"))
		return
	}
	body := embedInjectBridge(page)
	dst.Del("Content-Length")
	dst.Del("Etag")
	dst.Set("Content-Length", strconv.Itoa(len(body)))
	dst.Set("Cache-Control", "no-store")
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(body)
}

// stream copies a body through, flushing as it goes so long-lived responses keep flowing.
func (p *embedProxy) stream(w *embedWriter, body io.Reader) {
	rc := http.NewResponseController(w)
	buf := make([]byte, 32*1024)
	for {
		n, err := body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			_ = rc.Flush()
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				panic(http.ErrAbortHandler)
			}
			return
		}
	}
}
