package server

import (
	"context"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

func init() {
	registerRoutes(func(b *Backend, q *request) (any, int, bool, error) {
		switch {
		case q.method == "GET" && q.route == "/api/prometheus/provider":
			v, err := b.routePrometheusProvider(q)
			return v, 200, true, err
		case q.method == "POST" && q.route == "/api/prometheus/range":
			v, err := b.routePrometheusRange(q)
			return v, 200, true, err
		}
		return nil, 0, false, nil
	})
}

const prometheusCacheTTL = 5 * time.Minute

type prometheusCandidate struct {
	pattern *regexp.Regexp
	score   int
}

var prometheusCandidates = []prometheusCandidate{
	{regexp.MustCompile(`(?i)thanos.*(query|querier)(-frontend)?$`), 100},
	{regexp.MustCompile(`(?i)^prometheus-operated$`), 90},
	{regexp.MustCompile(`(?i)prometheus(-kube)?-prometheus$`), 85},
	{regexp.MustCompile(`(?i)^(kube-)?prometheus(-stack)?-prometheus$`), 84},
	{regexp.MustCompile(`(?i)^prometheus-server$`), 80},
	{regexp.MustCompile(`(?i)^prometheus(-k8s)?$`), 78},
	{regexp.MustCompile(`(?i)vmselect|victoria-metrics-single|vmsingle`), 60},
	{regexp.MustCompile(`(?i)prometheus`), 40},
}

var (
	prometheusPorts       = []int{9090, 10902, 9091, 8481, 8428, 80, 443}
	prometheusPortNameRE  = regexp.MustCompile(`(?i)http|web|query|^$`)
	monitoringNamespaceRE = regexp.MustCompile(`monitoring|observability|prometheus|thanos`)
	prometheusPrefixRE    = regexp.MustCompile(`^/[A-Za-z0-9._~\-/]*$`)
	prometheusKeyRE       = regexp.MustCompile(`^[A-Za-z0-9_-]{1,40}$`)
)

// prometheusProvider is the service queries go through (the API server's service proxy).
type prometheusProvider struct {
	Namespace string `json:"namespace"`
	Service   string `json:"service"`
	Port      int    `json:"port"`
	Prefix    string `json:"prefix"`
	Scheme    string `json:"scheme"`
	Source    string `json:"source"`
}

type promCacheEntry struct {
	at       time.Time
	provider *prometheusProvider
	err      error
}

func (p *prometheusProvider) proxyBase() string {
	return "/api/v1/namespaces/" + encodeURIComponent(p.Namespace) + "/services/" + p.Scheme + ":" + encodeURIComponent(p.Service) + ":" + strconv.Itoa(p.Port) + "/proxy" + p.Prefix
}

func inPrometheusPorts(port int) bool {
	for _, p := range prometheusPorts {
		if p == port {
			return true
		}
	}
	return false
}

// servicePort picks the port to query: a well-known port with a web-like name, any well-known port,
// else the first one.
func servicePort(ports []any) (name string, number int, ok bool) {
	portNumber := func(p any) int { return int(numOf(objOf(p)["port"])) }
	for _, p := range ports {
		if inPrometheusPorts(portNumber(p)) && prometheusPortNameRE.MatchString(strOf(objOf(p)["name"])) {
			return strOf(objOf(p)["name"]), portNumber(p), true
		}
	}
	for _, p := range ports {
		if inPrometheusPorts(portNumber(p)) {
			return strOf(objOf(p)["name"]), portNumber(p), true
		}
	}
	if len(ports) > 0 {
		return strOf(objOf(ports[0])["name"]), portNumber(ports[0]), true
	}
	return "", 0, false
}

// prometheusProviderFor resolves the provider for a context: Settings first, else auto-detection
// (cached for five minutes, errors included).
func (b *Backend) prometheusProviderFor(ctx context.Context, kubeContext string, prefs map[string]any, refresh bool) (*prometheusProvider, error) {
	configured := objOf(objOf(prefs["prometheusByContext"])[kubeContext])
	if configured != nil && configured["mode"] == "off" {
		return nil, problem("Prometheus is turned off for this cluster in Settings", 404)
	}
	if configured != nil && configured["mode"] == "service" {
		namespace, err := validateNamespace(configured["namespace"], false)
		if err != nil {
			return nil, err
		}
		service, err := validateName(configured["service"], "Prometheus service")
		if err != nil {
			return nil, err
		}
		port, err := integer(configured["port"], "Prometheus port", 1, 65535, nil)
		if err != nil {
			return nil, err
		}
		prefix := ""
		if truthy(configured["prefix"]) {
			prefix = strings.TrimRight(jsString(configured["prefix"]), "/")
		}
		if prefix != "" && !prometheusPrefixRE.MatchString(prefix) {
			return nil, bad("Invalid Prometheus path prefix")
		}
		scheme := "http"
		if configured["scheme"] == "https" {
			scheme = "https"
		}
		return &prometheusProvider{Namespace: namespace, Service: service, Port: int(port), Prefix: prefix, Scheme: scheme, Source: "settings"}, nil
	}
	st := b.xstate()
	st.mu.Lock()
	cached, hit := st.prom[kubeContext]
	st.mu.Unlock()
	if !refresh && hit && st.now().Sub(cached.at) < prometheusCacheTTL {
		if cached.err != nil {
			return nil, cached.err
		}
		return cached.provider, nil
	}
	provider, err := b.detectPrometheus(ctx, kubeContext)
	if ctx.Err() == nil {
		st.mu.Lock()
		st.prom[kubeContext] = promCacheEntry{at: st.now(), provider: provider, err: err}
		st.mu.Unlock()
	}
	return provider, err
}

func (b *Backend) detectPrometheus(ctx context.Context, kubeContext string) (*prometheusProvider, error) {
	services, err := b.listObjects(ctx, kubeContext, "services", "*", ListOptions{})
	if err != nil {
		return nil, err
	}
	type candidate struct {
		score    int
		provider prometheusProvider
	}
	var candidates []candidate
	for _, it := range listOf(services["items"]) {
		service := objOf(it)
		meta := objOf(service["metadata"])
		name := strOf(meta["name"])
		var match *prometheusCandidate
		for i := range prometheusCandidates {
			if prometheusCandidates[i].pattern.MatchString(name) {
				match = &prometheusCandidates[i]
				break
			}
		}
		if match == nil {
			continue
		}
		_, port, ok := servicePort(listOf(objOf(service["spec"])["ports"]))
		if !ok {
			continue
		}
		namespace := strOf(meta["namespace"])
		score := match.score
		if monitoringNamespaceRE.MatchString(namespace) {
			score += 5
		}
		scheme := "http"
		if port == 443 {
			scheme = "https"
		}
		candidates = append(candidates, candidate{score, prometheusProvider{Namespace: namespace, Service: name, Port: port, Scheme: scheme, Source: "auto-detected"}})
	}
	sort.SliceStable(candidates, func(i, j int) bool { return candidates[i].score > candidates[j].score })
	if len(candidates) > 4 {
		candidates = candidates[:4]
	}
	for _, c := range candidates {
		provider := c.provider
		probe, err := b.rawGet(ctx, kubeContext, provider.proxyBase()+"/api/v1/query?query="+encodeURIComponent("vector(1)"), RawOptions{})
		if err == nil && objOf(probe)["status"] == "success" {
			return &provider, nil
		}
	}
	return nil, problem("No Prometheus or Thanos query service was found in this cluster. Set one in Settings › Metrics.", 404)
}

func (b *Backend) routePrometheusProvider(q *request) (any, error) {
	kubeContext, err := validateText(q.q("context"), "context")
	if err != nil {
		return nil, err
	}
	if !liveReady(b) {
		return obj{"provider": nil, "error": "Prometheus history needs the live cluster connection, which is not available in this session"}, nil
	}
	prefs, err := b.readPreferences()
	if err != nil {
		return obj{"provider": nil, "error": shortError(err)}, nil
	}
	provider, err := b.prometheusProviderFor(q.ctx, kubeContext, prefs, q.query["refresh"] == "1")
	if err != nil {
		return obj{"provider": nil, "error": shortError(err)}, nil
	}
	return obj{"provider": provider}, nil
}

func (b *Backend) routePrometheusRange(q *request) (any, error) {
	body := q.body
	kubeContext, err := validateText(body["context"], "context")
	if err != nil {
		return nil, err
	}
	if !liveReady(b) {
		return nil, problem("Prometheus queries need the live cluster connection", 503)
	}
	prefs, err := b.readPreferences()
	if err != nil {
		return nil, err
	}
	queries, ok := body["queries"].(map[string]any)
	if !ok || len(queries) == 0 || len(queries) > 16 {
		return nil, bad("Provide between 1 and 16 named queries")
	}
	end := time.Now().Unix()
	if _, present := body["end"]; present {
		if end, err = integer(body["end"], "end", 0, 4e9, nil); err != nil {
			return nil, err
		}
	}
	start := end - 3600
	if _, present := body["start"]; present {
		if start, err = integer(body["start"], "start", 0, 4e9, nil); err != nil {
			return nil, err
		}
	}
	step, err := integer(body["step"], "step", 5, 86400, fb(60))
	if err != nil {
		return nil, err
	}
	if end <= start || float64(end-start)/float64(step) > 11000 {
		return nil, bad("Invalid time range")
	}
	provider, err := b.prometheusProviderFor(q.ctx, kubeContext, prefs, body["refresh"] == true)
	if err != nil {
		return nil, err
	}
	series := obj{}
	errs := obj{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for key, value := range queries {
		wg.Add(1)
		go func() {
			defer wg.Done()
			query, isString := value.(string)
			if !prometheusKeyRE.MatchString(key) || !isString || jsTrim(query) == "" || jsLength(query) > 4000 {
				mu.Lock()
				errs[key] = "Invalid query"
				mu.Unlock()
				return
			}
			result, err := b.prometheusRangeQuery(q.ctx, kubeContext, provider, query, start, end, step)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				errs[key] = shortError(err)
				return
			}
			series[key] = result
		}()
	}
	wg.Wait()
	return obj{"provider": provider, "start": start, "end": end, "step": step, "series": series, "errors": errs}, nil
}

func (b *Backend) prometheusRangeQuery(ctx context.Context, kubeContext string, provider *prometheusProvider, query string, start, end, step int64) ([]any, error) {
	search := "query=" + formEncode(query) + "&start=" + strconv.FormatInt(start, 10) + "&end=" + strconv.FormatInt(end, 10) + "&step=" + strconv.FormatInt(step, 10)
	raw, err := b.rawGet(ctx, kubeContext, provider.proxyBase()+"/api/v1/query_range?"+search, RawOptions{})
	if err != nil {
		return nil, err
	}
	response := objOf(raw)
	if response["status"] != "success" {
		if msg := strOf(response["error"]); msg != "" {
			return nil, errf("%s", msg)
		}
		return nil, errf("Prometheus query failed")
	}
	out := []any{}
	for i, r := range listOf(objOf(response["data"])["result"]) {
		if i >= 50 {
			break
		}
		result := objOf(r)
		metric := objOf(result["metric"])
		if metric == nil {
			metric = obj{}
		}
		values := []any{}
		for _, pair := range listOf(result["values"]) {
			p := listOf(pair)
			if len(p) < 2 {
				values = append(values, []any{jsonUnit(math.NaN()), jsonUnit(math.NaN())})
				continue
			}
			values = append(values, []any{jsonUnit(numOf(p[0])), jsonUnit(numOf(p[1]))})
		}
		out = append(out, obj{"metric": metric, "values": values})
	}
	return out, nil
}
