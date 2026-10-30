package server

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

func svc(namespace, name string, ports ...any) map[string]any {
	return map[string]any{"metadata": map[string]any{"namespace": namespace, "name": name}, "spec": map[string]any{"ports": ports}}
}

func svcPort(name string, port int) map[string]any { return map[string]any{"name": name, "port": port} }

const probeQuery = "/api/v1/query?query=vector(1)"

// promCluster answers the service list and probes: reachable names answer success, the rest fail.
func promCluster(t *testing.T, services []any, reachable ...string) *xfixture {
	return newXFixture(t, func(c call) Result {
		if hasArg(c.Args, "get") && hasArg(c.Args, "services") {
			return out(map[string]any{"items": services}, 0)
		}
		raw := rawPath(c.Args)
		for _, name := range reachable {
			if strings.Contains(raw, ":"+name+":") && strings.HasSuffix(raw, probeQuery) {
				return out(map[string]any{"status": "success", "data": map[string]any{"result": []any{}}}, 0)
			}
		}
		if strings.Contains(raw, "/query_range?") {
			return out(map[string]any{"status": "success", "data": map[string]any{"result": []any{}}}, 0)
		}
		return fail("Error from server (ServiceUnavailable)")
	})
}

func providerOf(res response) map[string]any {
	p, _ := res.Value["provider"].(map[string]any)
	return p
}

func probes(x *xfixture) []string {
	var out []string
	for _, c := range x.find(func(a []string) bool { return strings.HasSuffix(rawPath(a), probeQuery) }) {
		out = append(out, rawPath(c.Args))
	}
	return out
}

func TestPrometheusProviderAutoDetectsScoresAndCaches(t *testing.T) {
	withLive(t, nil)
	x := promCluster(t, []any{
		svc("default", "my-prometheus-thing", svcPort("web", 9090)),
		svc("monitoring", "prometheus-operated", svcPort("web", 9090)),
		svc("observability", "thanos-query", svcPort("grpc", 10901), svcPort("http", 10902)),
		svc("apps", "unrelated", svcPort("http", 80)),
		svc("tls", "prometheus-k8s", svcPort("", 443)),
		svc("empty", "prometheus-server"),
	}, "prometheus-operated", "thanos-query")
	res := x.get("/api/prometheus/provider?context=dev")
	if res.Status != 200 {
		t.Fatalf("%d %s", res.Status, res.Raw)
	}
	want := map[string]any{"namespace": "observability", "service": "thanos-query", "port": float64(10902), "prefix": "", "scheme": "http", "source": "auto-detected"}
	if !reflect.DeepEqual(providerOf(res), want) {
		t.Fatalf("provider %s", res.Raw)
	}
	// Highest score first (thanos 100 + 5), then prometheus-operated.
	if got := probes(x); len(got) != 1 || got[0] != "/api/v1/namespaces/observability/services/http:thanos-query:10902/proxy"+probeQuery {
		t.Fatalf("probes %v", got)
	}
	again := x.get("/api/prometheus/provider?context=dev")
	if !reflect.DeepEqual(providerOf(again), want) || len(probes(x)) != 1 {
		t.Fatal("the provider must be cached")
	}
	listCalls := func() int {
		return len(x.find(func(a []string) bool { return hasArg(a, "services") }))
	}
	if listCalls() != 1 {
		t.Fatalf("service lists %d", listCalls())
	}
	x.get("/api/prometheus/provider?context=dev&refresh=1")
	if listCalls() != 2 {
		t.Fatal("refresh=1 must detect again")
	}
	// The cache expires after five minutes.
	st := x.b.xstate()
	st.mu.Lock()
	st.now = func() time.Time { return time.Now().Add(6 * time.Minute) }
	st.mu.Unlock()
	x.get("/api/prometheus/provider?context=dev")
	if listCalls() != 3 {
		t.Fatal("expired cache must detect again")
	}
}

func TestPrometheusProviderProbesAtMostFourCandidatesAndCachesTheFailure(t *testing.T) {
	withLive(t, nil)
	services := []any{}
	for _, name := range []string{"prometheus-a", "prometheus-b", "prometheus-c", "prometheus-d", "prometheus-e"} {
		services = append(services, svc("monitoring", name, svcPort("http", 9090)))
	}
	x := promCluster(t, services)
	res := x.get("/api/prometheus/provider?context=dev")
	if res.Status != 200 || res.Value["provider"] != nil || !strings.Contains(res.Value["error"].(string), "No Prometheus or Thanos query service was found") {
		t.Fatalf("%s", res.Raw)
	}
	if len(probes(x)) != 4 {
		t.Fatalf("probes %v", probes(x))
	}
	x.get("/api/prometheus/provider?context=dev")
	if len(probes(x)) != 4 {
		t.Fatal("a failed detection is cached too")
	}
	// A different context is detected separately.
	x.get("/api/prometheus/provider?context=other")
	if len(probes(x)) != 8 {
		t.Fatalf("probes %d", len(probes(x)))
	}
}

func TestPrometheusProviderFromSettings(t *testing.T) {
	withLive(t, nil)
	x := promCluster(t, nil)
	put := x.do("PUT", "/api/preferences", map[string]any{"prometheusByContext": map[string]any{
		"svc":   map[string]any{"mode": "service", "namespace": "mon", "service": "prom", "port": 9091, "prefix": "/prometheus//", "scheme": "https"},
		"plain": map[string]any{"mode": "service", "namespace": "mon", "service": "prom", "port": "9090"},
		"off":   map[string]any{"mode": "off"},
		"badp":  map[string]any{"mode": "service", "namespace": "mon", "service": "prom", "port": 9090, "prefix": "/a b"},
		"port":  map[string]any{"mode": "service", "namespace": "mon", "service": "prom", "port": 70000},
	}}, nil)
	if put.Status != 200 {
		t.Fatalf("prefs %d", put.Status)
	}
	if got := providerOf(x.get("/api/prometheus/provider?context=svc")); !reflect.DeepEqual(got, map[string]any{"namespace": "mon", "service": "prom", "port": float64(9091), "prefix": "/prometheus", "scheme": "https", "source": "settings"}) {
		t.Fatalf("service %v", got)
	}
	if got := providerOf(x.get("/api/prometheus/provider?context=plain")); got["port"] != float64(9090) || got["scheme"] != "http" || got["prefix"] != "" {
		t.Fatalf("plain %v", got)
	}
	off := x.get("/api/prometheus/provider?context=off")
	if off.Status != 200 || off.Value["provider"] != nil || off.Value["error"] != "Prometheus is turned off for this cluster in Settings" {
		t.Fatalf("off %s", off.Raw)
	}
	if r := x.get("/api/prometheus/provider?context=badp"); r.Value["error"] != "Invalid Prometheus path prefix" {
		t.Fatalf("prefix %s", r.Raw)
	}
	if r := x.get("/api/prometheus/provider?context=port"); r.Value["error"] != "Invalid Prometheus port" {
		t.Fatalf("port %s", r.Raw)
	}
	if len(x.commands()) != 0 {
		t.Fatalf("settings need no cluster calls: %v", x.commands())
	}
	if x.get("/api/prometheus/provider").Status != 400 {
		t.Fatal("context is required")
	}
}

func TestPrometheusProviderWithoutLiveConnection(t *testing.T) {
	x := newXFixture(t, func(call) Result { return Result{} })
	res := x.get("/api/prometheus/provider?context=dev")
	if res.Status != 200 || res.Value["provider"] != nil || !strings.Contains(res.Value["error"].(string), "needs the live cluster connection") {
		t.Fatalf("%s", res.Raw)
	}
	if got := x.post("/api/prometheus/range", map[string]any{"context": "dev", "queries": map[string]any{"a": "up"}}).Status; got != 503 {
		t.Fatalf("range status %d", got)
	}
}

func TestPrometheusRange(t *testing.T) {
	withLive(t, nil)
	x := newXFixture(t, func(c call) Result {
		raw := rawPath(c.Args)
		switch {
		case hasArg(c.Args, "services"):
			return out(map[string]any{"items": []any{svc("monitoring", "prometheus-operated", svcPort("web", 9090))}}, 0)
		case strings.HasSuffix(raw, probeQuery):
			return out(map[string]any{"status": "success"}, 0)
		case strings.Contains(raw, "query=bad"):
			return out(map[string]any{"status": "error", "error": "parse error: unexpected identifier"}, 0)
		case strings.Contains(raw, "query_range?"):
			results := []any{}
			for i := 0; i < 60; i++ {
				results = append(results, map[string]any{"metric": map[string]any{"pod": "p" + itoa(i)}, "values": []any{[]any{1700000000, "1.5"}, []any{1700000060, "NaN"}, []any{1700000120, "+Inf"}}})
			}
			return out(map[string]any{"status": "success", "data": map[string]any{"result": results}}, 0)
		}
		return fail("unexpected " + raw)
	})
	res := x.post("/api/prometheus/range", map[string]any{
		"context": "dev", "start": 1700000000, "end": 1700003600, "step": 30,
		"queries": map[string]any{"cpu": `sum(rate(x{a="b c"}[5m]))`, "bad": "bad", "Bad Key": "up", "blank": "  ", "num": 5},
	})
	if res.Status != 200 {
		t.Fatalf("%d %s", res.Status, res.Raw)
	}
	if res.Value["start"] != float64(1700000000) || res.Value["end"] != float64(1700003600) || res.Value["step"] != float64(30) {
		t.Fatalf("window %s", res.Raw)
	}
	if providerOf(res)["service"] != "prometheus-operated" {
		t.Fatalf("provider %s", res.Raw)
	}
	series := res.Value["series"].(map[string]any)
	cpu := series["cpu"].([]any)
	if len(cpu) != 50 {
		t.Fatalf("series limit %d", len(cpu))
	}
	first := cpu[0].(map[string]any)
	if first["metric"].(map[string]any)["pod"] != "p0" || !reflect.DeepEqual(first["values"], []any{[]any{float64(1700000000), 1.5}, []any{float64(1700000060), nil}, []any{float64(1700000120), nil}}) {
		t.Fatalf("values %v", first)
	}
	errs := res.Value["errors"].(map[string]any)
	if errs["bad"] != "parse error: unexpected identifier" || errs["Bad Key"] != "Invalid query" || errs["blank"] != "Invalid query" || errs["num"] != "Invalid query" || len(errs) != 4 {
		t.Fatalf("errors %v", errs)
	}
	ranges := x.find(func(a []string) bool { return strings.Contains(rawPath(a), "query_range?query=sum") })
	if len(ranges) != 1 {
		t.Fatal("query_range not requested")
	}
	wantPath := "/api/v1/namespaces/monitoring/services/http:prometheus-operated:9090/proxy/api/v1/query_range?query=sum%28rate%28x%7Ba%3D%22b+c%22%7D%5B5m%5D%29%29&start=1700000000&end=1700003600&step=30"
	if rawPath(ranges[0].Args) != wantPath {
		t.Fatalf("path %s", rawPath(ranges[0].Args))
	}
}

func TestPrometheusRangeValidation(t *testing.T) {
	withLive(t, nil)
	x := promCluster(t, []any{svc("monitoring", "prometheus-operated", svcPort("web", 9090))}, "prometheus-operated")
	valid := map[string]any{"a": "up"}
	many := map[string]any{}
	for i := 0; i < 17; i++ {
		many["k"+itoa(i)] = "up"
	}
	for name, body := range map[string]map[string]any{
		"no context":    {"queries": valid},
		"no queries":    {"context": "dev"},
		"empty queries": {"context": "dev", "queries": map[string]any{}},
		"array queries": {"context": "dev", "queries": []any{"up"}},
		"too many":      {"context": "dev", "queries": many},
		"inverted":      {"context": "dev", "queries": valid, "start": 100, "end": 50},
		"too many pts":  {"context": "dev", "queries": valid, "start": 0, "end": 1000000, "step": 5},
		"step range":    {"context": "dev", "queries": valid, "step": 4},
		"bad end":       {"context": "dev", "queries": valid, "end": "x"},
		"null start":    {"context": "dev", "queries": valid, "start": nil},
	} {
		if r := x.post("/api/prometheus/range", body); r.Status != 400 {
			t.Fatalf("%s: %d %s", name, r.Status, r.Raw)
		}
	}
	ok := x.post("/api/prometheus/range", map[string]any{"context": "dev", "queries": valid})
	if ok.Status != 200 || ok.Value["step"] != float64(60) || ok.Value["end"].(float64)-ok.Value["start"].(float64) != 3600 {
		t.Fatalf("defaults: %d %s", ok.Status, ok.Raw)
	}
	off := newXFixture(t, func(call) Result { return Result{} })
	off.do("PUT", "/api/preferences", map[string]any{"prometheusByContext": map[string]any{"dev": map[string]any{"mode": "off"}}}, nil)
	if r := off.post("/api/prometheus/range", map[string]any{"context": "dev", "queries": valid}); r.Status != 404 {
		t.Fatalf("provider gone: %d %s", r.Status, r.Raw)
	}
}
