package server

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"sync"
)

// The change timeline (ui/timeline.js) builds most of its entries from the live feeds the UI already
// watches. Two sources are not in those feeds and are read here, both read-only:
//
//   - /api/timeline/config: when ConfigMaps and Secrets were created and last written, per writer. The
//     live layer strips metadata.managedFields from lists, so this asks the API server for metadata only
//     (PartialObjectMetadataList) and returns names and times. Secret values are never requested through
//     the live layer and never returned on any path.
//   - /api/timeline/helm: the revision history of every Helm release in scope, in one call.

const (
	timelineHelmReleases    = 40 // releases whose history is read, newest first
	timelineHelmRevisions   = 10 // revisions per release
	timelineHelmConcurrency = 6
)

func init() {
	registerRoutes(func(b *Backend, q *request) (any, int, bool, error) {
		if q.method != "GET" {
			return nil, 0, false, nil
		}
		switch q.route {
		case "/api/timeline/config":
			v, err := b.routeTimelineConfig(q)
			return v, 200, true, err
		case "/api/timeline/helm":
			v, err := b.routeTimelineHelm(q)
			return v, 200, true, err
		}
		return nil, 0, false, nil
	})
}

// configWrite is one managedFields entry reduced to who wrote the object, how and when.
type configWrite struct {
	Time        string `json:"time"`
	Manager     string `json:"manager"`
	Operation   string `json:"operation"`
	Subresource string `json:"subresource,omitempty"`
}

// configEntry is what the timeline learns about one ConfigMap or Secret: never its data.
type configEntry struct {
	Kind      string        `json:"kind"`
	Namespace string        `json:"namespace"`
	Name      string        `json:"name"`
	UID       string        `json:"uid,omitempty"`
	Created   string        `json:"created,omitempty"`
	Owner     string        `json:"owner,omitempty"` // "Kind/name" of the controlling owner
	Writes    []configWrite `json:"writes"`
}

// configEntries reduces a (metadata-only or full) list to names, owners and write times.
func configEntries(kind string, list any) []configEntry {
	out := []configEntry{}
	for _, it := range listOf(objOf(list)["items"]) {
		meta := objOf(objOf(it)["metadata"])
		name := strOf(meta["name"])
		if name == "" {
			continue
		}
		entry := configEntry{Kind: kind, Namespace: strOf(meta["namespace"]), Name: name, UID: strOf(meta["uid"]), Created: strOf(meta["creationTimestamp"]), Writes: []configWrite{}}
		for _, ref := range listOf(meta["ownerReferences"]) {
			r := objOf(ref)
			if entry.Owner == "" || r["controller"] == true {
				entry.Owner = strOf(r["kind"]) + "/" + strOf(r["name"])
			}
		}
		for _, field := range listOf(meta["managedFields"]) {
			f := objOf(field)
			if t := strOf(f["time"]); t != "" {
				entry.Writes = append(entry.Writes, configWrite{Time: t, Manager: firstChars(strOf(f["manager"]), 120), Operation: strOf(f["operation"]), Subresource: strOf(f["subresource"])})
			}
		}
		sort.Slice(entry.Writes, func(i, j int) bool { return entry.Writes[i].Time < entry.Writes[j].Time })
		out = append(out, entry)
	}
	return out
}

func (b *Backend) routeTimelineConfig(q *request) (any, error) {
	kubeContext, err := validateText(q.q("context"), "context")
	if err != nil {
		return nil, err
	}
	namespace, err := validateNamespace(q.q("namespace"), true)
	if err != nil {
		return nil, err
	}
	scope := ""
	if namespace != "" && namespace != "*" {
		scope = "/namespaces/" + pathEscape(namespace)
	}
	kinds := []struct{ kind, plural string }{{"ConfigMap", "configmaps"}, {"Secret", "secrets"}}
	lists := make([]any, len(kinds))
	errs := make([]error, len(kinds))
	var wg sync.WaitGroup
	for i, k := range kinds {
		wg.Add(1)
		go func() {
			defer wg.Done()
			lists[i], errs[i] = b.metadataList(q.ctx, kubeContext, "/api/v1"+scope+"/"+k.plural)
		}()
	}
	wg.Wait()
	items := []configEntry{}
	warnings := []string{}
	for i, k := range kinds {
		if errs[i] != nil {
			// A user who may not list Secrets still gets the ConfigMaps, and the reason.
			warnings = append(warnings, k.kind+"s: "+shortError(errs[i]))
			continue
		}
		items = append(items, configEntries(k.kind, lists[i])...)
	}
	if len(warnings) == len(kinds) {
		return nil, errs[0]
	}
	return obj{"items": items, "warnings": warnings}, nil
}

// metadataList lists an API collection as PartialObjectMetadata, so object bodies (Secret data
// included) never leave the API server. The kubectl fallback cannot ask for that and reads the full
// list, which configEntries reduces to metadata before anything is returned.
func (b *Backend) metadataList(ctx context.Context, kubeContext, apiPath string) (any, error) {
	return b.rawGet(ctx, kubeContext, apiPath, RawOptions{Accept: metadataOnlyAccept})
}

// helmRevision is one entry of `helm history`.
type helmRevision struct {
	Revision    int64  `json:"revision"`
	Updated     string `json:"updated"`
	Status      string `json:"status"`
	Chart       string `json:"chart"`
	AppVersion  string `json:"appVersion"`
	Description string `json:"description"`
}

type helmTimelineRelease struct {
	Name      string         `json:"name"`
	Namespace string         `json:"namespace"`
	Chart     string         `json:"chart"`
	Status    string         `json:"status"`
	Updated   string         `json:"updated"`
	History   []helmRevision `json:"history"`
	Error     string         `json:"error,omitempty"`
}

func (b *Backend) routeTimelineHelm(q *request) (any, error) {
	kubeContext, err := validateText(q.q("context"), "context")
	if err != nil {
		return nil, err
	}
	nsArgs, err := namespaceArgs(q.q("namespace"), true)
	if err != nil {
		return nil, err
	}
	empty := func(warning string) obj {
		return obj{"releases": []helmTimelineRelease{}, "warnings": []string{warning}, "truncated": false}
	}
	if _, err := b.requireTool("helm"); err != nil {
		return empty("Helm is not installed, so Helm releases are not on the timeline."), nil
	}
	res, err := b.helm(q.ctx, append([]string{"list", "--all", "--output=json", "--kube-context=" + kubeContext}, nsArgs...), RunOptions{})
	if err != nil {
		return empty("Helm releases: " + shortError(err)), nil
	}
	parsed, err := parseJSON(res, "Helm")
	if err != nil {
		return nil, err
	}
	releases := []helmTimelineRelease{}
	for _, it := range listOf(parsed) {
		r := objOf(it)
		name, namespace := strOf(r["name"]), strOf(r["namespace"])
		if _, err := validateName(name, "release name"); err != nil {
			continue
		}
		if ns, err := validateNamespace(namespace, false); err != nil || ns == "" {
			continue
		}
		releases = append(releases, helmTimelineRelease{Name: name, Namespace: namespace, Chart: strOf(r["chart"]), Status: strOf(r["status"]), Updated: strOf(r["updated"]), History: []helmRevision{}})
	}
	// Newest first; Helm's "updated" text sorts by time within one zone, which is what one cluster's
	// list carries.
	sort.SliceStable(releases, func(i, j int) bool { return releases[i].Updated > releases[j].Updated })
	truncated := len(releases) > timelineHelmReleases
	if truncated {
		releases = releases[:timelineHelmReleases]
	}
	sem := make(chan struct{}, timelineHelmConcurrency)
	var wg sync.WaitGroup
	for i := range releases {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			rel := &releases[i]
			res, err := b.helm(q.ctx, []string{"history", rel.Name, "--kube-context=" + kubeContext, "--namespace=" + rel.Namespace, "--max=" + itoa(timelineHelmRevisions), "--output=json"}, RunOptions{})
			if err != nil {
				rel.Error = shortError(err)
				return
			}
			history, err := parseJSON(res, "Helm")
			if err != nil {
				rel.Error = shortError(err)
				return
			}
			for _, h := range listOf(history) {
				m := objOf(h)
				rel.History = append(rel.History, helmRevision{Revision: int64OfAny(m["revision"]), Updated: strOf(m["updated"]), Status: strOf(m["status"]), Chart: strOf(m["chart"]), AppVersion: strOf(m["app_version"]), Description: firstChars(strOf(m["description"]), 300)})
			}
		}()
	}
	wg.Wait()
	warnings := []string{}
	for _, rel := range releases {
		if rel.Error != "" {
			warnings = append(warnings, rel.Namespace+"/"+rel.Name+": "+rel.Error)
		}
	}
	if truncated {
		warnings = append(warnings, "Only the "+itoa(timelineHelmReleases)+" most recently updated Helm releases are on the timeline.")
	}
	return obj{"releases": releases, "warnings": warnings, "truncated": truncated}, nil
}

func int64OfAny(v any) int64 {
	switch n := v.(type) {
	case json.Number:
		i, _ := n.Int64()
		return i
	case float64:
		return int64(n)
	case int64:
		return n
	case int:
		return int64(n)
	case string:
		var out int64
		for _, c := range strings.TrimSpace(n) {
			if c < '0' || c > '9' {
				return 0
			}
			out = out*10 + int64(c-'0')
		}
		return out
	}
	return 0
}
