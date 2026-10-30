package server

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// xfixture is newFixture with a command log that is safe for the concurrent commands several routes
// start (the shared fixture appends to its slice without a lock).
type xfixture struct {
	*fixture
	mu  sync.Mutex
	log []call
}

func newXFixture(t *testing.T, handler func(c call) Result) *xfixture {
	t.Helper()
	x := &xfixture{}
	runner := func(ctx context.Context, command string, args []string, opts RunOptions) (Result, error) {
		c := call{command, args, opts}
		x.mu.Lock()
		x.log = append(x.log, c)
		x.mu.Unlock()
		return handler(c), nil
	}
	b := New(Options{DataDir: filepath.Join(t.TempDir(), "data"), KubectlPath: "test-kubectl", HelmPath: "test-helm", Runner: runner})
	conn, err := b.Start(0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { b.Close() })
	x.fixture = &fixture{t: t, b: b, conn: conn}
	return x
}

func (x *xfixture) commands() []call {
	x.mu.Lock()
	defer x.mu.Unlock()
	return append([]call(nil), x.log...)
}

func (x *xfixture) last() call {
	cmds := x.commands()
	return cmds[len(cmds)-1]
}

// find returns the commands whose arguments satisfy the predicate.
func (x *xfixture) find(match func(args []string) bool) []call {
	var out []call
	for _, c := range x.commands() {
		if match(c.Args) {
			out = append(out, c)
		}
	}
	return out
}

// rawPath is the value of a kubectl --raw= argument, or "".
func rawPath(args []string) string {
	for _, a := range args {
		if strings.HasPrefix(a, "--raw=") {
			return strings.TrimPrefix(a, "--raw=")
		}
	}
	return ""
}

func hasArg(args []string, want string) bool {
	for _, a := range args {
		if a == want {
			return true
		}
	}
	return false
}

func fail(stderr string) Result { return Result{Stderr: stderr, Code: 1} }

// withLive pretends the live layer is available for the test, serving requests through send.
func withLive(t *testing.T, send func(kubeContext, method, apiPath string, body any) (status int, reply string, err error)) {
	t.Helper()
	oldReady, oldSend := liveReady, liveSend
	liveReady = func(*Backend) bool { return true }
	if send != nil {
		liveSend = func(b *Backend, ctx context.Context, kubeContext, method, apiPath string, body any, o RawOptions) (json.RawMessage, int, error) {
			status, reply, err := send(kubeContext, method, apiPath, body)
			return json.RawMessage(reply), status, err
		}
	}
	t.Cleanup(func() { liveReady, liveSend = oldReady, oldSend })
}
