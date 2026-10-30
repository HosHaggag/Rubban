package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
)

var (
	secretResourceRE = regexp.MustCompile(`^(?:secrets?)(?:\..*)?$`)
	restartRE        = regexp.MustCompile(`^(?:deployments?|daemonsets?|statefulsets?)(?:\.apps)?$`)
	groupVersionRE   = regexp.MustCompile(`^[a-z0-9.-]+/v[a-z0-9]+$`)
)

const lastApplied = "kubectl.kubernetes.io/last-applied-configuration"

type obj = map[string]any

func nodePlatform() string {
	if runtime.GOOS == "windows" {
		return "win32"
	}
	return runtime.GOOS
}

// parseJSON decodes CLI output the way JSON.parse(stdout || '{}') did, keeping numbers exact.
func parseJSON(res Result, label string) (any, error) {
	text := res.Stdout
	if strings.TrimSpace(text) == "" {
		text = "{}"
	}
	dec := json.NewDecoder(strings.NewReader(text))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, problem(label+" returned invalid JSON", 502)
	}
	return v, nil
}

func parseObject(res Result, label string) (obj, error) {
	v, err := parseJSON(res, label)
	if err != nil {
		return nil, err
	}
	m, ok := v.(obj)
	if !ok {
		return nil, problem(label+" returned invalid JSON", 502)
	}
	return m, nil
}

func strOf(v any) string { s, _ := v.(string); return s }
func objOf(v any) obj    { m, _ := v.(obj); return m }
func listOf(v any) []any { l, _ := v.([]any); return l }

// redactSecret drops the values of a Secret and records only its key names.
func redactSecret(item obj) obj {
	safe := obj{}
	for k, v := range item {
		if k != "data" && k != "stringData" {
			safe[k] = v
		}
	}
	seen := map[string]bool{}
	var keys []any
	for _, field := range []string{"data", "stringData"} {
		m := objOf(item[field])
		names := make([]string, 0, len(m))
		for k := range m {
			names = append(names, k)
		}
		sort.Strings(names)
		for _, k := range names {
			if !seen[k] {
				seen[k] = true
				keys = append(keys, k)
			}
		}
	}
	if len(keys) > 0 {
		safe["dataKeys"] = keys
	}
	if meta := objOf(safe["metadata"]); meta != nil {
		if ann := objOf(meta["annotations"]); ann != nil && ann[lastApplied] != nil && ann[lastApplied] != "" {
			na := obj{}
			for k, v := range ann {
				if k != lastApplied {
					na[k] = v
				}
			}
			nm := obj{}
			for k, v := range meta {
				nm[k] = v
			}
			nm["annotations"] = na
			safe["metadata"] = nm
		}
	}
	return safe
}

func redactSecretList(doc obj) obj {
	out := obj{}
	for k, v := range doc {
		out[k] = v
	}
	items := []any{}
	for _, it := range listOf(doc["items"]) {
		if m, ok := it.(obj); ok {
			items = append(items, redactSecret(m))
		}
	}
	out["items"] = items
	return out
}

func (b *Backend) dispatch(q *request) (any, int, error) {
	method, route := q.method, q.route
	switch {
	case method == "GET" && route == "/api/health":
		return obj{"version": b.version, "tools": b.tools, "platform": nodePlatform(), "live": false}, 200, nil
	case method == "GET" && route == "/api/contexts":
		return b.routeContexts(q)
	case method == "GET" && route == "/api/kubeconfigs":
		return obj{"kubeconfigs": b.kubecfgs.list()}, 200, nil
	case method == "POST" && route == "/api/kubeconfigs":
		return b.routeKubeconfigAdd(q)
	case method == "DELETE" && strings.HasPrefix(route, "/api/kubeconfigs/"):
		if err := b.kubecfgs.remove(strings.TrimPrefix(route, "/api/kubeconfigs/")); err != nil {
			return nil, 0, err
		}
		return obj{"removed": true}, 200, nil
	case method == "GET" && route == "/api/namespaces":
		return b.routeNamespaces(q)
	case method == "GET" && (route == "/api/resources" || route == "/api/events"):
		return b.routeResources(q)
	case method == "GET" && route == "/api/discovery":
		return b.routeDiscovery(q)
	case method == "GET" && (route == "/api/resource" || route == "/api/yaml"):
		return b.routeResource(q)
	case method == "POST" && (route == "/api/diff" || route == "/api/apply"):
		return b.routeDiffApply(q)
	case method == "POST" && (route == "/api/delete" || route == "/api/scale" || route == "/api/restart"):
		return b.routeMutate(q)
	case method == "GET" && route == "/api/preferences":
		v, err := b.readPreferences()
		return v, 200, err
	case method == "PUT" && route == "/api/preferences":
		v, err := b.writePreferences(q.body)
		return v, 200, err
	}
	return b.dispatchMore(q)
}

func (b *Backend) routeContexts(q *request) (any, int, error) {
	res, err := b.kube(q.ctx, []string{"config", "view", "--output=json"}, RunOptions{})
	if err != nil {
		return nil, 0, err
	}
	doc, err := parseObject(res, "kubectl")
	if err != nil {
		return nil, 0, err
	}
	current := strOf(doc["current-context"])
	contexts := []any{}
	for _, it := range listOf(doc["contexts"]) {
		item := objOf(it)
		c := objOf(item["context"])
		name := strOf(item["name"])
		ns := strOf(c["namespace"])
		if ns == "" {
			ns = "default"
		}
		contexts = append(contexts, obj{"source": b.kubecfgs.sourceOf(name), "name": name, "cluster": strOf(c["cluster"]), "user": strOf(c["user"]), "namespace": ns, "current": name == current})
	}
	return obj{"current": current, "contexts": contexts}, 200, nil
}

func namesOf(doc obj, key string) []string {
	var out []string
	for _, it := range listOf(doc[key]) {
		if n := strOf(objOf(it)["name"]); n != "" {
			out = append(out, n)
		}
	}
	return out
}

func (b *Backend) routeKubeconfigAdd(q *request) (any, int, error) {
	// Names already defined: the imported files, plus what kubectl sees (a failure is not fatal,
	// so a kubeconfig can be imported before kubectl is installed).
	existing := b.kubecfgs.importedNames()
	if res, err := b.kube(q.ctx, []string{"config", "view", "--output=json"}, RunOptions{}); err == nil {
		if doc, err := parseObject(res, "kubectl"); err == nil {
			existing.Contexts = append(existing.Contexts, namesOf(doc, "contexts")...)
			existing.Clusters = append(existing.Clusters, namesOf(doc, "clusters")...)
			existing.Users = append(existing.Users, namesOf(doc, "users")...)
		}
	} else if q.ctx.Err() != nil {
		return nil, 0, err
	}
	content, _ := q.body["content"].(string)
	name, _ := q.body["name"].(string)
	source, _ := q.body["source"].(string)
	fileName, _ := q.body["fileName"].(string)
	entry, err := b.kubecfgs.add(name, content, source, fileName, existing)
	if err != nil {
		return nil, 0, err
	}
	return entry, 201, nil
}

func (b *Backend) routeNamespaces(q *request) (any, int, error) {
	ctxArgs, err := contextArgs(q.q("context"))
	if err != nil {
		return nil, 0, err
	}
	res, err := b.kube(q.ctx, append(ctxArgs, "get", "namespaces", "--output=json"), RunOptions{})
	if err != nil {
		return nil, 0, err
	}
	v, err := parseJSON(res, "kubectl")
	return v, 200, err
}

func selectorArgs(q *request) ([]string, error) {
	var args []string
	if s := q.query["labelSelector"]; s != "" {
		sel, err := validateSelector(s, "label selector")
		if err != nil {
			return nil, err
		}
		args = append(args, "--selector="+sel)
	}
	if s := q.query["fieldSelector"]; s != "" {
		sel, err := validateSelector(s, "field selector")
		if err != nil {
			return nil, err
		}
		args = append(args, "--field-selector="+sel)
	}
	return args, nil
}

func (b *Backend) routeResources(q *request) (any, int, error) {
	resource := "events"
	if q.route != "/api/events" {
		var err error
		if resource, err = validateResource(q.q("resource")); err != nil {
			return nil, 0, err
		}
	}
	ctxArgs, err := contextArgs(q.q("context"))
	if err != nil {
		return nil, 0, err
	}
	nsArgs, err := namespaceArgs(q.q("namespace"), true)
	if err != nil {
		return nil, 0, err
	}
	sel, err := selectorArgs(q)
	if err != nil {
		return nil, 0, err
	}
	// --all-namespaces belongs to get, not kubectl's root/plugin parser.
	args := append(append(append([]string{"get", resource}, ctxArgs...), nsArgs...), sel...)
	res, err := b.kube(q.ctx, append(args, "--output=json"), RunOptions{MaxBytes: listOutputLimit})
	if err != nil {
		return nil, 0, err
	}
	doc, err := parseObject(res, "kubectl")
	if err != nil {
		return nil, 0, err
	}
	if secretResourceRE.MatchString(resource) || doc["kind"] == "SecretList" {
		return redactSecretList(doc), 200, nil
	}
	return json.RawMessage(rawOrEmpty(res.Stdout)), 200, nil
}

func rawOrEmpty(s string) string {
	if strings.TrimSpace(s) == "" {
		return "{}"
	}
	return s
}

func (b *Backend) routeResource(q *request) (any, int, error) {
	ctxArgs, err := contextArgs(q.q("context"))
	if err != nil {
		return nil, 0, err
	}
	nsArgs, err := namespaceArgs(q.q("namespace"), false)
	if err != nil {
		return nil, 0, err
	}
	resource, err := validateResource(q.q("resource"))
	if err != nil {
		return nil, 0, err
	}
	name, err := validateName(q.q("name"), "name")
	if err != nil {
		return nil, 0, err
	}
	args := append(append(append([]string{}, ctxArgs...), nsArgs...), "get", resource, name)
	if q.route == "/api/yaml" {
		res, err := b.kube(q.ctx, append(args, "--output=yaml"), RunOptions{})
		if err != nil {
			return nil, 0, err
		}
		return obj{"yaml": res.Stdout}, 200, nil
	}
	res, err := b.kube(q.ctx, append(args, "--output=json"), RunOptions{})
	if err != nil {
		return nil, 0, err
	}
	doc, err := parseObject(res, "kubectl")
	if err != nil {
		return nil, 0, err
	}
	// Secret values are only returned by the explicit /api/secret-data and YAML reveal requests.
	if doc["kind"] == "Secret" {
		return redactSecret(doc), 200, nil
	}
	return json.RawMessage(rawOrEmpty(res.Stdout)), 200, nil
}

func (b *Backend) routeDiffApply(q *request) (any, int, error) {
	input, err := validateYAML(q.body["yaml"])
	if err != nil {
		return nil, 0, err
	}
	ctxArgs, err := contextArgs(q.body["context"])
	if err != nil {
		return nil, 0, err
	}
	nsArgs, err := namespaceArgs(q.body["namespace"], false)
	if err != nil {
		return nil, 0, err
	}
	isDiff := q.route == "/api/diff"
	verb, allow := "apply", []int{0}
	if isDiff {
		verb, allow = "diff", []int{0, 1}
	}
	args := append(append(append([]string{}, ctxArgs...), nsArgs...), verb, "--filename=-")
	res, err := b.kube(q.ctx, args, RunOptions{Input: input, AllowExit: allow})
	if err != nil {
		return nil, 0, err
	}
	if isDiff {
		return obj{"diff": res.Stdout + res.Stderr, "changed": res.Code == 1}, 200, nil
	}
	return obj{"output": res.Stdout + res.Stderr}, 200, nil
}

func (b *Backend) routeMutate(q *request) (any, int, error) {
	resource, err := validateResource(q.body["resource"])
	if err != nil {
		return nil, 0, err
	}
	name, err := validateName(q.body["name"], "name")
	if err != nil {
		return nil, 0, err
	}
	ctxArgs, err := contextArgs(q.body["context"])
	if err != nil {
		return nil, 0, err
	}
	nsArgs, err := namespaceArgs(q.body["namespace"], false)
	if err != nil {
		return nil, 0, err
	}
	args := append(append([]string{}, ctxArgs...), nsArgs...)
	switch q.route {
	case "/api/delete":
		args = append(args, "delete", resource, name, "--wait=false")
	case "/api/scale":
		n, err := integer(q.body["replicas"], "replicas", 0, 1000000, nil)
		if err != nil {
			return nil, 0, err
		}
		args = append(args, "scale", resource, name, fmt.Sprintf("--replicas=%d", n))
	default:
		if !restartRE.MatchString(resource) {
			return nil, 0, bad("Restart supports Deployments, DaemonSets and StatefulSets")
		}
		args = append(args, "rollout", "restart", resource+"/"+name)
	}
	res, err := b.kube(q.ctx, args, RunOptions{})
	if err != nil {
		return nil, 0, err
	}
	return obj{"output": res.Stdout + res.Stderr}, 200, nil
}

type discoveredResource struct {
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

func (b *Backend) routeDiscovery(q *request) (any, int, error) {
	ctxArgs, err := contextArgs(q.q("context"))
	if err != nil {
		return nil, 0, err
	}
	return b.discoverViaKubectl(q.ctx, ctxArgs)
}

func stringsOf(v any) []string {
	out := []string{}
	for _, s := range listOf(v) {
		if t, ok := s.(string); ok {
			out = append(out, t)
		}
	}
	return out
}

func (b *Backend) discoverViaKubectl(ctx context.Context, base []string) (any, int, error) {
	type outcome struct {
		res Result
		err error
	}
	var wg sync.WaitGroup
	results := make([]outcome, 2)
	for i, raw := range []string{"--raw=/api/v1", "--raw=/apis"} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := b.kube(ctx, append(append([]string{}, base...), "get", raw), RunOptions{})
			results[i] = outcome{res, err}
		}()
	}
	wg.Wait()
	resources := []discoveredResource{}
	warnings := []string{}
	add := func(doc obj, group, version string) {
		for _, it := range listOf(doc["resources"]) {
			r := objOf(it)
			name := strOf(r["name"])
			if name == "" || strings.Contains(name, "/") {
				continue
			}
			verbs := stringsOf(r["verbs"])
			short := stringsOf(r["shortNames"])
			ns, _ := r["namespaced"].(bool)
			resources = append(resources, discoveredResource{Name: name, Kind: strOf(r["kind"]), Namespaced: ns, Group: group, Version: version, Verbs: verbs, ShortNames: short, Singular: strOf(r["singularName"])})
		}
	}
	if results[0].err == nil {
		doc, err := parseObject(results[0].res, "Kubernetes discovery")
		if err != nil {
			return nil, 0, err
		}
		add(doc, "", "v1")
	} else {
		warnings = append(warnings, "Core discovery: "+shortError(results[0].err))
	}
	var versions []string
	if results[1].err == nil {
		doc, err := parseObject(results[1].res, "Kubernetes discovery")
		if err != nil {
			return nil, 0, err
		}
		for _, g := range listOf(doc["groups"]) {
			if gv := strOf(objOf(objOf(g)["preferredVersion"])["groupVersion"]); gv != "" {
				versions = append(versions, gv)
			}
		}
	} else {
		warnings = append(warnings, "API group discovery: "+shortError(results[1].err))
	}
	var mu sync.Mutex
	sem := make(chan struct{}, 6)
	for _, gv := range versions {
		if !groupVersionRE.MatchString(gv) {
			warnings = append(warnings, "Skipped malformed API group version")
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			if ctx.Err() != nil {
				return
			}
			res, err := b.kube(ctx, append(append([]string{}, base...), "get", "--raw=/apis/"+gv), RunOptions{})
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				warnings = append(warnings, gv+": "+shortError(err))
				return
			}
			doc, err := parseObject(res, "Kubernetes discovery")
			if err != nil {
				warnings = append(warnings, gv+": "+shortError(err))
				return
			}
			parts := strings.SplitN(gv, "/", 2)
			add(doc, parts[0], parts[1])
		}()
	}
	wg.Wait()
	if len(resources) == 0 && len(warnings) > 0 {
		return nil, 0, problem("Kubernetes discovery unavailable: "+strings.Join(warnings, "; "), 502)
	}
	sort.SliceStable(resources, func(i, j int) bool {
		return resources[i].Group+"/"+resources[i].Name < resources[j].Group+"/"+resources[j].Name
	})
	return obj{"resources": resources, "warnings": warnings}, 200, nil
}

var _ = errors.New
var _ = bytes.NewReader
