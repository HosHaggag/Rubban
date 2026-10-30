//go:build !windows

package server

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"testing/fstest"
	"time"

	"github.com/HosHaggag/rubban/internal/live"
	"github.com/HosHaggag/rubban/internal/live/livetest"
)

// ---------------------------------------------------------------------------------------------
// The kubectl proxy process

// lvFakeKubectl writes a stand-in for kubectl (never the real one) that records its arguments and
// either announces a proxy port or misbehaves.
func lvFakeKubectl(t *testing.T, body string) (path, argsFile, pidFile string) {
	t.Helper()
	dir := t.TempDir()
	argsFile, pidFile = filepath.Join(dir, "args"), filepath.Join(dir, "pid")
	path = filepath.Join(dir, "kubectl")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > '" + argsFile + "'\necho $$ > '" + pidFile + "'\n" + body
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path, argsFile, pidFile
}

func lvProcessGone(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == syscall.ESRCH
}

func TestKubectlProxyStarterRunsThroughTheRegistryAndCloseKillsIt(t *testing.T) {
	api := livetest.New()
	defer api.Close()
	api.Put("ADDED", lvConfigMap("a"))
	port := strings.TrimPrefix(api.BaseURL(), "http://127.0.0.1:")
	kubectl, argsFile, pidFile := lvFakeKubectl(t, "echo 'Starting to serve on 127.0.0.1:"+port+"'\nexec sleep 300\n")
	b := New(Options{DataDir: filepath.Join(t.TempDir(), "data"), KubectlPath: kubectl,
		UI: fstest.MapFS{"index.html": {Data: []byte("x")}}})
	conn, err := b.Start(0)
	if err != nil {
		t.Fatal(err)
	}
	_ = conn
	t.Cleanup(func() { _ = b.Close() })

	proxy, err := kubectlProxyStarter{b}.Start(context.Background(), "my-ctx")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(proxy.BaseURL(), "http://127.0.0.1:"+port+"/rubban-") || len(strings.TrimPrefix(proxy.BaseURL(), "http://127.0.0.1:"+port+"/rubban-")) != 32 {
		t.Fatalf("base url %q", proxy.BaseURL())
	}
	argsRaw, _ := os.ReadFile(argsFile)
	args := strings.Fields(string(argsRaw))
	prefix := strings.TrimPrefix(proxy.BaseURL(), "http://127.0.0.1:"+port)
	want := []string{"--context=my-ctx", "proxy", "--address=127.0.0.1", "--port=0", "--api-prefix=" + prefix + "/", `--accept-hosts=^127\.0\.0\.1$`}
	if fmt.Sprint(args) != fmt.Sprint(want) {
		t.Fatalf("args %v", args)
	}
	pidRaw, _ := os.ReadFile(pidFile)
	var pid int
	_, _ = fmt.Sscanf(string(pidRaw), "%d", &pid)
	if pid == 0 || lvProcessGone(pid) {
		t.Fatalf("proxy process not running: pid %d", pid)
	}
	b.procs.mu.Lock()
	tracked := len(b.procs.set)
	b.procs.mu.Unlock()
	if tracked != 1 {
		t.Fatalf("the proxy must be in the process registry, tracked=%d", tracked)
	}
	_ = b.Close()
	lvWait(t, "proxy process killed by Close", func() bool { return lvProcessGone(pid) })
	select {
	case <-proxy.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("Done must close when the process ends")
	}
}

func TestKubectlProxyStarterFailureModes(t *testing.T) {
	// Exits before announcing a port: 502 with kubectl's message.
	kubectl, _, _ := lvFakeKubectl(t, "echo 'error: context \"nope\" does not exist' >&2\nexit 1\n")
	b := New(Options{DataDir: t.TempDir(), KubectlPath: kubectl})
	defer b.Close()
	_, err := kubectlProxyStarter{b}.Start(context.Background(), "nope")
	var le *live.Error
	if !asLiveError(err, &le) || le.Status != 502 || !strings.HasPrefix(le.Message, "Cluster connection failed: error: context") {
		t.Fatalf("exit before ready: %#v", err)
	}

	// Never announces a port: the caller's deadline ends it and the process is killed.
	kubectl2, _, pidFile := lvFakeKubectl(t, "exec sleep 300\n")
	b2 := New(Options{DataDir: t.TempDir(), KubectlPath: kubectl2})
	defer b2.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if _, err := (kubectlProxyStarter{b2}).Start(ctx, "slow"); err == nil || ctx.Err() == nil {
		t.Fatalf("expected the start to time out: %v", err)
	}
	pidRaw, _ := os.ReadFile(pidFile)
	var pid int
	_, _ = fmt.Sscanf(string(pidRaw), "%d", &pid)
	lvWait(t, "slow proxy killed", func() bool { return pid != 0 && lvProcessGone(pid) })

	// kubectl missing: the 503 from requireTool.
	b3 := New(Options{DataDir: t.TempDir(), KubectlPath: filepath.Join(t.TempDir(), "absent")})
	defer b3.Close()
	_, err = kubectlProxyStarter{b3}.Start(context.Background(), "x")
	if !asLiveError(err, &le) || le.Status != 503 || !strings.Contains(le.Message, "kubectl is not installed") {
		t.Fatalf("missing tool: %#v", err)
	}

	// Through the pool all of those mark the proxy unavailable, and a closed backend refuses.
	_ = b3.Close()
	if _, err := (kubectlProxyStarter{b3}).Start(context.Background(), "x"); err == nil {
		t.Fatal("closed backend must refuse")
	}
}

func asLiveError(err error, target **live.Error) bool {
	if e, ok := err.(*live.Error); ok {
		*target = e
		return true
	}
	return false
}
