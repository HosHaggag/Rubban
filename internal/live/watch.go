package live

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/rand"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	listPageSize         = 500
	watchTimeoutSeconds  = 290
	eventLineLimit       = 16 * 1024 * 1024
	listPageTimeout      = 120 * time.Second
	defaultStreamIdle    = 150 * time.Second
	defaultWatchLinger   = 2 * time.Minute
	defaultPollInterval  = 15 * time.Second
	defaultFlushInterval = 150 * time.Millisecond
	defaultMaxBackoff    = 30 * time.Second
)

// Status is the state of a watch, sent to subscribers as {type:'status', ...}.
type Status struct {
	State   string // connecting | live | polling | reconnecting | error
	Message string
	Attempt int
}

// Listener receives the events of a shared watch. Methods are called with the watch's lock held and
// must return quickly (enqueue, never block) and must not call back into the watch.
type Listener interface {
	Status(Status)
	// Reset delivers the full snapshot once the first LIST completes (and to every later subscriber).
	Reset(items []Object, resourceVersion string)
	// Changes delivers coalesced upserts and the keys of deleted objects.
	Changes(upserts []Object, deletes []string)
	// Fatal reports an error after which the watch is over.
	Fatal(err error)
}

// omap is an insertion-ordered map, like a JavaScript Map.
type omap[V any] struct {
	m    map[string]omapEntry[V]
	next int
}

type omapEntry[V any] struct {
	v   V
	seq int
}

func newOmap[V any]() *omap[V] { return &omap[V]{m: map[string]omapEntry[V]{}} }

func (o *omap[V]) set(key string, v V) {
	if e, ok := o.m[key]; ok {
		o.m[key] = omapEntry[V]{v, e.seq}
		return
	}
	o.m[key] = omapEntry[V]{v, o.next}
	o.next++
}
func (o *omap[V]) get(key string) (V, bool) { e, ok := o.m[key]; return e.v, ok }
func (o *omap[V]) del(key string)           { delete(o.m, key) }
func (o *omap[V]) len() int                 { return len(o.m) }
func (o *omap[V]) clear()                   { o.m = map[string]omapEntry[V]{}; o.next = 0 }

func (o *omap[V]) keys() []string {
	type pair struct {
		k   string
		seq int
	}
	pairs := make([]pair, 0, len(o.m))
	for k, e := range o.m {
		pairs = append(pairs, pair{k, e.seq})
	}
	sort.Slice(pairs, func(i, j int) bool { return pairs[i].seq < pairs[j].seq })
	keys := make([]string, len(pairs))
	for i, p := range pairs {
		keys[i] = p.k
	}
	return keys
}

func (o *omap[V]) values() []V {
	keys := o.keys()
	out := make([]V, len(keys))
	for i, k := range keys {
		out[i] = o.m[k].v
	}
	return out
}

// timings are the intervals the watch loop uses; tests shorten them.
type timings struct {
	StreamIdle, Linger, Poll, Flush, MaxBackoff time.Duration
}

func (t timings) withDefaults() timings {
	def := func(v *time.Duration, d time.Duration) {
		if *v <= 0 {
			*v = d
		}
	}
	def(&t.StreamIdle, defaultStreamIdle)
	def(&t.Linger, defaultWatchLinger)
	def(&t.Poll, defaultPollInterval)
	def(&t.Flush, defaultFlushInterval)
	def(&t.MaxBackoff, defaultMaxBackoff)
	return t
}

func backoff(attempt int, max time.Duration) time.Duration {
	exp := attempt - 1
	if exp < 0 {
		exp = 0
	}
	if exp > 30 {
		exp = 30
	}
	base := time.Duration(float64(time.Second) * math.Pow(2, float64(exp)))
	if base > max {
		base = max
	}
	return time.Duration(float64(base) * (0.75 + rand.Float64()*0.5))
}

func isSecretTarget(t Resource) bool { return t.Group == "" && t.Name == "secrets" }

func collectionPath(t Resource, namespace string) string {
	root := "/api/" + t.Version
	if t.Group != "" {
		root = "/apis/" + t.Group + "/" + t.Version
	}
	scoped := ""
	if t.Namespaced && namespace != "" {
		scoped = "/namespaces/" + encodeURIComponent(namespace)
	}
	return root + scoped + "/" + t.Name
}

type listenerEntry struct{ l Listener }

// ResourceWatch is one shared LIST + WATCH stream for a resource, namespace and selector set.
type ResourceWatch struct {
	key       string
	context   string
	target    Resource
	namespace string
	selectors []kv
	pool      *Pool
	tx        *transport
	tm        timings
	onStopped func(*ResourceWatch)
	secret    bool
	path      string

	root     context.Context
	stopRoot context.CancelFunc

	mu              sync.Mutex
	listeners       map[*listenerEntry]struct{}
	items           *omap[Object]
	resourceVersion string
	synced          bool
	mode            string
	status          Status
	stopped         bool
	running         bool
	attempt         int
	abort           context.CancelFunc
	resyncRequested bool
	pendingUpserts  *omap[Object]
	pendingDeletes  *omap[struct{}]
	flushTimer      *time.Timer
	lingerTimer     *time.Timer
}

func newResourceWatch(parent context.Context, key, kubeContext string, target Resource, namespace string, selectors []kv, pool *Pool, tx *transport, tm timings, onStopped func(*ResourceWatch)) *ResourceWatch {
	root, cancel := context.WithCancel(parent)
	w := &ResourceWatch{
		key: key, context: kubeContext, target: target, namespace: namespace, selectors: selectors, pool: pool, tx: tx, tm: tm,
		onStopped: onStopped, secret: isSecretTarget(target), path: collectionPath(target, namespace),
		root: root, stopRoot: cancel,
		listeners: map[*listenerEntry]struct{}{}, items: newOmap[Object](), mode: "watch",
		status:         Status{State: "connecting", Message: "Connecting to the cluster…"},
		pendingUpserts: newOmap[Object](), pendingDeletes: newOmap[struct{}](),
	}
	return w
}

func call(fn func()) {
	defer func() { _ = recover() }() // A failing subscriber must not stop the stream.
	fn()
}

// subscribe adds a listener and starts the loop when needed. It returns false when the watch has
// already stopped; the caller then creates a fresh one.
func (w *ResourceWatch) subscribe(l Listener) (func(), bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.stopped {
		return nil, false
	}
	if w.lingerTimer != nil {
		w.lingerTimer.Stop()
		w.lingerTimer = nil
	}
	entry := &listenerEntry{l}
	w.listeners[entry] = struct{}{}
	status := w.status
	call(func() { l.Status(status) })
	if w.synced {
		items, rv := w.items.values(), w.resourceVersion
		call(func() { l.Reset(items, rv) })
	}
	if !w.running {
		w.running = true
		go w.loop()
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			w.mu.Lock()
			defer w.mu.Unlock()
			if _, ok := w.listeners[entry]; !ok {
				return
			}
			delete(w.listeners, entry)
			if len(w.listeners) > 0 || w.stopped {
				return
			}
			w.lingerTimer = time.AfterFunc(w.tm.Linger, w.stop)
		})
	}, true
}

// emit calls every listener. The caller holds w.mu.
func (w *ResourceWatch) emit(fn func(Listener)) {
	for entry := range w.listeners {
		l := entry.l
		call(func() { fn(l) })
	}
}

// setStatus updates the status and tells subscribers. The caller holds w.mu.
func (w *ResourceWatch) setStatus(state, message string, attempt int) {
	if w.status.State == state && w.status.Message == message {
		return
	}
	w.status = Status{State: state, Message: message, Attempt: attempt}
	st := w.status
	w.emit(func(l Listener) { l.Status(st) })
}

func (w *ResourceWatch) resync() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.stopped {
		return
	}
	w.resyncRequested = true
	w.resourceVersion = ""
	if w.abort != nil {
		w.abort()
	}
}

func (w *ResourceWatch) stop() {
	w.mu.Lock()
	if w.stopped {
		w.mu.Unlock()
		return
	}
	w.stopped = true
	if w.lingerTimer != nil {
		w.lingerTimer.Stop()
	}
	if w.flushTimer != nil {
		w.flushTimer.Stop()
		w.flushTimer = nil
	}
	w.listeners = map[*listenerEntry]struct{}{}
	w.mu.Unlock()
	w.stopRoot()
	if w.onStopped != nil {
		w.onStopped(w)
	}
}

func (w *ResourceWatch) isStopped() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.stopped
}

// newAbort returns a context for one network operation that resync and stop can cancel.
func (w *ResourceWatch) newAbort() context.Context {
	ctx, cancel := context.WithCancel(w.root)
	w.mu.Lock()
	w.abort = cancel
	w.mu.Unlock()
	return ctx
}

func (w *ResourceWatch) loop() {
	defer func() {
		w.mu.Lock()
		w.running = false
		w.mu.Unlock()
	}()
	for !w.isStopped() {
		err := w.cycle()
		if err == nil {
			continue
		}
		e, _ := asError(err)
		if e == nil {
			e = connectionFailure(err)
		}
		if w.isStopped() {
			return
		}
		w.mu.Lock()
		if w.resyncRequested {
			w.resyncRequested = false
			w.mu.Unlock()
			continue
		}
		if e.Gone {
			w.resourceVersion = ""
			w.mu.Unlock()
			continue
		}
		if e.WatchForbidden && w.mode != "poll" {
			w.mode = "poll"
			w.mu.Unlock()
			continue
		}
		if e.Fatal {
			w.setStatus("error", e.Message, 0)
			w.emit(func(l Listener) { l.Fatal(e) })
			w.mu.Unlock()
			w.stop()
			return
		}
		w.attempt++
		attempt := w.attempt
		if attempt >= 3 {
			w.resourceVersion = ""
		}
		// A dropped proxy is usually replaced within milliseconds; retry the first time quickly.
		delay := backoff(attempt, w.tm.MaxBackoff)
		if e.ConnectionLost && attempt == 1 {
			delay = 250 * time.Millisecond
		}
		secs := int(math.Round(delay.Seconds()))
		if secs < 1 {
			secs = 1
		}
		w.setStatus("reconnecting", fmt.Sprintf("%s Retrying in %ds.", e.Message, secs), attempt)
		w.mu.Unlock()
		sleep(w.newAbort(), delay)
		w.mu.Lock()
		w.resyncRequested = false
		w.mu.Unlock()
	}
}

// cycle runs one acquire, list and watch (or poll sleep). It returns nil on a normal end.
func (w *ResourceWatch) cycle() (err error) {
	lease, err := w.pool.Acquire(w.root, w.context)
	if err != nil {
		return err
	}
	defer lease.Release()
	defer func() {
		if e, ok := asError(err); ok && e.ConnectionLost {
			lease.Invalidate()
		}
	}()
	if w.isStopped() {
		return nil
	}
	w.mu.Lock()
	needList := w.resourceVersion == "" || w.mode == "poll"
	w.mu.Unlock()
	if needList {
		if err = w.list(lease); err != nil {
			return err
		}
	}
	if w.isStopped() {
		return nil
	}
	w.mu.Lock()
	poll := w.mode == "poll"
	w.mu.Unlock()
	if poll {
		sleep(w.newAbort(), w.tm.Poll)
	} else if err = w.watch(lease); err != nil {
		return err
	}
	w.mu.Lock()
	w.attempt = 0
	w.mu.Unlock()
	return nil
}

func (w *ResourceWatch) selectorPairs() []kv { return append([]kv(nil), w.selectors...) }

func (w *ResourceWatch) list(lease *Lease) error {
	ctx := w.newAbort()
	items := newOmap[Object]()
	token, resourceVersion := "", ""
	for {
		query := append([]kv{{"limit", itoa(listPageSize)}}, w.selectorPairs()...)
		if token != "" {
			query = append(query, kv{"continue", token})
		}
		v, err := w.tx.requestJSON(ctx, lease.BaseURL, w.path+"?"+buildQuery(query), reqOpts{Timeout: listPageTimeout})
		if err != nil {
			if e, ok := asError(err); ok {
				switch e.KubeStatus {
				case 401, 403, 404:
					e.Fatal = true
				case 410:
					e.Gone = true
				}
			}
			return err
		}
		page := objOf(v)
		meta := objOf(page["metadata"])
		if resourceVersion == "" {
			resourceVersion = strOf(meta["resourceVersion"])
		}
		kind := strings.TrimSuffix(strOf(page["kind"]), "List")
		if kind == "" {
			kind = w.target.Kind
		}
		for _, raw := range listOf(page["items"]) {
			item := Sanitize(listItem(page, kind, objOf(raw)), w.secret)
			items.set(ItemKey(item), item)
		}
		token = strOf(meta["continue"])
		if token == "" || w.isStopped() {
			break
		}
	}
	if w.isStopped() {
		return nil
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.stopped {
		return nil
	}
	w.resourceVersion = resourceVersion
	if !w.synced {
		w.items = items
		w.synced = true
		snapshot := items.values()
		w.emit(func(l Listener) { l.Reset(snapshot, resourceVersion) })
	} else {
		var upserts []Object
		var deletes []string
		for _, key := range items.keys() {
			item, _ := items.get(key)
			old, ok := w.items.get(key)
			if !ok || strOf(objOf(old["metadata"])["resourceVersion"]) != strOf(objOf(item["metadata"])["resourceVersion"]) {
				upserts = append(upserts, item)
			}
		}
		for _, key := range w.items.keys() {
			if _, ok := items.get(key); !ok {
				deletes = append(deletes, key)
			}
		}
		w.items = items
		w.pendingUpserts.clear()
		w.pendingDeletes.clear()
		if len(upserts) > 0 || len(deletes) > 0 {
			w.emit(func(l Listener) { l.Changes(upserts, deletes) })
		}
	}
	if w.mode == "poll" {
		w.setStatus("polling", fmt.Sprintf("Watching is not permitted for this resource; refreshing every %ds.", int(w.tm.Poll/time.Second)), 0)
	} else {
		w.setStatus("live", "Receiving live updates", 0)
	}
	return nil
}

// listItem builds `{apiVersion: page.apiVersion, kind, ...raw}`.
func listItem(page Object, kind string, raw Object) Object {
	item := make(Object, len(raw)+2)
	if v := strOf(page["apiVersion"]); v != "" {
		item["apiVersion"] = v
	}
	item["kind"] = kind
	for k, v := range raw {
		item[k] = v
	}
	return item
}

func (w *ResourceWatch) watch(lease *Lease) error {
	abortCtx := w.newAbort()
	// A stream that stays silent past StreamIdle is abandoned and restarted from the last version.
	var idled atomic.Bool
	ctx, cancel := context.WithCancel(abortCtx)
	defer cancel()
	idle := time.AfterFunc(w.tm.StreamIdle, func() { idled.Store(true); cancel() })
	defer idle.Stop()
	w.mu.Lock()
	rv := w.resourceVersion
	w.mu.Unlock()
	query := append([]kv{{"watch", "1"}, {"resourceVersion", rv}, {"allowWatchBookmarks", "true"}, {"timeoutSeconds", itoa(watchTimeoutSeconds)}}, w.selectorPairs()...)
	resp, err := w.tx.open(ctx, lease.BaseURL, w.path+"?"+buildQuery(query), reqOpts{})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		data, err := readBody(ctx, resp.Body, 1024*1024)
		if err != nil {
			return err
		}
		body, ok := decodeJSON(data)
		if !ok {
			body = nil
		}
		e := statusError(resp.StatusCode, body, string(data))
		switch resp.StatusCode {
		case 410:
			e.Gone = true
		case 403:
			e.WatchForbidden = true
		case 401, 404:
			e.Fatal = true
		}
		return e
	}
	w.mu.Lock()
	w.setStatus("live", "Receiving live updates", 0)
	w.mu.Unlock()

	defer w.flush()

	var buffer bytes.Buffer
	chunk := make([]byte, 64*1024)
	for {
		n, readErr := resp.Body.Read(chunk)
		if n > 0 {
			idle.Reset(w.tm.StreamIdle)
			buffer.Write(chunk[:n])
			for {
				index := bytes.IndexByte(buffer.Bytes(), '\n')
				if index < 0 {
					break
				}
				line := bytes.TrimSpace(buffer.Next(index + 1))
				if len(line) == 0 {
					continue
				}
				value, ok := decodeJSON(line)
				if !ok {
					return newError("Invalid watch event: invalid JSON", 502)
				}
				if err := w.handleEvent(objOf(value)); err != nil {
					return err
				}
			}
			if buffer.Len() > eventLineLimit {
				return newError("A watch event exceeded the size limit", 502)
			}
		}
		if readErr == nil {
			continue
		}
		switch {
		case idled.Load():
			return nil
		case abortCtx.Err() != nil:
			return canceled()
		case errors.Is(readErr, io.EOF):
			return nil
		case errors.Is(readErr, io.ErrUnexpectedEOF):
			e := newError("Watch stream interrupted", 502)
			e.ConnectionLost = true
			return e
		}
		return connectionFailure(readErr)
	}
}

func intOf(v any) int {
	switch t := v.(type) {
	case json.Number:
		n, _ := t.Int64()
		return int(n)
	case float64:
		return int(t)
	case int:
		return t
	}
	return 0
}

// handleEvent applies one watch event. A returned error ends the stream.
func (w *ResourceWatch) handleEvent(event Object) error {
	typ := strOf(event["type"])
	object := objOf(event["object"])
	switch typ {
	case "BOOKMARK":
		if rv := strOf(objOf(object["metadata"])["resourceVersion"]); rv != "" {
			w.mu.Lock()
			w.resourceVersion = rv
			w.mu.Unlock()
		}
		return nil
	case "ERROR":
		code := intOf(object["code"])
		if code == 0 {
			code = 500
		}
		e := statusError(code, object, "")
		if code == 410 {
			e.Gone = true
		}
		return e
	}
	if objOf(object["metadata"]) == nil {
		return nil
	}
	item := Sanitize(object, w.secret || strOf(object["kind"]) == "Secret")
	key := ItemKey(item)
	w.mu.Lock()
	defer w.mu.Unlock()
	switch typ {
	case "ADDED", "MODIFIED":
		w.items.set(key, item)
		w.pendingDeletes.del(key)
		w.pendingUpserts.set(key, item)
	case "DELETED":
		w.items.del(key)
		w.pendingUpserts.del(key)
		w.pendingDeletes.set(key, struct{}{})
	default:
		return nil
	}
	if rv := strOf(objOf(item["metadata"])["resourceVersion"]); rv != "" {
		w.resourceVersion = rv
	}
	if w.flushTimer == nil && !w.stopped {
		w.flushTimer = time.AfterFunc(w.tm.Flush, w.flush)
	}
	return nil
}

func (w *ResourceWatch) flush() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.flushTimer != nil {
		w.flushTimer.Stop()
		w.flushTimer = nil
	}
	if w.pendingUpserts.len() == 0 && w.pendingDeletes.len() == 0 {
		return
	}
	upserts, deletes := w.pendingUpserts.values(), w.pendingDeletes.keys()
	w.pendingUpserts.clear()
	w.pendingDeletes.clear()
	w.emit(func(l Listener) { l.Changes(upserts, deletes) })
}

// snapshot is used by Stats.
func (w *ResourceWatch) snapshot() WatchStat {
	w.mu.Lock()
	defer w.mu.Unlock()
	return WatchStat{Context: w.context, Path: w.path, State: w.status.State, Listeners: len(w.listeners), Items: w.items.len()}
}

// WatchStat describes one shared watch.
type WatchStat struct {
	Context   string `json:"context"`
	Path      string `json:"path"`
	State     string `json:"state"`
	Listeners int    `json:"listeners"`
	Items     int    `json:"items"`
}
