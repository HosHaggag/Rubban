package server

import (
	"net/url"
	"reflect"
	"strings"
	"testing"
)

// rightsizingCluster answers the Prometheus discovery and the three rightsizing instant queries.
func rightsizingCluster(t *testing.T, answer func(query string) Result) *xfixture {
	return newXFixture(t, func(c call) Result {
		raw := rawPath(c.Args)
		switch {
		case hasArg(c.Args, "services"):
			return out(map[string]any{"items": []any{svc("monitoring", "prometheus-operated", svcPort("web", 9090))}}, 0)
		case strings.HasSuffix(raw, probeQuery):
			return out(map[string]any{"status": "success"}, 0)
		case strings.Contains(raw, "/api/v1/query?"):
			u, err := url.Parse(raw)
			if err != nil {
				t.Fatal(err)
			}
			return answer(u.Query().Get("query"))
		}
		return fail("unexpected " + raw)
	})
}

func vector(samples ...map[string]any) Result {
	return out(map[string]any{"status": "success", "data": map[string]any{"resultType": "vector", "result": samples}}, 0)
}

func sample(ns, pod, container, value string) map[string]any {
	return map[string]any{"metric": map[string]any{"namespace": ns, "pod": pod, "container": container}, "value": []any{1700000000, value}}
}

func TestRightsizingHistory(t *testing.T) {
	withLive(t, nil)
	x := rightsizingCluster(t, func(query string) Result {
		switch {
		case strings.Contains(query, "container_cpu_usage_seconds_total"):
			return vector(sample("shop", "cart-5f6d7c8b9-aaaaa", "app", "0.012"), sample("shop", "cart-5f6d7c8b9-aaaaa", "proxy", "NaN"), map[string]any{"metric": map[string]any{"pod": "x"}, "value": []any{1, "1"}})
		case strings.HasPrefix(query, "time()"):
			return out(map[string]any{"status": "success", "data": map[string]any{"resultType": "vector", "result": []any{map[string]any{"metric": map[string]any{}, "value": []any{1, "302400"}}}}}, 0)
		case strings.Contains(query, "container_memory_working_set_bytes"):
			return vector(sample("shop", "cart-5f6d7c8b9-aaaaa", "app", "41943040"), sample("shop", "orders-0", "app", "1048576"))
		}
		return fail("unexpected query " + query)
	})
	res := x.post("/api/rightsizing/history", map[string]any{"context": "dev", "namespace": "shop", "days": 7})
	if res.Status != 200 {
		t.Fatalf("%d %s", res.Status, res.Raw)
	}
	if providerOf(res)["service"] != "prometheus-operated" || res.Value["days"] != float64(7) || res.Value["coverageSeconds"] != float64(302400) || res.Value["truncated"] != false {
		t.Fatalf("answer %s", res.Raw)
	}
	want := []any{
		map[string]any{"namespace": "shop", "pod": "cart-5f6d7c8b9-aaaaa", "container": "app", "cpu": 0.012, "memory": float64(41943040)},
		map[string]any{"namespace": "shop", "pod": "cart-5f6d7c8b9-aaaaa", "container": "proxy", "cpu": nil, "memory": nil},
		map[string]any{"namespace": "shop", "pod": "orders-0", "container": "app", "cpu": nil, "memory": float64(1048576)},
	}
	if !reflect.DeepEqual(res.Value["containers"], want) {
		t.Fatalf("containers %v", res.Value["containers"])
	}
	queries := x.find(func(a []string) bool {
		return strings.Contains(rawPath(a), "/api/v1/query?") && !strings.HasSuffix(rawPath(a), probeQuery)
	})
	if len(queries) != 3 {
		t.Fatalf("queries %d", len(queries))
	}
	for _, c := range queries {
		raw := rawPath(c.Args)
		if !strings.HasPrefix(raw, "/api/v1/namespaces/monitoring/services/http:prometheus-operated:9090/proxy/api/v1/query?query=") || !strings.Contains(raw, "&time=") {
			t.Fatalf("path %s", raw)
		}
		if !hasArg(c.Args, "--request-timeout=60s") {
			t.Fatalf("timeout %v", c.Args)
		}
		u, _ := url.Parse(raw)
		if q := u.Query().Get("query"); !strings.Contains(q, `namespace="shop"`) || !strings.Contains(q, `container!="POD"`) || !strings.Contains(q, "7d") {
			t.Fatalf("query %s", q)
		}
	}
}

func TestRightsizingHistoryReportsQueryErrorsAndAllNamespaces(t *testing.T) {
	withLive(t, nil)
	x := rightsizingCluster(t, func(query string) Result {
		if strings.Contains(query, "namespace=") {
			t.Errorf("all namespaces must not filter: %s", query)
		}
		if strings.Contains(query, "container_cpu_usage_seconds_total") {
			return out(map[string]any{"status": "error", "error": "query timed out"}, 0)
		}
		return vector()
	})
	res := x.post("/api/rightsizing/history", map[string]any{"context": "dev", "namespace": "*"})
	if res.Status != 200 {
		t.Fatalf("%d %s", res.Status, res.Raw)
	}
	if errs := res.Value["errors"].(map[string]any); errs["cpu"] != "query timed out" || len(errs) != 1 {
		t.Fatalf("errors %v", errs)
	}
	if res.Value["days"] != float64(7) || len(res.Value["containers"].([]any)) != 0 || res.Value["coverageSeconds"] != nil {
		t.Fatalf("answer %s", res.Raw)
	}
}

func TestRightsizingHistoryValidation(t *testing.T) {
	off := newXFixture(t, func(call) Result { return Result{} })
	if r := off.post("/api/rightsizing/history", map[string]any{"context": "dev"}); r.Status != 503 {
		t.Fatalf("without live: %d %s", r.Status, r.Raw)
	}
	withLive(t, nil)
	x := rightsizingCluster(t, func(string) Result { return vector() })
	for name, body := range map[string]map[string]any{
		"no context":    {"namespace": "*"},
		"bad namespace": {"context": "dev", "namespace": `shop"} or vector(1) #`},
		"days low":      {"context": "dev", "days": 0},
		"days high":     {"context": "dev", "days": 31},
		"days text":     {"context": "dev", "days": "seven"},
	} {
		if r := x.post("/api/rightsizing/history", body); r.Status != 400 {
			t.Fatalf("%s: %d %s", name, r.Status, r.Raw)
		}
	}
	x.do("PUT", "/api/preferences", map[string]any{"prometheusByContext": map[string]any{"dev": map[string]any{"mode": "off"}}}, nil)
	if r := x.post("/api/rightsizing/history", map[string]any{"context": "dev"}); r.Status != 404 {
		t.Fatalf("turned off: %d %s", r.Status, r.Raw)
	}
}

func TestRightsizingQueries(t *testing.T) {
	q := rightsizingQueries("*", 3)
	if strings.Contains(q["cpu"], "namespace=") || !strings.Contains(q["cpu"], "[3d:5m]") || !strings.Contains(q["memory"], "[3d]") || !strings.Contains(q["coverage"], "[3d:1h]") {
		t.Fatalf("%v", q)
	}
	if !strings.Contains(rightsizingQueries("data", 7)["memory"], `namespace="data"`) {
		t.Fatal("namespace filter")
	}
}
