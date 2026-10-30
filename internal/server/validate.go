package server

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// Problem is an error that carries the HTTP status the API answers with.
type Problem struct {
	Status int
	Msg    string
}

func (p *Problem) Error() string { return p.Msg }

func problem(msg string, status int) *Problem { return &Problem{Status: status, Msg: msg} }
func bad(msg string) *Problem                 { return problem(msg, 400) }

// statusOf returns the HTTP status for any error.
func statusOf(err error) int {
	var p *Problem
	if errors.As(err, &p) {
		return p.Status
	}
	return 500
}

func shortError(err error) string {
	msg := err.Error()
	if r := []rune(msg); len(r) > 6000 {
		msg = string(r[:6000])
	}
	return msg
}

var (
	nameRE      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@-]*$`)
	resourceRE  = regexp.MustCompile(`^[a-z][a-z0-9.-]*$`)
	namespaceRE = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`)
	selectorRE  = regexp.MustCompile(`^[A-Za-z0-9_./=,!() -]+$`)
	intRE       = regexp.MustCompile(`^-?\d+$`)
	driveRE     = regexp.MustCompile(`^[A-Za-z]:`)
	chartRE     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]*$`)
	urlChartRE  = regexp.MustCompile(`(?i)^(?:https?|oci)://`)
)

func hasControl(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < 0x20 || s[i] == 0x7f {
			return true
		}
	}
	return false
}

// textOpts: required defaults to true when constructed through validateText.
func validateTextOpt(v any, label string, required bool, max int) (string, error) {
	if v == nil {
		if required {
			return "", bad(label + " is required")
		}
		return "", nil
	}
	s, ok := v.(string)
	if ok && s == "" {
		if required {
			return "", bad(label + " is required")
		}
		return "", nil
	}
	if !ok || len([]rune(s)) > max || hasControl(s) {
		return "", bad("Invalid " + label)
	}
	return s, nil
}

func validateText(v any, label string) (string, error) { return validateTextOpt(v, label, true, 512) }

func validateName(v any, label string) (string, error) {
	s, err := validateTextOpt(v, label, true, 253)
	if err != nil {
		return "", err
	}
	if !nameRE.MatchString(s) {
		return "", bad("Invalid " + label)
	}
	return s, nil
}

func validateResource(v any) (string, error) {
	s, err := validateTextOpt(v, "resource", true, 253)
	if err != nil {
		return "", err
	}
	if !resourceRE.MatchString(s) {
		return "", bad("Invalid resource")
	}
	return s, nil
}

func validateNamespace(v any, all bool) (string, error) {
	s, err := validateTextOpt(v, "namespace", false, 63)
	if err != nil {
		return "", err
	}
	if s == "" {
		return "", nil
	}
	if s == "*" {
		if !all {
			return "", bad("Choose one namespace for this action")
		}
		return s, nil
	}
	if !namespaceRE.MatchString(s) {
		return "", bad("Invalid namespace")
	}
	return s, nil
}

func contextArgs(v any) ([]string, error) {
	s, err := validateText(v, "context")
	if err != nil {
		return nil, err
	}
	return []string{"--context=" + s}, nil
}

func namespaceArgs(v any, all bool) ([]string, error) {
	ns, err := validateNamespace(v, all)
	if err != nil {
		return nil, err
	}
	if ns == "" || ns == "*" {
		if all {
			return []string{"--all-namespaces"}, nil
		}
		return nil, nil
	}
	return []string{"--namespace=" + ns}, nil
}

// integer accepts a JSON number or a decimal string. When empty and hasFallback, fallback is returned.
func integer(v any, label string, min, max int64, fallback *int64) (int64, error) {
	if (v == nil || v == "") && fallback != nil {
		return *fallback, nil
	}
	var n int64
	switch t := v.(type) {
	case float64:
		if t != float64(int64(t)) || t > 9007199254740991 || t < -9007199254740991 {
			return 0, bad("Invalid " + label)
		}
		n = int64(t)
	case int:
		n = int64(t)
	case int64:
		n = t
	case string:
		if !intRE.MatchString(t) {
			return 0, bad("Invalid " + label)
		}
		p, err := strconv.ParseInt(t, 10, 64)
		if err != nil || p > 9007199254740991 || p < -9007199254740991 {
			return 0, bad("Invalid " + label)
		}
		n = p
	default:
		return 0, bad("Invalid " + label)
	}
	if n < min || n > max {
		return 0, bad("Invalid " + label)
	}
	return n, nil
}

func fb(n int64) *int64 { return &n }

func validateSelector(v any, label string) (string, error) {
	s, err := validateTextOpt(v, label, true, 2000)
	if err != nil {
		return "", err
	}
	if !selectorRE.MatchString(s) || strings.Contains(s, "--") {
		return "", bad("Invalid " + label)
	}
	return s, nil
}

func countAliases(n *yaml.Node) int {
	if n == nil {
		return 0
	}
	c := 0
	if n.Kind == yaml.AliasNode {
		c++
	}
	for _, child := range n.Content {
		c += countAliases(child)
	}
	return c
}

func mappingValue(n *yaml.Node, key string) *yaml.Node {
	for i := 0; i+1 < len(n.Content); i += 2 {
		if n.Content[i].Value == key {
			return n.Content[i+1]
		}
	}
	return nil
}

func isStringScalar(n *yaml.Node) bool {
	if n != nil && n.Kind == yaml.AliasNode {
		n = n.Alias
	}
	return n != nil && n.Kind == yaml.ScalarNode && n.ShortTag() == "!!str"
}

// validateYAML checks a (multi-document) Kubernetes manifest the same way the Node backend did.
func validateYAML(source any) (string, error) {
	s, ok := source.(string)
	if !ok || strings.TrimSpace(s) == "" || len(s) > 1024*1024 {
		return "", bad("YAML must contain between 1 byte and 1 MiB")
	}
	dec := yaml.NewDecoder(bytes.NewReader([]byte(s)))
	found := false
	for {
		var node yaml.Node
		err := dec.Decode(&node)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", bad("Invalid YAML: " + firstLine(err.Error()))
		}
		if countAliases(&node) > 100 {
			return "", bad("Invalid YAML: too many aliases")
		}
		var decoded any
		if err := node.Decode(&decoded); err != nil {
			return "", bad("Invalid YAML: " + firstLine(err.Error()))
		}
		if decoded == nil {
			continue
		}
		root := &node
		if root.Kind == yaml.DocumentNode && len(root.Content) == 1 {
			root = root.Content[0]
		}
		if root.Kind == yaml.AliasNode {
			root = root.Alias
		}
		if root.Kind != yaml.MappingNode || !isStringScalar(mappingValue(root, "apiVersion")) || !isStringScalar(mappingValue(root, "kind")) {
			return "", bad("Each YAML document must be a Kubernetes object with apiVersion and kind")
		}
		found = true
	}
	if !found {
		return "", bad("YAML contains no resource")
	}
	return s, nil
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

func validateChart(v any) (string, error) {
	chart, err := validateTextOpt(v, "chart", true, 2048)
	if err != nil {
		return "", err
	}
	if urlChartRE.MatchString(chart) {
		u, err := url.Parse(chart)
		if err != nil {
			return "", bad("Invalid chart URL")
		}
		if u.User != nil || u.Fragment != "" || strings.Contains(chart, "#") {
			return "", bad("Chart URLs must not contain credentials or fragments")
		}
		return chart, nil
	}
	if !chartRE.MatchString(chart) || driveRE.MatchString(chart) {
		return "", bad("Use a repository chart reference, HTTPS chart URL, or OCI reference")
	}
	for _, part := range strings.Split(chart, "/") {
		if part == ".." {
			return "", bad("Use a repository chart reference, HTTPS chart URL, or OCI reference")
		}
	}
	return chart, nil
}

// str reads a string field of a decoded JSON body; non-strings become nil so validators reject them.
func field(body map[string]any, key string) any { return body[key] }

func errf(format string, a ...any) error { return fmt.Errorf(format, a...) }
