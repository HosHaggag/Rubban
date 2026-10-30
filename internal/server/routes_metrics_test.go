package server

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestMetricsScopesPodsByNamespaceAndReportsMissingMetrics(t *testing.T) {
	x := newXFixture(t, func(c call) Result {
		if strings.HasSuffix(rawPath(c.Args), "/nodes") && strings.Contains(rawPath(c.Args), "metrics.k8s.io") {
			return fail("metrics.k8s.io not available")
		}
		return out(map[string]any{"items": []any{map[string]any{"metadata": map[string]any{"name": "web"}}}}, 0)
	})
	res := x.get("/api/metrics?context=dev&namespace=apps")
	if res.Status != 200 {
		t.Fatalf("status %d %s", res.Status, res.Raw)
	}
	nodes := res.Value["nodes"].(map[string]any)["items"].([]any)
	pods := res.Value["pods"].(map[string]any)["items"].([]any)
	if len(nodes) != 0 || len(pods) != 1 {
		t.Fatalf("nodes=%v pods=%v", nodes, pods)
	}
	warnings := res.Value["warnings"].([]any)
	if len(warnings) != 1 || !strings.Contains(warnings[0].(string), "metrics.k8s.io not available") || !strings.HasPrefix(warnings[0].(string), "nodes metrics unavailable: ") {
		t.Fatalf("warnings %v", warnings)
	}
	if len(x.find(func(a []string) bool { return rawPath(a) == "/apis/metrics.k8s.io/v1beta1/namespaces/apps/pods" })) != 1 {
		t.Fatalf("namespaced pod path not requested: %v", x.commands())
	}
	if res.Value["missingNodes"] == nil || len(res.Value["missingNodes"].(map[string]any)) != 0 {
		t.Fatalf("missingNodes %v", res.Value["missingNodes"])
	}
	if bad := x.get("/api/metrics?context=dev&namespace=Bad_NS"); bad.Status != 400 {
		t.Fatalf("bad namespace status %d", bad.Status)
	}
	if bad := x.get("/api/metrics"); bad.Status != 400 {
		t.Fatalf("missing context status %d", bad.Status)
	}
}

func TestMetricsReadsNodesMetricsServerLeftOutFromTheKubelet(t *testing.T) {
	kubeletUp := true
	handler := func(c call) Result {
		raw := rawPath(c.Args)
		switch {
		case raw == "/apis/metrics.k8s.io/v1beta1/nodes":
			return out(map[string]any{"items": []any{map[string]any{"metadata": map[string]any{"name": "n1"}, "usage": map[string]any{"cpu": "500m", "memory": "1Gi"}}}}, 0)
		case raw == "/apis/metrics.k8s.io/v1beta1/pods":
			return out(map[string]any{"items": []any{map[string]any{"metadata": map[string]any{"name": "a", "namespace": "x"}, "containers": []any{map[string]any{"name": "c", "usage": map[string]any{"cpu": "1m", "memory": "1Mi"}}}}}}, 0)
		case raw == "/api/v1/nodes":
			return out(map[string]any{"items": []any{map[string]any{"metadata": map[string]any{"name": "n1"}}, map[string]any{"metadata": map[string]any{"name": "n2"}}}}, 0)
		case strings.HasPrefix(raw, "/api/v1/nodes/n2/proxy/stats/summary"):
			if !kubeletUp {
				return fail(`Error from server (Forbidden): nodes "n2" is forbidden: cannot get resource "nodes/proxy"`)
			}
			return out(map[string]any{
				"node": map[string]any{"cpu": map[string]any{"time": "t", "usageNanoCores": 2500000000}, "memory": map[string]any{"time": "t", "workingSetBytes": 1073741824}},
				"pods": []any{
					map[string]any{"podRef": map[string]any{"name": "a", "namespace": "x"}, "containers": []any{map[string]any{"name": "c", "cpu": map[string]any{"usageNanoCores": 5}, "memory": map[string]any{"workingSetBytes": 5}}}},
					map[string]any{"podRef": map[string]any{"name": "b", "namespace": "x"}, "containers": []any{map[string]any{"name": "c", "cpu": map[string]any{"usageNanoCores": 300000000}, "memory": map[string]any{"workingSetBytes": 2048}}}},
				},
			}, 0)
		}
		return out(map[string]any{"items": []any{}}, 0)
	}
	x := newXFixture(t, handler)
	res := x.get("/api/metrics?context=dev&namespace=*")
	if res.Status != 200 {
		t.Fatalf("status %d %s", res.Status, res.Raw)
	}
	type row struct {
		name   string
		usage  any
		source any
	}
	var nodes []row
	for _, it := range res.Value["nodes"].(map[string]any)["items"].([]any) {
		m := it.(map[string]any)
		nodes = append(nodes, row{m["metadata"].(map[string]any)["name"].(string), m["usage"], m["source"]})
	}
	want := []row{
		{"n1", map[string]any{"cpu": "500m", "memory": "1Gi"}, nil},
		{"n2", map[string]any{"cpu": "2500000000n", "memory": "1073741824"}, "kubelet"},
	}
	if !reflect.DeepEqual(nodes, want) {
		t.Fatalf("nodes %v", nodes)
	}
	// Pods metrics-server already reported are kept; only the missing ones are added.
	var pods [][2]any
	for _, it := range res.Value["pods"].(map[string]any)["items"].([]any) {
		m := it.(map[string]any)
		pods = append(pods, [2]any{m["metadata"].(map[string]any)["name"], m["source"]})
	}
	if !reflect.DeepEqual(pods, [][2]any{{"a", nil}, {"b", "kubelet"}}) {
		t.Fatalf("pods %v", pods)
	}
	summary := x.find(func(a []string) bool {
		return rawPath(a) == "/api/v1/nodes/n2/proxy/stats/summary?only_cpu_and_memory=true"
	})
	if len(summary) != 1 || !hasArg(summary[0].Args, "--request-timeout=8s") {
		t.Fatalf("kubelet summary calls %v", summary)
	}

	kubeletUp = false
	failing := newXFixture(t, func(c call) Result {
		raw := rawPath(c.Args)
		switch {
		case raw == "/apis/metrics.k8s.io/v1beta1/nodes":
			return out(map[string]any{"items": []any{}}, 0)
		case raw == "/api/v1/nodes":
			return out(map[string]any{"items": []any{map[string]any{"metadata": map[string]any{"name": "n2"}}}}, 0)
		case strings.HasPrefix(raw, "/api/v1/nodes/n2/proxy"):
			return fail(`Error from server (Forbidden): cannot get resource "nodes/proxy"`)
		}
		return out(map[string]any{"items": []any{}}, 0)
	})
	missing := failing.get("/api/metrics?context=dev&namespace=*").Value["missingNodes"].(map[string]any)
	reason, _ := missing["n2"].(string)
	if !strings.HasPrefix(reason, "metrics-server has no sample for this node, and its kubelet could not be read: ") || !strings.Contains(reason, "nodes/proxy") {
		t.Fatalf("reason %q", reason)
	}
	failing.get("/api/metrics?context=dev&namespace=*")
	kubeletCalls := func() int {
		return len(failing.find(func(a []string) bool { return strings.HasPrefix(rawPath(a), "/api/v1/nodes/n2/proxy") }))
	}
	if kubeletCalls() != 1 {
		t.Fatalf("a failing kubelet is retried after a minute, not on every refresh: %d calls", kubeletCalls())
	}
	// After the cache entry expires the kubelet is asked again.
	st := failing.b.xstate()
	st.mu.Lock()
	st.now = func() time.Time { return time.Now().Add(2 * time.Minute) }
	st.mu.Unlock()
	failing.get("/api/metrics?context=dev&namespace=*")
	if kubeletCalls() != 2 {
		t.Fatalf("expected a retry after the failure expired: %d calls", kubeletCalls())
	}
}

func TestMetricsKubeletReadsAtMostTwentyNodes(t *testing.T) {
	items := []any{}
	for i := 0; i < 25; i++ {
		items = append(items, map[string]any{"metadata": map[string]any{"name": "node-" + itoa(i)}})
	}
	x := newXFixture(t, func(c call) Result {
		raw := rawPath(c.Args)
		switch {
		case raw == "/apis/metrics.k8s.io/v1beta1/nodes":
			return out(map[string]any{"items": []any{}}, 0)
		case raw == "/api/v1/nodes":
			return out(map[string]any{"items": items}, 0)
		case strings.Contains(raw, "/proxy/stats/summary"):
			return out(map[string]any{"node": map[string]any{"cpu": map[string]any{"usageNanoCores": 1}, "memory": map[string]any{"workingSetBytes": 2}}}, 0)
		}
		return out(map[string]any{"items": []any{}}, 0)
	})
	res := x.get("/api/metrics?context=dev")
	if n := len(res.Value["nodes"].(map[string]any)["items"].([]any)); n != 20 {
		t.Fatalf("%d kubelet nodes", n)
	}
}
