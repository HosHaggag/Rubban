package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"runtime"
	"strings"
	"time"
)

// Direct Prometheus queries (/api/prometheus) and the local AI assistant (/api/ai). Errors here are
// plain errors, so they answer 500 and are logged, as the Node extras did.

func init() {
	registerRoutes(func(b *Backend, q *request) (any, int, bool, error) {
		switch {
		case q.method == "POST" && q.route == "/api/prometheus":
			v, err := b.routePrometheusDirect(q)
			return v, 200, true, err
		case q.method == "POST" && q.route == "/api/ai":
			v, err := b.routeAI(q)
			return v, 200, true, err
		}
		return nil, 0, false, nil
	})
}

const serviceResponseLimit = 12 * 1024 * 1024

var shortTextRE = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.:@/+ -]{0,253}$`)

func shortText(v any, label string) (string, error) {
	s, ok := v.(string)
	if !ok || !shortTextRE.MatchString(s) {
		return "", errf("Invalid %s", label)
	}
	return s, nil
}

// validateServiceURL accepts an http(s) URL without embedded credentials or a fragment.
func validateServiceURL(input string) (*url.URL, error) {
	u, err := url.Parse(input)
	if err != nil || u.Scheme == "" {
		return nil, errors.New("Invalid URL")
	}
	password, _ := u.User.Password()
	if (u.Scheme != "http" && u.Scheme != "https") || (u.User != nil && (u.User.Username() != "" || password != "")) || u.Fragment != "" {
		return nil, errors.New("Use an HTTP(S) service URL without embedded credentials.")
	}
	if u.Host == "" {
		return nil, errors.New("Invalid URL")
	}
	return u, nil
}

// serviceClient never follows redirects.
var serviceClient = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("unexpected redirect") }}

// jsonFetch reads a JSON document from a user-configured service: 15 s, 12 MiB, no redirects.
func jsonFetch(ctx context.Context, target string) (json.RawMessage, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	res, err := serviceClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, serviceResponseLimit+1))
	if err != nil {
		return nil, err
	}
	if len(data) > serviceResponseLimit {
		return nil, errors.New("Service response exceeds 12 MiB.")
	}
	var doc any
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("Service returned non-JSON response (HTTP %d).", res.StatusCode)
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		fields, _ := doc.(map[string]any)
		for _, key := range []string{"error", "message"} {
			if truthy(fields[key]) {
				return nil, errors.New(jsString(fields[key]))
			}
		}
		return nil, fmt.Errorf("Service returned HTTP %d", res.StatusCode)
	}
	return json.RawMessage(data), nil
}

func (b *Backend) routePrometheusDirect(q *request) (any, error) {
	prefs, err := b.readPreferences()
	if err != nil {
		return nil, err
	}
	endpoint, _ := prefs["prometheusUrl"].(string)
	if endpoint == "" {
		return nil, errors.New("Configure your Prometheus endpoint in Settings first.")
	}
	u, err := validateServiceURL(endpoint)
	if err != nil {
		return nil, err
	}
	query := ""
	if truthy(q.body["query"]) {
		query = jsString(q.body["query"])
	}
	if query == "" || jsLength(query) > 16000 {
		return nil, errors.New("A PromQL query of at most 16,000 characters is required.")
	}
	path := strings.TrimSuffix(u.Path, "/") + "/api/v1/query"
	if truthy(q.body["start"]) {
		path = strings.TrimSuffix(u.Path, "/") + "/api/v1/query_range"
	}
	params := u.Query()
	params.Set("query", query)
	if truthy(q.body["start"]) {
		step := "60"
		if truthy(q.body["step"]) {
			step = jsString(q.body["step"])
		}
		params.Set("start", jsString(q.body["start"]))
		params.Set("end", jsStringOrUndefined(q.body, "end"))
		params.Set("step", step)
	}
	u.Path, u.RawPath, u.RawQuery = path, "", params.Encode()
	return jsonFetch(q.ctx, u.String())
}

func jsStringOrUndefined(body map[string]any, key string) string {
	if v, ok := body[key]; ok {
		return jsString(v)
	}
	return "undefined"
}

var aiArgs = map[string][]string{
	"codex":    {"exec", "--skip-git-repo-check", "--sandbox", "read-only", "-"},
	"claude":   {"-p"},
	"gemini":   {},
	"opencode": {"run"},
}

// windowsWrapperUnsafeRE matches characters cmd.exe would interpret inside a .cmd or .bat wrapper call.
var windowsWrapperUnsafeRE = regexp.MustCompile(`[\r\n%!&|<>^"]`)

func (b *Backend) routeAI(q *request) (any, error) {
	prefs, err := b.readPreferences()
	if err != nil {
		return nil, err
	}
	var command any = q.body["command"]
	if !truthy(command) {
		command = prefs["aiCommand"]
	}
	if !truthy(command) {
		command = "codex"
	}
	name, _ := command.(string)
	args, supported := aiArgs[name]
	if !supported {
		return nil, errors.New("Select a supported installed AI CLI.")
	}
	prompt := ""
	if truthy(q.body["prompt"]) {
		prompt = jsTrim(jsString(q.body["prompt"]))
	}
	if prompt == "" || jsLength(prompt) > 32000 {
		return nil, errors.New("Enter a prompt of at most 32,000 characters.")
	}
	contextLine := ""
	if truthy(q.body["context"]) {
		text, err := shortText(q.body["context"], "context")
		if err != nil {
			return nil, err
		}
		contextLine = "Selected Kubernetes context: " + text + ".\n"
	}
	input := "You are helping with Kubernetes. This request comes from Rubban. Do not change any resource or execute mutations without asking the user. Do not read or print credentials or secret values.\n" + contextLine + "\n" + prompt + "\n"
	res, err := b.runExternal(q.ctx, name, args, RunOptions{Input: input, Timeout: 180 * time.Second, MaxBytes: 2 * 1024 * 1024})
	if err != nil {
		return nil, err
	}
	output := res.Stdout
	if output == "" {
		output = res.Stderr
	}
	return obj{"output": output}, nil
}

// runExternal runs a CLI found on PATH. On Windows a .cmd or .bat wrapper is refused when any argument
// could be reinterpreted by cmd.exe.
func (b *Backend) runExternal(ctx context.Context, name string, args []string, opts RunOptions) (Result, error) {
	command := findExecutable(name, "")
	if command == "" {
		return Result{}, fmt.Errorf("%s CLI is not installed or is not on PATH. Install it and authenticate with your own account.", name)
	}
	if runtime.GOOS == "windows" {
		if ext := strings.ToLower(command[max(0, len(command)-4):]); ext == ".cmd" || ext == ".bat" {
			for _, arg := range append([]string{command}, args...) {
				if windowsWrapperUnsafeRE.MatchString(arg) {
					return Result{}, errors.New("This value cannot be passed to a Windows command wrapper.")
				}
			}
		}
	}
	return b.run(ctx, command, args, opts)
}
