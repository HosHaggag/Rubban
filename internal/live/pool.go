package live

import (
	"context"
	"errors"
	"sync"
	"time"
)

// Proxy is a running connection to one cluster's API server (normally a `kubectl proxy` process).
type Proxy interface {
	// BaseURL is the API root, for example http://127.0.0.1:8001/rubban-<hex> (no trailing slash).
	BaseURL() string
	// Stop ends the connection. It may be called more than once.
	Stop()
	// Done is closed when the connection ends on its own. It may return nil.
	Done() <-chan struct{}
}

// ProxyStarter launches a Proxy for a kubeconfig context. Start returns once the proxy accepts requests
// or fails; ctx carries the start timeout and must not bound the proxy's lifetime.
type ProxyStarter interface {
	Start(ctx context.Context, kubeContext string) (Proxy, error)
}

// StarterFunc adapts a function to ProxyStarter.
type StarterFunc func(ctx context.Context, kubeContext string) (Proxy, error)

// Start implements ProxyStarter.
func (f StarterFunc) Start(ctx context.Context, kubeContext string) (Proxy, error) {
	return f(ctx, kubeContext)
}

type poolEntry struct {
	context  string
	users    int
	lastUsed time.Time
	ready    chan struct{}
	conn     Proxy
	err      error
}

// Pool keeps one proxy per context with reference-counted leases and an idle sweep.
type Pool struct {
	starter ProxyStarter
	idle    time.Duration
	start   time.Duration

	mu      sync.Mutex
	entries map[string]*poolEntry
	closed  bool
	stop    chan struct{}
}

// NewPool creates a pool. Zero durations use the defaults (10 minutes idle, 30 seconds to start).
func NewPool(starter ProxyStarter, idle, startTimeout time.Duration) *Pool {
	if idle <= 0 {
		idle = 10 * time.Minute
	}
	if startTimeout <= 0 {
		startTimeout = 30 * time.Second
	}
	p := &Pool{starter: starter, idle: idle, start: startTimeout, entries: map[string]*poolEntry{}, stop: make(chan struct{})}
	interval := 30 * time.Second
	if idle < interval {
		interval = idle
	}
	go p.sweeper(interval)
	return p
}

// Lease is a reference to a pool connection. Release it when the work is done; Invalidate it when the
// connection turned out to be broken so the next Acquire relaunches the proxy.
type Lease struct {
	BaseURL string

	pool  *Pool
	entry *poolEntry
	once  sync.Once
}

// Release drops the reference. It is safe to call more than once.
func (l *Lease) Release() {
	if l == nil {
		return
	}
	l.once.Do(func() {
		l.pool.mu.Lock()
		l.entry.users--
		l.entry.lastUsed = time.Now()
		l.pool.mu.Unlock()
	})
}

// Invalidate discards the connection.
func (l *Lease) Invalidate() {
	if l == nil {
		return
	}
	l.pool.invalidate(l.entry)
}

// Acquire returns a lease on the context's proxy, starting it when needed. Concurrent callers share
// one start. A failed start is reported to every waiter and not cached.
func (p *Pool) Acquire(ctx context.Context, kubeContext string) (*Lease, error) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil, newError("Backend is closed", 503)
	}
	e := p.entries[kubeContext]
	if e == nil {
		e = &poolEntry{context: kubeContext, ready: make(chan struct{})}
		p.entries[kubeContext] = e
		go p.launch(e)
	}
	e.users++
	e.lastUsed = time.Now()
	p.mu.Unlock()
	lease := &Lease{pool: p, entry: e}
	select {
	case <-e.ready:
	case <-ctx.Done():
		lease.Release()
		return nil, canceled()
	}
	if e.err != nil {
		lease.Release()
		return nil, e.err
	}
	lease.BaseURL = e.conn.BaseURL()
	return lease, nil
}

func (p *Pool) launch(e *poolEntry) {
	ctx, cancel := context.WithTimeout(context.Background(), p.start)
	conn, err := p.starter.Start(ctx, e.context)
	timedOut := ctx.Err() != nil && errors.Is(ctx.Err(), context.DeadlineExceeded)
	cancel()
	p.mu.Lock()
	if err != nil {
		var le *Error
		if ok := errors.As(err, &le); ok {
			copied := *le
			le = &copied
		} else if timedOut {
			le = newError("Timed out starting the cluster connection", 504)
		} else {
			le = newError("Unable to start kubectl proxy: "+err.Error(), 503)
		}
		le.ProxyUnavailable = true
		e.err = le
		if p.entries[e.context] == e {
			delete(p.entries, e.context)
		}
		p.mu.Unlock()
		close(e.ready)
		return
	}
	e.conn = conn
	closed := p.closed
	p.mu.Unlock()
	if closed {
		conn.Stop()
	}
	close(e.ready)
	if done := conn.Done(); done != nil {
		go func() {
			select {
			case <-done:
				p.mu.Lock()
				if p.entries[e.context] == e {
					delete(p.entries, e.context)
				}
				p.mu.Unlock()
			case <-p.stop:
			}
		}()
	}
}

func (p *Pool) invalidate(e *poolEntry) {
	p.mu.Lock()
	if p.entries[e.context] == e {
		delete(p.entries, e.context)
	}
	conn := e.conn
	p.mu.Unlock()
	if conn != nil {
		conn.Stop()
	}
}

func (p *Pool) sweeper(interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			p.sweep()
		case <-p.stop:
			return
		}
	}
}

func (p *Pool) sweep() {
	now := time.Now()
	var idle []*poolEntry
	p.mu.Lock()
	for _, e := range p.entries {
		if e.users <= 0 && e.conn != nil && now.Sub(e.lastUsed) > p.idle {
			idle = append(idle, e)
		}
	}
	p.mu.Unlock()
	for _, e := range idle {
		p.invalidate(e)
	}
}

// Close stops every proxy and refuses further leases.
func (p *Pool) Close() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	close(p.stop)
	var conns []Proxy
	for _, e := range p.entries {
		if e.conn != nil {
			conns = append(conns, e.conn)
		}
	}
	p.entries = map[string]*poolEntry{}
	p.mu.Unlock()
	for _, c := range conns {
		c.Stop()
	}
}

// ProxyStat describes one pool entry.
type ProxyStat struct {
	Context string `json:"context"`
	Users   int    `json:"users"`
	Ready   bool   `json:"ready"`
}

// Stats lists the pool's entries.
func (p *Pool) Stats() []ProxyStat {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]ProxyStat, 0, len(p.entries))
	for _, e := range p.entries {
		out = append(out, ProxyStat{Context: e.context, Users: e.users, Ready: e.conn != nil})
	}
	return out
}
