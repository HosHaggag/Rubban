package server

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"strings"
	"sync"

	"github.com/coder/websocket"
)

// logArgs builds the kubectl logs command for a /api/logs request.
func logArgs(query map[string]string) ([]string, error) {
	get := func(k string) any {
		if v, ok := query[k]; ok {
			return v
		}
		return nil
	}
	ctxArgs, err := contextArgs(get("context"))
	if err != nil {
		return nil, err
	}
	nsArgs, err := namespaceArgs(get("namespace"), false)
	if err != nil {
		return nil, err
	}
	args := append(append(ctxArgs, nsArgs...), "logs")
	if query["selector"] != "" {
		sel, err := validateTextOpt(query["selector"], "selector", true, 2000)
		if err != nil {
			return nil, err
		}
		if !selectorRE.MatchString(sel) || strings.Contains(sel, "--") {
			return nil, bad("Invalid label selector")
		}
		max, err := integer(get("maxRequests"), "max log requests", 1, 50, fb(20))
		if err != nil {
			return nil, err
		}
		args = append(args, "--selector="+sel, "--prefix=true", fmt.Sprintf("--max-log-requests=%d", max))
		if query["container"] == "" {
			args = append(args, "--all-containers=true")
		}
	} else {
		pod, err := validateName(get("pod"), "pod")
		if err != nil {
			return nil, err
		}
		args = append(args, pod)
	}
	follow := "true"
	if query["follow"] == "false" {
		follow = "false"
	}
	tail, err := integer(get("tail"), "tail lines", -1, 100000, fb(100))
	if err != nil {
		return nil, err
	}
	args = append(args, "--follow="+follow, fmt.Sprintf("--tail=%d", tail))
	switch c := query["container"]; {
	case c == "*":
		args = append(args, "--all-containers=true")
		if query["selector"] == "" {
			args = append(args, "--prefix=true")
		}
	case c != "":
		name, err := validateName(c, "container")
		if err != nil {
			return nil, err
		}
		args = append(args, "--container="+name)
	}
	if query["timestamps"] == "true" {
		args = append(args, "--timestamps=true")
	}
	if query["since"] != "" {
		n, err := integer(get("since"), "since seconds", 1, 30*86400, nil)
		if err != nil {
			return nil, err
		}
		args = append(args, fmt.Sprintf("--since=%ds", n))
	}
	if p := query["previous"]; p == "true" {
		args = append(args, "--previous=true")
	} else if p != "" && p != "false" {
		return nil, bad("Invalid previous-log flag")
	}
	return args, nil
}

func (b *Backend) serveLogs(w http.ResponseWriter, r *http.Request) {
	conn, err := b.acceptWS(w, r)
	if err != nil {
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	fail := func(code websocket.StatusCode, reason string, err error) {
		_ = conn.Write(ctx, websocket.MessageText, []byte("[error] "+shortError(err)+"\n"))
		_ = conn.Close(code, reason)
	}
	query := map[string]string{}
	for k, v := range r.URL.Query() {
		if len(v) > 0 {
			query[k] = v[len(v)-1]
		}
	}
	// A selector follows every pod of the workload, new ones included.
	if query["selector"] != "" {
		b.serveMultiLogs(conn, ctx, cancel, query)
		return
	}
	args, err := logArgs(query)
	if err != nil {
		fail(websocket.StatusPolicyViolation, "Invalid log request", err)
		return
	}
	tool, err := b.requireTool("kubectl")
	if err != nil {
		fail(websocket.StatusPolicyViolation, "Invalid log request", err)
		return
	}
	if b.opts.Runner != nil {
		fail(websocket.StatusInternalError, "Log command failed", problem("The injected runner does not support streaming commands", 503))
		return
	}
	cmd := exec.Command(tool, args...)
	configureCommand(cmd)
	cmd.Env = b.kubeEnv()
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		fail(websocket.StatusInternalError, "Log command failed", err)
		return
	}
	b.procs.add(cmd.Process)
	defer b.procs.remove(cmd.Process)
	// Reading drives close detection; closing the socket kills kubectl.
	go func() {
		for {
			if _, _, err := conn.Read(ctx); err != nil {
				cancel()
				return
			}
		}
	}()
	go func() { <-ctx.Done(); killProcess(cmd.Process) }()
	var wmu sync.Mutex
	var wg sync.WaitGroup
	pipe := func(rd io.Reader) {
		defer wg.Done()
		buf := make([]byte, 32*1024)
		for {
			n, err := rd.Read(buf)
			if n > 0 {
				wmu.Lock()
				werr := conn.Write(ctx, websocket.MessageText, append([]byte(nil), buf[:n]...))
				wmu.Unlock()
				if werr != nil {
					cancel()
					return
				}
			}
			if err != nil {
				return
			}
		}
	}
	wg.Add(2)
	go pipe(stdout)
	go pipe(stderr)
	wg.Wait()
	waitErr := cmd.Wait()
	if ctx.Err() != nil {
		_ = conn.CloseNow()
		return
	}
	if waitErr != nil {
		code := -1
		if ee, ok := waitErr.(*exec.ExitError); ok {
			code = ee.ExitCode()
		}
		_ = conn.Write(ctx, websocket.MessageText, []byte(fmt.Sprintf("\n[process exited with code %d]\n", code)))
	}
	_ = conn.Close(websocket.StatusNormalClosure, "Log stream ended")
}
