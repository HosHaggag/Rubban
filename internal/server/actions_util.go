package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf16"
)

// Helpers shared by the metrics, Helm, actions, Prometheus and extras routes.

// liveReady and liveSend wrap the live-layer helpers in access.go. They are variables so tests can
// stand in for the kubectl-proxy transport, which the fake command runner cannot provide.
var liveReady = func(b *Backend) bool { return b.liveAvailable() }

var liveSend = func(b *Backend, ctx context.Context, kubeContext, method, apiPath string, body any, o RawOptions) (json.RawMessage, int, error) {
	return b.liveRequest(ctx, kubeContext, method, apiPath, body, o)
}

// backendState is the per-backend memory of these routes (kubelet failures, Prometheus providers).
type backendState struct {
	mu      sync.Mutex
	now     func() time.Time
	kubelet map[string]kubeletFailure
	prom    map[string]promCacheEntry
}

var backendStates sync.Map // *Backend -> *backendState

func (b *Backend) xstate() *backendState {
	if v, ok := backendStates.Load(b); ok {
		return v.(*backendState)
	}
	v, _ := backendStates.LoadOrStore(b, &backendState{now: time.Now, kubelet: map[string]kubeletFailure{}, prom: map[string]promCacheEntry{}})
	return v.(*backendState)
}

// truthy mirrors JavaScript truthiness for decoded JSON values.
func truthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case float64:
		return t != 0 && !math.IsNaN(t)
	case json.Number:
		f, _ := t.Float64()
		return f != 0
	}
	return true
}

// jsString mirrors String(value) for decoded JSON values.
func jsString(v any) string {
	switch t := v.(type) {
	case nil:
		return "null"
	case string:
		return t
	case bool:
		return strconv.FormatBool(t)
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case json.Number:
		return t.String()
	}
	data, _ := json.Marshal(v)
	return string(data)
}

// numOf mirrors Number(value) for decoded JSON values; NaN when it is not a number.
func numOf(v any) float64 {
	switch t := v.(type) {
	case nil:
		return 0
	case bool:
		if t {
			return 1
		}
		return 0
	case float64:
		return t
	case json.Number:
		f, err := t.Float64()
		if err != nil {
			return math.NaN()
		}
		return f
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return 0
		}
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return math.NaN()
		}
		return f
	}
	return math.NaN()
}

// jsonUnit is a JSON number, or null where JSON cannot carry NaN and infinities.
func jsonUnit(f float64) any {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return nil
	}
	return f
}

// compactJSON is JSON.stringify: compact, without HTML escaping.
func compactJSON(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return ""
	}
	return strings.TrimRight(buf.String(), "\n")
}

// trimOutput is (stdout + stderr).trim().
func trimOutput(res Result) string { return strings.TrimSpace(res.Stdout + res.Stderr) }

// encodeURIComponent escapes like the JavaScript function of the same name.
func encodeURIComponent(s string) string {
	const unreserved = "-_.!~*'()"
	var sb strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.IndexByte(unreserved, c) >= 0 {
			sb.WriteByte(c)
		} else {
			fmt.Fprintf(&sb, "%%%02X", c)
		}
	}
	return sb.String()
}

// formEncode escapes like URLSearchParams.
func formEncode(s string) string {
	var sb strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '*' || c == '-' || c == '.' || c == '_':
			sb.WriteByte(c)
		case c == ' ':
			sb.WriteByte('+')
		default:
			fmt.Fprintf(&sb, "%%%02X", c)
		}
	}
	return sb.String()
}

// jsLength is String.length (UTF-16 code units).
func jsLength(s string) int {
	n := 0
	for _, r := range s {
		n += len(utf16.Encode([]rune{r}))
	}
	return n
}

func jsTrim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool { return unicode.IsSpace(r) || r == '\uFEFF' })
}

// firstChars keeps at most n characters.
func firstChars(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

// settled is one result of a group of concurrent commands.
type settled struct {
	Res Result
	Err error
}

// settle runs the thunks concurrently and returns every outcome in order (Promise.allSettled).
func settle(thunks ...func() (Result, error)) []settled {
	out := make([]settled, len(thunks))
	var wg sync.WaitGroup
	for i, thunk := range thunks {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := thunk()
			out[i] = settled{res, err}
		}()
	}
	wg.Wait()
	return out
}

// liveFailure turns a non-2xx status from liveSend into the Problem the API reports.
func liveFailure(raw json.RawMessage, status int, err error) error {
	if err != nil {
		return err
	}
	if status < 400 {
		return nil
	}
	msg := fmt.Sprintf("Kubernetes API returned HTTP %d", status)
	var doc struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(raw, &doc) == nil && doc.Message != "" {
		msg = doc.Message
	}
	return problem(msg, status)
}
