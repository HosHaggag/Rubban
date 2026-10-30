package live

import (
	"sort"
	"strconv"
)

const lastApplied = "kubectl.kubernetes.io/last-applied-configuration"

func itoa(n int) string { return strconv.Itoa(n) }

func objOf(v any) Object { m, _ := v.(map[string]any); return m }
func listOf(v any) []any { l, _ := v.([]any); return l }
func strOf(v any) string { s, _ := v.(string); return s }

// Sanitize returns a copy of object without managedFields. For Secrets it also drops the values
// (data, stringData) and records only the key names as dataKeys, and strips the last-applied
// annotation, which would carry the values.
func Sanitize(object Object, secret bool) Object {
	if object == nil {
		return object
	}
	out := make(Object, len(object)+1)
	for k, v := range object {
		out[k] = v
	}
	if meta := objOf(out["metadata"]); meta != nil {
		m := make(Object, len(meta))
		for k, v := range meta {
			if k != "managedFields" {
				m[k] = v
			}
		}
		if secret {
			if ann := objOf(m["annotations"]); ann != nil && truthy(ann[lastApplied]) {
				a := make(Object, len(ann))
				for k, v := range ann {
					if k != lastApplied {
						a[k] = v
					}
				}
				m["annotations"] = a
			}
		}
		out["metadata"] = m
	}
	if secret {
		// Key names (never values) let the UI list a secret's keys without revealing it.
		seen := map[string]bool{}
		var keys []any
		for _, field := range []string{"data", "stringData"} {
			names := make([]string, 0)
			for k := range objOf(out[field]) {
				names = append(names, k)
			}
			sort.Strings(names)
			for _, k := range names {
				if !seen[k] {
					seen[k] = true
					keys = append(keys, k)
				}
			}
		}
		delete(out, "data")
		delete(out, "stringData")
		if len(keys) > 0 {
			out["dataKeys"] = keys
		}
	}
	return out
}

func truthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case string:
		return t != ""
	case bool:
		return t
	}
	return true
}

// ItemKey identifies an object in a watch: metadata.uid, else namespace/name.
func ItemKey(item Object) string {
	meta := objOf(item["metadata"])
	if uid := strOf(meta["uid"]); uid != "" {
		return uid
	}
	return strOf(meta["namespace"]) + "/" + strOf(meta["name"])
}

// encodeURIComponent escapes like the JavaScript function of the same name.
func encodeURIComponent(s string) string {
	const hex = "0123456789ABCDEF"
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9',
			c == '-', c == '_', c == '.', c == '!', c == '~', c == '*', c == '\'', c == '(', c == ')':
			out = append(out, c)
		default:
			out = append(out, '%', hex[c>>4], hex[c&15])
		}
	}
	return string(out)
}
