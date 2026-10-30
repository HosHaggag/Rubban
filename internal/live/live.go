package live

import (
	"bytes"
	"context"
	"encoding/json"
	"sort"
	"strings"
	"sync"
	"time"
)

// Config tunes the live layer. Zero values select the defaults used in production; tests shorten them.
type Config struct {
	// Starter launches the per-context proxy.
	Starter ProxyStarter
	// ProxyIdle is how long an unused proxy lives (default 10 minutes).
	ProxyIdle time.Duration
	// ProxyStart is the start timeout (default 30 seconds).
	ProxyStart time.Duration
	// DiscoveryTTL is the discovery cache lifetime (default 5 minutes).
	DiscoveryTTL time.Duration
	// WatchLinger keeps a watch after its last subscriber left (default 2 minutes).
	WatchLinger time.Duration
	// StreamIdle restarts a silent watch stream (default 150 seconds).
	StreamIdle time.Duration
	// PollInterval is the LIST interval in poll mode (default 15 seconds).
	PollInterval time.Duration
	// FlushInterval coalesces watch events (default 150 ms).
	FlushInterval time.Duration
	// MaxBackoff caps the reconnect backoff (default 30 seconds).
	MaxBackoff time.Duration
}

// Live is the facade the backend uses.
type Live struct {
	pool      *Pool
	discovery *discoveryCache
	tx        *transport
	tm        timings
	root      context.Context
	cancel    context.CancelFunc

	mu      sync.Mutex
	watches map[string]*ResourceWatch
	closed  bool
}

// New creates the live layer.
func New(cfg Config) *Live {
	root, cancel := context.WithCancel(context.Background())
	tx := newTransport()
	pool := NewPool(cfg.Starter, cfg.ProxyIdle, cfg.ProxyStart)
	ttl := cfg.DiscoveryTTL
	if ttl <= 0 {
		ttl = 5 * time.Minute
	}
	return &Live{
		pool: pool, tx: tx, root: root, cancel: cancel, watches: map[string]*ResourceWatch{},
		discovery: newDiscoveryCache(root, pool, tx, ttl),
		tm:        timings{StreamIdle: cfg.StreamIdle, Linger: cfg.WatchLinger, Poll: cfg.PollInterval, Flush: cfg.FlushInterval, MaxBackoff: cfg.MaxBackoff}.withDefaults(),
	}
}

// Done is closed when the live layer closes.
func (l *Live) Done() <-chan struct{} { return l.root.Done() }

// ListOptions filters a list request.
type ListOptions struct{ LabelSelector, FieldSelector string }

// RawOptions tunes a raw API request.
type RawOptions struct {
	Accept  string        // Accept header (default application/json)
	Timeout time.Duration // 0 = 60 seconds
}

func (o ListOptions) pairs() []kv {
	var out []kv
	if o.LabelSelector != "" {
		out = append(out, kv{"labelSelector", o.LabelSelector})
	}
	if o.FieldSelector != "" {
		out = append(out, kv{"fieldSelector", o.FieldSelector})
	}
	return out
}

func (l *Live) withConnection(ctx context.Context, kubeContext string, fn func(*Lease) error) error {
	lease, err := l.pool.Acquire(ctx, kubeContext)
	if err != nil {
		return err
	}
	defer lease.Release()
	err = fn(lease)
	if e, ok := asError(err); ok && e.ConnectionLost {
		lease.Invalidate()
	}
	return err
}

func scopeOf(t Resource, namespace string) string {
	if t.Namespaced && namespace != "" && namespace != "*" {
		return namespace
	}
	return ""
}

func (l *Live) listAll(ctx context.Context, lease *Lease, path string, secret bool, fallbackKind string, selectors []kv) (Object, error) {
	items := []any{}
	token, resourceVersion := "", ""
	for {
		query := append([]kv{{"limit", itoa(listPageSize)}}, selectors...)
		if token != "" {
			query = append(query, kv{"continue", token})
		}
		v, err := l.tx.requestJSON(ctx, lease.BaseURL, path+"?"+buildQuery(query), reqOpts{Timeout: listPageTimeout})
		if err != nil {
			return nil, err
		}
		page := objOf(v)
		meta := objOf(page["metadata"])
		if resourceVersion == "" {
			resourceVersion = strOf(meta["resourceVersion"])
		}
		kind := strings.TrimSuffix(strOf(page["kind"]), "List")
		if kind == "" {
			kind = fallbackKind
		}
		for _, raw := range listOf(page["items"]) {
			items = append(items, Sanitize(listItem(page, kind, objOf(raw)), secret))
		}
		token = strOf(meta["continue"])
		if token == "" || ctx.Err() != nil {
			break
		}
	}
	return Object{"apiVersion": "v1", "kind": "List", "metadata": Object{"resourceVersion": resourceVersion}, "items": items}, nil
}

// List lists a resource (namespace "" or "*" = all namespaces) with every page, sanitised.
func (l *Live) List(ctx context.Context, kubeContext, resource, namespace string, o ListOptions) (Object, error) {
	target, err := l.discovery.resolve(ctx, kubeContext, resource)
	if err != nil {
		return nil, err
	}
	var out Object
	err = l.withConnection(ctx, kubeContext, func(lease *Lease) error {
		var err error
		out, err = l.listAll(ctx, lease, collectionPath(target, scopeOf(target, namespace)), isSecretTarget(target), target.Kind, o.pairs())
		return err
	})
	return out, err
}

func (l *Live) objectPath(ctx context.Context, kubeContext, resource, namespace, name string) (string, error) {
	target, err := l.discovery.resolve(ctx, kubeContext, resource)
	if err != nil {
		return "", err
	}
	scoped := ""
	if target.Namespaced {
		scoped = namespace
		if scoped == "" || scoped == "*" {
			scoped = "default"
		}
	}
	return collectionPath(target, scoped) + "/" + encodeURIComponent(name), nil
}

// Get reads one object without managedFields. Namespaced resources default to "default".
func (l *Live) Get(ctx context.Context, kubeContext, resource, namespace, name string) (Object, error) {
	path, err := l.objectPath(ctx, kubeContext, resource, namespace, name)
	if err != nil {
		return nil, err
	}
	var out any
	err = l.withConnection(ctx, kubeContext, func(lease *Lease) error {
		var err error
		out, err = l.tx.requestJSON(ctx, lease.BaseURL, path, reqOpts{})
		return err
	})
	if err != nil {
		return nil, err
	}
	return Sanitize(objOf(out), false), nil
}

// GetRaw reads one object and returns the API server's JSON with managedFields removed and key order
// preserved (the YAML view orders keys by source order).
func (l *Live) GetRaw(ctx context.Context, kubeContext, resource, namespace, name string) (json.RawMessage, error) {
	path, err := l.objectPath(ctx, kubeContext, resource, namespace, name)
	if err != nil {
		return nil, err
	}
	var raw json.RawMessage
	err = l.withConnection(ctx, kubeContext, func(lease *Lease) error {
		var err error
		raw, _, err = l.tx.requestRaw(ctx, lease.BaseURL, path, reqOpts{})
		return err
	})
	if err != nil {
		return nil, err
	}
	return StripManagedFields(raw), nil
}

// StripManagedFields removes metadata.managedFields from a JSON object without reordering keys.
// Input that is not a JSON object is returned unchanged.
func StripManagedFields(raw json.RawMessage) json.RawMessage {
	out, ok := rebuildObject(raw, func(key string, value json.RawMessage) (json.RawMessage, bool) {
		if key != "metadata" {
			return value, true
		}
		stripped, ok := rebuildObject(value, func(k string, v json.RawMessage) (json.RawMessage, bool) { return v, k != "managedFields" })
		if !ok {
			return value, true
		}
		return stripped, true
	})
	if !ok {
		return raw
	}
	return out
}

// rebuildObject re-emits a JSON object, passing each member through fn (which may drop it).
func rebuildObject(value json.RawMessage, fn func(key string, v json.RawMessage) (json.RawMessage, bool)) (json.RawMessage, bool) {
	dec := json.NewDecoder(bytes.NewReader(value))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return nil, false
	}
	var out bytes.Buffer
	out.WriteByte('{')
	first := true
	for dec.More() {
		keyTok, err := dec.Token()
		key, isString := keyTok.(string)
		if err != nil || !isString {
			return nil, false
		}
		var member json.RawMessage
		if err := dec.Decode(&member); err != nil {
			return nil, false
		}
		v, keep := fn(key, member)
		if !keep {
			continue
		}
		if !first {
			out.WriteByte(',')
		}
		first = false
		encodedKey, _ := json.Marshal(key)
		out.Write(encodedKey)
		out.WriteByte(':')
		out.Write(v)
	}
	out.WriteByte('}')
	return json.RawMessage(out.Bytes()), true
}

func (o RawOptions) reqOpts() reqOpts {
	r := reqOpts{Timeout: o.Timeout}
	if o.Accept != "" {
		r.Headers = map[string]string{"Accept": o.Accept}
	}
	return r
}

// Raw GETs an API path and decodes the JSON answer.
func (l *Live) Raw(ctx context.Context, kubeContext, apiPath string, o RawOptions) (any, error) {
	var out any
	err := l.withConnection(ctx, kubeContext, func(lease *Lease) error {
		var err error
		out, err = l.tx.requestJSON(ctx, lease.BaseURL, apiPath, o.reqOpts())
		return err
	})
	return out, err
}

// Do sends a request through the context's proxy and returns the JSON answer and its HTTP status.
// A non-nil body is sent as JSON.
func (l *Live) Do(ctx context.Context, kubeContext, method, apiPath string, body []byte, o RawOptions) (json.RawMessage, int, error) {
	opts := o.reqOpts()
	opts.Method = method
	if body != nil {
		opts.Body = body
		if opts.Headers == nil {
			opts.Headers = map[string]string{}
		}
		opts.Headers["Content-Type"] = "application/json"
	}
	var raw json.RawMessage
	var status int
	err := l.withConnection(ctx, kubeContext, func(lease *Lease) error {
		var err error
		raw, status, err = l.tx.requestRaw(ctx, lease.BaseURL, apiPath, opts)
		return err
	})
	return raw, status, err
}

// Discover returns the cached discovery for a context, sorted by group and name.
func (l *Live) Discover(ctx context.Context, kubeContext string, refresh bool) (*Discovery, error) {
	d, err := l.discovery.get(ctx, kubeContext, refresh)
	if err != nil {
		return nil, err
	}
	resources := append([]Resource{}, d.Resources...)
	sort.SliceStable(resources, func(i, j int) bool {
		return resources[i].Group+"/"+resources[i].Name < resources[j].Group+"/"+resources[j].Name
	})
	return &Discovery{Resources: resources, Warnings: d.Warnings}, nil
}

// WatchOptions tunes Watch.
type WatchOptions struct {
	Resync                       bool
	LabelSelector, FieldSelector string
}

// Watch subscribes a listener to the shared watch of a resource. The returned function unsubscribes;
// the stream lingers for a while after the last subscriber leaves.
func (l *Live) Watch(ctx context.Context, kubeContext, resource, namespace string, listener Listener, o WatchOptions) (func(), error) {
	target, err := l.discovery.resolve(ctx, kubeContext, resource)
	if err != nil {
		return nil, err
	}
	if !target.hasVerb("list") {
		return nil, newError(`The resource type "`+resource+`" cannot be listed`, 405)
	}
	scoped := scopeOf(target, namespace)
	selectors := ListOptions{LabelSelector: o.LabelSelector, FieldSelector: o.FieldSelector}.pairs()
	keyBytes, _ := json.Marshal([]any{kubeContext, target.Group, target.Version, target.Name, scoped, selectors2map(selectors)})
	key := string(keyBytes)
	for attempt := 0; attempt < 3; attempt++ {
		l.mu.Lock()
		if l.closed {
			l.mu.Unlock()
			return nil, newError("Backend is closed", 503)
		}
		entry := l.watches[key]
		created := false
		if entry == nil {
			entry = newResourceWatch(l.root, key, kubeContext, target, scoped, selectors, l.pool, l.tx, l.tm, func(stopped *ResourceWatch) {
				l.mu.Lock()
				if l.watches[key] == stopped {
					delete(l.watches, key)
				}
				l.mu.Unlock()
			})
			if !target.hasVerb("watch") {
				entry.mode = "poll"
			}
			l.watches[key] = entry
			created = true
		}
		l.mu.Unlock()
		if !created && o.Resync {
			entry.resync()
		}
		if unsubscribe, ok := entry.subscribe(listener); ok {
			return unsubscribe, nil
		}
	}
	return nil, newError("Unable to start the watch", 502)
}

func selectors2map(pairs []kv) map[string]string {
	m := map[string]string{}
	for _, p := range pairs {
		m[p.k] = p.v
	}
	return m
}

// Close stops every watch and proxy.
func (l *Live) Close() {
	if l == nil {
		return
	}
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return
	}
	l.closed = true
	watches := make([]*ResourceWatch, 0, len(l.watches))
	for _, w := range l.watches {
		watches = append(watches, w)
	}
	l.mu.Unlock()
	for _, w := range watches {
		w.stop()
	}
	l.cancel()
	l.pool.Close()
	l.tx.close()
}

// Stats describes the live layer for diagnostics.
type Stats struct {
	Proxies []ProxyStat `json:"proxies"`
	Watches []WatchStat `json:"watches"`
}

// Stats reports the proxies and watches.
func (l *Live) Stats() Stats {
	l.mu.Lock()
	watches := make([]*ResourceWatch, 0, len(l.watches))
	for _, w := range l.watches {
		watches = append(watches, w)
	}
	l.mu.Unlock()
	out := Stats{Proxies: l.pool.Stats(), Watches: []WatchStat{}}
	for _, w := range watches {
		out.Watches = append(out.Watches, w.snapshot())
	}
	return out
}
