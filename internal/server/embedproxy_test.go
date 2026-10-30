package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// embedTestGet fetches with the stock client; the proxy is under test, not the client.
func embedTestGet(t *testing.T, target string, headers map[string]string) (*http.Response, string) {
	t.Helper()
	req, err := http.NewRequest("GET", target, nil)
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	return res, string(body)
}

// embedPortOf is the port of a URL such as http://127.0.0.1:4567.
func embedPortOf(t *testing.T, rawURL string) int {
	t.Helper()
	u, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatal(err)
	}
	return port
}

func embedTestProxy(t *testing.T, opts embedProxyOptions) (*embedProxy, string) {
	t.Helper()
	p, err := newEmbedProxy(opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.close)
	return p, fmt.Sprintf("http://127.0.0.1:%d", p.port)
}

func TestEmbedBridgeScript(t *testing.T) {
	script := embedBridgeScript([]string{"http://127.0.0.1:9"}, "")
	if !strings.Contains(script, `const PARENTS = ["http://127.0.0.1:9"];`) || !strings.Contains(script, `const LOGIN_TOKEN = "";`) {
		t.Fatalf("placeholders: %s", script[:120])
	}
	// The postMessage protocol and its timings are part of the contract with ui/.
	for _, token := range []string{"rubban:connect", "rubban:ready", "rubban:login", "rubban:login-sent", "rubban:authenticated", "rubban:login-failed", "rubban:login-timeout", "rubban:credentials-unavailable", "Date.now() + 20000", "setTimeout(verify, 150)", "setTimeout(attempt, 150)"} {
		if !strings.Contains(script, token) {
			t.Fatalf("bridge lost %q", token)
		}
	}
	tokened := embedBridgeScript([]string{"http://a", "http://b"}, strings.Repeat("ab", 32))
	if !strings.Contains(tokened, `["http://a","http://b"]`) || !strings.Contains(tokened, `"`+strings.Repeat("ab", 32)+`"`) {
		t.Fatal("token or origins not substituted")
	}
}

// While the Node source still exists the Go bridge must stay byte-identical to it.
func TestEmbedBridgeMatchesNodeSource(t *testing.T) {
	source, err := os.ReadFile("../../server/embed-proxy.cjs")
	if err != nil {
		t.Skip("server/embed-proxy.cjs is gone")
	}
	m := regexp.MustCompile("(?s)return `(\\(\\(\\) => \\{.*?\\}\\)\\(\\);\n)`;").FindSubmatch(source)
	if m == nil {
		t.Fatal("bridge template not found in embed-proxy.cjs")
	}
	js := strings.NewReplacer("${JSON.stringify(parentOrigins)}", `["http://127.0.0.1:1"]`, "${JSON.stringify(loginToken)}", `"tok"`).Replace(string(m[1]))
	if got := embedBridgeScript([]string{"http://127.0.0.1:1"}, "tok"); got != js {
		t.Fatalf("bridge differs from embed-proxy.cjs\n--- node\n%s\n--- go\n%s", js, got)
	}
}

func TestEmbedFrameHeadersAndInjection(t *testing.T) {
	got := embedFrameHeaders(http.Header{"X-Frame-Options": {"DENY"}, "Content-Security-Policy": {"script-src 'self'; frame-ancestors 'none'"}}, []string{"http://127.0.0.1:1"})
	want := http.Header{"Content-Security-Policy": {"script-src 'self'; frame-ancestors http://127.0.0.1:1"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("frame headers %v", got)
	}
	if got := embedFrameHeaders(http.Header{}, []string{"a", "b"}); !reflect.DeepEqual(got, http.Header{"Content-Security-Policy": {"frame-ancestors a b"}}) {
		t.Fatalf("no csp: %v", got)
	}
	tag := `<script src="/__rubban/bridge.js"></script>`
	for in, want := range map[string]string{
		"<html><head><title>x</title></head><body></body></html>": "<html><head><title>x</title>" + tag + "</head><body></body></html>",
		"<HTML><BODY class=a>hi</BODY></HTML>":                    "<HTML><BODY class=a>" + tag + "hi</BODY></HTML>",
		"plain":                                                   tag + "plain",
	} {
		if got := string(embedInjectBridge([]byte(in))); got != want {
			t.Fatalf("inject %q -> %q", in, got)
		}
	}
}

func TestEmbedProxyHeadersBridgeRawPathsAndHost(t *testing.T) {
	var mu sync.Mutex
	type seen struct{ url, auth, host string }
	var requests []seen
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requests = append(requests, seen{r.RequestURI, r.Header.Get("Authorization"), r.Header.Get("Accept-Encoding")})
		mu.Unlock()
		if r.RequestURI == "/" {
			w.Header().Set("Content-Type", "text/html")
			w.Header().Set("X-Frame-Options", "SAMEORIGIN")
			w.Header().Set("Etag", `"x"`)
			_, _ = w.Write([]byte("<html><head></head><body>console</body></html>"))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("[]"))
	}))
	t.Cleanup(upstream.Close)
	_, base := embedTestProxy(t, embedProxyOptions{targetPort: embedPortOf(t, upstream.URL), parentOrigins: []string{"http://127.0.0.1:4000"}})

	page, body := embedTestGet(t, base+"/", nil)
	if page.Header.Get("X-Frame-Options") != "" || page.Header.Get("Etag") != "" || page.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("headers %v", page.Header)
	}
	if !regexp.MustCompile(`frame-ancestors http://127\.0\.0\.1:4000$`).MatchString(page.Header.Get("Content-Security-Policy")) {
		t.Fatalf("csp %q", page.Header.Get("Content-Security-Policy"))
	}
	if !strings.Contains(body, `<script src="/__rubban/bridge.js"></script></head>`) || page.ContentLength != int64(len(body)) {
		t.Fatalf("body %q length %d", body, page.ContentLength)
	}

	_, api := embedTestGet(t, base+"/api/queues/%2F/orders?x=1&y", map[string]string{"Authorization": "Basic eDp5"})
	if api != "[]" {
		t.Fatalf("api %q", api)
	}
	mu.Lock()
	last := requests[len(requests)-1]
	mu.Unlock()
	if last != (seen{"/api/queues/%2F/orders?x=1&y", "Basic eDp5", "identity"}) {
		t.Fatalf("upstream saw %+v", last)
	}

	bridge, text := embedTestGet(t, base+"/__rubban/bridge.js", nil)
	if bridge.Header.Get("Content-Type") != "application/javascript; charset=utf-8" || !strings.Contains(text, "rubban:login") {
		t.Fatalf("bridge %v", bridge.Header)
	}

	req, _ := http.NewRequest("GET", base+"/", nil)
	req.Host = fmt.Sprintf("attacker.example:%d", embedPortOf(t, base))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatalf("rebinding host got %d", res.StatusCode)
	}
}

func TestEmbedProxyHTMLTooLargeAndPassThrough(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/big":
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write([]byte(strings.Repeat("x", 200)))
		case "/gone":
			w.WriteHeader(304)
		default:
			w.Header().Set("Content-Type", "application/octet-stream")
			_, _ = w.Write([]byte("raw"))
		}
	}))
	t.Cleanup(upstream.Close)
	_, base := embedTestProxy(t, embedProxyOptions{targetPort: embedPortOf(t, upstream.URL), parentOrigins: []string{"http://127.0.0.1:4000"}, maxHTMLBytes: 100})
	if res, body := embedTestGet(t, base+"/big", nil); res.StatusCode != 502 || !strings.Contains(body, "too large") {
		t.Fatalf("big %d %q", res.StatusCode, body)
	}
	if res, _ := embedTestGet(t, base+"/gone", nil); res.StatusCode != 304 {
		t.Fatalf("304 %d", res.StatusCode)
	}
	if _, body := embedTestGet(t, base+"/raw", nil); body != "raw" {
		t.Fatalf("raw %q", body)
	}
}

func TestEmbedProxyLoginEndpointNeedsCapabilityAndSameOrigin(t *testing.T) {
	var mu sync.Mutex
	reads := 0
	_, base := embedTestProxy(t, embedProxyOptions{targetPort: 1, parentOrigins: []string{"http://127.0.0.1:4000"}, credentials: func(context.Context) (any, error) {
		mu.Lock()
		defer mu.Unlock()
		reads++
		return map[string]any{"username": "fixture", "password": fmt.Sprintf("rotation-%d", reads)}, nil
	}})
	if res, _ := embedTestGet(t, base+"/__rubban/login", nil); res.StatusCode != 403 {
		t.Fatalf("no token %d", res.StatusCode)
	}
	_, script := embedTestGet(t, base+"/__rubban/bridge.js", nil)
	m := regexp.MustCompile(`const LOGIN_TOKEN = "([a-f0-9]+)"`).FindStringSubmatch(script)
	if m == nil {
		t.Fatal("no login token in bridge")
	}
	headers := map[string]string{"X-Rubban-Embed-Token": m[1]}
	if res, _ := embedTestGet(t, base+"/__rubban/login", map[string]string{"X-Rubban-Embed-Token": m[1], "Origin": "http://untrusted.example"}); res.StatusCode != 403 {
		t.Fatalf("foreign origin %d", res.StatusCode)
	}
	if res, _ := embedTestGet(t, base+"/__rubban/login", map[string]string{"X-Rubban-Embed-Token": strings.Repeat("0", 64)}); res.StatusCode != 403 {
		t.Fatalf("wrong token %d", res.StatusCode)
	}
	res, body := embedTestGet(t, base+"/__rubban/login", headers)
	var login map[string]any
	_ = json.Unmarshal([]byte(body), &login)
	if res.Header.Get("Cache-Control") != "no-store" || login["password"] != "rotation-1" {
		t.Fatalf("login %v %q", res.Header, body)
	}
	if _, body := embedTestGet(t, base+"/__rubban/login", headers); !strings.Contains(body, "rotation-2") {
		t.Fatalf("second read %q", body)
	}

	// A failing Secret read is a 502, never the credentials.
	_, failing := embedTestProxy(t, embedProxyOptions{targetPort: 1, parentOrigins: []string{"http://127.0.0.1:4000"}, credentials: func(context.Context) (any, error) { return nil, errors.New("nope") }})
	_, script = embedTestGet(t, failing+"/__rubban/bridge.js", nil)
	token := regexp.MustCompile(`const LOGIN_TOKEN = "([a-f0-9]+)"`).FindStringSubmatch(script)[1]
	if res, _ := embedTestGet(t, failing+"/__rubban/login", map[string]string{"X-Rubban-Embed-Token": token}); res.StatusCode != 502 {
		t.Fatalf("failing credentials %d", res.StatusCode)
	}
	// Without credentials there is no token and the endpoint stays closed.
	_, plain := embedTestProxy(t, embedProxyOptions{targetPort: 1, parentOrigins: []string{"http://127.0.0.1:4000"}})
	if res, _ := embedTestGet(t, plain+"/__rubban/login", map[string]string{"X-Rubban-Embed-Token": strings.Repeat("0", 64)}); res.StatusCode != 403 {
		t.Fatalf("plain login %d", res.StatusCode)
	}
}

func TestEmbedProxyFollowsRestartedUpstream(t *testing.T) {
	serve := func() *httptest.Server {
		var server *httptest.Server
		server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"port": embedPortOf(t, server.URL), "method": r.Method})
		}))
		return server
	}
	upstream := serve()
	t.Cleanup(func() { upstream.Close() })
	var mu sync.Mutex
	var answers, lookups []int
	_, base := embedTestProxy(t, embedProxyOptions{parentOrigins: []string{"http://127.0.0.1:4000"}, target: func(context.Context) (int, error) {
		mu.Lock()
		defer mu.Unlock()
		port := embedPortOf(t, upstream.URL)
		if len(answers) > 0 {
			port, answers = answers[0], answers[1:]
		}
		lookups = append(lookups, port)
		return port, nil
	}})
	portAnswer := func(res string) int {
		var v map[string]any
		if err := json.Unmarshal([]byte(res), &v); err != nil {
			t.Fatalf("%q: %v", res, err)
		}
		return int(v["port"].(float64))
	}
	live := embedPortOf(t, upstream.URL)
	if _, body := embedTestGet(t, base+"/api/overview", nil); portAnswer(body) != live {
		t.Fatalf("first answer %q", body)
	}

	// The tunnel dies and comes back on another port. The first lookup still names the dead port
	// (nobody has noticed yet); the retry's lookup gets the new one.
	upstream.Close()
	upstream = serve()
	mu.Lock()
	answers = []int{live}
	mu.Unlock()
	res, body := embedTestGet(t, base+"/api/overview", nil)
	fresh := embedPortOf(t, upstream.URL)
	if res.StatusCode != 200 || portAnswer(body) != fresh {
		t.Fatalf("recovered %d %q", res.StatusCode, body)
	}
	mu.Lock()
	if !reflect.DeepEqual(lookups, []int{live, live, fresh}) {
		t.Fatalf("lookups %v", lookups)
	}
	answers = []int{live}
	mu.Unlock()

	// A request with a body cannot be replayed: it fails honestly.
	post, err := http.Post(base+"/api/queues/%2F/x", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	text, _ := io.ReadAll(post.Body)
	post.Body.Close()
	if post.StatusCode != 502 || !strings.Contains(string(text), "port forward is not answering") {
		t.Fatalf("post %d %q", post.StatusCode, text)
	}
	if _, body := embedTestGet(t, base+"/api/overview", nil); portAnswer(body) != fresh {
		t.Fatalf("after failure %q", body)
	}
}

func TestEmbedProxyTargetFailureIs502(t *testing.T) {
	var logged []string
	var mu sync.Mutex
	_, base := embedTestProxy(t, embedProxyOptions{parentOrigins: []string{"http://127.0.0.1:4000"},
		target: func(context.Context) (int, error) { return 0, errors.New("forward did not start") },
		log: func(m string) {
			mu.Lock()
			logged = append(logged, m)
			mu.Unlock()
		}})
	res, body := embedTestGet(t, base+"/x", nil)
	if res.StatusCode != 502 || body != "The port forward is not answering: forward did not start" {
		t.Fatalf("%d %q", res.StatusCode, body)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(logged) != 1 || logged[0] != "Console request GET /x failed: forward did not start" {
		t.Fatalf("log %v", logged)
	}
}
