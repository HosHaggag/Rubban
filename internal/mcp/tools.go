package mcp

import (
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"unicode/utf16"
)

type annotations struct {
	ReadOnlyHint    bool `json:"readOnlyHint"`
	DestructiveHint bool `json:"destructiveHint"`
	IdempotentHint  bool `json:"idempotentHint"`
	OpenWorldHint   bool `json:"openWorldHint"`
}

type tool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
	Annotations annotations     `json:"annotations"`

	properties map[string]bool
	required   []string
}

const (
	contextSchema   = `{"type":"string","minLength":1,"maxLength":512,"description":"An exact Kubernetes context returned by list_contexts"}`
	namespaceSchema = `{"type":"string","pattern":"^[a-z0-9][a-z0-9.-]*$","maxLength":253}`
)

func newTool(name, description string, props [][2]string, required ...string) tool {
	var b strings.Builder
	b.WriteString(`{"type":"object","properties":{`)
	set := map[string]bool{}
	for i, p := range props {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(`"` + p[0] + `":` + p[1])
		set[p[0]] = true
	}
	b.WriteString(`}`)
	if len(required) > 0 {
		req, _ := json.Marshal(required)
		b.WriteString(`,"required":` + string(req))
	}
	b.WriteString(`,"additionalProperties":false}`)
	return tool{
		Name: name, Description: description, InputSchema: json.RawMessage(b.String()),
		Annotations: annotations{ReadOnlyHint: true, DestructiveHint: false, IdempotentHint: true, OpenWorldHint: true},
		properties:  set, required: required,
	}
}

var tools = func() []tool {
	enum, _ := json.Marshal(resourceList)
	resourceSchema := `{"type":"string","enum":` + string(enum) + `}`
	return []tool{
		newTool("list_contexts", "List local Kubernetes contexts available in Rubban. Does not connect or change context.", nil),
		newTool("list_resources", "Read a Kubernetes resource list through the local Rubban API. Secrets and write operations are excluded.",
			[][2]string{{"context", contextSchema}, {"resource", resourceSchema}, {"namespace", namespaceSchema}}, "context", "resource"),
		newTool("resource_details", "Read one Kubernetes object through the local Rubban API. Secrets and write operations are excluded.",
			[][2]string{{"context", contextSchema}, {"resource", resourceSchema}, {"namespace", namespaceSchema}, {"name", namespaceSchema}}, "context", "resource", "name"),
		newTool("metrics", "Read node and pod metric snapshots. Requires the Kubernetes metrics API.",
			[][2]string{{"context", contextSchema}, {"namespace", namespaceSchema}}, "context"),
	}
}()

// request is one GET against the Rubban API.
type request struct {
	path   string
	params url.Values
}

// requestForTool validates a tools/call and maps it to a fixed, read-only API endpoint.
func requestForTool(name any, rawArgs any) (request, error) {
	args, ok := rawArgs.(map[string]any)
	if !ok {
		return request{}, errors.New("Tool arguments must be an object")
	}
	toolName, _ := name.(string)
	var t *tool
	for i := range tools {
		if name != nil && tools[i].Name == toolName {
			t = &tools[i]
		}
	}
	if t == nil {
		return request{}, errors.New("Unknown tool")
	}
	for k := range args {
		if !t.properties[k] {
			return request{}, errors.New("Unsupported tool argument")
		}
	}
	for _, key := range t.required {
		if s, ok := args[key].(string); !ok || s == "" {
			return request{}, errors.New(key + " is required")
		}
	}
	if toolName == "list_contexts" {
		return request{path: "/api/contexts", params: url.Values{}}, nil
	}
	ctx, _ := args["context"].(string)
	if ctx == "" || strings.HasPrefix(ctx, "-") || len(utf16.Encode([]rune(ctx))) > 512 || hasControl(ctx) {
		return request{}, errors.New("Invalid context")
	}
	params := url.Values{"context": {ctx}}
	namespace, hasNamespace := args["namespace"]
	if hasNamespace {
		q, err := ValidateQuery(map[string]any{"resource": "pods", "namespace": namespace})
		if err != nil {
			return request{}, err
		}
		if q.Namespace != "" {
			params.Set("namespace", q.Namespace)
		}
	}
	if toolName == "metrics" {
		return request{path: "/api/metrics", params: params}, nil
	}
	resource, _ := args["resource"].(string)
	if !resources[resource] {
		return request{}, errors.New("Resource is not permitted")
	}
	query := map[string]any{"resource": resource}
	if hasNamespace {
		query["namespace"] = namespace
	}
	if toolName == "resource_details" {
		query["name"] = args["name"]
	}
	q, err := ValidateQuery(query)
	if err != nil {
		return request{}, err
	}
	params.Set("resource", q.Resource)
	if q.Name != "" {
		params.Set("name", q.Name)
	}
	path := "/api/resources"
	if toolName == "resource_details" {
		path = "/api/resource"
	}
	return request{path: path, params: params}, nil
}

func hasControl(s string) bool {
	for _, r := range s {
		if r <= 0x1f || r == 0x7f {
			return true
		}
	}
	return false
}
