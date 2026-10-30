// Package live is Rubban's live cluster data layer: one `kubectl proxy` per kubeconfig context keeps a
// single authenticated connection to the API server, so exec credential plugins (gke-gcloud-auth-plugin,
// kubelogin, aws eks get-token) run once per token lifetime instead of once per request. The proxy
// listens on an OS-chosen loopback port under an unguessable path prefix. Reads go straight through it;
// resource views use shared LIST + WATCH streams with bookmarks, 410 relists, idle-stream recovery and
// exponential backoff. Writes stay on kubectl (apply/diff/delete semantics).
package live

import (
	"errors"
	"io"
	"net"
	"strings"
)

// Object is a decoded Kubernetes object (numbers are json.Number so they re-encode exactly).
type Object = map[string]any

// Error is a live-layer failure. Status is the HTTP status the API answers with; the flags steer the
// pool and the watch loop exactly like the properties of the Node errors did.
type Error struct {
	Status  int
	Message string

	KubeStatus       int // upstream HTTP status, when the API server answered
	Reason           string
	ConnectionLost   bool // the proxy connection dropped; invalidate it
	Canceled         bool
	ProxyUnavailable bool // the proxy process could not be spawned or did not become ready
	Gone             bool // 410: the resourceVersion expired
	Fatal            bool // the watch cannot recover
	WatchForbidden   bool // the watch verb is denied; fall back to polling
}

func (e *Error) Error() string { return e.Message }

func newError(message string, status int) *Error { return &Error{Status: status, Message: message} }

func canceled() *Error {
	e := newError("Request canceled", 499)
	e.Canceled = true
	return e
}

// asError returns err as an *Error when it is one.
func asError(err error) (*Error, bool) {
	var e *Error
	if errors.As(err, &e) {
		return e, true
	}
	return nil, false
}

// connectionFailure turns a transport error into an *Error, marking dropped connections.
func connectionFailure(err error) *Error {
	if e, ok := asError(err); ok {
		return e
	}
	msg := "unknown error"
	if err != nil {
		msg = err.Error()
	}
	e := newError("Cluster connection lost: "+msg, 502)
	e.ConnectionLost = isConnectionLost(err)
	return e
}

func isConnectionLost(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}
	var op *net.OpError
	if errors.As(err, &op) {
		return true
	}
	text := strings.ToLower(err.Error())
	for _, s := range []string{"connection reset", "connection refused", "broken pipe", "unexpected eof", "use of closed network connection"} {
		if strings.Contains(text, s) {
			return true
		}
	}
	return false
}

// statusError maps a Kubernetes error response to an *Error. Statuses the UI understands pass through,
// everything else becomes 502.
func statusError(status int, body any, text string) *Error {
	b, _ := body.(map[string]any)
	message, _ := b["message"].(string)
	if message == "" {
		message = strings.TrimSpace(text)
		if r := []rune(message); len(r) > 2000 {
			message = string(r[:2000])
		}
	}
	if message == "" {
		message = "Kubernetes API returned HTTP " + itoa(status)
	}
	mapped := 502
	switch status {
	case 400, 401, 403, 404, 409, 410, 422, 429:
		mapped = status
	}
	e := newError(message, mapped)
	e.KubeStatus = status
	e.Reason, _ = b["reason"].(string)
	return e
}
