package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

// terminalProcess is one running interactive command: a PTY-backed process or a pair of pipes.
// Tests inject fakes through terminalState.start.
type terminalProcess interface {
	// Read returns the merged output of the command. It fails with io.EOF (or any error) when the
	// output is finished or the process was closed.
	Read(p []byte) (int, error)
	Write(p []byte) (int, error)
	// Resize changes the terminal size; pipes ignore it.
	Resize(cols, rows int) error
	// Wait blocks until the command exits and returns its exit code (-1 when it was signalled).
	Wait() (int, error)
	// Kill ends the command and its process group. It does nothing once the command has exited.
	Kill()
	// Close releases the PTY or pipes and unblocks Read.
	Close() error
}

// terminalSpec describes the command a terminal session starts.
type terminalSpec struct {
	Command    string
	Args       []string
	Env        []string
	Dir        string
	Cols, Rows int
	PTY        bool
}

// terminalState is the Backend's terminal bookkeeping.
type terminalState struct {
	// start replaces process spawning (tests). Nil spawns real processes through the registry.
	start func(spec terminalSpec) (terminalProcess, error)

	mu       sync.Mutex
	sessions map[*terminalSession]struct{}
}

func (t *terminalState) add(s *terminalSession) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.sessions == nil {
		t.sessions = map[*terminalSession]struct{}{}
	}
	t.sessions[s] = struct{}{}
}

func (t *terminalState) remove(s *terminalSession) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.sessions, s)
}

func (t *terminalState) cancelAll() {
	t.mu.Lock()
	all := make([]*terminalSession, 0, len(t.sessions))
	for s := range t.sessions {
		all = append(all, s)
	}
	t.mu.Unlock()
	for _, s := range all {
		s.cancel()
	}
}

func (b *Backend) terminalsDir() string { return filepath.Join(b.dataDir, "terminals") }

// wipeTerminals removes scoped kubeconfigs left by a crash, a forced quit or a finished session.
func (b *Backend) wipeTerminals() { _ = os.RemoveAll(b.terminalsDir()) }

// closeTerminals ends every open terminal session and removes their kubeconfigs.
func (b *Backend) closeTerminals() {
	b.term.cancelAll()
	b.wipeTerminals()
}

func (b *Backend) startTerminalProcess(spec terminalSpec) (terminalProcess, error) {
	if b.isClosed() {
		return nil, problem("Backend is closed", 503)
	}
	if b.term.start != nil {
		return b.term.start(spec)
	}
	if spec.PTY {
		return startPTYProcess(spec, b.procs.track)
	}
	return startPipeProcess(spec, b.procs.track)
}

// track registers a child so Close can end it and returns the function that forgets it.
func (p *processes) track(proc *os.Process) func() {
	p.add(proc)
	return func() { p.remove(proc) }
}

// --- the local shell -------------------------------------------------------------------

// localShell is the local terminal. A shell opened for a cluster skips the user's startup files, so a
// profile that exports KUBECONFIG cannot silently point it at another cluster; an unscoped shell is
// the user's normal login shell (zsh on macOS, $SHELL elsewhere, PowerShell on Windows).
func localShell(goos, shellEnv string, scoped bool, exists func(string) bool) (string, []string) {
	if goos == "windows" {
		root := os.Getenv("SystemRoot")
		if root == "" {
			root = `C:\Windows`
		}
		command := strings.TrimRight(root, `\/`) + `\System32\WindowsPowerShell\v1.0\powershell.exe`
		if scoped {
			return command, []string{"-NoLogo", "-NoProfile"}
		}
		return command, []string{"-NoLogo"}
	}
	preferred := []string{shellEnv}
	if goos == "darwin" {
		preferred = append(preferred, "/bin/zsh")
	}
	preferred = append(preferred, "/bin/bash", "/bin/sh")
	command := "/bin/sh"
	for _, candidate := range preferred {
		if candidate != "" && path.IsAbs(candidate) && exists(candidate) {
			command = candidate
			break
		}
	}
	name := path.Base(command)
	if !scoped {
		if name == "sh" {
			return command, nil
		}
		return command, []string{"-l"}
	}
	switch name {
	case "bash":
		return command, []string{"--noprofile", "--norc"}
	case "zsh":
		return command, []string{"-f"}
	case "fish":
		return command, []string{"--no-config"}
	}
	if exists("/bin/sh") {
		return "/bin/sh", nil
	}
	return command, nil
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// scopedKubeconfig writes a minified kubeconfig for one context (and the selected namespace) so
// kubectl and helm in a local shell target the cluster on screen.
func (b *Backend) scopedKubeconfig(ctx context.Context, kubeContext, namespace string) (string, error) {
	name, err := validateText(kubeContext, "context")
	if err != nil {
		return "", err
	}
	res, err := b.kube(ctx, []string{"config", "view", "--raw", "--minify", "--flatten", "--context=" + name, "--output=json"}, RunOptions{Timeout: 20 * time.Second})
	if err != nil {
		return "", err
	}
	var config map[string]any
	if err := json.Unmarshal([]byte(res.Stdout), &config); err != nil || config == nil {
		return "", errors.New("kubectl returned an invalid kubeconfig")
	}
	if namespace != "" && namespace != "*" {
		ns, err := validateNamespace(namespace, false)
		if err != nil {
			return "", err
		}
		if contexts, ok := config["contexts"].([]any); ok && len(contexts) > 0 {
			if first, ok := contexts[0].(map[string]any); ok {
				if inner, ok := first["context"].(map[string]any); ok {
					inner["namespace"] = ns
				}
			}
		}
	}
	data, err := marshalNoEscape(config)
	if err != nil {
		return "", err
	}
	dir := b.terminalsDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	id := make([]byte, 8)
	_, _ = rand.Read(id)
	file := filepath.Join(dir, hex.EncodeToString(id)+".kubeconfig")
	if err := os.WriteFile(file, data, 0o600); err != nil {
		return "", err
	}
	return file, nil
}

func marshalNoEscape(v any) ([]byte, error) {
	var sb strings.Builder
	enc := json.NewEncoder(&sb)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return []byte(strings.TrimRight(sb.String(), "\n")), nil
}

// --- the command a session runs ---------------------------------------------------------

var (
	nodeImageRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/:@-]*$`)
	// The terminator guards against a name split across two output chunks.
	debugPodRE = regexp.MustCompile(`debugging pod (node-debugger-[a-z0-9.-]+)[^a-z0-9.-]`)
)

// terminalPlan is a validated session request.
type terminalPlan struct {
	mode       string // local, node, exec or attach
	remote     bool
	command    string
	args       func(tty bool) []string
	dir        string
	kubeconfig string
	kubeCtx    string // context a debug pod belongs to
}

func (b *Backend) planTerminal(ctx context.Context, query map[string]string) (*terminalPlan, error) {
	get := func(k string) any {
		if v, ok := query[k]; ok {
			return v
		}
		return nil
	}
	plan := &terminalPlan{mode: "local", remote: query["pod"] != "" || query["node"] != ""}
	if query["run"] != "" && plan.remote {
		return nil, bad("A sign-in command cannot run inside a pod or node")
	}
	switch {
	case query["node"] != "":
		// A short-lived privileged debug pod on the node, entering the host filesystem.
		plan.mode = "node"
		tool, err := b.requireTool("kubectl")
		if err != nil {
			return nil, err
		}
		image := query["image"]
		if image == "" {
			image = "busybox:1.36"
		}
		if image, err = validateTextOpt(image, "node shell image", true, 300); err != nil {
			return nil, err
		}
		if !nodeImageRE.MatchString(image) {
			return nil, bad("Invalid node shell image")
		}
		ctxArgs, err := contextArgs(get("context"))
		if err != nil {
			return nil, err
		}
		node, err := validateName(get("node"), "node")
		if err != nil {
			return nil, err
		}
		plan.command, plan.kubeCtx = tool, query["context"]
		plan.args = func(tty bool) []string {
			args := append(append([]string{}, ctxArgs...), "--namespace=kube-system", "debug", "node/"+node, "--stdin=true", "--image="+image, "--profile=sysadmin")
			if tty {
				args = append(args, "--tty=true")
			}
			return append(args, "--", "chroot", "/host", "/bin/sh", "-c", "if [ -x /bin/bash ]; then exec /bin/bash -l; else exec /bin/sh -l; fi")
		}
	case query["pod"] != "":
		plan.mode = "exec"
		if query["attach"] == "true" {
			plan.mode = "attach"
		}
		tool, err := b.requireTool("kubectl")
		if err != nil {
			return nil, err
		}
		ctxArgs, err := contextArgs(get("context"))
		if err != nil {
			return nil, err
		}
		nsArgs, err := namespaceArgs(get("namespace"), false)
		if err != nil {
			return nil, err
		}
		pod, err := validateName(get("pod"), "pod")
		if err != nil {
			return nil, err
		}
		var container string
		if query["container"] != "" {
			if container, err = validateName(get("container"), "container"); err != nil {
				return nil, err
			}
		}
		mode := plan.mode
		plan.command = tool
		plan.args = func(tty bool) []string {
			args := append(append(append([]string{}, ctxArgs...), nsArgs...), mode, "--stdin=true")
			if tty {
				args = append(args, "--tty=true")
			}
			args = append(args, pod)
			if container != "" {
				args = append(args, "--container="+container)
			}
			// Prefer bash when the image has it; fall back to sh.
			if mode == "exec" {
				args = append(args, "--", "/bin/sh", "-c", "if [ -x /bin/bash ]; then exec /bin/bash; else exec /bin/sh; fi")
			}
			return args
		}
	default:
		scoped := query["context"] != ""
		command, args := localShell(runtime.GOOS, os.Getenv("SHELL"), scoped, fileExists)
		if query["run"] != "" {
			// A sign-in preset replaces the shell: the session ends with the command, and its exit
			// code tells the UI whether the login worked.
			if !scoped {
				return nil, bad("A sign-in command needs a cluster context")
			}
			kubeContext, err := validateText(get("context"), "context")
			if err != nil {
				return nil, err
			}
			if command, args, err = b.signInPlan(ctx, query["run"], kubeContext); err != nil {
				return nil, err
			}
		}
		plan.command = command
		plan.args = func(bool) []string { return append([]string{}, args...) }
		if scoped {
			// Fail closed: never open a "cluster" shell that would silently use another context.
			file, err := b.scopedKubeconfig(ctx, query["context"], query["namespace"])
			if err != nil {
				return nil, problem(fmt.Sprintf("Could not prepare a kubeconfig for %s: %s", query["context"], shortError(err)), 502)
			}
			plan.kubeconfig = file
		}
	}
	// Local shells start in the home folder; kubectl sessions do not depend on it.
	home, _ := os.UserHomeDir()
	switch {
	case plan.mode == "local" && home != "" && fileExists(home):
		plan.dir = home
	case fileExists(b.dataDir):
		plan.dir = b.dataDir
	default:
		plan.dir = home
	}
	return plan, nil
}

// terminalEnv is the process environment plus TERM and the scoped kubeconfig.
func (b *Backend) terminalEnv(plan *terminalPlan, kubeContext string) []string {
	env := b.kubeEnv()
	if env == nil {
		env = os.Environ()
	}
	env = append([]string(nil), env...)
	env = setEnv(env, "TERM", "xterm-256color")
	if plan.kubeconfig != "" {
		env = setEnv(env, "KUBECONFIG", plan.kubeconfig)
		env = setEnv(env, "RUBBAN_CONTEXT", kubeContext)
	}
	return env
}

func setEnv(env []string, key, value string) []string {
	out := env[:0:0]
	for _, kv := range env {
		name, _, _ := strings.Cut(kv, "=")
		if name == key || (runtime.GOOS == "windows" && strings.EqualFold(name, key)) {
			continue
		}
		out = append(out, kv)
	}
	return append(out, key+"="+value)
}

// --- output decoding --------------------------------------------------------------------

// utf8Carry holds back an incomplete trailing UTF-8 sequence so a character split across two reads is
// not turned into replacement characters.
type utf8Carry struct{ rest []byte }

func (c *utf8Carry) next(chunk []byte) string {
	data := append(c.rest, chunk...)
	cut := len(data)
	for i := len(data) - 1; i >= 0 && i >= len(data)-utf8.UTFMax+1; i-- {
		if utf8.RuneStart(data[i]) {
			if !utf8.FullRune(data[i:]) {
				cut = i
			}
			break
		}
	}
	c.rest = append([]byte(nil), data[cut:]...)
	return string(data[:cut])
}

func (c *utf8Carry) flush() string {
	out := string(c.rest)
	c.rest = nil
	return out
}

// --- command pipes ----------------------------------------------------------------------

// pipeProcess runs a command with stdin and a merged stdout+stderr pipe: no TTY, no resize.
type pipeProcess struct {
	cmd     *exec.Cmd
	in      *os.File
	out     *os.File
	untrack func()
	exited  atomic.Bool
}

func startPipeProcess(spec terminalSpec, track func(*os.Process) func()) (terminalProcess, error) {
	inR, inW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		inR.Close()
		inW.Close()
		return nil, err
	}
	cmd := exec.Command(spec.Command, spec.Args...)
	configureCommand(cmd)
	cmd.Env, cmd.Dir = spec.Env, spec.Dir
	cmd.Stdin, cmd.Stdout, cmd.Stderr = inR, outW, outW
	err = cmd.Start()
	// The child holds its own ends; ours must close so EOF and EPIPE can be seen.
	inR.Close()
	outW.Close()
	if err != nil {
		inW.Close()
		outR.Close()
		return nil, err
	}
	return &pipeProcess{cmd: cmd, in: inW, out: outR, untrack: track(cmd.Process)}, nil
}

func (p *pipeProcess) Read(b []byte) (int, error)  { return p.out.Read(b) }
func (p *pipeProcess) Write(b []byte) (int, error) { return p.in.Write(b) }
func (p *pipeProcess) Resize(int, int) error       { return nil }

func (p *pipeProcess) Wait() (int, error) {
	err := p.cmd.Wait()
	p.exited.Store(true)
	p.untrack()
	return exitCodeOf(p.cmd.ProcessState, err)
}

func (p *pipeProcess) Kill() {
	if !p.exited.Load() {
		killProcess(p.cmd.Process)
	}
}

func (p *pipeProcess) Close() error {
	return errors.Join(p.in.Close(), p.out.Close())
}

// exitCodeOf maps a finished command to the code a terminal reports.
func exitCodeOf(state *os.ProcessState, err error) (int, error) {
	if state != nil {
		return state.ExitCode(), nil
	}
	return -1, err
}

var _ io.ReadWriter = (*pipeProcess)(nil)
