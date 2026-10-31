package server

import (
	"context"
	"errors"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"github.com/coder/websocket"
)

func TestClassifyAuthFailure(t *testing.T) {
	cases := []struct {
		message, kind, plugin string
	}{
		{"Unable to connect to the server: getting credentials: exec: executable gke-gcloud-auth-plugin failed with exit code 1", "exec-plugin", "gke-gcloud-auth-plugin"},
		{"getting credentials: exec: executable C:\\tools\\kubelogin.exe failed with exit code 1", "exec-plugin", "kubelogin"},
		{"exec: executable aws failed with exit code 255", "exec-plugin", "aws"},
		{"exec: executable aws-iam-authenticator failed", "exec-plugin", "aws-iam-authenticator"},
		{"exec: executable some-plugin failed with exit code 2", "exec-plugin", ""},
		{"getting credentials: something else", "exec-plugin", ""},
		{"error: You must be logged in to the server (Unauthorized)", "unauthorized", ""},
		{"Unauthorized", "unauthorized", ""},
		{"the server has asked for the client to provide credentials", "unauthorized", ""},
		{"oauth2: cannot fetch token: invalid_grant", "exec-plugin", ""},
		{"google.auth.exceptions.RefreshError: Reauthentication is required. Please run `gcloud auth login`", "exec-plugin", "gke-gcloud-auth-plugin"},
		{"AADSTS70043: The refresh token has expired", "exec-plugin", "kubelogin"},
		{"Please run: az login", "exec-plugin", "kubelogin"},
		{"The SSO session associated with this profile has expired. aws sso login", "exec-plugin", "aws"},
		{"An error occurred (ExpiredToken) when calling the GetCallerIdentity operation", "exec-plugin", "aws"},
		{"oidc: token expired", "exec-plugin", "oidc-login"},
	}
	for _, c := range cases {
		got, ok := classifyAuthFailure(c.message)
		if !ok || got.Kind != c.kind || got.Plugin != c.plugin {
			t.Errorf("%q: got %+v ok=%v, want %s/%s", c.message, got, ok, c.kind, c.plugin)
		}
	}
	for _, message := range []string{"", "pods is forbidden: User cannot list resource", "Cluster connection lost: connection refused", "the server could not find the requested resource", "unauthorized: authentication required",
		`Error from server (NotFound): secrets "oidc-client" not found`, `pods "oidc-proxy-7d9" not found`, `error: unknown field "spec.az login"`, `container "getting credentials" is not valid`} {
		if got, ok := classifyAuthFailure(message); ok {
			t.Errorf("%q must not classify, got %+v", message, got)
		}
	}
}

func TestRemedyFromExecConfig(t *testing.T) {
	user := func(command string, args []any, env map[string]string) obj {
		var e []any
		for k, v := range env {
			e = append(e, obj{"name": k, "value": v})
		}
		return obj{"exec": obj{"command": command, "args": args, "env": e}}
	}
	cases := []struct {
		name string
		user obj
		want remedy
	}{
		{"gke", user("gke-gcloud-auth-plugin", nil, nil), remedy{Preset: "gcloud-login", Label: "gcloud auth login"}},
		{"gke on windows", user(`C:\Program Files\gke-gcloud-auth-plugin.exe`, nil, nil), remedy{Preset: "gcloud-login", Label: "gcloud auth login"}},
		{"kubelogin", user("kubelogin", []any{"get-token"}, nil), remedy{Preset: "az-login", Label: "az login"}},
		{"aws env profile", user("aws", []any{"eks", "get-token"}, map[string]string{"AWS_PROFILE": "prod-sso"}), remedy{Preset: "aws-sso-login", Label: "aws sso login --profile prod-sso", Profile: "prod-sso"}},
		{"aws args profile", user("aws", []any{"eks", "get-token", "--profile", "dev"}, nil), remedy{Preset: "aws-sso-login", Label: "aws sso login --profile dev", Profile: "dev"}},
		{"aws no profile", user("aws", []any{"eks"}, nil), remedy{Preset: "aws-sso-login", Label: "aws sso login"}},
		{"aws bad profile", user("aws", nil, map[string]string{"AWS_PROFILE": "x; rm -rf /"}), remedy{Preset: "aws-sso-login", Label: "aws sso login"}},
		{"other plugin", user("kubectl", []any{"oidc-login"}, nil), genericRemedy},
		{"no exec", obj{"token": "REDACTED"}, genericRemedy},
		{"no user", nil, genericRemedy},
	}
	for _, c := range cases {
		if got := remedyForUser(c.user); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: got %+v want %+v", c.name, got, c.want)
		}
	}
}

func configWithUser(user obj) Result {
	return out(map[string]any{
		"current-context": "prod",
		"contexts":        []any{map[string]any{"name": "prod", "context": map[string]any{"cluster": "c", "user": "u"}}},
		"users":           []any{map[string]any{"name": "u", "user": user}},
	}, 0)
}

func authOfContext(t *testing.T, f *fixture) map[string]any {
	t.Helper()
	res := f.get("/api/contexts")
	if res.Status != 200 {
		t.Fatalf("contexts: %d %v", res.Status, res.Value)
	}
	return res.Value["contexts"].([]any)[0].(map[string]any)["auth"].(map[string]any)
}

func TestContextsReportExpiredCredentialsAndRecheckClearsThem(t *testing.T) {
	f := newFixture(t, func(args []string, _ RunOptions) Result {
		if len(args) > 0 && args[0] == "config" {
			return configWithUser(map[string]any{"exec": map[string]any{"command": "gke-gcloud-auth-plugin", "apiVersion": "client.authentication.k8s.io/v1beta1"}})
		}
		return Result{Stderr: "Unable to connect to the server: getting credentials: exec: executable gke-gcloud-auth-plugin failed with exit code 1", Code: 1}
	})
	if got := authOfContext(t, f); got["status"] != "unknown" {
		t.Fatalf("before any request: %v", got)
	}
	res := f.get("/api/namespaces?context=prod")
	if res.Status != 502 || res.Value["code"] != "credentials" || res.Value["plugin"] != "gke-gcloud-auth-plugin" {
		t.Fatalf("namespaces: %d %v", res.Status, res.Value)
	}
	got := authOfContext(t, f)
	remedy := got["remedy"].(map[string]any)
	if got["status"] != "expired" || got["plugin"] != "gke-gcloud-auth-plugin" || !strings.Contains(got["message"].(string), "gke-gcloud-auth-plugin") ||
		remedy["preset"] != "gcloud-login" || remedy["label"] != "gcloud auth login" {
		t.Fatalf("after failure: %v", got)
	}
	if res := f.post("/api/contexts/recheck", map[string]any{"context": "prod"}); res.Status != 200 || res.Value["ok"] != true {
		t.Fatalf("recheck: %d %v", res.Status, res.Value)
	}
	if got := authOfContext(t, f); got["status"] != "unknown" || got["message"] != "" {
		t.Fatalf("after recheck: %v", got)
	}
	if res := f.post("/api/contexts/recheck", map[string]any{}); res.Status != 400 {
		t.Fatalf("recheck without context: %d", res.Status)
	}
}

func TestOrdinaryFailuresDoNotMarkCredentials(t *testing.T) {
	f := newFixture(t, func(args []string, _ RunOptions) Result {
		if len(args) > 0 && args[0] == "config" {
			return configWithUser(map[string]any{"token": "REDACTED"})
		}
		return Result{Stderr: `namespaces is forbidden: User "x" cannot list resource "namespaces"`, Code: 1}
	})
	res := f.get("/api/namespaces?context=prod")
	if res.Status != 502 || res.Value["code"] != nil {
		t.Fatalf("%d %v", res.Status, res.Value)
	}
	got := authOfContext(t, f)
	if got["status"] != "unknown" || got["remedy"].(map[string]any)["preset"] != "" {
		t.Fatalf("%v", got)
	}
}

func TestTagCredentialsKeepsExistingCodeAndIgnoresOtherErrors(t *testing.T) {
	b := New(Options{DataDir: t.TempDir(), Runner: func(_ context.Context, _ string, _ []string, _ RunOptions) (Result, error) { return Result{}, nil }})
	t.Cleanup(func() { b.Close() })
	plain := errors.New("boom")
	if b.tagCredentials(plain, "prod") != plain || b.authOf("prod").Status != "" {
		t.Fatal("non-problem errors are untouched")
	}
	p := problem("Unauthorized", 401)
	b.tagCredentials(p, "prod")
	if p.Code != "credentials" || b.authOf("prod").Status != "expired" {
		t.Fatalf("%+v %+v", p, b.authOf("prod"))
	}
	since := b.authOf("prod").Since
	b.tagCredentials(problem("Unauthorized", 401), "prod")
	if !b.authOf("prod").Since.Equal(since) {
		t.Fatal("Since must be kept while the credentials stay expired")
	}
	b.clearAuth("prod")
	if b.authOf("prod").Status != "ok" {
		t.Fatal("clearAuth")
	}
}

func TestTerminalSignInPresets(t *testing.T) {
	t.Setenv("RUBBAN_DISABLE_PTY", "")
	old := lookPath
	lookPath = func(name string) (string, error) { return "/opt/bin/" + name, nil }
	t.Cleanup(func() { lookPath = old })
	tb := newTermBackend(t)
	tb.handler = func(args []string) Result {
		if len(args) > 1 && args[0] == "config" && args[1] == "view" && len(args) == 3 {
			return out(map[string]any{
				"contexts": []any{map[string]any{"name": "prod", "context": map[string]any{"cluster": "c", "user": "u"}}, map[string]any{"name": "other", "context": map[string]any{"cluster": "c", "user": "v"}}},
				"users": []any{
					map[string]any{"name": "u", "user": map[string]any{"exec": map[string]any{"command": "aws", "args": []any{"eks", "get-token"}, "env": []any{map[string]any{"name": "AWS_PROFILE", "value": "prod-sso"}}}}},
					map[string]any{"name": "v", "user": map[string]any{"token": "x"}},
				},
			}, 0)
		}
		return out(map[string]any{"apiVersion": "v1", "kind": "Config", "contexts": []any{map[string]any{"name": "prod", "context": map[string]any{"cluster": "c", "user": "u"}}}}, 0)
	}
	started := func(q url.Values) terminalSpec {
		tc := dialTerm(t, tb.conn, q)
		tc.awaitType("status")
		return tb.spawner.spec(t, len(tb.spawner.specs)-1)
	}
	spec := started(url.Values{"context": {"prod"}, "run": {"gcloud-login"}})
	if spec.Command != "/opt/bin/gcloud" || !reflect.DeepEqual(spec.Args, args("auth", "login")) || !containsArg(spec.Env, "RUBBAN_CONTEXT=prod") {
		t.Fatalf("%+v", spec)
	}
	spec = started(url.Values{"context": {"prod"}, "run": {"az-login"}})
	if spec.Command != "/opt/bin/az" || !reflect.DeepEqual(spec.Args, args("login")) {
		t.Fatalf("%+v", spec)
	}
	// The profile comes from the server-side remedy, whatever the client sends.
	spec = started(url.Values{"context": {"prod"}, "run": {"aws-sso-login"}, "profile": {"evil"}})
	if spec.Command != "/opt/bin/aws" || !reflect.DeepEqual(spec.Args, args("sso", "login", "--profile", "prod-sso")) {
		t.Fatalf("%+v", spec)
	}
	rejected := func(q url.Values, want string) {
		t.Helper()
		before := len(tb.spawner.specs)
		tc := dialTerm(t, tb.conn, q)
		msg := tc.awaitType("error")
		if !strings.Contains(msg["error"].(string), want) {
			t.Fatalf("%v, want %q", msg, want)
		}
		if code := tc.awaitClose(); code != websocket.StatusPolicyViolation {
			t.Fatalf("close %d", code)
		}
		if len(tb.spawner.specs) != before {
			t.Fatal("nothing may start")
		}
	}
	rejected(url.Values{"context": {"prod"}, "run": {"rm -rf /"}}, "Unknown sign-in command")
	rejected(url.Values{"context": {"prod"}, "run": {"gcloud-login ; id"}}, "Unknown sign-in command")
	rejected(url.Values{"run": {"gcloud-login"}}, "needs a cluster context")
	rejected(url.Values{"context": {"other"}, "run": {"aws-sso-login"}}, "does not sign in with AWS")
	rejected(url.Values{"context": {"prod"}, "pod": {"p"}, "run": {"gcloud-login"}}, "cannot run inside")
	lookPath = func(string) (string, error) { return "", errors.New("not found") }
	rejected(url.Values{"context": {"prod"}, "run": {"gcloud-login"}}, "was not found on your PATH")
}
