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

	"github.com/HosHaggag/rubban/internal/live"
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
		return obj{"version": b.version, "tools": b.tools, "platform": nodePlatform(), "live": b.live != nil, "migratedFrom": b.opts.MigratedFrom}, 200, nil
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
	case method == "POST" && route == "/api/apply/preview":
		return b.routeApplyPreview(q)
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
	remedies := remediesOf(doc)
	contexts := []any{}
	for _, it := range listOf(doc["contexts"]) {
		item := objOf(it)
		c := objOf(item["context"])
		name := strOf(item["name"])
		ns := strOf(c["namespace"])
		if ns == "" {
			ns = "default"
		}
		contexts = append(contexts, obj{"source": b.kubecfgs.sourceOf(name), "name": name, "cluster": strOf(c["cluster"]), "user": strOf(c["user"]), "namespace": ns, "current": name == current, "auth": b.authView(name, remedies[name])})
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
	kubeContext, err := validateText(q.q("context"), "context")
	if err != nil {
		return nil, 0, err
	}
	doc, err := viaLive(b, func(l *live.Live) (any, error) {
		return l.List(q.ctx, kubeContext, "namespaces", "", live.ListOptions{})
	}, func() (any, error) {
		res, err := b.kube(q.ctx, []string{"--context=" + kubeContext, "get", "namespaces", "--output=json"}, RunOptions{})
		if err != nil {
			return nil, err
		}
		return parseJSON(res, "kubectl")
	})
	return doc, 200, err
}

// selectorValues validates the optional label and field selectors of a list request.
func selectorValues(q *request) (ListOptions, error) {
	var o ListOptions
	var err error
	if s := q.query["labelSelector"]; s != "" {
		if o.LabelSelector, err = validateSelector(s, "label selector"); err != nil {
			return o, err
		}
	}
	if s := q.query["fieldSelector"]; s != "" {
		if o.FieldSelector, err = validateSelector(s, "field selector"); err != nil {
			return o, err
		}
	}
	return o, nil
}

// listed is a list answer: parsed, and for kubectl also the exact text (so it can be passed through).
type listed struct {
	doc obj
	raw string
}

func (b *Backend) routeResources(q *request) (any, int, error) {
	resource := "events"
	if q.route != "/api/events" {
		var err error
		if resource, err = validateResource(q.q("resource")); err != nil {
			return nil, 0, err
		}
	}
	kubeContext, err := validateText(q.q("context"), "context")
	if err != nil {
		return nil, 0, err
	}
	namespace, err := validateNamespace(q.q("namespace"), true)
	if err != nil {
		return nil, 0, err
	}
	sel, err := selectorValues(q)
	if err != nil {
		return nil, 0, err
	}
	result, err := viaLive(b, func(l *live.Live) (listed, error) {
		doc, err := l.List(q.ctx, kubeContext, resource, namespace, live.ListOptions{LabelSelector: sel.LabelSelector, FieldSelector: sel.FieldSelector})
		return listed{doc: doc}, err
	}, func() (listed, error) {
		nsArgs, err := namespaceArgs(namespace, true)
		if err != nil {
			return listed{}, err
		}
		// --all-namespaces belongs to get, not kubectl's root/plugin parser.
		args := append(append(append([]string{"get", resource, "--context=" + kubeContext}, nsArgs...), sel.args()...), "--output=json")
		res, err := b.kube(q.ctx, args, RunOptions{MaxBytes: listOutputLimit})
		if err != nil {
			return listed{}, err
		}
		doc, err := parseObject(res, "kubectl")
		return listed{doc: doc, raw: res.Stdout}, err
	})
	if err != nil {
		return nil, 0, err
	}
	if secretResourceRE.MatchString(resource) || result.doc["kind"] == "SecretList" {
		return redactSecretList(result.doc), 200, nil
	}
	if result.raw != "" || result.doc == nil {
		return json.RawMessage(rawOrEmpty(result.raw)), 200, nil
	}
	return result.doc, 200, nil
}

func rawOrEmpty(s string) string {
	if strings.TrimSpace(s) == "" {
		return "{}"
	}
	return s
}

func (b *Backend) routeResource(q *request) (any, int, error) {
	kubeContext, err := validateText(q.q("context"), "context")
	if err != nil {
		return nil, 0, err
	}
	namespace, err := validateNamespace(q.q("namespace"), false)
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
	nsArgs, err := namespaceArgs(namespace, false)
	if err != nil {
		return nil, 0, err
	}
	args := append(append([]string{"--context=" + kubeContext}, nsArgs...), "get", resource, name)
	if q.route == "/api/yaml" {
		text, err := viaLive(b, func(l *live.Live) (string, error) {
			raw, err := l.GetRaw(q.ctx, kubeContext, resource, namespace, name)
			if err != nil {
				return "", err
			}
			return objectYAML(raw)
		}, func() (string, error) {
			res, err := b.kube(q.ctx, append(args, "--output=yaml"), RunOptions{})
			return res.Stdout, err
		})
		if err != nil {
			return nil, 0, err
		}
		return obj{"yaml": text}, 200, nil
	}
	result, err := viaLive(b, func(l *live.Live) (listed, error) {
		doc, err := l.Get(q.ctx, kubeContext, resource, namespace, name)
		return listed{doc: doc}, err
	}, func() (listed, error) {
		res, err := b.kube(q.ctx, append(args, "--output=json"), RunOptions{})
		if err != nil {
			return listed{}, err
		}
		doc, err := parseObject(res, "kubectl")
		return listed{doc: doc, raw: res.Stdout}, err
	})
	if err != nil {
		return nil, 0, err
	}
	// Secret values are only returned by the explicit /api/secret-data and YAML reveal requests.
	if result.doc["kind"] == "Secret" {
		return redactSecret(result.doc), 200, nil
	}
	if result.raw != "" || result.doc == nil {
		return json.RawMessage(rawOrEmpty(result.raw)), 200, nil
	}
	return result.doc, 200, nil
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
	} else {
		// Only the manifest the user reviewed is applied.
		hash, _ := q.body["previewHash"].(string)
		if hash == "" {
			return nil, 0, bad("Review the changes before applying")
		}
		if hash != manifestHash(q.body["context"].(string), nsOf(q), input) {
			return nil, 0, problem("The manifest changed since the preview", 409)
		}
	}
	args := append(append(append([]string{}, ctxArgs...), nsArgs...), verb, fieldManager, "--filename=-")
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
	kubeContext, err := validateText(q.q("context"), "context")
	if err != nil {
		return nil, 0, err
	}
	result, err := viaLive(b, func(l *live.Live) (any, error) {
		d, err := l.Discover(q.ctx, kubeContext, q.query["refresh"] == "1")
		if err != nil {
			return nil, err
		}
		return obj{"resources": d.Resources, "warnings": d.Warnings}, nil
	}, func() (any, error) {
		v, _, err := b.discoverViaKubectl(q.ctx, []string{"--context=" + kubeContext})
		return v, err
	})
	return result, 200, err
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
