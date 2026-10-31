package server

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Global search: GET /api/search finds resources by name (and the app labels) in one cluster. The UI asks
// once per cluster that has a tab open, so Ctrl+K reaches pods, deployments and services everywhere.

const (
	searchMinLen   = 2
	searchMaxLen   = 64
	searchMaxLimit = 50
	searchDefault  = 20
	searchIndexTTL = 20 * time.Second
	searchParallel = 6
)

// searchKind is a resource the search looks through, in result order.
type searchKind struct {
	resource string
	kind     string
}

var searchKinds = []searchKind{
	{"pods", "Pod"}, {"deployments", "Deployment"}, {"statefulsets", "StatefulSet"}, {"daemonsets", "DaemonSet"},
	{"jobs", "Job"}, {"cronjobs", "CronJob"}, {"services", "Service"}, {"ingresses", "Ingress"},
	{"configmaps", "ConfigMap"}, {"secrets", "Secret"}, {"persistentvolumeclaims", "PersistentVolumeClaim"},
	{"namespaces", "Namespace"}, {"nodes", "Node"},
}

var argoSearchKind = searchKind{"applications.argoproj.io", "Application"}

// searchEntry is the small, secret-free record kept per object: names and one status word, never the
// object itself (a Secret's data is never copied).
type searchEntry struct {
	Resource  string `json:"resource"`
	Kind      string `json:"kind"`
	Namespace string `json:"namespace,omitempty"`
	Name      string `json:"name"`
	App       string `json:"app,omitempty"`
	Status    string `json:"status,omitempty"`
}

type kindIndex struct {
	mu      sync.Mutex
	at      time.Time
	entries []searchEntry
}

type searchIndex struct {
	mu sync.Mutex
	m  map[string]*kindIndex
}

// searchNow is replaced in tests to age the index.
var searchNow = time.Now

func (s *searchIndex) slot(key string) *kindIndex {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.m == nil {
		s.m = map[string]*kindIndex{}
	}
	if s.m[key] == nil {
		s.m[key] = &kindIndex{}
	}
	return s.m[key]
}

func ratio(have, want any) string { return fmt.Sprintf("%s/%s", numString(have), numString(want)) }

func numString(v any) string {
	switch t := v.(type) {
	case float64:
		return fmt.Sprintf("%d", int64(t))
	case int64:
		return fmt.Sprintf("%d", t)
	case int:
		return fmt.Sprintf("%d", t)
	case interface{ String() string }:
		return t.String()
	}
	return "0"
}

func conditionTrue(item obj, kind string) bool {
	for _, c := range listOf(objOf(item["status"])["conditions"]) {
		cond := objOf(c)
		if strOf(cond["type"]) == kind {
			return strOf(cond["status"]) == "True"
		}
	}
	return false
}

// searchStatus is the short status text of a search result.
func searchStatus(resource string, item obj) string {
	status := objOf(item["status"])
	spec := objOf(item["spec"])
	switch resource {
	case "pods":
		phase := strOf(status["phase"])
		statuses := listOf(status["containerStatuses"])
		if len(statuses) == 0 {
			return phase
		}
		ready := 0
		for _, cs := range statuses {
			if r, _ := objOf(cs)["ready"].(bool); r {
				ready++
			}
		}
		return fmt.Sprintf("%s %d/%d", phase, ready, len(statuses))
	case "deployments", "statefulsets":
		want := spec["replicas"]
		if want == nil {
			want = 1.0
		}
		return ratio(orZero(status["readyReplicas"]), want) + " ready"
	case "daemonsets":
		return ratio(orZero(status["numberReady"]), orZero(status["desiredNumberScheduled"])) + " ready"
	case "jobs":
		if conditionTrue(item, "Failed") {
			return "Failed"
		}
		if conditionTrue(item, "Complete") {
			return "Complete"
		}
		return "Running"
	case "cronjobs":
		if s, _ := spec["suspend"].(bool); s {
			return "Suspended"
		}
		return "Scheduled"
	case "persistentvolumeclaims", "namespaces":
		return strOf(status["phase"])
	case "nodes":
		if conditionTrue(item, "Ready") {
			return "Ready"
		}
		return "NotReady"
	case "applications.argoproj.io":
		syncState, health := strOf(objOf(status["sync"])["status"]), strOf(objOf(status["health"])["status"])
		return strings.TrimSpace(health + " " + syncState)
	}
	return ""
}

func orZero(v any) any {
	if v == nil {
		return 0.0
	}
	return v
}

func entriesOf(k searchKind, doc obj) []searchEntry {
	var out []searchEntry
	for _, it := range listOf(doc["items"]) {
		item := objOf(it)
		meta := objOf(item["metadata"])
		name := strOf(meta["name"])
		if name == "" {
			continue
		}
		labels := objOf(meta["labels"])
		app := strOf(labels["app"])
		if app == "" {
			app = strOf(labels["app.kubernetes.io/name"])
		}
		out = append(out, searchEntry{Resource: k.resource, Kind: k.kind, Namespace: strOf(meta["namespace"]), Name: name, App: app, Status: searchStatus(k.resource, item)})
	}
	return out
}

// indexOf returns the (at most 20 s old) name index of one kind. Concurrent callers share one list.
func (b *Backend) indexOf(ctx context.Context, kubeContext string, k searchKind) ([]searchEntry, error) {
	slot := b.search.slot(kubeContext + "\x00" + k.resource)
	slot.mu.Lock()
	defer slot.mu.Unlock()
	if !slot.at.IsZero() && searchNow().Sub(slot.at) < searchIndexTTL {
		return slot.entries, nil
	}
	doc, err := b.listObjects(ctx, kubeContext, k.resource, "*", ListOptions{})
	if err != nil {
		return nil, err
	}
	slot.entries, slot.at = entriesOf(k, doc), searchNow()
	return slot.entries, nil
}

// matchRank is 0 for a prefix, 1 for the start of a word (after - _ . / : or a space), 2 for any other
// substring, and -1 for no match. Both sides are lower-case.
func matchRank(text, needle string) int {
	rank := -1
	for from := 0; from < len(text); {
		i := strings.Index(text[from:], needle)
		if i < 0 {
			break
		}
		at := from + i
		switch {
		case at == 0:
			return 0
		case strings.ContainsRune("-_./: ", rune(text[at-1])):
			rank = 1
		case rank < 0:
			rank = 2
		}
		from = at + 1
	}
	return rank
}

// rankEntry scores an entry (lower is better): a name match beats a label match of the same quality.
func rankEntry(e searchEntry, needle string) int {
	best := -1
	if r := matchRank(strings.ToLower(e.Name), needle); r >= 0 {
		best = r * 2
	}
	if e.App != "" {
		if r := matchRank(strings.ToLower(e.App), needle); r >= 0 && (best < 0 || r*2+1 < best) {
			best = r*2 + 1
		}
	}
	return best
}

type searchHit struct {
	entry searchEntry
	rank  int
	order int // position of the kind in searchKinds
}

// searchEntries ranks matches: prefix, then word boundary, then substring; shorter names first; then
// kind order and name. It returns at most limit of them and whether more matched.
func searchEntries(entries [][]searchEntry, query string, limit int) ([]searchEntry, bool) {
	needle := strings.ToLower(strings.TrimSpace(query))
	var hits []searchHit
	for order, list := range entries {
		for _, e := range list {
			if r := rankEntry(e, needle); r >= 0 {
				hits = append(hits, searchHit{e, r, order})
			}
		}
	}
	sort.SliceStable(hits, func(i, j int) bool {
		a, b := hits[i], hits[j]
		if a.rank != b.rank {
			return a.rank < b.rank
		}
		if len(a.entry.Name) != len(b.entry.Name) {
			return len(a.entry.Name) < len(b.entry.Name)
		}
		if a.order != b.order {
			return a.order < b.order
		}
		if a.entry.Name != b.entry.Name {
			return a.entry.Name < b.entry.Name
		}
		return a.entry.Namespace < b.entry.Namespace
	})
	truncated := len(hits) > limit
	if truncated {
		hits = hits[:limit]
	}
	out := make([]searchEntry, 0, len(hits))
	for _, h := range hits {
		out = append(out, h.entry)
	}
	return out, truncated
}

func (b *Backend) routeSearch(q *request) (any, int, error) {
	kubeContext, err := validateText(q.q("context"), "context")
	if err != nil {
		return nil, 0, err
	}
	query, err := validateText(q.q("q"), "search text")
	if err != nil {
		return nil, 0, err
	}
	if n := utf8.RuneCountInString(strings.TrimSpace(query)); n < searchMinLen || n > searchMaxLen {
		return nil, 0, bad(fmt.Sprintf("Search text must be %d to %d characters", searchMinLen, searchMaxLen))
	}
	limit, err := integer(q.q("limit"), "limit", 1, searchMaxLimit, fb(searchDefault))
	if err != nil {
		return nil, 0, err
	}
	kinds := append([]searchKind{}, searchKinds...)
	if b.hasArgoCD(q.ctx, kubeContext) {
		kinds = append(kinds, argoSearchKind)
	}
	lists := make([][]searchEntry, len(kinds))
	errs := make([]error, len(kinds))
	sem := make(chan struct{}, searchParallel)
	var wg sync.WaitGroup
	for i, k := range kinds {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			lists[i], errs[i] = b.indexOf(q.ctx, kubeContext, k)
		}()
	}
	wg.Wait()
	failed, first := 0, error(nil)
	for _, e := range errs {
		if e != nil {
			failed++
			if first == nil {
				first = e
			}
		}
	}
	// A kind that cannot be listed (RBAC, a missing CRD) is skipped; nothing to search is an error.
	if failed == len(kinds) {
		return nil, 0, first
	}
	results, truncated := searchEntries(lists, query, int(limit))
	return obj{"results": results, "truncated": truncated}, 200, nil
}

func init() {
	registerRoutes(func(b *Backend, q *request) (any, int, bool, error) {
		if q.method != "GET" || q.route != "/api/search" {
			return nil, 0, false, nil
		}
		v, status, err := b.routeSearch(q)
		return v, status, true, err
	})
}
