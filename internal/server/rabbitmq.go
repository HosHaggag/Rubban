package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// RabbitMQ management consoles in the cluster: find them, resolve the initial (default) login the
// deployment was created with, and open the console through a port forward plus an embed proxy.
//
// Instances are Services that expose the management port (15672, or a port named management /
// http-stats). The login is looked up, in order, from:
//   - the RabbitMQ Cluster Operator's "<cluster>-default-user" Secret (username / password keys);
//   - RABBITMQ_DEFAULT_USER / RABBITMQ_DEFAULT_PASS (official image) or RABBITMQ_USERNAME /
//     RABBITMQ_PASSWORD (Bitnami) on the RabbitMQ container: literal values, secretKeyRef,
//     envFrom Secrets, or *_FILE variables pointing into a mounted Secret;
//   - RabbitMQ's built-in guest / guest, which RabbitMQ accepts only from localhost - a port
//     forward arrives on the pod's loopback interface, so it works here.
//
// Lists never carry credential values; /api/rabbitmq/credentials returns them on request.

var (
	rabbitMgmtPortNames = map[string]bool{"management": true, "http-stats": true, "http-management": true, "mgmt": true, "rabbitmq-management": true}
	rabbitTLSPortNames  = map[string]bool{"management-tls": true, "https-stats": true, "management-https": true}
	rabbitUserEnv       = []string{"RABBITMQ_DEFAULT_USER", "RABBITMQ_USERNAME"}
	rabbitPassEnv       = []string{"RABBITMQ_DEFAULT_PASS", "RABBITMQ_PASSWORD"}

	rabbitImageRE    = regexp.MustCompile(`(?i)rabbitmq`)
	rabbitExporterRE = regexp.MustCompile(`(?i)exporter`)
	rabbitBitnamiRE  = regexp.MustCompile(`(?i)bitnami`)
	rabbitTagRE      = regexp.MustCompile(`:([^:@/]+)(?:@.*)?$`)
	rabbitSubstRE    = regexp.MustCompile(`\$\(`)
)

// rabbitMgmtPort is a Service port that serves the management console.
type rabbitMgmtPort struct {
	Port   int
	Name   string
	Scheme string
}

// rmqInt reads a JSON or YAML number (json.Number, float64 or int) as an int.
func rmqInt(v any) (int, bool) {
	switch n := v.(type) {
	case json.Number:
		i, err := n.Int64()
		return int(i), err == nil
	case float64:
		return int(n), n == float64(int(n))
	case int:
		return n, true
	case int64:
		return int(n), true
	}
	return 0, false
}

func rmqIsInt(v any, want int) bool {
	n, ok := rmqInt(v)
	return ok && n == want
}

func rabbitManagementPort(service obj) *rabbitMgmtPort {
	ports := listOf(objOf(service["spec"])["ports"])
	find := func(match func(p obj) bool) obj {
		for _, item := range ports {
			if p := objOf(item); p != nil && match(p) {
				return p
			}
		}
		return nil
	}
	portOf := func(p obj, scheme string) *rabbitMgmtPort {
		n, _ := rmqInt(p["port"])
		return &rabbitMgmtPort{Port: n, Name: strOf(p["name"]), Scheme: scheme}
	}
	if p := find(func(p obj) bool {
		return rmqIsInt(p["port"], 15672) || rmqIsInt(p["targetPort"], 15672) || rabbitMgmtPortNames[strOf(p["name"])] || p["targetPort"] == "management"
	}); p != nil {
		return portOf(p, "http")
	}
	if p := find(func(p obj) bool {
		return rmqIsInt(p["port"], 15671) || rmqIsInt(p["targetPort"], 15671) || rabbitTLSPortNames[strOf(p["name"])]
	}); p != nil {
		return portOf(p, "https")
	}
	return nil
}

// rmqLess orders strings the way localeCompare does for the ASCII names in play: case-insensitively,
// then lower case before upper case.
func rmqLess(a, b string) bool {
	la, lb := strings.ToLower(a), strings.ToLower(b)
	if la != lb {
		return la < lb
	}
	return a > b
}

func rabbitSelectorText(selector obj) string {
	keys := make([]string, 0, len(selector))
	for k := range selector {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return rmqLess(keys[i], keys[j]) })
	parts := make([]string, len(keys))
	for i, k := range keys {
		parts[i] = k + "=" + fmt.Sprint(selector[k])
	}
	return strings.Join(parts, ",")
}

func rabbitIsReady(pod obj) bool {
	status := objOf(pod["status"])
	if strOf(status["phase"]) != "Running" {
		return false
	}
	for _, c := range listOf(status["conditions"]) {
		if m := objOf(c); strOf(m["type"]) == "Ready" && strOf(m["status"]) == "True" {
			return true
		}
	}
	return false
}

func rabbitImageOf(container obj) string { return strOf(container["image"]) }

func rabbitVersionOf(image string) string {
	if m := rabbitTagRE.FindStringSubmatch(image); m != nil {
		return m[1]
	}
	return ""
}

func rabbitContainerOf(pod obj) obj {
	containers := listOf(objOf(pod["spec"])["containers"])
	var all []obj
	for _, c := range containers {
		if m := objOf(c); m != nil {
			all = append(all, m)
		}
	}
	for _, c := range all {
		if image := rabbitImageOf(c); rabbitImageRE.MatchString(image) && !rabbitExporterRE.MatchString(image) {
			return c
		}
	}
	for _, c := range all {
		for _, p := range listOf(c["ports"]) {
			if rmqIsInt(objOf(p)["containerPort"], 15672) {
				return c
			}
		}
	}
	for _, c := range all {
		if rabbitImageRE.MatchString(strOf(c["name"])) {
			return c
		}
	}
	return nil
}

// rabbitSource says where a credential comes from, without its value.
type rabbitSource struct {
	Type         string // secret, secret-envfrom, literal, default
	Secret       string
	Key          string
	Via          string
	Value        string
	Alternatives []string
	Fallback     string
}

func rabbitEnvSource(pod, container obj, names []string) *rabbitSource {
	var env []obj
	for _, e := range listOf(container["env"]) {
		if m := objOf(e); m != nil {
			env = append(env, m)
		}
	}
	findEnv := func(name string) obj {
		for _, e := range env {
			if strOf(e["name"]) == name {
				return e
			}
		}
		return nil
	}
	for _, name := range names {
		entry := findEnv(name)
		if ref := objOf(objOf(entry["valueFrom"])["secretKeyRef"]); ref != nil {
			return &rabbitSource{Type: "secret", Secret: strOf(ref["name"]), Key: strOf(ref["key"]), Via: name}
		}
		if value, ok := entry["value"].(string); entry != nil && ok && !rabbitSubstRE.MatchString(value) {
			return &rabbitSource{Type: "literal", Via: name}
		}
		file := ""
		if f := findEnv(name + "_FILE"); f != nil {
			file = strOf(f["value"])
		}
		if file == "" {
			continue
		}
		var mount obj
		mountDir := ""
		for _, m := range listOf(container["volumeMounts"]) {
			mm := objOf(m)
			dir := strings.TrimSuffix(strOf(mm["mountPath"]), "/")
			if mm != nil && strings.HasPrefix(file, dir+"/") && (mount == nil || len(strOf(mm["mountPath"])) > len(strOf(mount["mountPath"]))) {
				mount, mountDir = mm, dir
			}
		}
		if mount == nil {
			continue
		}
		for _, v := range listOf(objOf(pod["spec"])["volumes"]) {
			volume := objOf(v)
			if strOf(volume["name"]) != strOf(mount["name"]) {
				continue
			}
			secret := objOf(volume["secret"])
			if strOf(secret["secretName"]) == "" {
				break
			}
			fileName := file[len(mountDir)+1:]
			key := fileName
			for _, i := range listOf(secret["items"]) {
				if item := objOf(i); strOf(item["path"]) == fileName {
					key = strOf(item["key"])
					break
				}
			}
			return &rabbitSource{Type: "secret", Secret: strOf(secret["secretName"]), Key: key, Via: name + "_FILE"}
		}
	}
	for _, item := range listOf(container["envFrom"]) {
		ref := objOf(objOf(item)["secretRef"])
		if strOf(ref["name"]) == "" {
			continue
		}
		prefix := strOf(objOf(item)["prefix"])
		alternatives := make([]string, len(names))
		for i, n := range names {
			alternatives[i] = prefix + n
		}
		return &rabbitSource{Type: "secret-envfrom", Secret: strOf(ref["name"]), Key: prefix + names[0], Alternatives: alternatives, Via: "envFrom"}
	}
	return nil
}

// rabbitPlan is how to obtain the login of one pod.
type rabbitPlan struct {
	Kind     string
	Username *rabbitSource
	Password *rabbitSource
}

// rabbitCredentialPlan accepts a nil pod (a Service with no pods behind it).
func rabbitCredentialPlan(pod obj) rabbitPlan {
	labels := objOf(objOf(pod["metadata"])["labels"])
	if strOf(labels["app.kubernetes.io/part-of"]) == "rabbitmq" && strOf(labels["app.kubernetes.io/name"]) != "" {
		secret := strOf(labels["app.kubernetes.io/name"]) + "-default-user"
		return rabbitPlan{
			Kind:     "Cluster Operator",
			Username: &rabbitSource{Type: "secret", Secret: secret, Key: "username"},
			Password: &rabbitSource{Type: "secret", Secret: secret, Key: "password"},
		}
	}
	container := rabbitContainerOf(pod)
	bitnami := rabbitBitnamiRE.MatchString(rabbitImageOf(container))
	withFallback := func(source *rabbitSource, value string) *rabbitSource {
		if source != nil && source.Type == "secret-envfrom" {
			source.Fallback = value
		}
		return source
	}
	userDefault, kind := "guest", "RabbitMQ image"
	if bitnami {
		userDefault, kind = "user", "Bitnami"
	}
	plan := rabbitPlan{Kind: kind}
	if plan.Username = withFallback(rabbitEnvSource(pod, container, rabbitUserEnv), userDefault); plan.Username == nil {
		plan.Username = &rabbitSource{Type: "default", Value: userDefault}
	}
	if plan.Password = withFallback(rabbitEnvSource(pod, container, rabbitPassEnv), "guest"); plan.Password == nil {
		plan.Password = &rabbitSource{Type: "default", Value: "guest"}
	}
	return plan
}

func rabbitDescribeSource(source *rabbitSource) string {
	switch {
	case source == nil:
		return "unknown"
	case source.Type == "secret" || source.Type == "secret-envfrom":
		return "Secret " + source.Secret + " › " + source.Key
	case source.Type == "literal":
		return source.Via + " on the container"
	case source.Value == "guest":
		return "RabbitMQ default (guest)"
	}
	return "chart default (" + source.Value + ")"
}

type rabbitInstance struct {
	ID       string `json:"id"`
	NS       string `json:"namespace"`
	Service  string `json:"service"`
	Port     int    `json:"port"`
	PortName string `json:"portName"`
	Scheme   string `json:"scheme"`
	Headless bool   `json:"headless"`
	Kind     string `json:"kind"`
	Image    string `json:"image"`
	Version  string `json:"version"`
	Pods     struct {
		Ready int `json:"ready"`
		Total int `json:"total"`
	} `json:"pods"`
	Pod      string `json:"pod"`
	AMQPPort *int   `json:"amqpPort"`
	Login    struct {
		Username string `json:"username"`
		Password string `json:"password"`
	} `json:"login"`
}

type rabbitCandidate struct {
	service    obj
	management *rabbitMgmtPort
	headless   bool
}

func (b *Backend) rabbitDiscover(ctx context.Context, kubeContext, namespace string) ([]rabbitInstance, error) {
	list, err := b.listObjects(ctx, kubeContext, "services", namespace, ListOptions{})
	if err != nil {
		return nil, err
	}
	// One instance per selector: prefer the regular Service over a headless twin.
	groups := map[string]*rabbitCandidate{}
	var order []string
	for _, item := range listOf(list["items"]) {
		service := objOf(item)
		management := rabbitManagementPort(service)
		if service == nil || management == nil {
			continue
		}
		meta := objOf(service["metadata"])
		selector := rabbitSelectorText(objOf(objOf(service["spec"])["selector"]))
		if selector == "" {
			selector = strOf(meta["name"])
		}
		key := strOf(meta["namespace"]) + "|" + selector
		headless := strOf(objOf(service["spec"])["clusterIP"]) == "None"
		current := groups[key]
		if current == nil {
			order = append(order, key)
		}
		if current == nil || (current.headless && !headless) || (current.headless == headless && management.Scheme == "http" && current.management.Scheme != "http") {
			groups[key] = &rabbitCandidate{service: service, management: management, headless: headless}
		}
	}
	instances := []rabbitInstance{}
	for _, key := range order {
		c := groups[key]
		meta := objOf(c.service["metadata"])
		ns, name := strOf(meta["namespace"]), strOf(meta["name"])
		selector := rabbitSelectorText(objOf(objOf(c.service["spec"])["selector"]))
		var pods []obj
		if selector != "" {
			if podList, err := b.listObjects(ctx, kubeContext, "pods", ns, ListOptions{LabelSelector: selector}); err == nil {
				for _, p := range listOf(podList["items"]) {
					if m := objOf(p); m != nil {
						pods = append(pods, m)
					}
				}
			}
		}
		var pod obj
		ready := 0
		for _, p := range pods {
			if rabbitIsReady(p) {
				ready++
				if pod == nil {
					pod = p
				}
			}
		}
		if pod == nil && len(pods) > 0 {
			pod = pods[0]
		}
		container := rabbitContainerOf(pod)
		if pod != nil && container == nil {
			continue // a Service on 15672 in front of something that is not RabbitMQ
		}
		plan := rabbitCredentialPlan(pod)
		instance := rabbitInstance{
			ID: ns + "/" + name, NS: ns, Service: name, Port: c.management.Port, PortName: c.management.Name, Scheme: c.management.Scheme, Headless: c.headless,
			Kind: "Service", Image: rabbitImageOf(container), Version: rabbitVersionOf(rabbitImageOf(container)), Pod: strOf(objOf(pod["metadata"])["name"]),
		}
		if pod != nil {
			instance.Kind = plan.Kind
		}
		instance.Pods.Ready, instance.Pods.Total = ready, len(pods)
		for _, p := range listOf(objOf(c.service["spec"])["ports"]) {
			if pm := objOf(p); rmqIsInt(pm["port"], 5672) || strOf(pm["name"]) == "amqp" {
				if n, ok := rmqInt(pm["port"]); ok && n != 0 {
					instance.AMQPPort = &n
				}
				break
			}
		}
		instance.Login.Username = rabbitDescribeSource(plan.Username)
		instance.Login.Password = rabbitDescribeSource(plan.Password)
		instances = append(instances, instance)
	}
	sort.SliceStable(instances, func(i, j int) bool { return rmqLess(instances[i].ID, instances[j].ID) })
	return instances, nil
}

func (b *Backend) rabbitInstanceFor(ctx context.Context, kubeContext, namespace, service string) (rabbitInstance, error) {
	instances, err := b.rabbitDiscover(ctx, kubeContext, namespace)
	if err != nil {
		return rabbitInstance{}, err
	}
	for _, instance := range instances {
		if instance.Service == service {
			return instance, nil
		}
	}
	return rabbitInstance{}, problem(fmt.Sprintf("No RabbitMQ management Service named %s in %s", service, namespace), 404)
}

// rmqBase64 decodes Secret data the way Buffer.from(value, 'base64') does: padding and line breaks are optional.
func rmqBase64(value any) string {
	text, _ := value.(string)
	text = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == ' ' || r == '\t' {
			return -1
		}
		return r
	}, text)
	text = strings.TrimRight(text, "=")
	text = strings.NewReplacer("-", "+", "_", "/").Replace(text)
	data, _ := base64.RawStdEncoding.DecodeString(text)
	return strings.ToValidUTF8(string(data), "�")
}

func (b *Backend) rabbitResolveValue(ctx context.Context, kubeContext, namespace string, source *rabbitSource) (string, error) {
	if source == nil {
		return "", nil
	}
	if source.Type == "default" || source.Type == "literal" {
		return source.Value, nil
	}
	data, err := b.readSecretData(ctx, kubeContext, namespace, source.Secret)
	if err != nil {
		return "", err
	}
	keys := source.Alternatives
	if keys == nil {
		keys = []string{source.Key}
	}
	key := ""
	for _, k := range keys {
		if _, ok := data[k]; ok {
			key = k
			break
		}
	}
	// envFrom Secrets may simply not set the variable; RabbitMQ then uses its default.
	if key == "" && source.Type == "secret-envfrom" {
		return source.Fallback, nil
	}
	if key == "" {
		return "", problem(fmt.Sprintf("Secret %s has no %s key", source.Secret, strings.Join(keys, " or ")), 404)
	}
	return rmqBase64(data[key]), nil
}

type rabbitCredentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Source   struct {
		Username string `json:"username"`
		Password string `json:"password"`
	} `json:"source"`
}

func (b *Backend) rabbitCredentials(ctx context.Context, kubeContext, namespace, service string) (rabbitCredentials, error) {
	var out rabbitCredentials
	instance, err := b.rabbitInstanceFor(ctx, kubeContext, namespace, service)
	if err != nil {
		return out, err
	}
	var pod obj
	if instance.Pod != "" {
		list, err := b.listObjects(ctx, kubeContext, "pods", namespace, ListOptions{FieldSelector: "metadata.name=" + instance.Pod})
		if err != nil {
			return out, err
		}
		if items := listOf(list["items"]); len(items) > 0 {
			pod = objOf(items[0])
		}
	}
	plan := rabbitCredentialPlan(pod)
	container := rabbitContainerOf(pod)
	// Literal env values are read from the pod spec at reveal time only.
	for _, source := range []*rabbitSource{plan.Username, plan.Password} {
		if source.Type != "literal" {
			continue
		}
		for _, e := range listOf(container["env"]) {
			if m := objOf(e); strOf(m["name"]) == source.Via {
				source.Value = strOf(m["value"])
				break
			}
		}
	}
	if out.Username, err = b.rabbitResolveValue(ctx, kubeContext, namespace, plan.Username); err != nil {
		return out, err
	}
	if out.Password, err = b.rabbitResolveValue(ctx, kubeContext, namespace, plan.Password); err != nil {
		return out, err
	}
	out.Source.Username = rabbitDescribeSource(plan.Username)
	out.Source.Password = rabbitDescribeSource(plan.Password)
	return out, nil
}

func init() {
	registerRoutes(func(b *Backend, q *request) (any, int, bool, error) {
		switch {
		case q.method == "GET" && q.route == "/api/rabbitmq":
			kubeContext, err := validateText(q.q("context"), "context")
			if err != nil {
				return nil, 0, true, err
			}
			namespace, err := validateNamespace(q.q("namespace"), true)
			if err != nil {
				return nil, 0, true, err
			}
			if namespace == "" {
				namespace = "*"
			}
			items, err := b.rabbitDiscover(q.ctx, kubeContext, namespace)
			if err != nil {
				return nil, 0, true, err
			}
			return obj{"items": items}, 200, true, nil
		case q.method == "POST" && q.route == "/api/rabbitmq/credentials":
			kubeContext, namespace, service, err := rabbitTarget(q)
			if err != nil {
				return nil, 0, true, err
			}
			creds, err := b.rabbitCredentials(q.ctx, kubeContext, namespace, service)
			if err != nil {
				return nil, 0, true, err
			}
			return creds, 200, true, nil
		case q.method == "POST" && q.route == "/api/rabbitmq/open":
			kubeContext, namespace, service, err := rabbitTarget(q)
			if err != nil {
				return nil, 0, true, err
			}
			instance, err := b.rabbitInstanceFor(q.ctx, kubeContext, namespace, service)
			if err != nil {
				return nil, 0, true, err
			}
			opened, err := b.fwdOpenEmbedded(q.ctx, fwdConsoleSpec{
				fwdSpec: fwdSpec{context: kubeContext, namespace: namespace, resource: "services", name: instance.Service, remotePort: instance.Port},
				scheme:  instance.Scheme,
				credentials: func(ctx context.Context) (any, error) {
					return b.rabbitCredentials(ctx, kubeContext, namespace, instance.Service)
				},
			})
			if err != nil {
				return nil, 0, true, err
			}
			return opened, 200, true, nil
		}
		return nil, 0, false, nil
	})
}

func rabbitTarget(q *request) (kubeContext, namespace, service string, err error) {
	if kubeContext, err = validateText(q.body["context"], "context"); err != nil {
		return
	}
	if namespace, err = validateNamespace(q.body["namespace"], false); err != nil {
		return
	}
	service, err = validateName(q.body["service"], "service")
	return
}
