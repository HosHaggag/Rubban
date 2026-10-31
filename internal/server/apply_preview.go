package server

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"strings"
)

// Apply with a review: no YAML reaches a cluster without the user having seen the exact change and the
// admission result. POST /api/apply/preview runs `kubectl diff` and a server-side dry-run apply, and
// answers with the diff, the objects it touches, kubectl's warnings and a hash of the manifest it
// looked at; POST /api/apply refuses a manifest whose hash is not the one that was previewed.

const fieldManager = "--field-manager=rubban"

// manifestHash binds the reviewed text to the cluster and namespace it was reviewed against.
func manifestHash(context, namespace, yaml string) string {
	sum := sha256.Sum256([]byte(context + "\x00" + namespace + "\x00" + yaml))
	return hex.EncodeToString(sum[:])
}

// previewObject is one object of the manifest as the dry-run reports it.
type previewObject struct {
	Kind      string `json:"kind"`
	Namespace string `json:"namespace,omitempty"`
	Name      string `json:"name"`
	Created   bool   `json:"created"`
	Changed   bool   `json:"changed"` // the diff has a section for it
}

// warningLines are the "Warning:" lines kubectl printed (deprecations, missing annotations), once each.
func warningLines(texts ...string) []string {
	warnings := []string{}
	seen := map[string]bool{}
	for _, text := range texts {
		for _, line := range strings.Split(text, "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "Warning:") && !seen[line] {
				seen[line] = true
				warnings = append(warnings, line)
			}
		}
	}
	return warnings
}

// diffHeaderRE matches the header kubectl diff prints per object: the file name is
// <group>.<version>.<Kind>.<namespace>.<name> (no namespace for cluster-scoped objects).
var diffHeaderRE = regexp.MustCompile(`^diff .* (\S+)$`)
var hunkNewRE = regexp.MustCompile(`^@@ -0,0 \+`)

// createdFiles reports, per diff file name, whether the object is new: its left side is empty.
func createdFiles(diff string) map[string]bool {
	created := map[string]bool{}
	current := ""
	for _, line := range strings.Split(diff, "\n") {
		if m := diffHeaderRE.FindStringSubmatch(line); m != nil {
			current = m[1]
			if i := strings.LastIndexAny(current, `/\`); i >= 0 {
				current = current[i+1:]
			}
			if _, ok := created[current]; !ok {
				created[current] = false
			}
		} else if current != "" && hunkNewRE.MatchString(line) {
			created[current] = true
		}
	}
	return created
}

// previewObjects lists the objects of a dry-run answer (one object, or a List of them) and marks the
// ones the diff shows as new.
func previewObjects(doc obj, diff string) []previewObject {
	items := []obj{doc}
	if strOf(doc["kind"]) == "List" {
		items = nil
		for _, it := range listOf(doc["items"]) {
			if m := objOf(it); m != nil {
				items = append(items, m)
			}
		}
	}
	files := createdFiles(diff)
	objects := []previewObject{}
	for _, item := range items {
		meta := objOf(item["metadata"])
		o := previewObject{Kind: strOf(item["kind"]), Namespace: strOf(meta["namespace"]), Name: strOf(meta["name"])}
		suffix := "." + o.Kind + "." + o.Name
		if o.Namespace != "" {
			suffix = "." + o.Kind + "." + o.Namespace + "." + o.Name
		}
		for file, isNew := range files {
			if strings.HasSuffix(file, suffix) || file == suffix[1:] {
				o.Created, o.Changed = isNew, true
			}
		}
		objects = append(objects, o)
	}
	return objects
}

// inlineFailure turns a failed kubectl run into text for the review panel. Failures that are not about
// the manifest (credentials, a missing kubectl, a cancelled request) stay real errors.
func inlineFailure(err error) (string, bool) {
	var re *runError
	if !errors.As(err, &re) || re.Code == "credentials" {
		return "", false
	}
	text := strings.TrimSpace(re.Result.Stderr)
	if text == "" {
		text = strings.TrimSpace(re.Result.Stdout)
	}
	if text == "" {
		text = re.Msg
	}
	var kept []string
	for _, line := range strings.Split(text, "\n") {
		if !strings.HasPrefix(strings.TrimSpace(line), "Warning:") {
			kept = append(kept, line)
		}
	}
	return strings.TrimSpace(strings.Join(kept, "\n")), true
}

func (b *Backend) routeApplyPreview(q *request) (any, int, error) {
	input, err := validateYAML(q.body["yaml"])
	if err != nil {
		return nil, 0, err
	}
	ctxArgs, err := contextArgs(q.body["context"])
	if err != nil {
		return nil, 0, err
	}
	nsArgs, err := namespaceArgs(q.body["namespace"], false)
	if err != nil {
		return nil, 0, err
	}
	base := append(append([]string{}, ctxArgs...), nsArgs...)
	answer := obj{"diff": "", "changed": false, "objects": []previewObject{}, "warnings": []string{}, "error": ""}

	diffRes, err := b.kube(q.ctx, append(append([]string{}, base...), "diff", fieldManager, "--filename=-"), RunOptions{Input: input, AllowExit: []int{0, 1}})
	if err != nil {
		text, inline := inlineFailure(err)
		if !inline {
			return nil, 0, err
		}
		answer["error"] = text
		var re *runError
		errors.As(err, &re)
		answer["warnings"] = warningLines(re.Result.Stderr)
		return answer, 200, nil
	}
	answer["diff"], answer["changed"] = diffRes.Stdout, diffRes.Code == 1

	dryRes, err := b.kube(q.ctx, append(append([]string{}, base...), "apply", "--dry-run=server", fieldManager, "--output=json", "--filename=-"), RunOptions{Input: input})
	if err != nil {
		text, inline := inlineFailure(err)
		if !inline {
			return nil, 0, err
		}
		answer["error"] = text
		var re *runError
		errors.As(err, &re)
		answer["warnings"] = warningLines(diffRes.Stderr, re.Result.Stderr)
		return answer, 200, nil
	}
	doc, err := parseObject(dryRes, "kubectl")
	if err != nil {
		answer["error"] = err.Error()
		return answer, 200, nil
	}
	answer["objects"] = previewObjects(doc, diffRes.Stdout)
	answer["warnings"] = warningLines(diffRes.Stderr, dryRes.Stderr)
	answer["previewHash"] = manifestHash(q.body["context"].(string), nsOf(q), input)
	return answer, 200, nil
}

// nsOf is the validated namespace of a request ("" when none).
func nsOf(q *request) string {
	ns, _ := q.body["namespace"].(string)
	return ns
}
