package server

import (
	"math"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Rightsizing history: per container, the 95th percentile of CPU and the peak working-set memory
// over the last days, from the cluster's Prometheus. POST /api/rightsizing/history runs instant
// queries (not ranges: the answer is one number per container, and a range answer is capped at 50
// series) through the API server's service proxy, like the other Prometheus routes.

func init() {
	registerRoutes(func(b *Backend, q *request) (any, int, bool, error) {
		if q.method == "POST" && q.route == "/api/rightsizing/history" {
			v, err := b.routeRightsizingHistory(q)
			return v, 200, true, err
		}
		return nil, 0, false, nil
	})
}

const (
	rightsizingMaxSeries = 20000
	rightsizingTimeoutMs = 60000
)

// rightsizingQueries are the PromQL expressions for a window of days, scoped to one namespace or all.
// Pause containers and the pod-level cgroup (container="" or "POD") are left out.
func rightsizingQueries(namespace string, days int64) map[string]string {
	selector := `container!="",container!="POD"`
	if namespace != "" && namespace != "*" {
		selector += `,namespace="` + namespace + `"`
	}
	window := strconv.FormatInt(days, 10) + "d"
	return map[string]string{
		"cpu":      `max by (namespace, pod, container) (quantile_over_time(0.95, rate(container_cpu_usage_seconds_total{` + selector + `}[5m])[` + window + `:5m]))`,
		"memory":   `max by (namespace, pod, container) (max_over_time(container_memory_working_set_bytes{` + selector + `}[` + window + `]))`,
		"coverage": `time() - min_over_time(timestamp(count(container_memory_working_set_bytes{` + selector + `}))[` + window + `:1h])`,
	}
}

type rightsizingRow struct {
	Namespace string `json:"namespace"`
	Pod       string `json:"pod"`
	Container string `json:"container"`
	CPU       any    `json:"cpu"`
	Memory    any    `json:"memory"`
}

func (b *Backend) routeRightsizingHistory(q *request) (any, error) {
	body := q.body
	kubeContext, err := validateText(body["context"], "context")
	if err != nil {
		return nil, err
	}
	namespace, err := validateNamespace(body["namespace"], true)
	if err != nil {
		return nil, err
	}
	days, err := integer(body["days"], "days", 1, 30, fb(7))
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
	provider, err := b.prometheusProviderFor(q.ctx, kubeContext, prefs, false)
	if err != nil {
		return nil, err
	}
	now := time.Now().Unix()
	results := map[string][]any{}
	errs := obj{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for key, query := range rightsizingQueries(namespace, days) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, err := b.prometheusInstant(q, kubeContext, provider, query, now)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				errs[key] = shortError(err)
				return
			}
			results[key] = result
		}()
	}
	wg.Wait()

	rows := map[string]*rightsizingRow{}
	order := []string{}
	truncated := false
	for _, key := range []string{"cpu", "memory"} {
		for i, r := range results[key] {
			if i >= rightsizingMaxSeries {
				truncated = true
				break
			}
			sample := objOf(r)
			metric := objOf(sample["metric"])
			ns, pod, container := strOf(metric["namespace"]), strOf(metric["pod"]), strOf(metric["container"])
			if ns == "" || pod == "" || container == "" {
				continue
			}
			id := ns + "/" + pod + "/" + container
			row := rows[id]
			if row == nil {
				row = &rightsizingRow{Namespace: ns, Pod: pod, Container: container}
				rows[id] = row
				order = append(order, id)
			}
			value := jsonUnit(sampleValue(sample))
			if key == "cpu" {
				row.CPU = value
			} else {
				row.Memory = value
			}
		}
	}
	containers := make([]*rightsizingRow, 0, len(order))
	for _, id := range order {
		containers = append(containers, rows[id])
	}
	var coverage any
	if list := results["coverage"]; len(list) > 0 {
		coverage = jsonUnit(sampleValue(objOf(list[0])))
	}
	return obj{"provider": provider, "days": days, "time": now, "coverageSeconds": coverage, "containers": containers, "errors": errs, "truncated": truncated}, nil
}

// sampleValue is the number of an instant-vector sample ({"value": [time, "number"]}).
func sampleValue(sample obj) float64 {
	pair := listOf(sample["value"])
	if len(pair) < 2 {
		return math.NaN()
	}
	return numOf(pair[1])
}

// prometheusInstant runs one instant query and returns its vector (or a scalar as a one-sample vector).
func (b *Backend) prometheusInstant(q *request, kubeContext string, provider *prometheusProvider, query string, at int64) ([]any, error) {
	search := "query=" + formEncode(query) + "&time=" + strconv.FormatInt(at, 10)
	raw, err := b.rawGet(q.ctx, kubeContext, provider.proxyBase()+"/api/v1/query?"+search, RawOptions{TimeoutMs: rightsizingTimeoutMs})
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
	data := objOf(response["data"])
	switch strings.ToLower(strOf(data["resultType"])) {
	case "scalar":
		return []any{obj{"metric": obj{}, "value": data["result"]}}, nil
	case "vector", "":
		return listOf(data["result"]), nil
	}
	return nil, errf("Unexpected Prometheus result type %s", strOf(data["resultType"]))
}
