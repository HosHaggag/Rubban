package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strconv"

	"gopkg.in/yaml.v3"
)

// jsonNode decodes JSON into a yaml.Node tree that keeps object key order.
func jsonNode(dec *json.Decoder) (*yaml.Node, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		if t == '{' {
			n := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
			for dec.More() {
				keyTok, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, _ := keyTok.(string)
				val, err := jsonNode(dec)
				if err != nil {
					return nil, err
				}
				n.Content = append(n.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, val)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return n, nil
		}
		n := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
		for dec.More() {
			val, err := jsonNode(dec)
			if err != nil {
				return nil, err
			}
			n.Content = append(n.Content, val)
		}
		if _, err := dec.Token(); err != nil {
			return nil, err
		}
		return n, nil
	case string:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: t}, nil
	case json.Number:
		tag := "!!int"
		if _, err := strconv.ParseInt(t.String(), 10, 64); err != nil {
			tag = "!!float"
		}
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: tag, Value: t.String()}, nil
	case bool:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: strconv.FormatBool(t)}, nil
	case nil:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!null", Value: "null"}, nil
	}
	return nil, fmt.Errorf("unexpected JSON token %v", tok)
}

// objectYAML renders a Kubernetes object as YAML the way kubectl does: apiVersion, kind and
// metadata first, everything else in source order.
func objectYAML(raw []byte) (string, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	root, err := jsonNode(dec)
	if err != nil && err != io.EOF {
		return "", err
	}
	if root != nil && root.Kind == yaml.MappingNode {
		ordered := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		taken := map[int]bool{}
		for _, first := range []string{"apiVersion", "kind", "metadata"} {
			for i := 0; i+1 < len(root.Content); i += 2 {
				if root.Content[i].Value == first && !taken[i] {
					ordered.Content = append(ordered.Content, root.Content[i], root.Content[i+1])
					taken[i] = true
				}
			}
		}
		for i := 0; i+1 < len(root.Content); i += 2 {
			if !taken[i] {
				ordered.Content = append(ordered.Content, root.Content[i], root.Content[i+1])
			}
		}
		root = ordered
	}
	var out bytes.Buffer
	enc := yaml.NewEncoder(&out)
	enc.SetIndent(2)
	if err := enc.Encode(root); err != nil {
		return "", err
	}
	_ = enc.Close()
	return out.String(), nil
}
