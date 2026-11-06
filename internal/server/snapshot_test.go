package server

import (
	"reflect"
	"strings"
	"testing"
)

func TestLogTailArgs(t *testing.T) {
	args, err := logTailArgs(map[string]string{"context": "dev", "namespace": "shop", "pod": "web-1", "container": "app", "tail": "50", "previous": "true", "follow": "true", "since": "60", "timestamps": "true"})
	want := []string{"--context=dev", "--namespace=shop", "logs", "web-1", "--follow=false", "--tail=50", "--container=app", "--previous=true", "--limit-bytes=524288"}
	if err != nil || !reflect.DeepEqual(args, want) {
		t.Fatalf("%v %v", args, err)
	}
	for name, query := range map[string]map[string]string{
		"selector":       {"context": "dev", "namespace": "shop", "selector": "app=web", "container": "app"},
		"no container":   {"context": "dev", "namespace": "shop", "pod": "web-1"},
		"all containers": {"context": "dev", "namespace": "shop", "pod": "web-1", "container": "*"},
		"tail too large": {"context": "dev", "namespace": "shop", "pod": "web-1", "container": "app", "tail": "100000"},
		"tail zero":      {"context": "dev", "namespace": "shop", "pod": "web-1", "container": "app", "tail": "0"},
		"bad pod":        {"context": "dev", "namespace": "shop", "pod": "--all", "container": "app"},
		"bad previous":   {"context": "dev", "namespace": "shop", "pod": "web-1", "container": "app", "previous": "yes"},
		"no context":     {"namespace": "shop", "pod": "web-1", "container": "app"},
	} {
		if _, err := logTailArgs(query); err == nil {
			t.Errorf("%s: accepted %v", name, query)
		}
	}
}

func TestLogTailRoute(t *testing.T) {
	f := newFixture(t, func(args []string, opts RunOptions) Result {
		joined := strings.Join(args, " ")
		switch {
		case strings.Contains(joined, "logs crashing") && strings.Contains(joined, "--previous=true"):
			return Result{Stdout: "starting\npanic: connection refused\n"}
		case strings.Contains(joined, "logs fresh") && strings.Contains(joined, "--previous=true"):
			return Result{Stderr: `Error from server (BadRequest): previous terminated container "app" in pod "fresh" not found`, Code: 1}
		case strings.Contains(joined, "logs pulling"):
			return Result{Stderr: `Error from server (BadRequest): container "app" in pod "pulling" is waiting to start: trying and failing to pull image`, Code: 1}
		case strings.Contains(joined, "logs removed"):
			return Result{Stdout: "unable to retrieve container logs for containerd://c60c7bda\n"}
		case strings.Contains(joined, "logs broken"):
			return Result{Stderr: "error: You must be logged in to the server (Unauthorized)", Code: 1}
		}
		return Result{Stdout: "line 1\nline 2\n"}
	})
	res := f.get("/api/logs/tail?context=dev&namespace=shop&pod=web-1&container=app&tail=2")
	if res.Status != 200 || res.Value["text"] != "line 1\nline 2\n" || res.Value["previous"] != false || res.Value["truncated"] != false {
		t.Fatalf("%d %v", res.Status, res.Value)
	}
	if call := f.last(); call.Opts.Timeout != logTailTimeout || !reflect.DeepEqual(call.Args[len(call.Args)-1], "--limit-bytes=524288") || !strings.Contains(strings.Join(call.Args, " "), "--follow=false --tail=2") {
		t.Fatalf("%+v", call)
	}
	res = f.get("/api/logs/tail?context=dev&namespace=shop&pod=crashing&container=app&previous=true")
	if res.Status != 200 || !strings.Contains(res.Value["text"].(string), "panic") || res.Value["previous"] != true {
		t.Fatalf("%d %v", res.Status, res.Value)
	}
	res = f.get("/api/logs/tail?context=dev&namespace=shop&pod=fresh&container=app&previous=true")
	if res.Status != 200 || res.Value["text"] != "" || !strings.Contains(res.Value["unavailable"].(string), "previous terminated container") {
		t.Fatalf("%d %v", res.Status, res.Value)
	}
	res = f.get("/api/logs/tail?context=dev&namespace=shop&pod=pulling&container=app")
	if res.Status != 200 || !strings.Contains(res.Value["unavailable"].(string), "waiting to start") {
		t.Fatalf("%d %v", res.Status, res.Value)
	}
	res = f.get("/api/logs/tail?context=dev&namespace=shop&pod=removed&container=app&previous=true")
	if res.Status != 200 || res.Value["text"] != "" || !strings.Contains(res.Value["unavailable"].(string), "removed") {
		t.Fatalf("%d %v", res.Status, res.Value)
	}
	if res = f.get("/api/logs/tail?context=dev&namespace=shop&pod=broken&container=app"); res.Status != 502 {
		t.Fatalf("%d %v", res.Status, res.Value)
	}
	if res = f.get("/api/logs/tail?context=dev&namespace=shop&selector=app%3Dweb&container=app"); res.Status != 400 {
		t.Fatalf("%d %v", res.Status, res.Value)
	}
	if res = f.do("POST", "/api/logs/tail?context=dev&namespace=shop&pod=web-1&container=app", map[string]any{}, nil); res.Status == 200 {
		t.Fatalf("POST accepted: %v", res.Value)
	}
}
