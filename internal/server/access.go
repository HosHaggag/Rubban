package server

import (
	"context"
	"encoding/json"
	"net/url"
	"strconv"
	"strings"
)

// Cluster access used by route handlers. Today every helper goes through one-shot kubectl; the live
// layer (internal/live) replaces the bodies with the kubectl-proxy transport and falls back to these
// kubectl paths only when the proxy cannot be started.

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

// listObjects lists a resource (namespace "" or "*" = all namespaces). The context is already validated.
func (b *Backend) listObjects(ctx context.Context, kubeContext, resource, namespace string, o ListOptions) (obj, error) {
	nsArgs, err := namespaceArgs(namespace, true)
	if err != nil {
		return nil, err
	}
	args := append(append([]string{"get", resource, "--context=" + kubeContext}, nsArgs...), o.args()...)
	res, err := b.kube(ctx, append(args, "--output=json"), RunOptions{MaxBytes: listOutputLimit})
	if err != nil {
		return nil, err
	}
	return parseObject(res, "kubectl")
}

// getObject reads one object. For namespaced resources namespace must be set; "" means cluster scoped.
func (b *Backend) getObject(ctx context.Context, kubeContext, resource, namespace, name string) (obj, error) {
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
	opts := RunOptions{}
	args := []string{"--context=" + kubeContext, "get", "--raw=" + apiPath}
	if o.TimeoutMs > 0 {
		args = append(args, "--request-timeout="+itoa(o.TimeoutMs/1000)+"s")
	}
	res, err := b.kube(ctx, args, opts)
	if err != nil {
		return nil, err
	}
	return parseJSON(res, "Kubernetes API")
}

// readSecretData returns the (base64) data map of a Secret.
func (b *Backend) readSecretData(ctx context.Context, kubeContext, namespace, name string) (map[string]any, error) {
	secret, err := b.getObject(ctx, kubeContext, "secret", namespace, name)
	if err != nil {
		return nil, err
	}
	data, _ := secret["data"].(obj)
	if data == nil {
		data = obj{}
	}
	return data, nil
}

// liveRequest sends a request through the live layer. Without it there is no safe equivalent, so the
// caller gets a 503 and the UI explains the feature needs the live connection.
func (b *Backend) liveRequest(ctx context.Context, kubeContext, method, apiPath string, body any, o RawOptions) (json.RawMessage, int, error) {
	return nil, 0, problem("This action needs the live cluster connection, which is not available.", 503)
}

// liveAvailable reports whether liveRequest can work.
func (b *Backend) liveAvailable() bool { return false }

func itoa(n int) string { return strconv.Itoa(n) }

// pathEscape escapes one URL path segment like encodeURIComponent.
func pathEscape(s string) string { return strings.ReplaceAll(url.PathEscape(s), "+", "%2B") }
