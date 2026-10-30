package live

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	responseLimit  = 96 * 1024 * 1024
	defaultTimeout = 60 * time.Second
)

// kv is one query parameter. Queries are built in insertion order, like URLSearchParams.
type kv struct{ k, v string }

func buildQuery(pairs []kv) string {
	var sb strings.Builder
	for i, p := range pairs {
		if i > 0 {
			sb.WriteByte('&')
		}
		sb.WriteString(url.QueryEscape(p.k))
		sb.WriteByte('=')
		sb.WriteString(url.QueryEscape(p.v))
	}
	return sb.String()
}

// transport talks HTTP to a kubectl proxy.
type transport struct{ client *http.Client }

func newTransport() *transport {
	return &transport{client: &http.Client{Transport: &http.Transport{
		Proxy:               nil, // the proxy is on loopback; never route it through an environment proxy
		MaxIdleConnsPerHost: 16,
		IdleConnTimeout:     90 * time.Second,
		DialContext:         (&net.Dialer{Timeout: 10 * time.Second}).DialContext,
	}}}
}

func (t *transport) close() { t.client.CloseIdleConnections() }

type reqOpts struct {
	Method  string
	Headers map[string]string
	Body    []byte
	Timeout time.Duration
}

// open sends a request and returns the response with its body unread. ctx governs the whole exchange,
// including reading the body. A cancelled ctx is reported as 499 and a dropped connection as 502.
func (t *transport) open(ctx context.Context, baseURL, apiPath string, o reqOpts) (*http.Response, error) {
	if ctx.Err() != nil {
		return nil, canceled()
	}
	if _, err := url.Parse(baseURL + apiPath); err != nil {
		return nil, newError("Invalid Kubernetes API path", 400)
	}
	method := o.Method
	if method == "" {
		method = http.MethodGet
	}
	var body io.Reader
	if o.Body != nil {
		body = bytes.NewReader(o.Body)
	}
	req, err := http.NewRequestWithContext(ctx, method, baseURL+apiPath, body)
	if err != nil {
		return nil, newError("Invalid Kubernetes API path", 400)
	}
	req.Header.Set("Accept", "application/json")
	for k, v := range o.Headers {
		req.Header.Set(k, v)
	}
	resp, err := t.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, canceled()
		}
		return nil, connectionFailure(err)
	}
	return resp, nil
}

// readBody reads at most limit bytes of a response body.
func readBody(ctx context.Context, body io.Reader, limit int) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(body, int64(limit)+1))
	if err != nil {
		if ctx.Err() != nil {
			return nil, canceled()
		}
		e := connectionFailure(err)
		if err == io.ErrUnexpectedEOF {
			e = newError("Kubernetes API response was interrupted", 502)
			e.ConnectionLost = true
		}
		return nil, e
	}
	if len(data) > limit {
		return nil, newError("Kubernetes API response exceeded the size limit", 502)
	}
	return data, nil
}

// fetch performs one request to completion and returns the status and body. Failures are *Error:
// 499 when ctx was cancelled, 504 on timeout, 502 for a lost connection.
func (t *transport) fetch(ctx context.Context, baseURL, apiPath string, o reqOpts) (int, []byte, error) {
	timeout := o.Timeout
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	rctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	timedOut := func() *Error {
		return newError(fmt.Sprintf("Kubernetes API request timed out after %d ms", timeout.Milliseconds()), 504)
	}
	resp, err := t.open(rctx, baseURL, apiPath, o)
	if err != nil {
		if ctx.Err() == nil && rctx.Err() != nil {
			return 0, nil, timedOut()
		}
		return 0, nil, err
	}
	defer resp.Body.Close()
	data, err := readBody(rctx, resp.Body, responseLimit)
	if err != nil {
		if ctx.Err() == nil && rctx.Err() != nil {
			return 0, nil, timedOut()
		}
		return 0, nil, err
	}
	return resp.StatusCode, data, nil
}

// decodeJSON parses a body the way JSON.parse(text || '{}') did, keeping numbers exact.
func decodeJSON(data []byte) (any, bool) {
	if len(bytes.TrimSpace(data)) == 0 {
		return map[string]any{}, true
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, false
	}
	if dec.More() {
		return nil, false
	}
	return v, true
}

// requestJSON GETs (or sends) a request and decodes the JSON answer. Kubernetes statuses the UI
// understands pass through; everything else is 502.
func (t *transport) requestJSON(ctx context.Context, baseURL, apiPath string, o reqOpts) (any, error) {
	status, data, err := t.fetch(ctx, baseURL, apiPath, o)
	if err != nil {
		return nil, err
	}
	parsed, ok := decodeJSON(data)
	if status >= 400 {
		if !ok {
			parsed = nil
		}
		return nil, statusError(status, parsed, string(data))
	}
	if !ok {
		return nil, newError("Kubernetes API returned invalid JSON", 502)
	}
	return parsed, nil
}

// requestRaw is requestJSON without decoding: it validates the body and returns it untouched, so key
// order survives (the YAML view depends on it).
func (t *transport) requestRaw(ctx context.Context, baseURL, apiPath string, o reqOpts) (json.RawMessage, int, error) {
	status, data, err := t.fetch(ctx, baseURL, apiPath, o)
	if err != nil {
		return nil, 0, err
	}
	if status >= 400 {
		parsed, ok := decodeJSON(data)
		if !ok {
			parsed = nil
		}
		return nil, 0, statusError(status, parsed, string(data))
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return json.RawMessage("{}"), status, nil
	}
	if !json.Valid(data) {
		return nil, 0, newError("Kubernetes API returned invalid JSON", 502)
	}
	return json.RawMessage(data), status, nil
}

func sleep(ctx context.Context, d time.Duration) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-ctx.Done():
	}
}
