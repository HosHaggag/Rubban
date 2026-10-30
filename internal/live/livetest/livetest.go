// Package livetest is a small in-memory Kubernetes API for tests: aggregated (or legacy) discovery,
// paginated lists, streaming watches with bookmarks and 410 errors, and a pod eviction endpoint. It
// stands in for the per-context kubectl proxy so the real HTTP transport is exercised without a cluster.
package livetest

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// Object is a Kubernetes object.
type Object = map[string]any

type event struct {
	Type   string `json:"type"`
	Object Object `json:"object"`
}

type watcher struct {
	kind      string
	namespace string
	from      int
	lines     chan []byte
	drop      chan struct{}
	once      sync.Once
}

func (w *watcher) close() { w.once.Do(func() { close(w.drop) }) }

type failure struct{ status, remaining int }

type resourceInfo struct{ kind, prefix, group string }

var resources = map[string]resourceInfo{
	"configmaps":  {"ConfigMap", "/api/v1", ""},
	"secrets":     {"Secret", "/api/v1", ""},
	"events":      {"Event", "/api/v1", ""},
	"namespaces":  {"Namespace", "/api/v1", ""},
	"deployments": {"Deployment", "/apis/apps/v1", "apps"},
}

var pathRE = regexp.MustCompile(`^(/api/v1|/apis/apps/v1)/(?:namespaces/([^/]+)/)?(configmaps|secrets|events|namespaces|deployments)(?:/([^/]+))?$`)
var evictRE = regexp.MustCompile(`^/api/v1/namespaces/([^/]+)/pods/([^/]+)/eviction$`)

// Server is the fake API server.
type Server struct {
	*httptest.Server

	mu       sync.Mutex
	store    map[string]Object
	watchers map[*watcher]struct{}
	history  []event
	requests []string
	posts    []string
	rv       int

	goneOnNextWatch bool
	forbidden       map[string]bool // plural -> every request is 403
	forbidWatch     map[string]bool // plural -> only watch requests are 403
	failNext        map[string]failure
	legacy          bool
	evictStatus     int
	pageSize        int
}

// New starts the server.
func New() *Server {
	s := &Server{store: map[string]Object{}, watchers: map[*watcher]struct{}{}, rv: 100,
		forbidden: map[string]bool{}, forbidWatch: map[string]bool{}, failNext: map[string]failure{}, pageSize: 2}
	s.Server = httptest.NewServer(http.HandlerFunc(s.handle))
	return s
}

// BaseURL is the API root (what the kubectl proxy's base URL would be).
func (s *Server) BaseURL() string { return s.URL }

func keyOf(o Object) string {
	meta, _ := o["metadata"].(Object)
	ns, _ := meta["namespace"].(string)
	name, _ := meta["name"].(string)
	return fmt.Sprintf("%v/%s/%s", o["kind"], ns, name)
}

func send(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func discoveryResource(name, kind, scope string, verbs []any, group string) Object {
	return Object{"resource": name, "responseKind": Object{"group": group, "version": "v1", "kind": kind}, "scope": scope,
		"singularResource": strings.ToLower(kind), "verbs": verbs}
}

func (s *Server) handle(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	s.requests = append(s.requests, r.URL.Path+rawSuffix(r))
	legacy := s.legacy
	s.mu.Unlock()
	path := r.URL.Path
	verbs := []any{"get", "list", "watch", "create", "delete"}
	if m := evictRE.FindStringSubmatch(path); m != nil && r.Method == http.MethodPost {
		body, _ := io.ReadAll(r.Body)
		s.mu.Lock()
		s.posts = append(s.posts, path+" "+string(body))
		status := s.evictStatus
		s.mu.Unlock()
		if status == 0 {
			status = 201
		}
		if status >= 400 {
			send(w, status, Object{"kind": "Status", "code": status, "reason": "TooManyRequests", "message": "Cannot evict pod as it would violate the pod's disruption budget."})
			return
		}
		send(w, status, Object{"kind": "Status", "apiVersion": "v1", "status": "Success"})
		return
	}
	switch path {
	case "/api":
		if legacy {
			send(w, 200, Object{"kind": "APIVersions", "versions": []any{"v1"}})
			return
		}
		send(w, 200, Object{"kind": "APIGroupDiscoveryList", "apiVersion": "apidiscovery.k8s.io/v2", "items": []any{
			Object{"metadata": Object{}, "versions": []any{Object{"version": "v1", "resources": []any{
				discoveryResource("configmaps", "ConfigMap", "Namespaced", verbs, ""),
				discoveryResource("secrets", "Secret", "Namespaced", verbs, ""),
				discoveryResource("events", "Event", "Namespaced", verbs, ""),
				discoveryResource("namespaces", "Namespace", "Cluster", verbs, ""),
				discoveryResource("pods", "Pod", "Namespaced", verbs, ""),
			}}}}}})
		return
	case "/apis":
		if legacy {
			send(w, 200, Object{"kind": "APIGroupList", "groups": []any{
				Object{"name": "apps", "preferredVersion": Object{"groupVersion": "apps/v1"}},
				Object{"name": "bad", "preferredVersion": Object{"groupVersion": "BAD GROUP/v1"}},
			}})
			return
		}
		deployments := discoveryResource("deployments", "Deployment", "Namespaced", verbs, "apps")
		deployments["shortNames"] = []any{"deploy"}
		send(w, 200, Object{"kind": "APIGroupDiscoveryList", "apiVersion": "apidiscovery.k8s.io/v2", "items": []any{
			Object{"metadata": Object{"name": "apps"}, "versions": []any{Object{"version": "v1", "resources": []any{deployments}}}},
			Object{"metadata": Object{"name": "events.k8s.io"}, "versions": []any{Object{"version": "v1", "resources": []any{discoveryResource("events", "Event", "Namespaced", verbs, "events.k8s.io")}}}},
		}})
		return
	case "/api/v1":
		if legacy {
			send(w, 200, Object{"kind": "APIResourceList", "groupVersion": "v1", "resources": []any{
				Object{"name": "configmaps", "kind": "ConfigMap", "namespaced": true, "verbs": verbs, "singularName": "configmap"},
				Object{"name": "pods", "kind": "Pod", "namespaced": true, "verbs": verbs, "singularName": "pod", "shortNames": []any{"po"}},
				Object{"name": "pods/log", "kind": "Pod", "namespaced": true, "verbs": []any{"get"}},
			}})
			return
		}
	case "/apis/apps/v1":
		if legacy {
			send(w, 200, Object{"kind": "APIResourceList", "groupVersion": "apps/v1", "resources": []any{
				Object{"name": "deployments", "kind": "Deployment", "namespaced": true, "verbs": verbs, "singularName": "deployment", "shortNames": []any{"deploy"}},
			}})
			return
		}
	}
	m := pathRE.FindStringSubmatch(path)
	if m == nil {
		send(w, 404, Object{"kind": "Status", "code": 404, "message": "the server could not find the requested resource"})
		return
	}
	prefix, namespace, plural, name := m[1], m[2], m[3], m[4]
	info := resources[plural]
	if info.prefix != prefix {
		send(w, 404, Object{"kind": "Status", "code": 404, "message": "the server could not find the requested resource"})
		return
	}
	s.mu.Lock()
	forbidden := s.forbidden[plural]
	watchForbidden := s.forbidWatch[plural] && r.URL.Query().Get("watch") == "1"
	failing := s.failNext[plural]
	hit := failing.remaining > 0
	if hit {
		failing.remaining--
		s.failNext[plural] = failing
	}
	s.mu.Unlock()
	if hit {
		send(w, failing.status, Object{"kind": "Status", "code": failing.status, "message": "injected failure"})
		return
	}
	if forbidden || watchForbidden {
		send(w, 403, Object{"kind": "Status", "code": 403, "reason": "Forbidden", "message": fmt.Sprintf("%s is forbidden: User \"tester\" cannot list resource \"%s\"", plural, plural)})
		return
	}
	s.mu.Lock()
	var matching []Object
	for _, o := range s.store {
		meta, _ := o["metadata"].(Object)
		if o["kind"] == info.kind && (namespace == "" || meta["namespace"] == namespace) {
			matching = append(matching, o)
		}
	}
	sort.Slice(matching, func(i, j int) bool { return keyOf(matching[i]) < keyOf(matching[j]) })
	rv := s.rv
	pageSize := s.pageSize
	s.mu.Unlock()
	if name != "" {
		for _, o := range matching {
			if meta, _ := o["metadata"].(Object); meta["name"] == name {
				send(w, 200, o)
				return
			}
		}
		send(w, 404, Object{"kind": "Status", "code": 404, "message": fmt.Sprintf("%s %q not found", plural, name)})
		return
	}
	if r.URL.Query().Get("watch") == "1" {
		s.serveWatch(w, r, info.kind, namespace, rv)
		return
	}
	// Lists are paginated so continue tokens are exercised.
	start, _ := strconv.Atoi(r.URL.Query().Get("continue"))
	end := start + pageSize
	if start > len(matching) {
		start = len(matching)
	}
	if end > len(matching) {
		end = len(matching)
	}
	items := []any{}
	for _, o := range matching[start:end] {
		stripped := Object{}
		for k, v := range o {
			if k != "kind" && k != "apiVersion" {
				stripped[k] = v
			}
		}
		items = append(items, stripped)
	}
	meta := Object{"resourceVersion": strconv.Itoa(rv)}
	if end < len(matching) {
		meta["continue"] = strconv.Itoa(end)
	}
	apiVersion := "v1"
	if info.group != "" {
		apiVersion = info.group + "/v1"
	}
	send(w, 200, Object{"kind": info.kind + "List", "apiVersion": apiVersion, "metadata": meta, "items": items})
}

func rawSuffix(r *http.Request) string {
	if r.URL.RawQuery == "" {
		return ""
	}
	return "?" + r.URL.RawQuery
}

func matches(w *watcher, o Object) bool {
	meta, _ := o["metadata"].(Object)
	return w.kind == o["kind"] && (w.namespace == "" || w.namespace == meta["namespace"])
}

func (s *Server) serveWatch(w http.ResponseWriter, r *http.Request, kind, namespace string, rv int) {
	flusher, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(200)
	s.mu.Lock()
	if s.goneOnNextWatch {
		s.goneOnNextWatch = false
		s.mu.Unlock()
		line, _ := json.Marshal(event{"ERROR", Object{"kind": "Status", "code": 410, "reason": "Expired", "message": "too old resource version"}})
		_, _ = w.Write(append(line, '\n'))
		return
	}
	from, _ := strconv.Atoi(r.URL.Query().Get("resourceVersion"))
	wt := &watcher{kind: kind, namespace: namespace, from: from, lines: make(chan []byte, 1024), drop: make(chan struct{})}
	s.watchers[wt] = struct{}{}
	// Like the API server, replay events newer than the requested resourceVersion.
	for _, e := range s.history {
		meta, _ := e.Object["metadata"].(Object)
		n, _ := strconv.Atoi(meta["resourceVersion"].(string))
		if n > from && matches(wt, e.Object) {
			line, _ := json.Marshal(e)
			wt.lines <- append(line, '\n')
		}
	}
	bookmark, _ := json.Marshal(event{"BOOKMARK", Object{"kind": kind, "apiVersion": "v1", "metadata": Object{"resourceVersion": strconv.Itoa(rv)}}})
	wt.lines <- append(bookmark, '\n')
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.watchers, wt)
		s.mu.Unlock()
	}()
	for {
		select {
		case line := <-wt.lines:
			_, _ = w.Write(line)
			if flusher != nil {
				flusher.Flush()
			}
		case <-wt.drop:
			return
		case <-r.Context().Done():
			return
		}
	}
}

// Put stores an object and notifies watchers. typ is ADDED, MODIFIED or DELETED. The object gets a
// uid, a fresh resourceVersion and a managedFields entry (which the live layer must strip).
func (s *Server) Put(typ string, object Object) Object {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rv++
	meta := Object{}
	orig, _ := object["metadata"].(Object)
	name, _ := orig["name"].(string)
	meta["uid"] = fmt.Sprintf("uid-%v-%s", object["kind"], name)
	for k, v := range orig {
		meta[k] = v
	}
	meta["resourceVersion"] = strconv.Itoa(s.rv)
	meta["managedFields"] = []any{Object{"manager": "test"}}
	stored := Object{"apiVersion": "v1"}
	for k, v := range object {
		stored[k] = v
	}
	stored["metadata"] = meta
	if typ == "DELETED" {
		delete(s.store, keyOf(stored))
	} else {
		s.store[keyOf(stored)] = stored
	}
	e := event{typ, stored}
	s.history = append(s.history, e)
	line, _ := json.Marshal(e)
	for wt := range s.watchers {
		if matches(wt, stored) {
			select {
			case wt.lines <- append(line, '\n'):
			default:
			}
		}
	}
	return stored
}

// Remove deletes an object silently (no watch event), like a change that happened while a watch was down.
func (s *Server) Remove(kind, namespace, name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.store, fmt.Sprintf("%s/%s/%s", kind, namespace, name))
}

// DropWatches ends every open watch stream cleanly.
func (s *Server) DropWatches() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for wt := range s.watchers {
		wt.close()
	}
}

// Watchers is the number of open watch streams.
func (s *Server) Watchers() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.watchers)
}

// Requests lists every request received as path?query, in order.
func (s *Server) Requests() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.requests...)
}

// Count counts requests whose path?query satisfies the predicate.
func (s *Server) Count(match func(string) bool) int {
	n := 0
	for _, r := range s.Requests() {
		if match(r) {
			n++
		}
	}
	return n
}

// Posts lists eviction POSTs as "path body".
func (s *Server) Posts() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.posts...)
}

// GoneOnNextWatch makes the next watch request answer an ERROR 410 event.
func (s *Server) GoneOnNextWatch() {
	s.mu.Lock()
	s.goneOnNextWatch = true
	s.mu.Unlock()
}

// Forbid makes every request for a plural answer 403 (or lifts it).
func (s *Server) Forbid(plural string, on bool) {
	s.mu.Lock()
	s.forbidden[plural] = on
	s.mu.Unlock()
}

// ForbidWatch makes only watch requests for a plural answer 403.
func (s *Server) ForbidWatch(plural string, on bool) {
	s.mu.Lock()
	s.forbidWatch[plural] = on
	s.mu.Unlock()
}

// SetFail makes the next n requests for a plural answer with the given status.
func (s *Server) SetFail(plural string, status, n int) {
	s.mu.Lock()
	s.failNext[plural] = failure{status, n}
	s.mu.Unlock()
}

// SetPageSize sets how many items a list page holds (default 2, so continue tokens are exercised).
func (s *Server) SetPageSize(n int) {
	s.mu.Lock()
	s.pageSize = n
	s.mu.Unlock()
}

// SetLegacy switches discovery to the pre-aggregated API.
func (s *Server) SetLegacy(on bool) {
	s.mu.Lock()
	s.legacy = on
	s.mu.Unlock()
}

// SetEvictStatus sets the status the eviction endpoint answers (default 201).
func (s *Server) SetEvictStatus(status int) {
	s.mu.Lock()
	s.evictStatus = status
	s.mu.Unlock()
}

// Close drops the watches and stops the server.
func (s *Server) Close() {
	s.DropWatches()
	s.Server.CloseClientConnections()
	s.Server.Close()
}
