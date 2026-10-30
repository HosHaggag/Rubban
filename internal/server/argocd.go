package server

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// Argo CD application management through the Kubernetes API, using the same kubeconfig
// credentials and RBAC as every other Rubban action (no separate Argo CD login):
//   - refresh / hard refresh: the argocd.argoproj.io/refresh annotation the controller watches
//   - sync and rollback: an `operation` written on the Application, as the Argo CD API server does
//   - terminate: operationState.phase = Terminating (the Application CRD has no status subresource)
//   - auto-sync: spec.syncPolicy.automated
//   - delete: the resources finalizer decides cascading (foreground/background) or not

const (
	argoApps                = "applications.argoproj.io"
	argoResourcesFinalizer  = "resources-finalizer.argocd.argoproj.io"
	argoBusyMessage         = "Another operation is already in progress for this application"
	argoRollbackAutoMessage = "Turn off auto-sync before rolling back; Argo CD would otherwise sync forward again"
)

// argoSyncOptions maps the UI's boolean options to Argo CD sync option strings, in the order the
// Node backend emitted them.
var argoSyncOptions = []struct{ key, value string }{
	{"skipSchemaValidation", "Validate=false"},
	{"createNamespace", "CreateNamespace=true"},
	{"pruneLast", "PruneLast=true"},
	{"applyOutOfSyncOnly", "ApplyOutOfSyncOnly=true"},
	{"respectIgnoreDifferences", "RespectIgnoreDifferences=true"},
	{"serverSideApply", "ServerSideApply=true"},
	{"replace", "Replace=true"},
}

var (
	argoRevisionRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/@:+~-]*$`)
	argoKindRE     = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9]*$`)
	argoGroupRE    = regexp.MustCompile(`^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$`)
)

// argoTruthy is JavaScript truthiness for decoded JSON values.
func argoTruthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case float64:
		return t != 0
	case json.Number:
		f, err := t.Float64()
		return err != nil || f != 0
	}
	return true
}

func argoRevision(v any) (string, error) {
	if v == nil || v == "" {
		return "", nil
	}
	revision, err := validateTextOpt(v, "revision", true, 256)
	if err != nil {
		return "", err
	}
	if !argoRevisionRE.MatchString(revision) {
		return "", bad("Invalid revision")
	}
	return revision, nil
}

func argoResourceRef(entry any) (obj, error) {
	m, ok := entry.(map[string]any)
	if !ok || m == nil {
		return nil, bad("Invalid resource selection")
	}
	kind, err := validateTextOpt(m["kind"], "resource kind", true, 100)
	if err != nil {
		return nil, err
	}
	if !argoKindRE.MatchString(kind) {
		return nil, bad("Invalid resource kind")
	}
	group := ""
	if argoTruthy(m["group"]) {
		if group, err = validateTextOpt(m["group"], "resource group", true, 253); err != nil {
			return nil, err
		}
		if group != "" && !argoGroupRE.MatchString(group) {
			return nil, bad("Invalid resource group")
		}
	}
	name, err := validateName(m["name"], "resource name")
	if err != nil {
		return nil, err
	}
	namespace := ""
	if argoTruthy(m["namespace"]) {
		if namespace, err = validateNamespace(m["namespace"], false); err != nil {
			return nil, err
		}
	}
	return obj{"group": group, "kind": kind, "name": name, "namespace": namespace}, nil
}

var argoInitiatedBy = obj{"username": "rubban"}

func argoSyncOperation(options map[string]any) (obj, error) {
	var syncOptions []any
	for _, o := range argoSyncOptions {
		if options[o.key] == true {
			syncOptions = append(syncOptions, o.value)
		}
	}
	if policy := options["prunePropagationPolicy"]; argoTruthy(policy) {
		if policy != "foreground" && policy != "background" && policy != "orphan" {
			return nil, bad("Invalid prune propagation policy")
		}
		syncOptions = append(syncOptions, fmt.Sprintf("PrunePropagationPolicy=%v", policy))
	}
	force := obj{"force": options["force"] == true}
	strategy := obj{"hook": force}
	if options["applyOnly"] == true {
		strategy = obj{"apply": force}
	}
	sync := obj{"prune": options["prune"] == true, "dryRun": options["dryRun"] == true, "syncStrategy": strategy}
	if len(syncOptions) > 0 {
		sync["syncOptions"] = syncOptions
	}
	revision, err := argoRevision(options["revision"])
	if err != nil {
		return nil, err
	}
	if revision != "" {
		sync["revision"] = revision
	}
	if resources, present := options["resources"]; present {
		list, ok := resources.([]any)
		if !ok || len(list) > 1000 {
			return nil, bad("Resources must be a list of up to 1000 entries")
		}
		if len(list) > 0 {
			refs := make([]any, len(list))
			for i, entry := range list {
				if refs[i], err = argoResourceRef(entry); err != nil {
					return nil, err
				}
			}
			sync["resources"] = refs
		}
	}
	operation := obj{"initiatedBy": argoInitiatedBy, "sync": sync}
	if options["retry"] == true {
		limit, err := integer(options["retryLimit"], "retry limit", 1, 100, fb(5))
		if err != nil {
			return nil, err
		}
		operation["retry"] = obj{"limit": limit, "backoff": obj{"duration": "5s", "factor": 2, "maxDuration": "3m"}}
	}
	return operation, nil
}

// argoCD handles POST /api/argocd.
func (b *Backend) argoCD(ctx context.Context, body map[string]any) (any, error) {
	kubeContext, err := validateText(body["context"], "context")
	if err != nil {
		return nil, err
	}
	namespace, err := validateNamespace(body["namespace"], false)
	if err != nil {
		return nil, err
	}
	name, err := validateName(body["name"], "application")
	if err != nil {
		return nil, err
	}
	base := []string{"--context=" + kubeContext}
	if namespace != "" {
		base = append(base, "--namespace="+namespace)
	}
	kube := func(args ...string) (Result, error) {
		return b.kube(ctx, append(append([]string{}, base...), args...), RunOptions{})
	}
	read := func() (obj, error) {
		res, err := kube("get", argoApps, name, "--output=json")
		if err != nil {
			return nil, err
		}
		return parseObject(res, "kubectl")
	}
	patch := func(value any) error {
		data, err := json.Marshal(value)
		if err != nil {
			return err
		}
		_, err = kube("patch", argoApps, name, "--type=merge", "--patch="+string(data))
		return err
	}
	resourceVersion := func(app obj) any { return objOf(app["metadata"])["resourceVersion"] }
	done := func(output string) (any, error) { return obj{"output": output}, nil }

	action, _ := body["action"].(string)
	switch action {
	case "refresh", "hard-refresh":
		mode := "normal"
		if action == "hard-refresh" {
			mode = "hard"
		}
		res, err := kube("annotate", argoApps, name, "argocd.argoproj.io/refresh="+mode, "--overwrite")
		if err != nil {
			return nil, err
		}
		if out := strings.TrimSpace(res.Stdout); out != "" {
			return done(out)
		}
		return done(fmt.Sprintf("%s %s refresh requested", name, mode))
	case "sync":
		app, err := read()
		if err != nil {
			return nil, err
		}
		if app["operation"] != nil {
			return nil, problem(argoBusyMessage, 409)
		}
		options, _ := body["options"].(map[string]any)
		operation, err := argoSyncOperation(options)
		if err != nil {
			return nil, err
		}
		if err := patch(obj{"metadata": obj{"resourceVersion": resourceVersion(app)}, "operation": operation}); err != nil {
			return nil, err
		}
		sync := operation["sync"].(obj)
		message := name + ": "
		if sync["dryRun"] == true {
			message += "dry-run "
		}
		message += "sync requested"
		if revision, _ := sync["revision"].(string); revision != "" {
			message += " to " + revision
		}
		return done(message)
	case "rollback":
		app, err := read()
		if err != nil {
			return nil, err
		}
		if app["operation"] != nil {
			return nil, problem(argoBusyMessage, 409)
		}
		if objOf(objOf(app["spec"])["syncPolicy"])["automated"] != nil {
			return nil, problem(argoRollbackAutoMessage, 409)
		}
		id, err := integer(body["id"], "history id", 0, 1e9, nil)
		if err != nil {
			return nil, err
		}
		var entry obj
		for _, item := range listOf(objOf(app["status"])["history"]) {
			if m := objOf(item); argoNumber(m["id"]) == id {
				entry = m
				break
			}
		}
		if entry == nil {
			return nil, problem(fmt.Sprintf("History entry %d was not found", id), 404)
		}
		sync := obj{"prune": body["prune"] == true, "dryRun": body["dryRun"] == true, "syncStrategy": obj{"hook": obj{}}}
		if revisions := listOf(entry["revisions"]); len(revisions) > 0 {
			sync["revisions"] = revisions
			if entry["sources"] != nil {
				sync["sources"] = entry["sources"]
			}
		} else {
			if entry["revision"] != nil {
				sync["revision"] = entry["revision"]
			}
			if entry["source"] != nil {
				sync["source"] = entry["source"]
			}
		}
		if err := patch(obj{"metadata": obj{"resourceVersion": resourceVersion(app)}, "operation": obj{"initiatedBy": argoInitiatedBy, "sync": sync}}); err != nil {
			return nil, err
		}
		revision := strOf(entry["revision"])
		if !argoTruthy(entry["revision"]) {
			if revisions := listOf(entry["revisions"]); len(revisions) > 0 {
				revision = strOf(revisions[0])
			}
		}
		if r := []rune(revision); len(r) > 12 {
			revision = string(r[:12])
		}
		return done(fmt.Sprintf("%s: rollback to history %d (%s) requested", name, id, revision))
	case "terminate":
		app, err := read()
		if err != nil {
			return nil, err
		}
		if strOf(objOf(objOf(app["status"])["operationState"])["phase"]) != "Running" {
			return nil, problem("No operation is running for this application", 409)
		}
		if err := patch(obj{"metadata": obj{"resourceVersion": resourceVersion(app)}, "status": obj{"operationState": obj{"phase": "Terminating"}}}); err != nil {
			return nil, err
		}
		return done(name + ": termination requested")
	case "auto-sync":
		var automated any
		summary := "off"
		if body["enabled"] == true {
			prune, selfHeal := body["prune"] == true, body["selfHeal"] == true
			value := obj{"prune": prune, "selfHeal": selfHeal}
			if body["allowEmpty"] == true {
				value["allowEmpty"] = true
			}
			automated = value
			summary = "on"
			if prune {
				summary += " · prune"
			}
			if selfHeal {
				summary += " · self-heal"
			}
		}
		if err := patch(obj{"spec": obj{"syncPolicy": obj{"automated": automated}}}); err != nil {
			return nil, err
		}
		return done(fmt.Sprintf("%s: auto-sync %s", name, summary))
	case "delete":
		cascade := "foreground"
		if argoTruthy(body["cascade"]) {
			cascade, _ = body["cascade"].(string)
		}
		if cascade != "foreground" && cascade != "background" && cascade != "none" {
			return nil, bad("Cascade must be foreground, background or none")
		}
		app, err := read()
		if err != nil {
			return nil, err
		}
		finalizers := []any{}
		for _, item := range listOf(objOf(app["metadata"])["finalizers"]) {
			if s, ok := item.(string); !ok || !strings.HasPrefix(s, argoResourcesFinalizer) {
				finalizers = append(finalizers, item)
			}
		}
		if cascade == "background" {
			finalizers = append(finalizers, argoResourcesFinalizer+"/background")
		} else if cascade != "none" {
			finalizers = append(finalizers, argoResourcesFinalizer)
		}
		// Same resourceVersion guard as Argo CD: the finalizer must match the cascade the user chose.
		if err := patch(obj{"metadata": obj{"resourceVersion": resourceVersion(app), "finalizers": finalizers}}); err != nil {
			return nil, err
		}
		res, err := kube("delete", argoApps, name, "--wait=false")
		if err != nil {
			return nil, err
		}
		suffix := " (resources kept)"
		if cascade != "none" {
			suffix = fmt.Sprintf(" (%s cascade: Argo CD deletes the managed resources)", cascade)
		}
		return done(strings.TrimSpace(res.Stdout) + suffix)
	}
	return nil, bad("Unsupported Argo CD action")
}

// argoNumber reads a decoded number, or -1 when it is not one.
func argoNumber(v any) int64 {
	switch n := v.(type) {
	case json.Number:
		if i, err := n.Int64(); err == nil {
			return i
		}
	case float64:
		return int64(n)
	}
	return -1
}

func init() {
	registerRoutes(func(b *Backend, q *request) (any, int, bool, error) {
		if q.method != "POST" || q.route != "/api/argocd" {
			return nil, 0, false, nil
		}
		result, err := b.argoCD(q.ctx, q.body)
		return result, 200, true, err
	})
}
