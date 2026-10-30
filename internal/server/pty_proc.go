//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd || solaris || windows

package server

import (
	"errors"
	"os"
	"sync/atomic"

	gopty "github.com/aymanbagabas/go-pty"
)

// ptyProcess runs a command attached to a pseudo-terminal: creack/pty on Unix, ConPTY on Windows.
type ptyProcess struct {
	pty     gopty.Pty
	cmd     *gopty.Cmd
	untrack func()
	exited  atomic.Bool
}

func startPTYProcess(spec terminalSpec, track func(*os.Process) func()) (terminalProcess, error) {
	p, err := gopty.New()
	if err != nil {
		return nil, err
	}
	if err := p.Resize(spec.Cols, spec.Rows); err != nil {
		p.Close()
		return nil, err
	}
	cmd := p.Command(spec.Command, spec.Args...)
	cmd.Env, cmd.Dir = spec.Env, spec.Dir
	if err := cmd.Start(); err != nil {
		p.Close()
		return nil, err
	}
	releaseSlave(p)
	return &ptyProcess{pty: p, cmd: cmd, untrack: track(cmd.Process)}, nil
}

func (p *ptyProcess) Read(b []byte) (int, error)  { return p.pty.Read(b) }
func (p *ptyProcess) Write(b []byte) (int, error) { return p.pty.Write(b) }

func (p *ptyProcess) Resize(cols, rows int) error { return p.pty.Resize(cols, rows) }

func (p *ptyProcess) Wait() (int, error) {
	err := p.cmd.Wait()
	p.exited.Store(true)
	p.untrack()
	return exitCodeOf(p.cmd.ProcessState, err)
}

// Kill hangs up the terminal and terminates the process group. Interactive shells ignore SIGTERM, and
// closing the master does not hang them up while a read on it is still pending, so SIGHUP is sent
// explicitly (what node-pty's kill() does).
func (p *ptyProcess) Kill() {
	if !p.exited.Load() {
		hangupProcess(p.cmd.Process)
		killProcess(p.cmd.Process)
	}
}

func (p *ptyProcess) Close() error {
	err := p.pty.Close()
	// Unix closes the slave a second time after releaseSlave; that is not a failure.
	if errors.Is(err, os.ErrClosed) {
		return nil
	}
	return err
}
