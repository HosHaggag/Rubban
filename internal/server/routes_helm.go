package server

import (
	"errors"
	"io"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

func init() {
	registerRoutes(func(b *Backend, q *request) (any, int, bool, error) {
		var (
			v      any
			status = 200
			err    error
		)
		switch {
		case q.method == "GET" && q.route == "/api/helm":
			v, err = b.routeHelmList(q)
		case q.method == "GET" && q.route == "/api/helm/charts":
			v, err = b.routeHelmCharts(q)
		case q.method == "GET" && q.route == "/api/helm/chart":
			v, err = b.routeHelmChart(q)
		case q.method == "GET" && q.route == "/api/helm/release":
			v, err = b.routeHelmRelease(q)
		case q.method == "POST" && q.route == "/api/helm":
			v, err = b.helmMutation(q)
		default:
			return nil, 0, false, nil
		}
		return v, status, true, err
	})
}

var (
	noRepositoriesRE = regexp.MustCompile(`(?i)no repositories`)
	chartRefRE       = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$`)
	manifestSplitRE  = regexp.MustCompile(`(?m)^---[ \t]*$`)
)

var helmActions = map[string]bool{"install": true, "upgrade": true, "uninstall": true, "repo-add": true, "repo-update": true, "repo-remove": true, "rollback": true}

func (b *Backend) routeHelmList(q *request) (any, error) {
	kubeContext, err := validateText(q.q("context"), "context")
	if err != nil {
		return nil, err
	}
	nsArgs, err := namespaceArgs(q.q("namespace"), true)
	if err != nil {
		return nil, err
	}
	args := append([]string{"list", "--all", "--output=json", "--kube-context=" + kubeContext}, nsArgs...)
	r := settle(
		func() (Result, error) { return b.helm(q.ctx, args, RunOptions{}) },
		func() (Result, error) {
			return b.helm(q.ctx, []string{"repo", "list", "--output=json"}, RunOptions{AllowExit: []int{0, 1}})
		},
	)
	if r[0].Err != nil {
		return nil, r[0].Err
	}
	var repositories any = []any{}
	warnings := []string{}
	if r[1].Err != nil {
		warnings = append(warnings, shortError(r[1].Err))
	} else if r[1].Res.Code == 0 {
		if repositories, err = parseJSON(r[1].Res, "Helm"); err != nil {
			return nil, err
		}
	}
	releases, err := parseJSON(r[0].Res, "Helm")
	if err != nil {
		return nil, err
	}
	return obj{"releases": releases, "repositories": repositories, "warnings": warnings}, nil
}

// routeHelmCharts lists the latest version of every chart in the configured repositories, plus the
// repositories themselves.
func (b *Backend) routeHelmCharts(q *request) (any, error) {
	allow := RunOptions{AllowExit: []int{0, 1}}
	r := settle(
		func() (Result, error) { return b.helm(q.ctx, []string{"search", "repo", "--output=json"}, allow) },
		func() (Result, error) { return b.helm(q.ctx, []string{"repo", "list", "--output=json"}, allow) },
	)
	warnings := []string{}
	var parseErr error
	parse := func(s settled) []any {
		if s.Err != nil {
			warnings = append(warnings, shortError(s.Err))
			return []any{}
		}
		if s.Res.Code != 0 {
			text := strings.TrimSpace(s.Res.Stderr)
			if text == "" {
				text = strings.TrimSpace(s.Res.Stdout)
			}
			if text != "" && !noRepositoriesRE.MatchString(text) {
				warnings = append(warnings, firstChars(text, 1000))
			}
			return []any{}
		}
		parsed, err := parseJSON(s.Res, "Helm")
		if err != nil {
			parseErr = err
			return []any{}
		}
		if list, ok := parsed.([]any); ok {
			return list
		}
		return []any{}
	}
	charts := parse(r[0])
	repositories := parse(r[1])
	if parseErr != nil {
		return nil, parseErr
	}
	return obj{"charts": charts, "repositories": repositories, "warnings": warnings}, nil
}

func (b *Backend) routeHelmChart(q *request) (any, error) {
	chart, err := validateTextOpt(q.q("chart"), "chart", true, 300)
	if err != nil {
		return nil, err
	}
	if !chartRefRE.MatchString(chart) {
		return nil, bad("Use a repository/chart reference")
	}
	version := ""
	if truthy(q.q("version")) {
		if version, err = validateTextOpt(q.q("version"), "chart version", true, 128); err != nil {
			return nil, err
		}
	}
	var versionArgs []string
	if version != "" {
		versionArgs = []string{"--version=" + version}
	}
	limit := RunOptions{MaxBytes: 4 * 1024 * 1024}
	r := settle(
		func() (Result, error) {
			return b.helm(q.ctx, append([]string{"show", "readme", chart}, versionArgs...), limit)
		},
		func() (Result, error) {
			return b.helm(q.ctx, append([]string{"show", "values", chart}, versionArgs...), limit)
		},
		func() (Result, error) {
			return b.helm(q.ctx, []string{"search", "repo", chart, "--versions", "--output=json"}, RunOptions{})
		},
	)
	list := []obj{}
	if r[2].Err == nil {
		parsed, err := parseJSON(r[2].Res, "Helm")
		if err != nil {
			return nil, err
		}
		for _, it := range listOf(parsed) {
			if item := objOf(it); item["name"] == chart {
				list = append(list, item)
			}
		}
	}
	if version == "" && len(list) > 0 {
		version, _ = list[0]["version"].(string)
	}
	versions := []any{}
	for i, item := range list {
		if i >= 200 {
			break
		}
		entry := obj{}
		for key, from := range map[string]string{"version": "version", "appVersion": "app_version", "description": "description"} {
			if v, ok := item[from]; ok {
				entry[key] = v
			}
		}
		versions = append(versions, entry)
	}
	warnings := []string{}
	for _, s := range r {
		if s.Err != nil {
			warnings = append(warnings, shortError(s.Err))
		}
	}
	text := func(s settled) string {
		if s.Err != nil {
			return ""
		}
		return s.Res.Stdout
	}
	return obj{"chart": chart, "version": version, "readme": text(r[0]), "values": text(r[1]), "versions": versions, "warnings": warnings}, nil
}

// manifestResources lists the objects in a rendered Helm manifest, skipping documents that do not parse.
func manifestResources(manifest string) []any {
	resources := []any{}
	for _, document := range manifestSplitRE.Split(manifest, -1) {
		var node yaml.Node
		if err := yaml.NewDecoder(strings.NewReader(document)).Decode(&node); err != nil || countAliases(&node) > 50 {
			continue
		}
		var decoded map[string]any
		if err := node.Decode(&decoded); err != nil {
			continue
		}
		meta := objOf(decoded["metadata"])
		kind, name := strOf(decoded["kind"]), strOf(meta["name"])
		if kind == "" || name == "" {
			continue
		}
		item := obj{"kind": kind, "name": name, "namespace": strOf(meta["namespace"])}
		if apiVersion, ok := decoded["apiVersion"]; ok {
			item["apiVersion"] = apiVersion
		}
		resources = append(resources, item)
	}
	return resources
}

func (b *Backend) routeHelmRelease(q *request) (any, error) {
	kubeContext, err := validateText(q.q("context"), "context")
	if err != nil {
		return nil, err
	}
	namespace, err := validateNamespace(q.q("namespace"), false)
	if err != nil {
		return nil, err
	}
	name, err := validateName(q.q("name"), "release name")
	if err != nil {
		return nil, err
	}
	base := []string{"--kube-context=" + kubeContext, "--namespace=" + namespace}
	withBase := func(head []string, tail ...string) []string {
		return append(append(append(append([]string{}, head...), name), base...), tail...)
	}
	r := settle(
		func() (Result, error) {
			return b.helm(q.ctx, withBase([]string{"get", "values"}, "--output=yaml"), RunOptions{})
		},
		func() (Result, error) {
			return b.helm(q.ctx, withBase([]string{"get", "values"}, "--all", "--output=yaml"), RunOptions{})
		},
		func() (Result, error) {
			return b.helm(q.ctx, withBase([]string{"get", "notes"}), RunOptions{AllowExit: []int{0, 1}})
		},
		func() (Result, error) {
			return b.helm(q.ctx, withBase([]string{"get", "manifest"}), RunOptions{MaxBytes: 16 * 1024 * 1024})
		},
		func() (Result, error) {
			return b.helm(q.ctx, withBase([]string{"history"}, "--max=50", "--output=json"), RunOptions{})
		},
	)
	resources := []any{}
	if r[3].Err == nil {
		resources = manifestResources(r[3].Res.Stdout)
	}
	if r[4].Err != nil {
		return nil, r[4].Err
	}
	text := func(s settled) string {
		if s.Err != nil {
			return ""
		}
		return s.Res.Stdout
	}
	history, err := parseJSON(r[4].Res, "Helm")
	if err != nil {
		return nil, err
	}
	return obj{"name": name, "namespace": namespace, "values": text(r[0]), "allValues": text(r[1]), "notes": text(r[2]), "resources": resources, "history": history}, nil
}

// validHelmValues checks that every YAML document in the values text parses.
func validHelmValues(text string) bool {
	dec := yaml.NewDecoder(strings.NewReader(text))
	for {
		var node yaml.Node
		err := dec.Decode(&node)
		if errors.Is(err, io.EOF) {
			return true
		}
		if err != nil || countAliases(&node) > 100 {
			return false
		}
		var decoded any
		if err := node.Decode(&decoded); err != nil {
			return false
		}
	}
}

// webURL parses a repository URL the way new URL() does for the http and https schemes.
func webURL(raw string) (*url.URL, bool) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return nil, false
	}
	u.Scheme = strings.ToLower(u.Scheme)
	u.Host = strings.ToLower(u.Host)
	if port := u.Port(); (u.Scheme == "http" && port == "80") || (u.Scheme == "https" && port == "443") {
		u.Host = strings.TrimSuffix(u.Host, ":"+port)
	}
	if u.Path == "" && (u.Scheme == "http" || u.Scheme == "https") {
		u.Path = "/"
	}
	return u, true
}

func (b *Backend) helmMutation(q *request) (any, error) {
	body := q.body
	action, _ := body["action"].(string)
	if !helmActions[action] {
		return nil, bad("Unsupported Helm action")
	}
	var args []string
	var input string
	switch action {
	case "repo-add":
		repo, err := validateName(body["repo"], "repository name")
		if err != nil {
			return nil, err
		}
		text, err := validateTextOpt(body["url"], "repository URL", true, 2048)
		if err != nil {
			return nil, err
		}
		u, ok := webURL(text)
		if !ok {
			return nil, bad("Invalid repository URL")
		}
		password, _ := u.User.Password()
		if (u.Scheme != "http" && u.Scheme != "https") || (u.User != nil && (u.User.Username() != "" || password != "")) || u.Fragment != "" {
			return nil, bad("Use an HTTP(S) repository URL without credentials")
		}
		args = []string{"repo", "add", repo, u.String()}
	case "repo-remove":
		repo, err := validateName(body["repo"], "repository name")
		if err != nil {
			return nil, err
		}
		args = []string{"repo", "remove", repo}
	case "repo-update":
		args = []string{"repo", "update"}
		if truthy(body["repo"]) {
			repo, err := validateName(body["repo"], "repository name")
			if err != nil {
				return nil, err
			}
			args = append(args, repo)
		}
	default:
		kubeContext, err := validateText(body["context"], "context")
		if err != nil {
			return nil, err
		}
		namespace, err := validateNamespace(body["namespace"], false)
		if err != nil {
			return nil, err
		}
		name, err := validateName(body["name"], "release name")
		if err != nil {
			return nil, err
		}
		args = []string{action, name}
		install := action == "install" || action == "upgrade"
		if install {
			chart, err := validateChart(body["chart"])
			if err != nil {
				return nil, err
			}
			args = append(args, chart)
		}
		if action == "rollback" {
			revision, err := integer(body["revision"], "revision", 1, 1000000, nil)
			if err != nil {
				return nil, err
			}
			args = append(args, strconv.FormatInt(revision, 10))
		}
		nsArgs, err := namespaceArgs(namespace, false)
		if err != nil {
			return nil, err
		}
		args = append(append(args, "--kube-context="+kubeContext), nsArgs...)
		if install && truthy(body["version"]) {
			version, err := validateTextOpt(body["version"], "chart version", true, 128)
			if err != nil {
				return nil, err
			}
			args = append(args, "--version="+version)
		}
		if values, present := body["values"]; present && install {
			text, ok := values.(string)
			if !ok || len(text) > 1024*1024 {
				return nil, bad("Values must be YAML text up to 1 MiB")
			}
			if !validHelmValues(text) {
				return nil, bad("Invalid Helm values YAML")
			}
			args = append(args, "--values=-")
			input = text
		}
	}
	res, err := b.helm(q.ctx, args, RunOptions{Input: input, Timeout: 300 * time.Second})
	if err != nil {
		return nil, err
	}
	return obj{"output": res.Stdout + res.Stderr}, nil
}
