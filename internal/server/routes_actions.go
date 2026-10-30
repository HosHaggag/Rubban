package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

func init() {
	registerRoutes(func(b *Backend, q *request) (any, int, bool, error) {
		var (
			v   any
			err error
		)
		switch {
		case q.method == "POST" && q.route == "/api/node":
			v, err = b.routeNode(q)
		case q.method == "POST" && q.route == "/api/evict":
			v, err = b.routeEvict(q)
		case q.method == "POST" && q.route == "/api/cronjob":
			v, err = b.routeCronJob(q)
		case q.method == "POST" && q.route == "/api/rollout-undo":
			v, err = b.routeRolloutUndo(q)
		case q.method == "POST" && q.route == "/api/patch":
			v, err = b.routePatch(q)
		case q.method == "POST" && (q.route == "/api/default-class" || q.route == "/api/ingressclass-default"):
			v, err = b.routeDefaultClass(q)
		case q.method == "GET" && q.route == "/api/secret-data":
			v, err = b.routeSecretData(q)
		case q.method == "POST" && q.route == "/api/serviceaccount-kubeconfig":
			v, err = b.routeServiceAccountKubeconfig(q)
		default:
			return nil, 0, false, nil
		}
		return v, 200, true, err
	})
}

var multiDotRE = regexp.MustCompile(`\.+`)

func (b *Backend) kubeOutput(ctx context.Context, args []string, opts RunOptions) (any, error) {
	res, err := b.kube(ctx, args, opts)
	if err != nil {
		return nil, err
	}
	return obj{"output": trimOutput(res)}, nil
}

func (b *Backend) routeNode(q *request) (any, error) {
	body := q.body
	kubeContext, err := validateText(body["context"], "context")
	if err != nil {
		return nil, err
	}
	name, err := validateName(body["name"], "node")
	if err != nil {
		return nil, err
	}
	ctxArgs, _ := contextArgs(kubeContext)
	action, _ := body["action"].(string)
	var args []string
	var opts RunOptions
	switch action {
	case "cordon", "uncordon":
		args = append(ctxArgs, action, name)
	case "drain":
		timeout, err := integer(body["timeoutSeconds"], "drain timeout", 10, 3600, fb(300))
		if err != nil {
			return nil, err
		}
		args = append(ctxArgs, "drain", name,
			fmt.Sprintf("--timeout=%ds", timeout),
			fmt.Sprintf("--ignore-daemonsets=%t", body["ignoreDaemonsets"] != false),
			fmt.Sprintf("--delete-emptydir-data=%t", body["deleteEmptyDirData"] != false),
			fmt.Sprintf("--force=%t", body["force"] == true))
		if grace, present := body["gracePeriodSeconds"]; present && grace != "" {
			n, err := integer(grace, "grace period", -1, 3600, nil)
			if err != nil {
				return nil, err
			}
			args = append(args, fmt.Sprintf("--grace-period=%d", n))
		}
		opts.Timeout = time.Duration(timeout+30) * time.Second
	default:
		return nil, bad("Node actions are cordon, uncordon and drain")
	}
	return b.kubeOutput(q.ctx, args, opts)
}

func (b *Backend) routeEvict(q *request) (any, error) {
	body := q.body
	kubeContext, err := validateText(body["context"], "context")
	if err != nil {
		return nil, err
	}
	namespace, err := validateNamespace(body["namespace"], false)
	if err != nil {
		return nil, err
	}
	name, err := validateName(body["name"], "pod")
	if err != nil {
		return nil, err
	}
	if !liveReady(b) {
		return nil, problem("Eviction needs the live cluster connection", 503)
	}
	eviction := obj{"apiVersion": "policy/v1", "kind": "Eviction", "metadata": obj{"name": name, "namespace": namespace}}
	apiPath := "/api/v1/namespaces/" + pathEscape(namespace) + "/pods/" + pathEscape(name) + "/eviction"
	raw, status, err := liveSend(b, q.ctx, kubeContext, "POST", apiPath, eviction, RawOptions{})
	if err := liveFailure(raw, status, err); err != nil {
		return nil, err
	}
	return obj{"output": "pod/" + name + " evicted"}, nil
}

func (b *Backend) routeCronJob(q *request) (any, error) {
	body := q.body
	kubeContext, err := validateText(body["context"], "context")
	if err != nil {
		return nil, err
	}
	namespace, err := validateNamespace(body["namespace"], false)
	if err != nil {
		return nil, err
	}
	name, err := validateName(body["name"], "CronJob")
	if err != nil {
		return nil, err
	}
	ctxArgs, _ := contextArgs(kubeContext)
	nsArgs, _ := namespaceArgs(namespace, false)
	args := append(append([]string{}, ctxArgs...), nsArgs...)
	switch body["action"] {
	case "trigger":
		suffix := make([]byte, 3)
		_, _ = rand.Read(suffix)
		job := multiDotRE.ReplaceAllString(name[:min(len(name), 44)]+"-manual-"+hex.EncodeToString(suffix), "-")
		args = append(args, "create", "job", job, "--from=cronjob/"+name)
	case "suspend", "resume":
		patch := compactJSON(obj{"spec": obj{"suspend": body["action"] == "suspend"}})
		args = append(args, "patch", "cronjob", name, "--type=merge", "--patch="+patch)
	default:
		return nil, bad("CronJob actions are trigger, suspend and resume")
	}
	return b.kubeOutput(q.ctx, args, RunOptions{})
}

func (b *Backend) routeRolloutUndo(q *request) (any, error) {
	body := q.body
	kubeContext, err := validateText(body["context"], "context")
	if err != nil {
		return nil, err
	}
	namespace, err := validateNamespace(body["namespace"], false)
	if err != nil {
		return nil, err
	}
	resource, err := validateResource(body["resource"])
	if err != nil {
		return nil, err
	}
	if !restartRE.MatchString(resource) {
		return nil, bad("Rollback supports Deployments, DaemonSets and StatefulSets")
	}
	name, err := validateName(body["name"], "name")
	if err != nil {
		return nil, err
	}
	revision, err := integer(body["revision"], "revision", 1, 1e9, nil)
	if err != nil {
		return nil, err
	}
	ctxArgs, _ := contextArgs(kubeContext)
	nsArgs, _ := namespaceArgs(namespace, false)
	args := append(append(append([]string{}, ctxArgs...), nsArgs...), "rollout", "undo", resource+"/"+name, fmt.Sprintf("--to-revision=%d", revision))
	return b.kubeOutput(q.ctx, args, RunOptions{})
}

func (b *Backend) routePatch(q *request) (any, error) {
	body := q.body
	kubeContext, err := validateText(body["context"], "context")
	if err != nil {
		return nil, err
	}
	namespace, err := validateNamespace(body["namespace"], false)
	if err != nil {
		return nil, err
	}
	resource, err := validateResource(body["resource"])
	if err != nil {
		return nil, err
	}
	name, err := validateName(body["name"], "name")
	if err != nil {
		return nil, err
	}
	patchType := "merge"
	if t, _ := body["type"].(string); t == "merge" || t == "strategic" || t == "json" {
		patchType = t
	}
	switch body["patch"].(type) {
	case map[string]any, []any:
	default:
		return nil, bad("Patch must be a JSON object or array")
	}
	patch := compactJSON(body["patch"])
	if len(patch) > 1024*1024 {
		return nil, problem("Patch is too large", 413)
	}
	ctxArgs, _ := contextArgs(kubeContext)
	nsArgs, _ := namespaceArgs(namespace, false)
	args := append(append(append([]string{}, ctxArgs...), nsArgs...), "patch", resource, name, "--type="+patchType, "--patch="+patch)
	return b.kubeOutput(q.ctx, args, RunOptions{})
}

const betaDefaultClass = "storageclass.beta.kubernetes.io/is-default-class"

// routeDefaultClass marks one IngressClass or StorageClass as the cluster default and clears the flag
// on the others.
func (b *Backend) routeDefaultClass(q *request) (any, error) {
	body := q.body
	kubeContext, err := validateText(body["context"], "context")
	if err != nil {
		return nil, err
	}
	kind, _ := body["kind"].(string)
	if q.route == "/api/ingressclass-default" {
		kind = "ingressclasses"
	}
	if kind != "ingressclasses" && kind != "storageclasses" {
		return nil, bad("Default class applies to ingressclasses or storageclasses")
	}
	label := "StorageClass"
	if kind == "ingressclasses" {
		label = "IngressClass"
	}
	name, err := validateName(body["name"], label)
	if err != nil {
		return nil, err
	}
	classes, err := b.listObjects(q.ctx, kubeContext, kind, "*", ListOptions{})
	if err != nil {
		return nil, err
	}
	var items []obj
	selected := -1
	for _, it := range listOf(classes["items"]) {
		item := objOf(it)
		if item == nil {
			continue
		}
		if selected < 0 && strOf(objOf(item["metadata"])["name"]) == name {
			selected = len(items)
		}
		items = append(items, item)
	}
	if selected < 0 {
		return nil, problem(name+" was not found", 404)
	}
	key := "ingressclass.kubernetes.io/is-default-class"
	if kind == "storageclasses" {
		key = "storageclass.kubernetes.io/is-default-class"
	}
	ctxArgs, _ := contextArgs(kubeContext)
	var outputs []string
	// Set the new default first. If that write is forbidden or fails, keep the existing default.
	// Kubernetes allows multiple defaults while the remaining annotations are cleared.
	ordered := []obj{items[selected]}
	for i, item := range items {
		if i != selected {
			ordered = append(ordered, item)
		}
	}
	for _, item := range ordered {
		itemName := strOf(objOf(item["metadata"])["name"])
		annotations := objOf(objOf(item["metadata"])["annotations"])
		current := annotations[key] == "true" || (kind == "storageclasses" && annotations[betaDefaultClass] == "true")
		wanted := itemName == name
		if current == wanted {
			continue
		}
		args := append(append([]string{}, ctxArgs...), "annotate", kind, itemName, fmt.Sprintf("%s=%t", key, wanted), "--overwrite")
		if !wanted && truthy(annotations[betaDefaultClass]) {
			args = append(args, betaDefaultClass+"-")
		}
		res, err := b.kube(q.ctx, args, RunOptions{})
		if err != nil {
			return nil, err
		}
		outputs = append(outputs, strings.TrimSpace(res.Stdout))
	}
	if len(outputs) == 0 {
		return obj{"output": name + " is already the default"}, nil
	}
	return obj{"output": strings.Join(outputs, "\n")}, nil
}

// routeSecretData is the explicit, per-request reveal of one Secret's data (lists and watches never
// carry values).
func (b *Backend) routeSecretData(q *request) (any, error) {
	kubeContext, err := validateText(q.q("context"), "context")
	if err != nil {
		return nil, err
	}
	namespace, err := validateNamespace(q.q("namespace"), false)
	if err != nil {
		return nil, err
	}
	name, err := validateName(q.q("name"), "secret")
	if err != nil {
		return nil, err
	}
	raw, err := b.rawGet(q.ctx, kubeContext, "/api/v1/namespaces/"+pathEscape(namespace)+"/secrets/"+pathEscape(name), RawOptions{})
	if err != nil {
		return nil, err
	}
	secret := objOf(raw)
	secretType := strOf(secret["type"])
	if secretType == "" {
		secretType = "Opaque"
	}
	data := objOf(secret["data"])
	if data == nil {
		data = obj{}
	}
	return obj{"type": secretType, "data": data, "resourceVersion": strOf(objOf(secret["metadata"])["resourceVersion"])}, nil
}

type kubeconfigCluster struct {
	Server                string `yaml:"server"`
	CertificateAuthority  string `yaml:"certificate-authority-data,omitempty"`
	InsecureSkipTLSVerify bool   `yaml:"insecure-skip-tls-verify,omitempty"`
	TLSServerName         string `yaml:"tls-server-name,omitempty"`
}

type kubeconfigClusterEntry struct {
	Name    string            `yaml:"name"`
	Cluster kubeconfigCluster `yaml:"cluster"`
}

type kubeconfigUserEntry struct {
	Name string `yaml:"name"`
	User struct {
		Token string `yaml:"token"`
	} `yaml:"user"`
}

type kubeconfigContextEntry struct {
	Name    string `yaml:"name"`
	Context struct {
		Cluster   string `yaml:"cluster"`
		User      string `yaml:"user"`
		Namespace string `yaml:"namespace"`
	} `yaml:"context"`
}

type kubeconfigDoc struct {
	APIVersion     string                   `yaml:"apiVersion"`
	Kind           string                   `yaml:"kind"`
	Preferences    map[string]any           `yaml:"preferences"`
	Clusters       []kubeconfigClusterEntry `yaml:"clusters"`
	Users          []kubeconfigUserEntry    `yaml:"users"`
	Contexts       []kubeconfigContextEntry `yaml:"contexts"`
	CurrentContext string                   `yaml:"current-context"`
}

func (b *Backend) routeServiceAccountKubeconfig(q *request) (any, error) {
	body := q.body
	kubeContext, err := validateText(body["context"], "context")
	if err != nil {
		return nil, err
	}
	namespace, err := validateNamespace(body["namespace"], false)
	if err != nil {
		return nil, err
	}
	name, err := validateName(body["name"], "service account")
	if err != nil {
		return nil, err
	}
	hours, err := integer(body["hours"], "token lifetime (hours)", 1, 8760, fb(24))
	if err != nil {
		return nil, err
	}
	ctxArgs, _ := contextArgs(kubeContext)
	nsArgs, _ := namespaceArgs(namespace, false)
	r := settle(
		func() (Result, error) {
			args := append(append(append([]string{}, ctxArgs...), nsArgs...), "create", "token", name, fmt.Sprintf("--duration=%dh", hours))
			return b.kube(q.ctx, args, RunOptions{})
		},
		func() (Result, error) {
			return b.kube(q.ctx, []string{"config", "view", "--raw", "--minify", "--flatten", "--context=" + kubeContext, "--output=json"}, RunOptions{})
		},
	)
	for _, s := range r {
		if s.Err != nil {
			return nil, s.Err
		}
	}
	config, err := parseObject(r[1].Res, "kubectl")
	if err != nil {
		return nil, err
	}
	clusters := listOf(config["clusters"])
	var entry, spec obj
	if len(clusters) > 0 {
		entry = objOf(clusters[0])
		spec = objOf(entry["cluster"])
	}
	server := strOf(spec["server"])
	if server == "" {
		return nil, problem("Could not read the cluster endpoint for this context", 502)
	}
	clusterName := strOf(entry["name"])
	cluster := kubeconfigCluster{Server: server, CertificateAuthority: strOf(spec["certificate-authority-data"]), TLSServerName: strOf(spec["tls-server-name"])}
	cluster.InsecureSkipTLSVerify = truthy(spec["insecure-skip-tls-verify"])
	user := name + "@" + namespace
	contextName := user + "-" + clusterName
	doc := kubeconfigDoc{APIVersion: "v1", Kind: "Config", Preferences: map[string]any{}, CurrentContext: contextName}
	doc.Clusters = []kubeconfigClusterEntry{{Name: clusterName, Cluster: cluster}}
	var u kubeconfigUserEntry
	u.Name, u.User.Token = user, strings.TrimSpace(r[0].Res.Stdout)
	doc.Users = []kubeconfigUserEntry{u}
	var c kubeconfigContextEntry
	c.Name, c.Context.Cluster, c.Context.User, c.Context.Namespace = contextName, clusterName, user, namespace
	doc.Contexts = []kubeconfigContextEntry{c}
	var out bytes.Buffer
	enc := yaml.NewEncoder(&out)
	enc.SetIndent(2)
	if err := enc.Encode(doc); err != nil {
		return nil, err
	}
	_ = enc.Close()
	return obj{"kubeconfig": out.String(), "expiresInHours": hours}, nil
}
