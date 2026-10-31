package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/HosHaggag/rubban/internal/live"
)

// Cluster access used by route handlers. Every helper prefers the live layer (internal/live: a
// kubectl-proxy transport with shared watches) and falls back to one-shot kubectl only when the proxy
// process could not be spawned (503) or did not start in time (504), never when the cluster answered
// with an error, including a failed proxy handshake (502).

// ListOptions filters a list request.
type ListOptions struct{ LabelSelector, FieldSelector string }

// RawOptions tunes a raw API request.
type RawOptions struct {
	Accept    string // Accept header for the live transport; ignored by the kubectl fallback
	TimeoutMs int    // 0 = default
}

func (o ListOptions) args() []string {
	var args []string
	if o.LabelSelector != "" {
		args = append(args, "--selector="+o.LabelSelector)
	}
	if o.FieldSelector != "" {
		args = append(args, "--field-selector="+o.FieldSelector)
	}
	return args
}

// liveProblem turns a live-layer error into the Problem the API answers with.
func liveProblem(err error) error {
	var le *live.Error
	if errors.As(err, &le) {
		status := le.Status
		if status == 0 {
			status = 502
		}
		p := problem(le.Message, status)
		if failure, ok := classifyAuthFailure(le.Message); ok || le.KubeStatus == 401 {
			if !ok {
				failure = authFailure{Kind: "unauthorized"}
			}
			p.Code, p.Plugin = "credentials", failure.Plugin
		}
		return p
	}
	return err
}

// viaLive runs read on the live layer and falls back to kubectl only when the proxy is unavailable.
// Without a live layer it just runs the fallback.
func viaLive[T any](b *Backend, read func(l *live.Live) (T, error), fallback func() (T, error)) (T, error) {
	if b.live == nil {
		return fallback()
	}
	v, err := read(b.live)
	if err == nil {
		return v, nil
	}
	var le *live.Error
	if errors.As(err, &le) && le.ProxyUnavailable && le.Status != 502 {
		return fallback()
	}
	var zero T
	return zero, liveProblem(err)
}

// listObjects lists a resource (namespace "" or "*" = all namespaces). The context is already validated.
func (b *Backend) listObjects(ctx context.Context, kubeContext, resource, namespace string, o ListOptions) (obj, error) {
	namespace, err := validateNamespace(namespace, true)
	if err != nil {
		return nil, err
	}
	return viaLive(b, func(l *live.Live) (obj, error) {
		return l.List(ctx, kubeContext, resource, namespace, live.ListOptions{LabelSelector: o.LabelSelector, FieldSelector: o.FieldSelector})
	}, func() (obj, error) { return b.listObjectsKubectl(ctx, kubeContext, resource, namespace, o) })
}

func (b *Backend) listObjectsKubectl(ctx context.Context, kubeContext, resource, namespace string, o ListOptions) (obj, error) {
	nsArgs, err := namespaceArgs(namespace, true)
	if err != nil {
		return nil, err
	}
	// --all-namespaces belongs to get, not kubectl's root/plugin parser.
	args := append(append([]string{"get", resource, "--context=" + kubeContext}, nsArgs...), o.args()...)
	res, err := b.kube(ctx, append(args, "--output=json"), RunOptions{MaxBytes: listOutputLimit})
	if err != nil {
		return nil, err
	}
	return parseObject(res, "kubectl")
}

// getObject reads one object. For namespaced resources namespace must be set; "" means cluster scoped.
func (b *Backend) getObject(ctx context.Context, kubeContext, resource, namespace, name string) (obj, error) {
	namespace, err := validateNamespace(namespace, false)
	if err != nil {
		return nil, err
	}
	return viaLive(b, func(l *live.Live) (obj, error) {
		return l.Get(ctx, kubeContext, resource, namespace, name)
	}, func() (obj, error) { return b.getObjectKubectl(ctx, kubeContext, resource, namespace, name) })
}

func (b *Backend) getObjectKubectl(ctx context.Context, kubeContext, resource, namespace, name string) (obj, error) {
	nsArgs, err := namespaceArgs(namespace, false)
	if err != nil {
		return nil, err
	}
	args := append(append([]string{"--context=" + kubeContext}, nsArgs...), "get", resource, name, "--output=json")
	res, err := b.kube(ctx, args, RunOptions{})
	if err != nil {
		return nil, err
	}
	return parseObject(res, "kubectl")
}

// rawGet reads an API path (for example /apis/metrics.k8s.io/v1beta1/nodes) and decodes the JSON body.
func (b *Backend) rawGet(ctx context.Context, kubeContext, apiPath string, o RawOptions) (any, error) {
	if !strings.HasPrefix(apiPath, "/") || strings.ContainsRune(apiPath, 0) {
		return nil, bad("Invalid Kubernetes API path")
	}
	return viaLive(b, func(l *live.Live) (any, error) {
		return l.Raw(ctx, kubeContext, apiPath, live.RawOptions{Accept: o.Accept, Timeout: time.Duration(o.TimeoutMs) * time.Millisecond})
	}, func() (any, error) {
		args := []string{"--context=" + kubeContext, "get", "--raw=" + apiPath}
		if o.TimeoutMs > 0 {
			args = append(args, "--request-timeout="+itoa(o.TimeoutMs/1000)+"s")
		}
		res, err := b.kube(ctx, args, RunOptions{})
		if err != nil {
			return nil, err
		}
		return parseJSON(res, "Kubernetes API")
	})
}

// readSecretData returns the (base64) data map of a Secret.
func (b *Backend) readSecretData(ctx context.Context, kubeContext, namespace, name string) (map[string]any, error) {
	namespace, err := validateNamespace(namespace, false)
	if err != nil {
		return nil, err
	}
	secret, err := viaLive(b, func(l *live.Live) (any, error) {
		return l.Raw(ctx, kubeContext, "/api/v1/namespaces/"+pathEscape(namespace)+"/secrets/"+pathEscape(name), live.RawOptions{})
	}, func() (any, error) {
		return b.getObjectKubectl(ctx, kubeContext, "secret", namespace, name)
	})
	if err != nil {
		return nil, err
	}
	data := objOf(objOf(secret)["data"])
	if data == nil {
		data = obj{}
	}
	return data, nil
}

// liveRequest sends a request through the live layer and returns the JSON answer and its HTTP status.
// Kubernetes errors (for example a 429 from a PodDisruptionBudget) come back as Problems carrying that
// status. Without the live layer there is no safe equivalent, so the caller gets a 503 and the UI
// explains the feature needs the live connection.
func (b *Backend) liveRequest(ctx context.Context, kubeContext, method, apiPath string, body any, o RawOptions) (json.RawMessage, int, error) {
	if b.live == nil {
		return nil, 0, problem("This action needs the live cluster connection, which is not available.", 503)
	}
	if !strings.HasPrefix(apiPath, "/") || strings.ContainsRune(apiPath, 0) {
		return nil, 0, bad("Invalid Kubernetes API path")
	}
	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			return nil, 0, bad("Invalid request body")
		}
	}
	raw, status, err := b.live.Do(ctx, kubeContext, method, apiPath, payload, live.RawOptions{Accept: o.Accept, Timeout: time.Duration(o.TimeoutMs) * time.Millisecond})
	if err != nil {
		return nil, 0, liveProblem(err)
	}
	return raw, status, nil
}

// liveAvailable reports whether liveRequest can work.
func (b *Backend) liveAvailable() bool { return b.live != nil }

func itoa(n int) string { return strconv.Itoa(n) }

// pathEscape escapes one URL path segment like encodeURIComponent.
func pathEscape(s string) string { return strings.ReplaceAll(url.PathEscape(s), "+", "%2B") }
