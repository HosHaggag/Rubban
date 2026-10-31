package server

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
)

// Compare one resource across two clusters (or namespaces): both objects are read, cleaned of the fields
// that always differ (uid, resourceVersion, managedFields, status …) and rendered as YAML with sorted keys,
// so the UI can show a side-by-side diff of what a person actually configured.

type compareSide struct {
	context, namespace, resource, name string
}

func parseCompareSide(v any, label string) (compareSide, error) {
	m, ok := v.(map[string]any)
	if !ok {
		return compareSide{}, bad("Invalid " + label)
	}
	var s compareSide
	var err error
	if s.context, err = validateText(m["context"], label+" context"); err != nil {
		return s, err
	}
	if s.namespace, err = validateNamespace(m["namespace"], false); err != nil {
		return s, err
	}
	if s.resource, err = validateResource(m["resource"]); err != nil {
		return s, err
	}
	if s.name, err = validateName(m["name"], label+" name"); err != nil {
		return s, err
	}
	// Secret values never leave the cluster through a comparison.
	if s.resource == "secrets" || strings.HasPrefix(s.resource, "secrets.") || s.resource == "secret" {
		return s, bad("Secrets cannot be compared")
	}
	return s, nil
}

// droppedMetadata are metadata fields that differ between clusters without meaning anything.
var droppedMetadata = []string{"managedFields", "uid", "resourceVersion", "creationTimestamp", "generation", "selfLink"}

var droppedAnnotations = []string{"kubectl.kubernetes.io/last-applied-configuration", "deployment.kubernetes.io/revision"}

const droppedAnnotationPrefix = "autoscaling.alpha.kubernetes.io/"

func deepCopy(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			out[k] = deepCopy(val)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = deepCopy(val)
		}
		return out
	}
	return v
}

// normalizeForCompare returns a copy of the object without the fields that always differ. An annotations
// map that becomes empty is removed, so an object that never had one does not differ from it.
func normalizeForCompare(o obj, includeStatus bool) obj {
	out, _ := deepCopy(o).(map[string]any)
	if out == nil {
		return obj{}
	}
	if !includeStatus {
		delete(out, "status")
	}
	meta := objOf(out["metadata"])
	if meta == nil {
		return out
	}
	for _, key := range droppedMetadata {
		delete(meta, key)
	}
	if ann := objOf(meta["annotations"]); ann != nil {
		for key := range ann {
			if strings.HasPrefix(key, droppedAnnotationPrefix) {
				delete(ann, key)
			}
		}
		for _, key := range droppedAnnotations {
			delete(ann, key)
		}
		if len(ann) == 0 {
			delete(meta, "annotations")
		}
	}
	return out
}

// compareYAML is the YAML of the cleaned object; json.Marshal sorts every map's keys.
func compareYAML(o obj, includeStatus bool) (string, error) {
	raw, err := json.Marshal(normalizeForCompare(o, includeStatus))
	if err != nil {
		return "", err
	}
	return objectYAML(raw)
}

type compareResult struct {
	yaml string
	err  error
}

func (b *Backend) compareSideYAML(ctx context.Context, s compareSide, includeStatus bool) compareResult {
	o, err := b.getObject(ctx, s.context, s.resource, s.namespace, s.name)
	if err != nil {
		return compareResult{err: err}
	}
	if strOf(o["kind"]) == "Secret" {
		return compareResult{err: bad("Secrets cannot be compared")}
	}
	text, err := compareYAML(o, includeStatus)
	return compareResult{yaml: text, err: err}
}

func sideMeta(s compareSide) obj {
	return obj{"context": s.context, "namespace": s.namespace, "resource": s.resource, "name": s.name}
}

func (b *Backend) routeCompare(q *request) (any, int, error) {
	left, err := parseCompareSide(q.body["left"], "left side")
	if err != nil {
		return nil, 0, err
	}
	right, err := parseCompareSide(q.body["right"], "right side")
	if err != nil {
		return nil, 0, err
	}
	includeStatus, _ := q.body["includeStatus"].(bool)
	var results [2]compareResult
	var wg sync.WaitGroup
	for i, s := range []compareSide{left, right} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i] = b.compareSideYAML(q.ctx, s, includeStatus)
		}()
	}
	wg.Wait()
	// A refusal is the whole request's; a side that cannot be read is reported next to the other one.
	for _, r := range results {
		if r.err != nil && statusOf(r.err) == 400 {
			return nil, 0, r.err
		}
	}
	if results[0].err != nil && results[1].err != nil {
		b.tagCredentials(results[1].err, right.context)
		return nil, 0, b.tagCredentials(results[0].err, left.context)
	}
	answer := obj{"left": results[0].yaml, "right": results[1].yaml, "leftMeta": sideMeta(left), "rightMeta": sideMeta(right), "includeStatus": includeStatus}
	if results[0].err != nil {
		answer["leftError"] = shortError(b.tagCredentials(results[0].err, left.context))
	}
	if results[1].err != nil {
		answer["rightError"] = shortError(b.tagCredentials(results[1].err, right.context))
	}
	return answer, 200, nil
}

func init() {
	registerRoutes(func(b *Backend, q *request) (any, int, bool, error) {
		if q.method != "POST" || q.route != "/api/compare" {
			return nil, 0, false, nil
		}
		v, status, err := b.routeCompare(q)
		return v, status, true, err
	})
}
