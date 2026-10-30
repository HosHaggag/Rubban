package server

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	outputLimit     = 12 * 1024 * 1024
	listOutputLimit = 64 * 1024 * 1024
)

// RunOptions configures one command invocation.
type RunOptions struct {
	Timeout   time.Duration // default 60 s, max 600 s
	MaxBytes  int           // combined stdout+stderr cap, default 12 MiB, max 64 MiB
	AllowExit []int         // default {0}
	Input     string        // written to stdin, which is then closed
	Env       []string      // nil means the backend's kubectl environment
	Dir       string
}

// Result is the outcome of a finished command.
type Result struct {
	Stdout string
	Stderr string
	Code   int
}

// CommandRunner executes a program. The default implementation spawns a process; tests inject a fake.
type CommandRunner func(ctx context.Context, command string, args []string, opts RunOptions) (Result, error)

// processes tracks every child the backend started so Close can end them.
type processes struct {
	mu   sync.Mutex
	set  map[*os.Process]struct{}
	done bool
}

func (p *processes) add(proc *os.Process) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.set == nil {
		p.set = map[*os.Process]struct{}{}
	}
	p.set[proc] = struct{}{}
}

func (p *processes) remove(proc *os.Process) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.set, proc)
}

func (p *processes) killAll() {
	p.mu.Lock()
	all := make([]*os.Process, 0, len(p.set))
	for proc := range p.set {
		all = append(all, proc)
	}
	p.set = nil
	p.done = true
	p.mu.Unlock()
	for _, proc := range all {
		killProcess(proc)
	}
}

// limitedBuffer collects output and refuses to grow past max.
type limitedBuffer struct {
	mu       sync.Mutex
	buf      bytes.Buffer
	max      int
	exceeded bool
	shared   *int
	onLimit  func()
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	*l.shared += len(p)
	if *l.shared > l.max {
		if !l.exceeded {
			l.exceeded = true
			if l.onLimit != nil {
				go l.onLimit()
			}
		}
		return len(p), nil
	}
	l.buf.Write(p)
	return len(p), nil
}

func (b *Backend) execRunner(ctx context.Context, command string, args []string, opts RunOptions) (Result, error) {
	cmd := exec.Command(command, args...)
	configureCommand(cmd)
	cmd.Env = opts.Env
	cmd.Dir = opts.Dir
	cmd.Stdin = strings.NewReader(opts.Input)
	total := 0
	var out, errb limitedBuffer
	var once sync.Once
	kill := func() { once.Do(func() { killProcess(cmd.Process) }) }
	out = limitedBuffer{max: opts.MaxBytes, shared: &total, onLimit: kill}
	errb = limitedBuffer{max: opts.MaxBytes, shared: &total, onLimit: kill}
	cmd.Stdout = &out
	cmd.Stderr = &errb
	if err := cmd.Start(); err != nil {
		return Result{}, problem(fmt.Sprintf("Unable to start %s: %s", filepath.Base(command), err.Error()), 503)
	}
	b.procs.add(cmd.Process)
	defer b.procs.remove(cmd.Process)
	waited := make(chan error, 1)
	go func() { waited <- cmd.Wait() }()
	select {
	case err := <-waited:
		if out.exceeded || errb.exceeded {
			return Result{}, problem("Command output exceeded the configured limit", 502)
		}
		code := 0
		if err != nil {
			var ee *exec.ExitError
			if errors.As(err, &ee) {
				code = ee.ExitCode()
			} else {
				return Result{}, problem(fmt.Sprintf("Unable to run %s: %s", filepath.Base(command), err.Error()), 503)
			}
		}
		return Result{Stdout: out.buf.String(), Stderr: errb.buf.String(), Code: code}, nil
	case <-ctx.Done():
		kill()
		<-waited
		return Result{}, ctx.Err()
	}
}

// run validates arguments, applies timeout and limits, and enforces allowed exit codes.
func (b *Backend) run(ctx context.Context, command string, args []string, opts RunOptions) (Result, error) {
	if b.isClosed() {
		return Result{}, problem("Backend is closed", 503)
	}
	if command == "" || strings.ContainsRune(command, 0) {
		return Result{}, bad("Invalid process arguments")
	}
	for _, a := range args {
		if strings.ContainsRune(a, 0) {
			return Result{}, bad("Invalid process arguments")
		}
	}
	if opts.Timeout <= 0 {
		opts.Timeout = 60 * time.Second
	}
	if opts.Timeout > 600*time.Second {
		return Result{}, bad("Invalid process timeout")
	}
	if opts.MaxBytes <= 0 {
		opts.MaxBytes = outputLimit
	}
	if opts.MaxBytes > 64*1024*1024 {
		return Result{}, bad("Invalid output limit")
	}
	allow := opts.AllowExit
	if allow == nil {
		allow = []int{0}
	}
	if opts.Env == nil {
		opts.Env = b.kubeEnv()
	}
	ctx, stop := context.WithCancel(ctx)
	defer stop()
	defer b.trackRun(stop)()
	deadline, cancelTimer := context.WithTimeout(ctx, opts.Timeout)
	defer cancelTimer()
	res, err := b.runner(deadline, command, append([]string(nil), args...), opts)
	if err != nil {
		var p *Problem
		if errors.As(err, &p) {
			return Result{}, err
		}
		if ctx.Err() != nil {
			return Result{}, problem("Command canceled", 499)
		}
		if deadline.Err() != nil {
			return Result{}, problem(fmt.Sprintf("Command timed out after %d ms", opts.Timeout.Milliseconds()), 504)
		}
		return Result{}, problem(fmt.Sprintf("Unable to start %s: %s", filepath.Base(command), err.Error()), 503)
	}
	if len(res.Stdout)+len(res.Stderr) > opts.MaxBytes {
		return Result{}, problem("Command output exceeded the configured limit", 502)
	}
	ok := false
	for _, c := range allow {
		if c == res.Code {
			ok = true
		}
	}
	if !ok {
		detail := strings.TrimSpace(res.Stderr)
		if detail == "" {
			detail = strings.TrimSpace(res.Stdout)
		}
		if r := []rune(detail); len(r) > 5000 {
			detail = string(r[:5000])
		}
		msg := fmt.Sprintf("%s exited with code %d", filepath.Base(command), res.Code)
		if detail != "" {
			msg += ": " + detail
		}
		return res, &runError{Problem: problem(msg, 502), Result: res}
	}
	return res, nil
}

// runError is a 502 for a non-zero exit that still exposes the captured output.
type runError struct {
	*Problem
	Result Result
}

func (e *runError) Unwrap() error { return e.Problem }

var _ io.Writer = (*limitedBuffer)(nil)
