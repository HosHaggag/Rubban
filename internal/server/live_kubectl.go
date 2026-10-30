package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"sync"

	"github.com/HosHaggag/rubban/internal/live"
)

var proxyReadyRE = regexp.MustCompile(`Starting to serve on 127\.0\.0\.1:(\d+)`)

// initLive creates the live layer. Like the Node backend it stays off when the caller asked for that
// or when a test runner is injected without a proxy starter (those tests keep the kubectl-only path).
func (b *Backend) initLive() {
	if b.opts.DisableLive || (b.opts.Runner != nil && b.opts.ProxyStarter == nil) {
		return
	}
	cfg := b.opts.LiveConfig
	cfg.Starter = b.opts.ProxyStarter
	if cfg.Starter == nil {
		cfg.Starter = kubectlProxyStarter{b}
	}
	b.live = live.New(cfg)
}

// kubectlProxyStarter runs `kubectl proxy` per context through the backend's process registry, so
// Close ends every proxy.
type kubectlProxyStarter struct{ b *Backend }

// proxyOutput watches a proxy's stdout for the line that announces its port and keeps the tail of
// what it printed for error messages.
type proxyOutput struct {
	mu    sync.Mutex
	tail  string
	ready chan string
	sent  bool
}

func (o *proxyOutput) Write(p []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.tail += string(p)
	if r := []rune(o.tail); len(r) > 4000 {
		o.tail = string(r[len(r)-4000:])
	}
	if !o.sent {
		if m := proxyReadyRE.FindStringSubmatch(o.tail); m != nil {
			o.sent = true
			o.ready <- m[1]
		}
	}
	return len(p), nil
}

func (o *proxyOutput) text() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return strings.TrimSpace(o.tail)
}

type kubectlProxy struct {
	b       *Backend
	cmd     *exec.Cmd
	baseURL string
	done    chan struct{}
	once    sync.Once
}

func (p *kubectlProxy) BaseURL() string       { return p.baseURL }
func (p *kubectlProxy) Done() <-chan struct{} { return p.done }
func (p *kubectlProxy) Stop()                 { p.once.Do(func() { killProcess(p.cmd.Process) }) }

// Start launches the proxy and waits for the line announcing its port.
func (s kubectlProxyStarter) Start(ctx context.Context, kubeContext string) (live.Proxy, error) {
	b := s.b
	if b.isClosed() {
		return nil, &live.Error{Status: 503, Message: "Backend is closed"}
	}
	tool, err := b.requireTool("kubectl")
	if err != nil {
		return nil, &live.Error{Status: statusOf(err), Message: err.Error()}
	}
	if strings.ContainsRune(kubeContext, 0) {
		return nil, &live.Error{Status: 400, Message: "Invalid process arguments"}
	}
	token := make([]byte, 16)
	_, _ = rand.Read(token)
	prefix := "/rubban-" + hex.EncodeToString(token)
	args := []string{"--context=" + kubeContext, "proxy", "--address=127.0.0.1", "--port=0", "--api-prefix=" + prefix + "/", `--accept-hosts=^127\.0\.0\.1$`}
	cmd := exec.Command(tool, args...)
	configureCommand(cmd)
	cmd.Env = b.kubeEnv()
	out := &proxyOutput{ready: make(chan string, 1)}
	errOut := &proxyOutput{ready: make(chan string, 1)}
	cmd.Stdout, cmd.Stderr = out, errOut
	if err := cmd.Start(); err != nil {
		return nil, &live.Error{Status: 503, Message: "Unable to start kubectl proxy: " + err.Error()}
	}
	b.procs.add(cmd.Process)
	proxy := &kubectlProxy{b: b, cmd: cmd, done: make(chan struct{})}
	var exitErr error
	go func() {
		exitErr = cmd.Wait()
		b.procs.remove(cmd.Process)
		close(proxy.done)
	}()
	if b.isClosed() {
		proxy.Stop()
	}
	select {
	case port := <-out.ready:
		proxy.baseURL = "http://127.0.0.1:" + port + prefix
		return proxy, nil
	case <-proxy.done:
		detail := errOut.text()
		if detail == "" {
			detail = out.text()
		}
		if detail == "" {
			detail = fmt.Sprintf("kubectl proxy exited with code %d", exitCode(exitErr))
		}
		if r := []rune(detail); len(r) > 2000 {
			detail = string(r[:2000])
		}
		return nil, &live.Error{Status: 502, Message: "Cluster connection failed: " + detail}
	case <-ctx.Done():
		proxy.Stop()
		return nil, ctx.Err()
	}
}

func exitCode(err error) int {
	if err == nil {
		return 0
	}
	if ee, ok := err.(*exec.ExitError); ok {
		return ee.ExitCode()
	}
	return -1
}
