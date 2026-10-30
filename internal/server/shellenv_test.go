package server

import (
	"context"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func existsIn(files ...string) func(string) bool {
	return func(p string) bool {
		for _, f := range files {
			if f == p {
				return true
			}
		}
		return false
	}
}

func TestShellEnvPicksUpPathAndKubeconfigFromLoginShell(t *testing.T) {
	var gotShell string
	var gotArgs, gotEnv []string
	env := map[string]string{"SHELL": "/bin/zsh", "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HTTPS_PROXY": "http://kept:3128"}
	changed := ImportShellEnvironment(ShellEnvOptions{
		Env: env, GOOS: "darwin", Home: "/Users/h",
		Exists: existsIn("/bin/zsh", "/opt/homebrew/bin", "/Users/h/google-cloud-sdk/bin"),
		Run: func(_ context.Context, shell string, args []string, e []string) ([]byte, error) {
			gotShell, gotArgs, gotEnv = shell, args, e
			return []byte("Last login: today\nbanner\n\n__RUBBAN_ENV__\nPATH=/opt/homebrew/bin:/Users/h/google-cloud-sdk/bin:/usr/bin:/bin\nKUBECONFIG=/Users/h/.kube/config:/Users/h/.kube/gke\nHTTPS_PROXY=http://ignored\nSECRET_TOKEN=nope\n"), nil
		},
	})
	if gotShell != "/bin/zsh" || len(gotArgs) != 2 || gotArgs[0] != "-ilc" {
		t.Fatalf("shell call %q %q", gotShell, gotArgs)
	}
	if !strings.Contains(gotArgs[1], "__RUBBAN_ENV__") || !strings.Contains(gotArgs[1], "USE_GKE_GCLOUD_AUTH_PLUGIN") {
		t.Fatalf("script %q", gotArgs[1])
	}
	joined := "\x00" + strings.Join(gotEnv, "\x00") + "\x00"
	for _, want := range []string{"DISABLE_AUTO_UPDATE=true", "ZSH_DISABLE_COMPFIX=true", "RUBBAN_SHELL_PROBE=1", "SHELL=/bin/zsh"} {
		if !strings.Contains(joined, "\x00"+want+"\x00") {
			t.Fatalf("probe env misses %s", want)
		}
	}
	want := map[string]string{
		"PATH":       "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/Users/h/google-cloud-sdk/bin",
		"KUBECONFIG": "/Users/h/.kube/config:/Users/h/.kube/gke",
	}
	if !reflect.DeepEqual(changed, want) {
		t.Fatalf("changed %v", changed)
	}
	if env["PATH"] != "/usr/bin:/bin:/usr/sbin:/sbin" {
		t.Fatal("the input map must not be modified")
	}
}

func TestShellEnvBrokenOrSlowShellStillAddsToolFolders(t *testing.T) {
	env := map[string]string{"SHELL": "/bin/zsh", "PATH": "/usr/bin:/bin"}
	changed := ImportShellEnvironment(ShellEnvOptions{
		Env: env, GOOS: "darwin", Home: "/Users/h", Exists: existsIn("/bin/zsh", "/usr/local/bin"),
		Run: func(context.Context, string, []string, []string) ([]byte, error) { return nil, errors.New("timeout") },
	})
	if changed["PATH"] != "/usr/bin:/bin:/usr/local/bin" || len(changed) != 1 {
		t.Fatalf("%v", changed)
	}
	// A timeout that still printed values keeps them.
	changed = ImportShellEnvironment(ShellEnvOptions{
		Env: env, GOOS: "darwin", Home: "/Users/h", Exists: existsIn("/bin/zsh"),
		Run: func(context.Context, string, []string, []string) ([]byte, error) {
			return []byte("\n__RUBBAN_ENV__\nAWS_PROFILE=prod\nLANG=en_US.UTF-8"), errors.New("signal: killed")
		},
	})
	if changed["AWS_PROFILE"] != "prod" || changed["LANG"] != "en_US.UTF-8" {
		t.Fatalf("partial output: %v", changed)
	}
}

func TestShellEnvSkipsWindowsAndOptOut(t *testing.T) {
	ran := false
	run := func(context.Context, string, []string, []string) ([]byte, error) { ran = true; return nil, nil }
	if c := ImportShellEnvironment(ShellEnvOptions{Env: map[string]string{"PATH": `C:\Windows`}, GOOS: "windows", Run: run}); len(c) != 0 {
		t.Fatalf("windows %v", c)
	}
	if c := ImportShellEnvironment(ShellEnvOptions{Env: map[string]string{"PATH": "/usr/bin", "SHELL": "/bin/sh", "RUBBAN_SKIP_SHELL_ENV": "1"}, GOOS: "linux", Run: run, Exists: existsIn("/bin/sh")}); len(c) != 0 {
		t.Fatalf("opt-out %v", c)
	}
	if ran {
		t.Fatal("the shell must not run")
	}
}

func TestShellEnvShellSelectionAndExistingValues(t *testing.T) {
	var shells []string
	run := func(_ context.Context, shell string, _ []string, _ []string) ([]byte, error) {
		shells = append(shells, shell)
		return []byte("\n__RUBBAN_ENV__\nLANG=C\nKUBECONFIG=/k\nNO_PROXY=\n"), nil
	}
	// $SHELL that does not exist falls back to bash on linux and zsh on darwin; relative $SHELL is ignored.
	ImportShellEnvironment(ShellEnvOptions{Env: map[string]string{"SHELL": "/missing/fish"}, GOOS: "linux", Run: run, Exists: existsIn("/bin/bash")})
	ImportShellEnvironment(ShellEnvOptions{Env: map[string]string{"SHELL": "zsh"}, GOOS: "darwin", Run: run, Exists: existsIn("/bin/zsh")})
	ImportShellEnvironment(ShellEnvOptions{Env: map[string]string{}, GOOS: "linux", Run: run, Exists: existsIn()})
	if !reflect.DeepEqual(shells, []string{"/bin/bash", "/bin/zsh"}) {
		t.Fatalf("shells %v", shells)
	}
	// Variables the app already has (even empty) win; empty imported values are ignored.
	c := ImportShellEnvironment(ShellEnvOptions{Env: map[string]string{"SHELL": "/bin/bash", "LANG": ""}, GOOS: "linux", Run: run, Exists: existsIn("/bin/bash")})
	if !reflect.DeepEqual(c, map[string]string{"KUBECONFIG": "/k"}) {
		t.Fatalf("%v", c)
	}
}

func TestShellEnvParseAndMerge(t *testing.T) {
	if got := parseShellEnv("no marker"); len(got) != 0 {
		t.Fatal(got)
	}
	// Only text after the last marker counts, and only allowlisted keys.
	got := parseShellEnv("__RUBBAN_ENV__\nLANG=old\nrc noise\n__RUBBAN_ENV__\nLANG=new\nA=b\nPATH=/x=y\n")
	if !reflect.DeepEqual(got, map[string]string{"LANG": "new", "PATH": "/x=y"}) {
		t.Fatalf("%v", got)
	}
	if got := mergePathLists("/a:/b", "/b:/c", ""); got != "/a:/b:/c" {
		t.Fatal(got)
	}
}

func TestShellEnvRealShell(t *testing.T) {
	if _, err := os.Stat("/bin/sh"); err != nil {
		t.Skip("needs /bin/sh")
	}
	t.Setenv("RUBBAN_TEST_PROBE_FOO", "x")
	env := map[string]string{"SHELL": "/bin/sh", "PATH": "/usr/bin:/bin", "HOME": t.TempDir(), "AWS_REGION": "eu-west-1"}
	start := time.Now()
	c := ImportShellEnvironment(ShellEnvOptions{Env: env, GOOS: "linux", Exists: func(p string) bool { return p == "/bin/sh" }, Timeout: 5 * time.Second})
	if p, ok := c["PATH"]; ok && !strings.HasPrefix(p, "/usr/bin:/bin:") {
		t.Fatalf("PATH %v", c)
	}
	if _, set := c["AWS_REGION"]; set {
		t.Fatal("existing variables must not be replaced")
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("too slow")
	}
}

func TestShellEnvTimeoutKillsShell(t *testing.T) {
	if _, err := os.Stat("/bin/sh"); err != nil {
		t.Skip("needs /bin/sh")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	out, err := runLoginShell(ctx, "/bin/sh", []string{"-c", "printf 'partial'; sleep 10"}, os.Environ())
	if err == nil || string(out) != "partial" || time.Since(start) > 4*time.Second {
		t.Fatalf("%q %v %v", out, err, time.Since(start))
	}
}
