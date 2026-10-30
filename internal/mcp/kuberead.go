package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// resourceList is the allow-list of Kubernetes resources the bridge may read (no secrets), in the
// order the tool schemas present them.
var resourceList = strings.Fields(`pods nodes namespaces deployments daemonsets statefulsets replicasets jobs cronjobs services endpoints endpointslices ingresses networkpolicies configmaps persistentvolumeclaims persistentvolumes storageclasses events serviceaccounts roles rolebindings clusterroles clusterrolebindings horizontalpodautoscalers customresourcedefinitions leases resourcequotas limitranges poddisruptionbudgets`)

var resources = func() map[string]bool {
	m := make(map[string]bool, len(resourceList))
	for _, r := range resourceList {
		m[r] = true
	}
	return m
}()

var special = map[string]bool{"api-resources": true, "metrics:nodes": true, "metrics:pods": true, "logs": true}

var kubeName = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$`)

// Query is a validated structured read.
type Query struct {
	Resource  string
	Namespace string
	Name      string
}

// ValidateQuery accepts only {resource, namespace?, name?}; a namespace of "*" or "" means all/none.
func ValidateQuery(value map[string]any) (Query, error) {
	if value == nil {
		return Query{}, errors.New("A query object is required")
	}
	for k := range value {
		if k != "resource" && k != "namespace" && k != "name" {
			return Query{}, errors.New("Unsupported query field")
		}
	}
	resource, ok := value["resource"].(string)
	if !ok || !(resources[resource] || special[resource]) {
		return Query{}, errors.New("Resource is not permitted")
	}
	q := Query{Resource: resource}
	for _, key := range []string{"namespace", "name"} {
		v, present := value[key]
		if !present {
			continue
		}
		if s, isString := v.(string); isString && (s == "" || (key == "namespace" && s == "*")) {
			continue
		}
		s, isString := v.(string)
		if !isString || !kubeName.MatchString(s) {
			return Query{}, fmt.Errorf("Invalid %s", key)
		}
		if key == "namespace" {
			q.Namespace = s
		} else {
			q.Name = s
		}
	}
	switch {
	case q.Resource == "logs" && (q.Name == "" || q.Namespace == ""):
		return Query{}, errors.New("Log snapshots require pod name and namespace")
	case q.Resource == "api-resources" && (q.Name != "" || q.Namespace != ""):
		return Query{}, errors.New("Discovery takes no name or namespace")
	case strings.HasPrefix(q.Resource, "metrics:") && q.Name != "":
		return Query{}, errors.New("Metrics takes no resource name")
	case q.Resource == "metrics:nodes" && q.Namespace != "":
		return Query{}, errors.New("Node metrics takes no namespace")
	}
	return q, nil
}

// Plan is the kubectl invocation for a Query.
type Plan struct {
	Query Query
	Args  []string
	JSON  bool
}

// KubectlPlan turns a query into kubectl arguments. context nil means "the current context".
func KubectlPlan(value map[string]any, context *string) (Plan, error) {
	q, err := ValidateQuery(value)
	if err != nil {
		return Plan{}, err
	}
	var args []string
	if context != nil {
		c := *context
		if c == "" || strings.HasPrefix(c, "-") || len(c) > 512 || strings.ContainsAny(c, "\r\n\x00") {
			return Plan{}, errors.New("Invalid configured Kubernetes context")
		}
		args = append(args, "--context", c)
	}
	args = append(args, "--request-timeout=15s")
	switch {
	case q.Resource == "api-resources":
		args = append(args, "api-resources", "-o", "wide")
	case q.Resource == "logs":
		args = append(args, "logs", q.Name, "--namespace", q.Namespace, "--tail=200", "--limit-bytes=65536", "--timestamps=true")
	case strings.HasPrefix(q.Resource, "metrics:"):
		kind := "pods"
		if q.Resource == "metrics:nodes" {
			kind = "nodes"
		}
		args = append(args, "top", kind, "--no-headers")
		if q.Resource == "metrics:pods" {
			if q.Namespace != "" {
				args = append(args, "--namespace", q.Namespace)
			} else {
				args = append(args, "--all-namespaces")
			}
		}
	default:
		args = append(args, "get", q.Resource)
		if q.Name != "" {
			args = append(args, q.Name)
		}
		if q.Namespace != "" {
			args = append(args, "--namespace", q.Namespace)
		} else if q.Name == "" {
			args = append(args, "--all-namespaces")
		}
		args = append(args, "-o", "json")
	}
	return Plan{Query: q, Args: args, JSON: resources[q.Resource]}, nil
}

// ExecFunc runs one kubectl invocation to completion. It returns stdout and the exit code; a non-nil
// error means the process could not be started or was stopped (timeout, output cap).
type ExecFunc func(ctx context.Context, executable string, args []string) (stdout []byte, exitCode int, err error)

// ReadOptions tunes RunReadQuery; the zero value runs the real kubectl.
type ReadOptions struct {
	Context *string
	Kubectl string // default $RUBBAN_KUBECTL, else "kubectl"
	Exec    ExecFunc
	Timeout time.Duration // default 20 s
}

const maxOutput = 4 * 1024 * 1024

// RunReadQuery runs a structured read through kubectl and decodes the result (a plain
// {text} object for non-JSON queries). The bridge itself reads through the Rubban API instead;
// this is kept for the structured-read runner the Node tree ships alongside it.
func RunReadQuery(ctx context.Context, value map[string]any, opts ReadOptions) (any, error) {
	plan, err := KubectlPlan(value, opts.Context)
	if err != nil {
		return nil, err
	}
	executable := opts.Kubectl
	if executable == "" {
		executable = os.Getenv("RUBBAN_KUBECTL")
	}
	if executable == "" {
		executable = "kubectl"
	}
	run := opts.Exec
	if run == nil {
		run = execKubectl
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = 20 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	stdout, code, err := run(ctx, executable, plan.Args)
	if err != nil {
		return nil, err
	}
	if code != 0 {
		label := fmt.Sprint(code)
		if code < 0 {
			label = "signal"
		}
		return nil, fmt.Errorf("kubectl failed (%s); check cluster permissions, context and API availability", label)
	}
	if !plan.JSON {
		return map[string]any{"text": string(stdout)}, nil
	}
	var data any
	if json.Unmarshal(stdout, &data) != nil {
		return nil, errors.New("kubectl returned invalid JSON")
	}
	return data, nil
}

// capWriter collects up to max bytes and cancels the process when the cap is exceeded.
type capWriter struct {
	buf    bytes.Buffer
	max    int
	over   bool
	cancel context.CancelFunc
}

func (w *capWriter) Write(p []byte) (int, error) {
	if w.over {
		return len(p), nil
	}
	if w.buf.Len()+len(p) > w.max {
		w.over = true
		w.cancel()
		return len(p), nil
	}
	return w.buf.Write(p)
}

func execKubectl(ctx context.Context, executable string, args []string) ([]byte, int, error) {
	inner, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := exec.CommandContext(inner, executable, args...) // never a shell
	hideWindow(cmd)
	cmd.WaitDelay = time.Second
	out := &capWriter{max: maxOutput, cancel: cancel}
	cmd.Stdout = out
	if err := cmd.Start(); err != nil {
		return nil, 0, errors.New("Could not start kubectl; verify installation and agent context")
	}
	err := cmd.Wait()
	switch {
	case out.over:
		return nil, 0, errors.New("Kubernetes response exceeded 4 MiB")
	case ctx.Err() != nil:
		return nil, 0, errors.New("Kubernetes query timed out")
	case err != nil:
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return nil, exit.ExitCode(), nil
		}
		return nil, 0, errors.New("Could not start kubectl; verify installation and agent context")
	}
	return out.buf.Bytes(), 0, nil
}
