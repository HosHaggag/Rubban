package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
)

func randomHex(n int) string {
	buf := make([]byte, n)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

// writeFileAtomic writes data to path through an exclusively created temporary file and a rename.
func writeFileAtomic(path string, data []byte, mode os.FileMode, tmpBytes int) error {
	tmp := path + "." + randomHex(tmpBytes) + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

func (b *Backend) preferencesPath() string { return filepath.Join(b.dataDir, "preferences.json") }

func (b *Backend) readPreferences() (map[string]any, error) {
	data, err := os.ReadFile(b.preferencesPath())
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{}, nil
		}
		return nil, problem("Independent preferences could not be read", 500)
	}
	var value map[string]any
	if err := json.Unmarshal(data, &value); err != nil || value == nil {
		return nil, problem("Independent preferences could not be read", 500)
	}
	return value, nil
}

func (b *Backend) writePreferences(value map[string]any) (map[string]any, error) {
	if value == nil {
		return nil, bad("Preferences must be an object")
	}
	if err := validateClusters(value["clusters"], value["clusters"] != nil || hasKey(value, "clusters")); err != nil {
		return nil, err
	}
	if theme, ok := value["theme"]; ok {
		s, isString := theme.(string)
		if !isString || (s != "system" && s != "light" && s != "dark") {
			return nil, bad("Invalid theme")
		}
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return nil, bad("Preferences must be an object")
	}
	if len(data) > 256*1024 {
		return nil, problem("Preferences are too large", 413)
	}
	if err := os.MkdirAll(b.dataDir, 0o700); err != nil {
		return nil, err
	}
	if err := writeFileAtomic(b.preferencesPath(), append(data, '\n'), 0o600, 6); err != nil {
		return nil, err
	}
	return value, nil
}

func hasKey(m map[string]any, k string) bool { _, ok := m[k]; return ok }
