package server

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
)

const maxKubeconfigBytes = 1024 * 1024

// ClusterIcons and ClusterEnvs mirror server/kubeconfigs.cjs.
var ClusterIcons = []string{"cluster", "gcp", "aws", "azure", "local", "production", "staging", "development", "database", "globe", "shield", "flask", "rocket", "star", "bolt", "box"}
var ClusterEnvs = []string{"production", "staging", "development", "other", ""}

var (
	idRE    = regexp.MustCompile(`^[a-f0-9]{16}$`)
	colorRE = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
)

// KubeconfigEntry is one imported kubeconfig as stored in index.json.
type KubeconfigEntry struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Source   string   `json:"source"`
	FileName string   `json:"fileName"`
	AddedAt  string   `json:"addedAt"`
	Contexts []string `json:"contexts"`
}

// kubeconfigNames are the names a kubeconfig defines.
type kubeconfigNames struct{ Contexts, Clusters, Users []string }

// parseKubeconfig validates a kubeconfig document and returns its context, cluster and user names.
func parseKubeconfig(content string) (kubeconfigNames, error) {
	var names kubeconfigNames
	if strings.TrimSpace(content) == "" {
		return names, bad("The kubeconfig is empty")
	}
	if len(content) > maxKubeconfigBytes {
		return names, problem("The kubeconfig is larger than 1 MB", 413)
	}
	var doc any
	if err := yaml.Unmarshal([]byte(content), &doc); err != nil {
		return names, bad("The kubeconfig is not valid YAML: " + firstLine(err.Error()))
	}
	m, ok := doc.(map[string]any)
	if !ok {
		return names, bad("The kubeconfig must be a YAML mapping")
	}
	if m["apiVersion"] != "v1" || m["kind"] != "Config" {
		return names, bad(`Not a kubeconfig: expected "apiVersion: v1" and "kind: Config"`)
	}
	lists := map[string][]any{}
	for _, key := range []string{"clusters", "contexts", "users"} {
		l, ok := m[key].([]any)
		if !ok {
			return names, bad(fmt.Sprintf(`The kubeconfig has no "%s" list`, key))
		}
		lists[key] = l
	}
	collect := func(items []any) []string {
		var out []string
		for _, it := range items {
			mm, _ := it.(map[string]any)
			n, _ := mm["name"].(string)
			out = append(out, n)
		}
		return out
	}
	ctxs := collect(lists["contexts"])
	if len(ctxs) == 0 {
		return names, bad("The kubeconfig needs at least one context, and every context needs a name")
	}
	for _, n := range ctxs {
		if n == "" || utf8.RuneCountInString(n) > 253 {
			return names, bad("The kubeconfig needs at least one context, and every context needs a name")
		}
	}
	names.Contexts = dedupe(ctxs)
	names.Clusters = dedupe(collect(lists["clusters"]))
	names.Users = dedupe(collect(lists["users"]))
	return names, nil
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// kubeconfigStore keeps imported kubeconfigs in <dataDir>/kubeconfigs and merges them into KUBECONFIG
// for processes Rubban starts. The user's own kubeconfig is never written.
type kubeconfigStore struct {
	dir   string
	mu    sync.Mutex
	cache []KubeconfigEntry
	valid bool
}

func newKubeconfigStore(dataDir string) *kubeconfigStore {
	return &kubeconfigStore{dir: filepath.Join(dataDir, "kubeconfigs")}
}

func (s *kubeconfigStore) fileFor(id string) string { return filepath.Join(s.dir, id+".yaml") }
func (s *kubeconfigStore) indexPath() string        { return filepath.Join(s.dir, "index.json") }

func (s *kubeconfigStore) readIndex() []KubeconfigEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readIndexLocked()
}

func (s *kubeconfigStore) readIndexLocked() []KubeconfigEntry {
	if s.valid {
		return s.cache
	}
	entries := []KubeconfigEntry{}
	if data, err := os.ReadFile(s.indexPath()); err == nil {
		var raw []json.RawMessage
		if json.Unmarshal(data, &raw) == nil {
			for _, r := range raw {
				var e KubeconfigEntry
				var probe struct {
					Contexts any `json:"contexts"`
				}
				if json.Unmarshal(r, &e) != nil || json.Unmarshal(r, &probe) != nil {
					continue
				}
				if _, ok := probe.Contexts.([]any); !ok || !idRE.MatchString(e.ID) {
					continue
				}
				if _, err := os.Stat(s.fileFor(e.ID)); err != nil {
					continue
				}
				entries = append(entries, e)
			}
		}
	}
	s.cache, s.valid = entries, true
	return entries
}

func (s *kubeconfigStore) writeIndexLocked(entries []KubeconfigEntry) error {
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return err
	}
	if err := writeFileAtomic(s.indexPath(), append(data, '\n'), 0o600, 4); err != nil {
		return err
	}
	s.valid = false
	return nil
}

func (s *kubeconfigStore) list() []KubeconfigEntry {
	entries := s.readIndex()
	return append([]KubeconfigEntry{}, entries...)
}

func (s *kubeconfigStore) files() []string {
	var out []string
	for _, e := range s.readIndex() {
		out = append(out, s.fileFor(e.ID))
	}
	return out
}

// variable returns the KUBECONFIG value for child processes, or "" while nothing is imported.
func (s *kubeconfigStore) variable() string {
	imported := s.files()
	if len(imported) == 0 {
		return ""
	}
	base := os.Getenv("KUBECONFIG")
	if base == "" {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, ".kube", "config")
	}
	return strings.Join(append([]string{base}, imported...), string(os.PathListSeparator))
}

func (s *kubeconfigStore) sourceOf(name string) string {
	for _, e := range s.readIndex() {
		for _, c := range e.Contexts {
			if c == name {
				return e.ID
			}
		}
	}
	return "default"
}

// importedNames lists the names defined by the imported files (used when kubectl is unavailable).
func (s *kubeconfigStore) importedNames() kubeconfigNames {
	var all kubeconfigNames
	for _, e := range s.readIndex() {
		data, err := os.ReadFile(s.fileFor(e.ID))
		if err != nil {
			continue
		}
		if n, err := parseKubeconfig(string(data)); err == nil {
			all.Contexts = append(all.Contexts, n.Contexts...)
			all.Clusters = append(all.Clusters, n.Clusters...)
			all.Users = append(all.Users, n.Users...)
		}
	}
	return all
}

func intersect(a, b []string) []string {
	set := map[string]bool{}
	for _, s := range b {
		set[s] = true
	}
	var out []string
	for _, s := range a {
		if set[s] {
			out = append(out, s)
		}
	}
	return out
}

func (s *kubeconfigStore) add(name, content, source, fileName string, existing kubeconfigNames) (KubeconfigEntry, error) {
	names, err := parseKubeconfig(content)
	if err != nil {
		return KubeconfigEntry{}, err
	}
	if clashes := intersect(names.Contexts, existing.Contexts); len(clashes) > 0 {
		return KubeconfigEntry{}, problem(fmt.Sprintf("These contexts already exist: %s. Rename them in the kubeconfig before importing.", strings.Join(clashes, ", ")), 409)
	}
	// kubectl merges KUBECONFIG files first-file-wins for clusters and users too, so a shared name
	// would silently point the imported context at another file's server or credentials.
	if clashes := intersect(names.Clusters, existing.Clusters); len(clashes) > 0 {
		return KubeconfigEntry{}, problem(fmt.Sprintf("These clusters already exist: %s. Rename them in the kubeconfig before importing.", strings.Join(clashes, ", ")), 409)
	}
	if clashes := intersect(names.Users, existing.Users); len(clashes) > 0 {
		return KubeconfigEntry{}, problem(fmt.Sprintf("These users already exist: %s. Rename them in the kubeconfig before importing.", strings.Join(clashes, ", ")), 409)
	}
	label := clip(strings.TrimSpace(name), 80)
	if label == "" {
		label = clip(strings.TrimSpace(fileName), 80)
	}
	if label == "" {
		label = "Imported kubeconfig"
	}
	entry := KubeconfigEntry{ID: randomHex(8), Name: label, Source: "paste", AddedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), Contexts: names.Contexts}
	if source == "file" {
		entry.Source = "file"
		entry.FileName = clip(fileName, 200)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return KubeconfigEntry{}, err
	}
	if err := os.WriteFile(s.fileFor(entry.ID), []byte(content), 0o600); err != nil {
		return KubeconfigEntry{}, err
	}
	if err := s.writeIndexLocked(append(append([]KubeconfigEntry{}, s.readIndexLocked()...), entry)); err != nil {
		return KubeconfigEntry{}, err
	}
	return entry, nil
}

func clip(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

func (s *kubeconfigStore) remove(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	entries := s.readIndexLocked()
	idx := -1
	for i, e := range entries {
		if e.ID == id {
			idx = i
		}
	}
	if idx < 0 {
		return problem("Imported kubeconfig not found", 404)
	}
	_ = os.Remove(s.fileFor(id))
	rest := append(append([]KubeconfigEntry{}, entries[:idx]...), entries[idx+1:]...)
	return s.writeIndexLocked(rest)
}

// validateClusters checks the per-cluster display preferences.
func validateClusters(value any, present bool) error {
	if !present || value == nil {
		return nil
	}
	m, ok := value.(map[string]any)
	if !ok {
		return bad("Invalid clusters preference")
	}
	if len(m) > 500 {
		return bad("Too many cluster entries")
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, name := range keys {
		entry, ok := m[name].(map[string]any)
		if name == "" || utf8.RuneCountInString(name) > 253 || !ok {
			return bad("Invalid cluster entry")
		}
		if v, has := entry["label"]; has {
			if s, ok := v.(string); !ok || utf8.RuneCountInString(s) > 80 {
				return bad("Invalid cluster label")
			}
		}
		if v, has := entry["icon"]; has {
			s, ok := v.(string)
			if !ok || (s != "" && !contains(ClusterIcons, s)) {
				return bad("Invalid cluster icon")
			}
		}
		if v, has := entry["color"]; has {
			s, ok := v.(string)
			if !ok || (s != "" && !colorRE.MatchString(s)) {
				return bad("Invalid cluster colour")
			}
		}
		if v, has := entry["env"]; has {
			s, ok := v.(string)
			if !ok || !contains(ClusterEnvs, s) {
				return bad("Invalid cluster environment")
			}
		}
	}
	return nil
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
