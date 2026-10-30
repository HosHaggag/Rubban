package server

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path"
	"runtime"
	"strings"
	"time"
)

// Apps started from Finder, the Dock or Spotlight on macOS do not get the PATH (or other variables)
// set in ~/.zprofile / ~/.zshrc, so kubectl, helm and kubeconfig credential plugins such as
// gke-gcloud-auth-plugin, aws and kubelogin are not found. The import reads a small allowlist of
// variables from the user's login shell once at start-up and adds the usual tool folders.

var importedEnvVars = []string{"PATH", "KUBECONFIG", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
	"CLOUDSDK_CONFIG", "CLOUDSDK_PYTHON", "USE_GKE_GCLOUD_AUTH_PLUGIN", "GOOGLE_APPLICATION_CREDENTIALS",
	"AWS_PROFILE", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_REGION", "AWS_DEFAULT_REGION",
	"AZURE_CONFIG_DIR", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "LANG"}

const shellEnvMarker = "__RUBBAN_ENV__"

// ShellEnvOptions configure ImportShellEnvironment. The zero value reads the real process.
type ShellEnvOptions struct {
	Env     map[string]string // the environment to extend; nil snapshots os.Environ
	GOOS    string            // default runtime.GOOS
	Home    string            // default os.UserHomeDir
	Timeout time.Duration     // default 5 s
	// Exists reports whether a file or folder exists (default os.Stat).
	Exists func(string) bool
	// Run executes the login shell and returns its stdout. On failure it may still return partial output.
	Run func(ctx context.Context, shell string, args []string, env []string) ([]byte, error)
}

func commonToolFolders(home string) []string {
	return []string{"/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin",
		path.Join(home, "google-cloud-sdk", "bin"), "/opt/homebrew/share/google-cloud-sdk/bin", "/usr/local/share/google-cloud-sdk/bin",
		"/opt/homebrew/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/bin", "/usr/local/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/bin",
		path.Join(home, ".krew", "bin"), path.Join(home, ".rd", "bin"), path.Join(home, ".local", "bin"), path.Join(home, "bin"),
		"/Applications/Docker.app/Contents/Resources/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"}
}

// parseShellEnv reads the allowlisted KEY=value lines printed after the last marker.
func parseShellEnv(text string) map[string]string {
	values := map[string]string{}
	start := strings.LastIndex(text, shellEnvMarker+"\n")
	if start < 0 {
		return values
	}
	for _, line := range strings.Split(text[start+len(shellEnvMarker)+1:], "\n") {
		i := strings.IndexByte(line, '=')
		if i <= 0 {
			continue
		}
		key := line[:i]
		for _, allowed := range importedEnvVars {
			if key == allowed {
				values[key] = line[i+1:]
				break
			}
		}
	}
	return values
}

// mergePathLists joins PATH lists, dropping empty and repeated entries, keeping first-seen order.
func mergePathLists(lists ...string) string {
	seen := map[string]bool{}
	var out []string
	for _, list := range lists {
		for _, entry := range strings.Split(list, ":") {
			if entry == "" || seen[entry] {
				continue
			}
			seen[entry] = true
			out = append(out, entry)
		}
	}
	return strings.Join(out, ":")
}

func runLoginShell(ctx context.Context, shell string, args []string, env []string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, shell, args...)
	cmd.Env = env
	var out bytes.Buffer
	cmd.Stdout = &out
	// A background child of the shell must not keep the pipe open past the timeout.
	cmd.WaitDelay = time.Second
	err := cmd.Run()
	return out.Bytes(), err
}

// ImportShellEnvironment returns the variables that should change in opts.Env: PATH extended with
// the login shell's PATH and the usual tool folders, plus allowlisted variables the process does not
// have. Windows and RUBBAN_SKIP_SHELL_ENV=1 change nothing. It does not modify opts.Env.
func ImportShellEnvironment(opts ShellEnvOptions) map[string]string {
	env := opts.Env
	if env == nil {
		env = map[string]string{}
		for _, kv := range os.Environ() {
			if k, v, ok := strings.Cut(kv, "="); ok && k != "" {
				env[k] = v
			}
		}
	}
	goos := opts.GOOS
	if goos == "" {
		goos = runtime.GOOS
	}
	changed := map[string]string{}
	if goos == "windows" || env["RUBBAN_SKIP_SHELL_ENV"] == "1" {
		return changed
	}
	exists := opts.Exists
	if exists == nil {
		exists = func(p string) bool { _, err := os.Stat(p); return err == nil }
	}
	run := opts.Run
	if run == nil {
		run = runLoginShell
	}
	home := opts.Home
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	fallbackShell := "/bin/bash"
	if goos == "darwin" {
		fallbackShell = "/bin/zsh"
	}
	shell := ""
	for _, candidate := range []string{env["SHELL"], fallbackShell} {
		if candidate != "" && path.IsAbs(candidate) && exists(candidate) {
			shell = candidate
			break
		}
	}
	imported := map[string]string{}
	if shell != "" {
		// -i -l: read the same startup files as a Terminal window. Output before the marker (banners,
		// motd) is ignored; stdin is closed so prompts cannot block start-up.
		script := `printf '\n` + shellEnvMarker + `\n'; for v in ` + strings.Join(importedEnvVars, " ") +
			`; do eval "x=\${$v-__unset__}"; if [ "$x" != "__unset__" ]; then printf '%s=%s\n' "$v" "$x"; fi; done; exit 0`
		probeEnv := make([]string, 0, len(env)+3)
		for k, v := range env {
			probeEnv = append(probeEnv, k+"="+v)
		}
		probeEnv = append(probeEnv, "DISABLE_AUTO_UPDATE=true", "ZSH_DISABLE_COMPFIX=true", "RUBBAN_SHELL_PROBE=1")
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		// A failure (including a timeout) still yields whatever the shell printed before it.
		output, _ := run(ctx, shell, []string{"-ilc", script}, probeEnv)
		cancel()
		imported = parseShellEnv(string(output))
	}
	// What the app was started with keeps priority (a Finder launch only has the system folders, which
	// hold no Kubernetes tools); then the login shell's PATH, then the usual tool folders.
	var folders []string
	for _, folder := range commonToolFolders(home) {
		if exists(folder) {
			folders = append(folders, folder)
		}
	}
	if next := mergePathLists(env["PATH"], imported["PATH"], strings.Join(folders, ":")); next != env["PATH"] {
		changed["PATH"] = next
	}
	for key, value := range imported {
		if _, set := env[key]; key == "PATH" || set || value == "" {
			continue
		}
		changed[key] = value
	}
	return changed
}

// ApplyShellEnvironment imports the login shell's environment into this process so every child
// inherits it. Call it before the backend starts. It returns the variables it set.
func ApplyShellEnvironment() map[string]string {
	changed := ImportShellEnvironment(ShellEnvOptions{})
	for key, value := range changed {
		_ = os.Setenv(key, value)
	}
	return changed
}
