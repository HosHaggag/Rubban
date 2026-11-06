package server

import (
	"errors"
	"strings"
	"time"
)

// Bounded log reads for the incident snapshot (/api/logs/tail): the last N lines of one container,
// or of its previous run, as one JSON answer instead of a WebSocket stream. kubectl runs with
// --follow=false, a byte cap and a timeout, so a chatty container cannot hold the request open.

const (
	logTailBytes   = 512 * 1024
	logTailTimeout = 20 * time.Second
)

func init() {
	registerRoutes(func(b *Backend, q *request) (any, int, bool, error) {
		if q.method != "GET" || q.route != "/api/logs/tail" {
			return nil, 0, false, nil
		}
		v, err := b.routeLogTail(q)
		return v, 200, true, err
	})
}

// logTailArgs builds the kubectl command for one container's bounded tail.
func logTailArgs(query map[string]string) ([]string, error) {
	if query["selector"] != "" {
		return nil, bad("A log tail reads one pod; selectors are not supported")
	}
	if query["container"] == "" || query["container"] == "*" {
		return nil, bad("Name the container to read")
	}
	var tail any
	if v, ok := query["tail"]; ok {
		tail = v
	}
	if _, err := integer(tail, "tail lines", 1, 5000, fb(100)); err != nil {
		return nil, err
	}
	params := map[string]string{}
	for k, v := range query {
		params[k] = v
	}
	params["follow"] = "false"
	delete(params, "since")
	delete(params, "timestamps")
	args, err := logArgs(params)
	if err != nil {
		return nil, err
	}
	return append(args, "--limit-bytes="+itoa(logTailBytes)), nil
}

func (b *Backend) routeLogTail(q *request) (any, error) {
	args, err := logTailArgs(q.query)
	if err != nil {
		return nil, err
	}
	previous := q.query["previous"] == "true"
	res, err := b.kube(q.ctx, args, RunOptions{Timeout: logTailTimeout, MaxBytes: logTailBytes + 64*1024})
	if err != nil {
		// A container that has not started yet, or has no previous run, has no logs to read: that is an
		// answer for the report, not a failure.
		var re *runError
		if errors.As(err, &re) {
			if detail := strings.TrimSpace(re.Result.Stderr); logsUnavailable(detail) {
				return obj{"text": "", "unavailable": firstLine(detail), "previous": previous}, nil
			}
		}
		return nil, err
	}
	// The kubelet answers with this single line, as log text, when the container is already gone.
	if line := strings.TrimSpace(res.Stdout); strings.HasPrefix(line, "unable to retrieve container logs for ") && !strings.Contains(line, "\n") {
		return obj{"text": "", "unavailable": "the container was removed before its logs could be read", "previous": previous}, nil
	}
	return obj{"text": res.Stdout, "truncated": len(res.Stdout) >= logTailBytes, "previous": previous}, nil
}

// logsUnavailable reports kubectl's answer for a container without logs: no previous run yet, or a
// container still waiting to start (image pull, configuration error, scheduling).
func logsUnavailable(message string) bool {
	return (strings.Contains(message, "previous terminated container") && strings.Contains(message, "not found")) ||
		strings.Contains(message, "is waiting to start") || strings.Contains(message, "ContainerCreating") ||
		strings.Contains(message, "PodInitializing")
}
