package server

import (
	"context"
	"errors"
	"os/exec"
	"path"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Credential health: when a context's credentials are expired or its exec plugin fails, the API says
// so (Problem.Code "credentials", the auth block of /api/contexts) and names the one command that
// fixes it. The sign-in command runs in Rubban's terminal dock from a fixed allowlist of presets.

// authFailure is the classification of an error message that points at credentials.
type authFailure struct {
	Kind    string `json:"kind"`   // exec-plugin or unauthorized
	Plugin  string `json:"plugin"` // gke-gcloud-auth-plugin, kubelogin, aws, aws-iam-authenticator, oidc-login or ""
	Message string `json:"message"`
}

var execFailedRE = regexp.MustCompile(`exec: executable (\S+) failed`)

// authRules are tried in order; the first match wins, so the specific patterns come before the
// generic ones.
var authRules = []struct {
	re     *regexp.Regexp
	kind   string
	plugin string
}{
	{regexp.MustCompile(`(?i)Reauthentication (is )?required|RefreshError`), "exec-plugin", "gke-gcloud-auth-plugin"},
	{regexp.MustCompile(`(?i)AADSTS\d{3,}|please run:? ?az login`), "exec-plugin", "kubelogin"},
	{regexp.MustCompile(`ExpiredToken|SSO session|aws sso login`), "exec-plugin", "aws"},
	{regexp.MustCompile(`invalid_grant`), "exec-plugin", ""},
	{regexp.MustCompile(`(?i)\boidc(-login)?: `), "exec-plugin", "oidc-login"},
	{execFailedRE, "exec-plugin", ""},
	{regexp.MustCompile(`getting credentials: `), "exec-plugin", ""},
	{regexp.MustCompile(`the server has asked for the client to provide credentials`), "unauthorized", ""},
	{regexp.MustCompile(`(?m)^\s*Unauthorized\s*$|\(Unauthorized\)|You must be logged in to the server`), "unauthorized", ""},
}

// knownPlugins maps an exec command (without directory or .exe) to the plugin name the API reports.
var knownPlugins = map[string]string{
	"gke-gcloud-auth-plugin": "gke-gcloud-auth-plugin",
	"kubelogin":              "kubelogin",
	"aws":                    "aws",
	"aws-iam-authenticator":  "aws-iam-authenticator",
	"kubectl-oidc_login":     "oidc-login",
	"kubectl-oidc-login":     "oidc-login",
}

// commandBase is the lower-case file name of an executable without its extension.
func commandBase(command string) string {
	command = strings.ReplaceAll(command, `\`, "/")
	base := strings.ToLower(path.Base(command))
	for _, ext := range []string{".exe", ".cmd", ".bat"} {
		base = strings.TrimSuffix(base, ext)
	}
	return base
}

func classifyAuthFailure(message string) (authFailure, bool) {
	for _, rule := range authRules {
		if !rule.re.MatchString(message) {
			continue
		}
		failure := authFailure{Kind: rule.kind, Plugin: rule.plugin, Message: firstLine(strings.TrimSpace(message))}
		if m := execFailedRE.FindStringSubmatch(message); m != nil {
			if plugin, ok := knownPlugins[commandBase(m[1])]; ok {
				failure.Plugin = plugin
			}
		}
		return failure, true
	}
	return authFailure{}, false
}

// authStatus is what the backend currently believes about one context's credentials.
type authStatus struct {
	Status  string // ok, expired
	Message string
	Plugin  string
	Since   time.Time
}

type authBook struct {
	mu    sync.Mutex
	state map[string]authStatus
}

// noteAuthFailure records expired credentials for a context.
func (b *Backend) noteAuthFailure(kubeContext string, failure authFailure) {
	if kubeContext == "" {
		return
	}
	b.auth.mu.Lock()
	defer b.auth.mu.Unlock()
	if b.auth.state == nil {
		b.auth.state = map[string]authStatus{}
	}
	since := time.Now()
	if old, ok := b.auth.state[kubeContext]; ok && old.Status == "expired" {
		since = old.Since
	}
	b.auth.state[kubeContext] = authStatus{Status: "expired", Message: failure.Message, Plugin: failure.Plugin, Since: since}
}

// clearAuth marks a context's credentials as working again.
func (b *Backend) clearAuth(kubeContext string) {
	if kubeContext == "" {
		return
	}
	b.auth.mu.Lock()
	defer b.auth.mu.Unlock()
	if b.auth.state == nil {
		b.auth.state = map[string]authStatus{}
	}
	if old, ok := b.auth.state[kubeContext]; ok && old.Status == "ok" {
		return
	}
	b.auth.state[kubeContext] = authStatus{Status: "ok", Since: time.Now()}
}

func (b *Backend) authOf(kubeContext string) authStatus {
	b.auth.mu.Lock()
	defer b.auth.mu.Unlock()
	return b.auth.state[kubeContext]
}

// forgetAuth drops everything known about a context (an explicit recheck starts from "unknown").
func (b *Backend) forgetAuth(kubeContext string) {
	b.auth.mu.Lock()
	defer b.auth.mu.Unlock()
	delete(b.auth.state, kubeContext)
}

// tagCredentials marks a failed request's Problem with the credentials code when its message
// classifies, and remembers the request's context (when it names one) as expired.
func (b *Backend) tagCredentials(err error, kubeContext string) error {
	var p *Problem
	if !errors.As(err, &p) {
		return err
	}
	if p.Code == "" {
		failure, matched := classifyAuthFailure(p.Msg)
		if !matched {
			return err
		}
		p.Code, p.Plugin = "credentials", failure.Plugin
	}
	if p.Code == "credentials" {
		b.noteAuthFailure(kubeContext, authFailure{Kind: "exec-plugin", Plugin: p.Plugin, Message: firstLine(p.Msg)})
	}
	return err
}

// contextOfArgs finds the --context= flag of a kubectl or helm command line.
func contextOfArgs(args []string) string {
	for _, a := range args {
		if v, ok := strings.CutPrefix(a, "--context="); ok {
			return v
		}
		if v, ok := strings.CutPrefix(a, "--kube-context="); ok {
			return v
		}
	}
	return ""
}

// --- remedies -------------------------------------------------------------------------------

var profileRE = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`)

// remedy is the sign-in command offered for a context.
type remedy struct {
	Preset  string
	Label   string
	Profile string
}

func (r remedy) view() obj {
	out := obj{"preset": r.Preset, "label": r.Label}
	if r.Profile != "" {
		out["profile"] = r.Profile
	}
	return out
}

var genericRemedy = remedy{Label: "Sign in with your identity provider, then retry"}

// remedyForUser reads the exec plugin of a kubeconfig user (users[].user). Only the command, its
// arguments and its environment names/values are looked at; tokens are never part of an exec config.
func remedyForUser(user obj) remedy {
	exe := objOf(user["exec"])
	if exe == nil {
		return genericRemedy
	}
	command := commandBase(strOf(exe["command"]))
	switch command {
	case "gke-gcloud-auth-plugin", "gcloud":
		return remedy{Preset: "gcloud-login", Label: "gcloud auth login"}
	case "kubelogin", "az":
		return remedy{Preset: "az-login", Label: "az login"}
	case "aws", "aws-iam-authenticator":
		profile := ""
		for _, item := range listOf(exe["env"]) {
			e := objOf(item)
			if strOf(e["name"]) == "AWS_PROFILE" {
				profile = strOf(e["value"])
			}
		}
		if profile == "" {
			args := listOf(exe["args"])
			for i, a := range args {
				if strOf(a) == "--profile" && i+1 < len(args) {
					profile = strOf(args[i+1])
				}
			}
		}
		if profile != "" && !profileRE.MatchString(profile) {
			profile = ""
		}
		label := "aws sso login"
		if profile != "" {
			label += " --profile " + profile
		}
		return remedy{Preset: "aws-sso-login", Label: label, Profile: profile}
	}
	return genericRemedy
}

// remediesOf maps every context of a `kubectl config view` document to its remedy.
func remediesOf(doc obj) map[string]remedy {
	users := map[string]obj{}
	for _, it := range listOf(doc["users"]) {
		item := objOf(it)
		users[strOf(item["name"])] = objOf(item["user"])
	}
	out := map[string]remedy{}
	for _, it := range listOf(doc["contexts"]) {
		item := objOf(it)
		out[strOf(item["name"])] = remedyForUser(users[strOf(objOf(item["context"])["user"])])
	}
	return out
}

// remedyOfContext asks kubectl for the context's remedy.
func (b *Backend) remedyOfContext(ctx context.Context, kubeContext string) (remedy, error) {
	res, err := b.kube(ctx, []string{"config", "view", "--output=json"}, RunOptions{})
	if err != nil {
		return remedy{}, err
	}
	doc, err := parseObject(res, "kubectl")
	if err != nil {
		return remedy{}, err
	}
	r, ok := remediesOf(doc)[kubeContext]
	if !ok {
		return remedy{}, bad("Unknown context")
	}
	return r, nil
}

// authView is the auth block of /api/contexts.
func (b *Backend) authView(kubeContext string, r remedy) obj {
	st := b.authOf(kubeContext)
	status := st.Status
	if status == "" {
		status = "unknown"
	}
	return obj{"status": status, "message": st.Message, "plugin": st.Plugin, "remedy": r.view()}
}

// --- terminal presets -----------------------------------------------------------------------

// signInPlan resolves a terminal run= preset to the command line it stands for. Only these presets
// exist; the AWS profile comes from the context's own kubeconfig, never from the client.
func (b *Backend) signInPlan(ctx context.Context, preset, kubeContext string) (string, []string, error) {
	switch preset {
	case "gcloud-login":
		return lookSignInTool("gcloud", "auth", "login")
	case "az-login":
		return lookSignInTool("az", "login")
	case "aws-sso-login":
		r, err := b.remedyOfContext(ctx, kubeContext)
		if err != nil {
			return "", nil, err
		}
		if r.Preset != "aws-sso-login" {
			return "", nil, bad("This cluster does not sign in with AWS")
		}
		args := []string{"sso", "login"}
		if r.Profile != "" {
			args = append(args, "--profile", r.Profile)
		}
		return lookSignInTool("aws", args...)
	}
	return "", nil, bad("Unknown sign-in command")
}

// lookPath is replaced in tests.
var lookPath = exec.LookPath

func lookSignInTool(name string, args ...string) (string, []string, error) {
	p, err := lookPath(name)
	if err != nil {
		return "", nil, problem(name+" was not found on your PATH; install it or sign in from your own terminal.", 400)
	}
	return p, args, nil
}

// --- routes ---------------------------------------------------------------------------------

func init() {
	registerRoutes(func(b *Backend, q *request) (any, int, bool, error) {
		if q.method != "POST" || q.route != "/api/contexts/recheck" {
			return nil, 0, false, nil
		}
		kubeContext, err := validateText(q.body["context"], "context")
		if err != nil {
			return nil, 0, true, err
		}
		b.forgetAuth(kubeContext)
		if b.live != nil {
			b.live.Invalidate(kubeContext)
		}
		return obj{"ok": true}, 200, true, nil
	})
}
