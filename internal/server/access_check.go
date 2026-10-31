package server

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/HosHaggag/rubban/internal/live"
)

// "Can I?" per cluster: README §6 as a live check. Every feature Rubban offers needs a few Kubernetes
// permissions; this asks the API server (SelfSubjectAccessReview, or `kubectl auth can-i` when the live
// layer is off) which of them the current identity has, so an empty Helm page or a 403 becomes
// "you lack get secrets in monitoring".

// accessCheck is one permission a feature needs.
type accessCheck struct {
	ID          string
	Feature     string
	Verb        string
	Resource    string
	Subresource string
	Group       string
	Scope       string // namespace or cluster
	Namespace   string // overrides the requested namespace for namespace-scoped checks
	Prometheus  bool   // the namespace is the configured Prometheus namespace
	Argo        bool   // only checked when the cluster has Argo CD
}

var accessChecks = []accessCheck{
	{ID: "browse-list-pods", Feature: "Browse views", Verb: "list", Resource: "pods", Scope: "namespace"},
	{ID: "browse-watch-pods", Feature: "Browse views", Verb: "watch", Resource: "pods", Scope: "namespace"},
	{ID: "browse-list-deployments", Feature: "Browse views", Verb: "list", Resource: "deployments", Group: "apps", Scope: "namespace"},
	{ID: "browse-watch-deployments", Feature: "Browse views", Verb: "watch", Resource: "deployments", Group: "apps", Scope: "namespace"},
	{ID: "browse-list-services", Feature: "Browse views", Verb: "list", Resource: "services", Scope: "namespace"},
	{ID: "browse-watch-services", Feature: "Browse views", Verb: "watch", Resource: "services", Scope: "namespace"},
	{ID: "browse-list-events", Feature: "Browse views", Verb: "list", Resource: "events", Scope: "namespace"},
	{ID: "browse-watch-events", Feature: "Browse views", Verb: "watch", Resource: "events", Scope: "namespace"},
	{ID: "browse-list-nodes", Feature: "Browse views", Verb: "list", Resource: "nodes", Scope: "cluster"},
	{ID: "browse-watch-nodes", Feature: "Browse views", Verb: "watch", Resource: "nodes", Scope: "cluster"},
	{ID: "details", Feature: "Resource details", Verb: "get", Resource: "pods", Scope: "namespace"},
	{ID: "logs", Feature: "Logs", Verb: "get", Resource: "pods", Subresource: "log", Scope: "namespace"},
	{ID: "exec", Feature: "Terminal (exec)", Verb: "create", Resource: "pods", Subresource: "exec", Scope: "namespace"},
	{ID: "attach", Feature: "Terminal (attach)", Verb: "create", Resource: "pods", Subresource: "attach", Scope: "namespace"},
	{ID: "port-forward", Feature: "Port forwarding and RabbitMQ console", Verb: "create", Resource: "pods", Subresource: "portforward", Scope: "namespace"},
	{ID: "secrets", Feature: "Reveal a Secret", Verb: "get", Resource: "secrets", Scope: "namespace"},
	{ID: "metrics-pods", Feature: "Live CPU and memory", Verb: "list", Resource: "pods", Group: "metrics.k8s.io", Scope: "namespace"},
	{ID: "metrics-nodes", Feature: "Live CPU and memory", Verb: "list", Resource: "nodes", Group: "metrics.k8s.io", Scope: "cluster"},
	{ID: "kubelet-summary", Feature: "Usage for nodes metrics-server misses", Verb: "get", Resource: "nodes", Subresource: "proxy", Scope: "cluster"},
	{ID: "prometheus", Feature: "Usage history and Metrics tabs", Verb: "get", Resource: "services", Subresource: "proxy", Scope: "namespace", Prometheus: true},
	{ID: "edit", Feature: "Edit", Verb: "patch", Resource: "deployments", Group: "apps", Scope: "namespace"},
	{ID: "scale", Feature: "Scale", Verb: "patch", Resource: "deployments", Subresource: "scale", Group: "apps", Scope: "namespace"},
	{ID: "delete", Feature: "Delete", Verb: "delete", Resource: "pods", Scope: "namespace"},
	{ID: "node-shell", Feature: "Node shell", Verb: "create", Resource: "pods", Scope: "namespace", Namespace: "kube-system"},
	{ID: "helm", Feature: "Helm releases", Verb: "list", Resource: "secrets", Scope: "namespace"},
	{ID: "argo-get", Feature: "Argo CD", Verb: "get", Resource: "applications", Group: "argoproj.io", Scope: "namespace", Namespace: "argocd", Argo: true},
	{ID: "argo-patch", Feature: "Argo CD", Verb: "patch", Resource: "applications", Group: "argoproj.io", Scope: "namespace", Namespace: "argocd", Argo: true},
	{ID: "argo-delete", Feature: "Argo CD", Verb: "delete", Resource: "applications", Group: "argoproj.io", Scope: "namespace", Namespace: "argocd", Argo: true},
	{ID: "crds", Feature: "Custom resource definitions", Verb: "list", Resource: "customresourcedefinitions", Group: "apiextensions.k8s.io", Scope: "cluster"},
}

const (
	accessCacheTTL    = 5 * time.Minute
	accessTimeout     = 10 * time.Second
	accessParallelism = 8
)

// accessResult is one answered check.
type accessResult struct {
	ID          string `json:"id"`
	Feature     string `json:"feature"`
	Verb        string `json:"verb"`
	Resource    string `json:"resource"`
	Subresource string `json:"subresource,omitempty"`
	Group       string `json:"group,omitempty"`
	Namespace   string `json:"namespace,omitempty"`
	Allowed     bool   `json:"allowed"`
	Reason      string `json:"reason,omitempty"`
	Error       string `json:"error,omitempty"`
}

type accessAnswer struct {
	User      string         `json:"user"`
	Groups    []string       `json:"groups"`
	Namespace string         `json:"namespace"`
	Checks    []accessResult `json:"checks"`
	CheckedAt string         `json:"checkedAt"`
}

type accessMemo struct {
	at     time.Time
	answer accessAnswer
}

type accessCache struct {
	mu sync.Mutex
	m  map[string]accessMemo
}

// resolved is a check with its namespace decided.
func (c accessCheck) resolved(requested, prometheusNS string) accessCheck {
	switch {
	case c.Scope == "cluster":
		c.Namespace = ""
	case c.Prometheus:
		c.Namespace = prometheusNS
	case c.Namespace == "":
		c.Namespace = requested
	}
	return c
}

// canIArgs is the `kubectl auth can-i` command line of a check.
func (c accessCheck) canIArgs(kubeContext string, allNamespaces bool) []string {
	// kubectl wants resource.group (pods.metrics.k8s.io); a subresource is a flag, because pods/log
	// would mean the pod named "log".
	target := c.Resource
	if c.Group != "" {
		target += "." + c.Group
	}
	args := []string{"--context=" + kubeContext, "auth", "can-i", c.Verb, target}
	if c.Subresource != "" {
		args = append(args, "--subresource="+c.Subresource)
	}
	switch {
	case c.Namespace != "":
		args = append(args, "--namespace="+c.Namespace)
	case c.Scope == "namespace" && allNamespaces:
		args = append(args, "--all-namespaces")
	}
	return args
}

func (c accessCheck) review() obj {
	attrs := obj{"verb": c.Verb, "resource": c.Resource, "group": c.Group}
	if c.Subresource != "" {
		attrs["subresource"] = c.Subresource
	}
	if c.Namespace != "" {
		attrs["namespace"] = c.Namespace
	}
	return obj{"apiVersion": "authorization.k8s.io/v1", "kind": "SelfSubjectAccessReview", "spec": obj{"resourceAttributes": attrs}}
}

// ask answers one check through the API server, or kubectl when the live layer is off.
func (b *Backend) askAccess(ctx context.Context, kubeContext string, c accessCheck, allNamespaces bool) (allowed bool, reason string, err error) {
	if liveReady(b) {
		raw, _, err := liveSend(b, ctx, kubeContext, "POST", "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews", c.review(), RawOptions{TimeoutMs: int(accessTimeout / time.Millisecond)})
		if err != nil {
			return false, "", err
		}
		var doc struct {
			Status struct {
				Allowed         bool   `json:"allowed"`
				Reason          string `json:"reason"`
				EvaluationError string `json:"evaluationError"`
			} `json:"status"`
		}
		if err := json.Unmarshal(raw, &doc); err != nil {
			return false, "", problem("Kubernetes returned an invalid access review", 502)
		}
		reason := doc.Status.Reason
		if reason == "" {
			reason = doc.Status.EvaluationError
		}
		return doc.Status.Allowed, reason, nil
	}
	res, err := b.kube(ctx, c.canIArgs(kubeContext, allNamespaces), RunOptions{AllowExit: []int{0, 1}, Timeout: accessTimeout})
	if err != nil {
		return false, "", err
	}
	answer := strings.TrimSpace(res.Stdout)
	return res.Code == 0 && strings.HasPrefix(answer, "yes"), strings.TrimSpace(res.Stderr), nil
}

// whoAmI reads the identity; it is optional (older clusters have no SelfSubjectReview).
func (b *Backend) whoAmI(ctx context.Context, kubeContext string) (string, []string) {
	var doc struct {
		Status struct {
			UserInfo struct {
				Username string   `json:"username"`
				Groups   []string `json:"groups"`
			} `json:"userInfo"`
		} `json:"status"`
	}
	if liveReady(b) {
		raw, _, err := liveSend(b, ctx, kubeContext, "POST", "/apis/authentication.k8s.io/v1/selfsubjectreviews", obj{"apiVersion": "authentication.k8s.io/v1", "kind": "SelfSubjectReview"}, RawOptions{TimeoutMs: int(accessTimeout / time.Millisecond)})
		if err != nil || json.Unmarshal(raw, &doc) != nil {
			return "", nil
		}
	} else {
		res, err := b.kube(ctx, []string{"--context=" + kubeContext, "auth", "whoami", "--output=json"}, RunOptions{Timeout: accessTimeout})
		if err != nil || json.Unmarshal([]byte(res.Stdout), &doc) != nil {
			return "", nil
		}
	}
	return doc.Status.UserInfo.Username, doc.Status.UserInfo.Groups
}

// hasArgoCD reports whether discovery knows applications.argoproj.io. A discovery failure counts as no.
func (b *Backend) hasArgoCD(ctx context.Context, kubeContext string) bool {
	found := func(group, name string) bool { return group == "argoproj.io" && name == "applications" }
	has, err := viaLive(b, func(l *live.Live) (bool, error) {
		d, err := l.Discover(ctx, kubeContext, false)
		if err != nil {
			return false, err
		}
		for _, r := range d.Resources {
			if found(r.Group, r.Name) {
				return true, nil
			}
		}
		return false, nil
	}, func() (bool, error) {
		v, _, err := b.discoverViaKubectl(ctx, []string{"--context=" + kubeContext})
		if err != nil {
			return false, err
		}
		for _, r := range objOf(v)["resources"].([]discoveredResource) {
			if found(r.Group, r.Name) {
				return true, nil
			}
		}
		return false, nil
	})
	return err == nil && has
}

// prometheusNamespace is where the Prometheus service lives: the namespace chosen in Settings, else
// the usual one auto-detection looks in first.
func (b *Backend) prometheusNamespace(kubeContext string) string {
	prefs, err := b.readPreferences()
	if err != nil {
		return "monitoring"
	}
	configured := objOf(objOf(prefs["prometheusByContext"])[kubeContext])
	if configured != nil && configured["mode"] == "service" {
		if ns, err := validateNamespace(configured["namespace"], false); err == nil && ns != "" {
			return ns
		}
	}
	return "monitoring"
}

func (b *Backend) accessCheckAll(ctx context.Context, kubeContext, namespace string) (accessAnswer, error) {
	ctx, cancel := context.WithTimeout(ctx, accessTimeout)
	defer cancel()
	requested := namespace
	if requested == "*" {
		requested = ""
	}
	promNS := b.prometheusNamespace(kubeContext)
	argo := b.hasArgoCD(ctx, kubeContext)
	var checks []accessCheck
	for _, c := range accessChecks {
		if c.Argo && !argo {
			continue
		}
		checks = append(checks, c.resolved(requested, promNS))
	}
	results := make([]accessResult, len(checks))
	errs := make([]error, len(checks))
	sem := make(chan struct{}, accessParallelism)
	var wg sync.WaitGroup
	for i, c := range checks {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			allowed, reason, err := b.askAccess(ctx, kubeContext, c, requested == "")
			results[i] = accessResult{ID: c.ID, Feature: c.Feature, Verb: c.Verb, Resource: c.Resource, Subresource: c.Subresource, Group: c.Group, Namespace: c.Namespace, Allowed: allowed, Reason: reason}
			if err != nil {
				errs[i] = err
				results[i].Error = shortError(err)
			}
		}()
	}
	wg.Wait()
	failed := 0
	var first error
	for _, err := range errs {
		if err != nil {
			failed++
			if first == nil {
				first = err
			}
		}
	}
	if failed == len(checks) && first != nil {
		return accessAnswer{}, first
	}
	user, groups := b.whoAmI(ctx, kubeContext)
	if groups == nil {
		groups = []string{}
	}
	return accessAnswer{User: user, Groups: groups, Namespace: namespace, Checks: results, CheckedAt: time.Now().UTC().Format(time.RFC3339)}, nil
}

func (b *Backend) routeAccessCheck(q *request) (any, int, error) {
	kubeContext, err := validateText(q.body["context"], "context")
	if err != nil {
		return nil, 0, err
	}
	namespace, err := validateNamespace(q.body["namespace"], true)
	if err != nil {
		return nil, 0, err
	}
	key := kubeContext + "\x00" + namespace
	refresh, _ := q.body["refresh"].(bool)
	b.accessMemo.mu.Lock()
	memo, ok := b.accessMemo.m[key]
	b.accessMemo.mu.Unlock()
	if ok && !refresh && time.Since(memo.at) < accessCacheTTL {
		return memo.answer, 200, nil
	}
	answer, err := b.accessCheckAll(q.ctx, kubeContext, namespace)
	if err != nil {
		return nil, 0, err
	}
	// A partial answer (some checks timed out) is shown but not remembered.
	for _, c := range answer.Checks {
		if c.Error != "" {
			return answer, 200, nil
		}
	}
	b.accessMemo.mu.Lock()
	if b.accessMemo.m == nil {
		b.accessMemo.m = map[string]accessMemo{}
	}
	b.accessMemo.m[key] = accessMemo{at: time.Now(), answer: answer}
	b.accessMemo.mu.Unlock()
	return answer, 200, nil
}

func init() {
	registerRoutes(func(b *Backend, q *request) (any, int, bool, error) {
		if q.method != "POST" || q.route != "/api/access/check" {
			return nil, 0, false, nil
		}
		v, status, err := b.routeAccessCheck(q)
		return v, status, true, err
	})
}
