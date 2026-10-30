package server

import (
	"context"
	"math"
	"strconv"
	"sync"
	"time"
)

func init() {
	registerRoutes(func(b *Backend, q *request) (any, int, bool, error) {
		if q.method == "GET" && q.route == "/api/metrics" {
			v, status, err := b.routeMetrics(q)
			return v, status, true, err
		}
		return nil, 0, false, nil
	})
}

const (
	metricsNodesPath    = "/apis/metrics.k8s.io/v1beta1/nodes"
	metadataOnlyAccept  = "application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1,application/json"
	kubeletFailureTTL   = 60 * time.Second
	kubeletMaxNodes     = 20
	kubeletRequestLimit = 8000 // ms
)

type kubeletFailure struct {
	until  time.Time
	reason string
}

// metricsResponse is the /api/metrics payload while it is being assembled.
type metricsResponse struct {
	nodes, pods  obj
	warnings     []string
	missingNodes obj
}

func (r *metricsResponse) items(doc obj) []any { return listOf(doc["items"]) }

// nodeNames lists node names through a metadata-only request (a full list when only kubectl is available).
func (b *Backend) nodeNames(ctx context.Context, kubeContext string) ([]string, error) {
	raw, err := b.rawGet(ctx, kubeContext, "/api/v1/nodes", RawOptions{Accept: metadataOnlyAccept})
	if err != nil {
		return nil, err
	}
	var names []string
	for _, it := range listOf(objOf(raw)["items"]) {
		if n := strOf(objOf(objOf(it)["metadata"])["name"]); n != "" {
			names = append(names, n)
		}
	}
	return names, nil
}

func (b *Backend) routeMetrics(q *request) (any, int, error) {
	kubeContext, err := validateText(q.q("context"), "context")
	if err != nil {
		return nil, 0, err
	}
	namespace, err := validateNamespace(q.q("namespace"), true)
	if err != nil {
		return nil, 0, err
	}
	podPath := "/apis/metrics.k8s.io/v1beta1/pods"
	if namespace != "" && namespace != "*" {
		podPath = "/apis/metrics.k8s.io/v1beta1/namespaces/" + encodeURIComponent(namespace) + "/pods"
	}
	var (
		wg          sync.WaitGroup
		nodesRaw    any
		podsRaw     any
		names       []string
		nodesErr    error
		podsErr     error
		namesErr    error
		readRawInto = func(path string, out *any, outErr *error) {
			defer wg.Done()
			*out, *outErr = b.rawGet(q.ctx, kubeContext, path, RawOptions{})
		}
	)
	wg.Add(3)
	go readRawInto(metricsNodesPath, &nodesRaw, &nodesErr)
	go readRawInto(podPath, &podsRaw, &podsErr)
	go func() {
		defer wg.Done()
		names, namesErr = b.nodeNames(q.ctx, kubeContext)
	}()
	wg.Wait()

	resp := &metricsResponse{nodes: obj{"items": []any{}}, pods: obj{"items": []any{}}, warnings: []string{}, missingNodes: obj{}}
	for i, label := range []string{"nodes", "pods"} {
		value, rerr := nodesRaw, nodesErr
		if i == 1 {
			value, rerr = podsRaw, podsErr
		}
		if rerr == nil {
			doc, ok := value.(obj)
			if !ok {
				rerr = problem("Kubernetes metrics API returned invalid JSON", 502)
			} else if i == 0 {
				resp.nodes = doc
			} else {
				resp.pods = doc
			}
		}
		if rerr != nil {
			resp.warnings = append(resp.warnings, label+" metrics unavailable: "+shortError(rerr))
		}
	}
	// metrics-server leaves out nodes it failed to scrape (and their pods). Read those from the
	// kubelet through the API server so a single slow node does not disappear from every total.
	if nodesErr == nil && namesErr == nil {
		reported := map[string]bool{}
		for _, it := range resp.items(resp.nodes) {
			reported[strOf(objOf(objOf(it)["metadata"])["name"])] = true
		}
		var missing []string
		for _, n := range names {
			if !reported[n] {
				missing = append(missing, n)
			}
		}
		if len(missing) > 0 {
			b.kubeletUsage(q.ctx, kubeContext, missing, namespace, resp)
		}
	}
	return obj{"nodes": resp.nodes, "pods": resp.pods, "warnings": resp.warnings, "missingNodes": resp.missingNodes}, 200, nil
}

// field reads a number the way Number(object[key]) does: absent is NaN, null is 0.
func sampleNumber(m obj, key string) float64 {
	v, ok := m[key]
	if !ok {
		return math.NaN()
	}
	return numOf(v)
}

func roundedUnits(v any, suffix string) string {
	n := numOf(v)
	if math.IsNaN(n) {
		n = 0
	}
	return strconv.FormatFloat(math.Max(0, math.Round(n)), 'f', 0, 64) + suffix
}

// kubeletUsage fills in usage for nodes metrics-server left out, read from each kubelet's summary API
// through the API server (needs nodes/proxy). Failures are remembered for a minute so a broken kubelet
// is not asked again on every refresh.
func (b *Backend) kubeletUsage(ctx context.Context, kubeContext string, names []string, namespace string, resp *metricsResponse) {
	st := b.xstate()
	now := st.now()
	known := map[string]bool{}
	for _, it := range resp.items(resp.pods) {
		meta := objOf(objOf(it)["metadata"])
		known[strOf(meta["namespace"])+"/"+strOf(meta["name"])] = true
	}
	if len(names) > kubeletMaxNodes {
		names = names[:kubeletMaxNodes]
	}
	type outcome struct {
		node    obj
		pods    []any
		reason  string
		skipped bool
	}
	results := make([]outcome, len(names))
	var wg sync.WaitGroup
	for i, name := range names {
		wg.Add(1)
		go func() {
			defer wg.Done()
			key := kubeContext + "\x00" + name
			st.mu.Lock()
			failure, failed := st.kubelet[key]
			st.mu.Unlock()
			if failed && failure.until.After(now) {
				results[i].reason = failure.reason
				return
			}
			apiPath := "/api/v1/nodes/" + encodeURIComponent(name) + "/proxy/stats/summary?only_cpu_and_memory=true"
			node, pods, err := b.readKubeletSummary(ctx, kubeContext, name, apiPath, namespace, known)
			if err != nil {
				if ctx.Err() != nil {
					results[i].skipped = true
					return
				}
				reason := "metrics-server has no sample for this node, and its kubelet could not be read: " + firstChars(firstLine(shortError(err)), 300)
				st.mu.Lock()
				st.kubelet[key] = kubeletFailure{until: now.Add(kubeletFailureTTL), reason: reason}
				st.mu.Unlock()
				results[i].reason = reason
				return
			}
			st.mu.Lock()
			delete(st.kubelet, key)
			st.mu.Unlock()
			results[i].node, results[i].pods = node, pods
		}()
	}
	wg.Wait()
	nodeItems := append([]any{}, resp.items(resp.nodes)...)
	podItems := append([]any{}, resp.items(resp.pods)...)
	for i, r := range results {
		switch {
		case r.skipped:
		case r.node != nil:
			nodeItems = append(nodeItems, r.node)
			podItems = append(podItems, r.pods...)
		default:
			resp.missingNodes[names[i]] = r.reason
		}
	}
	resp.nodes = withItems(resp.nodes, nodeItems)
	resp.pods = withItems(resp.pods, podItems)
}

func withItems(doc obj, items []any) obj {
	out := obj{}
	for k, v := range doc {
		out[k] = v
	}
	out["items"] = items
	return out
}

// readKubeletSummary reads one node's summary and converts it to metrics-server's item format.
func (b *Backend) readKubeletSummary(ctx context.Context, kubeContext, name, apiPath, namespace string, known map[string]bool) (obj, []any, error) {
	raw, err := b.rawGet(ctx, kubeContext, apiPath, RawOptions{TimeoutMs: kubeletRequestLimit})
	if err != nil {
		return nil, nil, err
	}
	summary := objOf(raw)
	node := objOf(summary["node"])
	cpu, memory := objOf(node["cpu"]), objOf(node["memory"])
	cpuN, memN := sampleNumber(cpu, "usageNanoCores"), sampleNumber(memory, "workingSetBytes")
	if math.IsNaN(cpuN) || math.IsInf(cpuN, 0) || math.IsNaN(memN) || math.IsInf(memN, 0) {
		return nil, nil, problem("the kubelet summary has no CPU or memory sample", 502)
	}
	nodeItem := obj{"metadata": obj{"name": name}, "usage": obj{"cpu": roundedUnits(cpu["usageNanoCores"], "n"), "memory": roundedUnits(memory["workingSetBytes"], "")}, "source": "kubelet"}
	if truthy(cpu["time"]) {
		nodeItem["timestamp"] = cpu["time"]
	} else if memory["time"] != nil {
		nodeItem["timestamp"] = memory["time"]
	}
	var pods []any
	for _, p := range listOf(summary["pods"]) {
		pod := objOf(p)
		ref := objOf(pod["podRef"])
		refName, refNamespace := strOf(ref["name"]), strOf(ref["namespace"])
		if refName == "" || (namespace != "" && namespace != "*" && refNamespace != namespace) || known[refNamespace+"/"+refName] {
			continue
		}
		var containers []any
		for _, c := range listOf(pod["containers"]) {
			container := objOf(c)
			if container["cpu"] == nil && container["memory"] == nil {
				continue
			}
			ccpu, cmem := objOf(container["cpu"]), objOf(container["memory"])
			containers = append(containers, obj{"name": container["name"], "usage": obj{"cpu": roundedUnits(ccpu["usageNanoCores"], "n"), "memory": roundedUnits(cmem["workingSetBytes"], "")}})
		}
		if len(containers) > 0 {
			item := obj{"metadata": obj{"name": refName, "namespace": refNamespace}, "containers": containers, "source": "kubelet"}
			if t := objOf(pod["cpu"])["time"]; t != nil {
				item["timestamp"] = t
			}
			pods = append(pods, item)
		}
	}
	return nodeItem, pods, nil
}
