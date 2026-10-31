package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Manifest keys use Node's platform and arch names so installed 0.11.0 apps keep matching.
var manifestTargets = map[string]string{"Windows-x64": "win32-x64", "macOS-arm64": "darwin-arm64", "macOS-x64": "darwin-x64"}
var assetRE = regexp.MustCompile(`^Rubban-(.+)-(Windows-x64|macOS-arm64|macOS-x64)\.zip$`)

// The Windows installer is listed under its own key; builds put in place by it update from this asset.
var setupRE = regexp.MustCompile(`^Rubban-(.+)-Setup\.exe$`)

const setupKey = "win32-x64-setup"

type fileInfo struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

type latestManifest struct {
	Version string              `json:"version"`
	Assets  map[string]fileInfo `json:"assets"`
	Notes   string              `json:"notes"`
}

func buildManifest(files []fileInfo, version, notes string) (string, latestManifest, error) {
	assets := map[string]fileInfo{}
	var sums []string
	for _, f := range files {
		sums = append(sums, f.SHA256+"  "+f.Name)
		if m := assetRE.FindStringSubmatch(f.Name); m != nil && m[1] == version {
			assets[manifestTargets[m[2]]] = f
		}
	}
	// The setup is optional (releases before the installer have none) and never stands alone.
	if len(assets) == 0 {
		return "", latestManifest{}, fmt.Errorf("No Rubban-%s-*.zip files found", version)
	}
	for _, f := range files {
		if m := setupRE.FindStringSubmatch(f.Name); m != nil && m[1] == version {
			assets[setupKey] = f
		}
	}
	return strings.Join(sums, "\n") + "\n", latestManifest{Version: version, Assets: assets, Notes: notes}, nil
}

// describeZips hashes the release files of a folder: the zips and the Windows installer.
func describeZips(dir string) ([]fileInfo, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var out []fileInfo
	for _, e := range entries {
		if e.IsDir() || !(strings.HasSuffix(e.Name(), ".zip") || setupRE.MatchString(e.Name())) {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return nil, err
		}
		sum := sha256.Sum256(data)
		out = append(out, fileInfo{Name: e.Name(), SHA256: hex.EncodeToString(sum[:]), Size: int64(len(data))})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func cmdWriteManifest(args []string) error {
	dir := "release"
	if len(args) > 0 {
		dir = args[0]
	}
	dir, _ = filepath.Abs(dir)
	root, err := repoRoot()
	if err != nil {
		return err
	}
	version, err := readVersion(root)
	if err != nil {
		return err
	}
	changelog, err := os.ReadFile(filepath.Join(root, "CHANGELOG.md"))
	if err != nil {
		return err
	}
	notes, err := releaseNotes(string(changelog), version)
	if err != nil {
		return err
	}
	files, err := describeZips(dir)
	if err != nil {
		return err
	}
	if len(files) == 0 {
		return errors.New("no zip files in " + dir)
	}
	sums, latest, err := buildManifest(files, version, notes)
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "SHA256SUMS.txt"), []byte(sums), 0o644); err != nil {
		return err
	}
	data, _ := json.MarshalIndent(latest, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, "latest.json"), append(data, '\n'), 0o644); err != nil {
		return err
	}
	fmt.Printf("Wrote SHA256SUMS.txt and latest.json for %s\n", version)
	return nil
}
