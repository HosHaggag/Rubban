package live

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"
)

const aggregatedAccept = "application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList,application/json"

var groupVersionRE = regexp.MustCompile(`^[a-z0-9.-]+/v[a-z0-9]+$`)

// Resource is one served resource type (subresources are excluded).
type Resource struct {
	Name       string   `json:"name"`
	Kind       string   `json:"kind"`
	Namespaced bool     `json:"namespaced"`
	Group      string   `json:"group"`
	Version    string   `json:"version"`
	Verbs      []string `json:"verbs"`
	ShortNames []string `json:"shortNames"`
	Singular   string   `json:"singular"`
	Priority   int      `json:"priority"`
}

// Discovery is the result of API discovery for one context.
type Discovery struct {
	Resources []Resource `json:"resources"`
	Warnings  []string   `json:"warnings"`
}

func (r Resource) hasVerb(verb string) bool {
	for _, v := range r.Verbs {
		if v == verb {
			return true
		}
	}
	return false
}

func stringList(v any) []string {
	out := []string{}
	for _, s := range listOf(v) {
		if t, ok := s.(string); ok {
			out = append(out, t)
		}
	}
	return out
}

func discoveryFromAggregated(list Object, resources *[]Resource, nextPriority func() int) {
	for _, g := range listOf(list["items"]) {
		group := objOf(g)
		name := strOf(objOf(group["metadata"])["name"])
		versions := listOf(group["versions"])
		if len(versions) == 0 {
			continue
		}
		version := objOf(versions[0])
		priority := nextPriority()
		for _, rr := range listOf(version["resources"]) {
			r := objOf(rr)
			resource := strOf(r["resource"])
			if resource == "" || strings.Contains(resource, "/") {
				continue
			}
			*resources = append(*resources, Resource{
				Name: resource, Kind: strOf(objOf(r["responseKind"])["kind"]), Namespaced: strOf(r["scope"]) == "Namespaced",
				Group: name, Version: strOf(version["version"]), Verbs: stringList(r["verbs"]), ShortNames: stringList(r["shortNames"]),
				Singular: strOf(r["singularResource"]), Priority: priority,
			})
		}
	}
}

func discoveryFromLegacy(document Object, group, version string, priority int, resources *[]Resource) {
	for _, rr := range listOf(document["resources"]) {
		r := objOf(rr)
		name := strOf(r["name"])
		if name == "" || strings.Contains(name, "/") {
			continue
		}
		namespaced, _ := r["namespaced"].(bool)
		*resources = append(*resources, Resource{
			Name: name, Kind: strOf(r["kind"]), Namespaced: namespaced, Group: group, Version: version,
			Verbs: stringList(r["verbs"]), ShortNames: stringList(r["shortNames"]), Singular: strOf(r["singularName"]), Priority: priority,
		})
	}
}

type jsonResult struct {
	value Object
	err   error
}

func (t *transport) requestObject(ctx context.Context, baseURL, apiPath string, headers map[string]string) jsonResult {
	v, err := t.requestJSON(ctx, baseURL, apiPath, reqOpts{Headers: headers})
	if err != nil {
		return jsonResult{err: err}
	}
	return jsonResult{value: objOf(v)}
}

func errText(err error) string { return err.Error() }

func fetchDiscovery(ctx context.Context, t *transport, baseURL string) (*Discovery, error) {
	var resources []Resource
	warnings := []string{}
	priority := 0
	nextPriority := func() int { p := priority; priority++; return p }
	headers := map[string]string{"Accept": aggregatedAccept}
	var core, groups jsonResult
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); core = t.requestObject(ctx, baseURL, "/api", headers) }()
	go func() { defer wg.Done(); groups = t.requestObject(ctx, baseURL, "/apis", headers) }()
	wg.Wait()

	switch {
	case core.err != nil:
		warnings = append(warnings, "Core discovery: "+errText(core.err))
	case core.value["kind"] == "APIGroupDiscoveryList":
		discoveryFromAggregated(core.value, &resources, nextPriority)
	default:
		legacy := t.requestObject(ctx, baseURL, "/api/v1", nil)
		if legacy.err != nil {
			warnings = append(warnings, "Core discovery: "+errText(legacy.err))
		} else {
			discoveryFromLegacy(legacy.value, "", "v1", nextPriority(), &resources)
		}
	}

	switch {
	case groups.err != nil:
		warnings = append(warnings, "API group discovery: "+errText(groups.err))
	case groups.value["kind"] == "APIGroupDiscoveryList":
		discoveryFromAggregated(groups.value, &resources, nextPriority)
	default:
		type groupVersion struct {
			gv       string
			priority int
		}
		var versions []groupVersion
		for _, g := range listOf(groups.value["groups"]) {
			if gv := strOf(objOf(objOf(g)["preferredVersion"])["groupVersion"]); gv != "" {
				versions = append(versions, groupVersion{gv, nextPriority()})
			}
		}
		var mu sync.Mutex
		next := 0
		workers := 8
		if len(versions) < workers {
			workers = len(versions)
		}
		var group sync.WaitGroup
		for i := 0; i < workers; i++ {
			group.Add(1)
			go func() {
				defer group.Done()
				for {
					mu.Lock()
					if next >= len(versions) || ctx.Err() != nil {
						mu.Unlock()
						return
					}
					item := versions[next]
					next++
					mu.Unlock()
					if !groupVersionRE.MatchString(item.gv) {
						mu.Lock()
						warnings = append(warnings, "Skipped malformed API group version")
						mu.Unlock()
						continue
					}
					res := t.requestObject(ctx, baseURL, "/apis/"+item.gv, nil)
					mu.Lock()
					if res.err != nil {
						warnings = append(warnings, fmt.Sprintf("%s: %s", item.gv, errText(res.err)))
					} else {
						parts := strings.SplitN(item.gv, "/", 2)
						discoveryFromLegacy(res.value, parts[0], parts[1], item.priority, &resources)
					}
					mu.Unlock()
				}
			}()
		}
		group.Wait()
	}

	if len(resources) == 0 && len(warnings) > 0 {
		e := newError("Kubernetes discovery unavailable: "+strings.Join(warnings, "; "), 502)
		// A dropped proxy must be replaced, so carry the loss through to the pool.
		for _, r := range []jsonResult{core, groups} {
			if le, ok := asError(r.err); ok && le.ConnectionLost {
				e.ConnectionLost = true
			}
		}
		return nil, e
	}
	if resources == nil {
		resources = []Resource{}
	}
	return &Discovery{Resources: resources, Warnings: warnings}, nil
}

// ResolveResource finds the served resource a name refers to. Scoring: `name.group` or
// `name.version.group` (core: `name.version`) exactly = 0; the exact plural = 1000 + priority;
// singular, kind or a short name = 100000 + priority. The lowest score wins; nil when nothing matches.
func ResolveResource(resources []Resource, value string) *Resource {
	id := strings.ToLower(value)
	var best *Resource
	bestScore := -1
	for i := range resources {
		r := &resources[i]
		score := -1
		switch {
		case r.Group != "" && (id == r.Name+"."+r.Group || id == r.Name+"."+r.Version+"."+r.Group):
			score = 0
		case r.Group == "" && id == r.Name+"."+r.Version:
			score = 0
		case id == r.Name:
			score = 1000 + r.Priority
		default:
			names := append([]string{r.Name, r.Singular, strings.ToLower(r.Kind)}, r.ShortNames...)
			for _, n := range names {
				if n != "" && n == id {
					score = 100000 + r.Priority
					break
				}
			}
		}
		if score >= 0 && (bestScore < 0 || score < bestScore) {
			best, bestScore = r, score
		}
	}
	return best
}

type discoveryEntry struct {
	at     time.Time
	done   chan struct{}
	result *Discovery
	err    error
}

// discoveryCache caches discovery per context for a TTL. Concurrent callers share one fetch.
type discoveryCache struct {
	pool *Pool
	tx   *transport
	ttl  time.Duration
	root context.Context

	mu sync.Mutex
	m  map[string]*discoveryEntry
}

func newDiscoveryCache(root context.Context, pool *Pool, tx *transport, ttl time.Duration) *discoveryCache {
	return &discoveryCache{pool: pool, tx: tx, ttl: ttl, root: root, m: map[string]*discoveryEntry{}}
}

func (c *discoveryCache) get(ctx context.Context, kubeContext string, refresh bool) (*Discovery, error) {
	c.mu.Lock()
	e := c.m[kubeContext]
	if e == nil || refresh || time.Since(e.at) >= c.ttl {
		e = &discoveryEntry{at: time.Now(), done: make(chan struct{})}
		c.m[kubeContext] = e
		go c.fetch(kubeContext, e)
	}
	c.mu.Unlock()
	select {
	case <-e.done:
		return e.result, e.err
	case <-ctx.Done():
		return nil, canceled()
	}
}

func (c *discoveryCache) fetch(kubeContext string, e *discoveryEntry) {
	result, err := func() (*Discovery, error) {
		lease, err := c.pool.Acquire(c.root, kubeContext)
		if err != nil {
			return nil, err
		}
		defer lease.Release()
		result, err := fetchDiscovery(c.root, c.tx, lease.BaseURL)
		if le, ok := asError(err); ok && le.ConnectionLost {
			lease.Invalidate()
		}
		return result, err
	}()
	c.mu.Lock()
	e.result, e.err = result, err
	if err != nil && c.m[kubeContext] == e {
		delete(c.m, kubeContext)
	}
	c.mu.Unlock()
	close(e.done)
}

// resolve finds the resource a name refers to, refreshing discovery once when it is unknown.
func (c *discoveryCache) resolve(ctx context.Context, kubeContext, resource string) (Resource, error) {
	d, err := c.get(ctx, kubeContext, false)
	if err != nil {
		return Resource{}, err
	}
	target := ResolveResource(d.Resources, resource)
	if target == nil {
		if d, err = c.get(ctx, kubeContext, true); err != nil {
			return Resource{}, err
		}
		target = ResolveResource(d.Resources, resource)
	}
	if target == nil {
		return Resource{}, newError(`This cluster does not serve the resource type "`+resource+`"`, 404)
	}
	return *target, nil
}
