package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Pinned terminal bundles; bump together with a review of the npm release.
const (
	xtermVersion    = "6.0.0"
	xtermFitVersion = "0.11.0"
)

type npmFile struct{ from, to string }

// fetchNPMFiles downloads a package tarball, verifies it against the registry's dist.integrity and
// returns the requested files.
func fetchNPMFiles(client *http.Client, pkg, version string, wanted []string) (map[string][]byte, error) {
	res, err := client.Get(fmt.Sprintf("https://registry.npmjs.org/%s/%s", pkg, version))
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("npm registry: %s@%s: %d", pkg, version, res.StatusCode)
	}
	var meta struct {
		Dist struct{ Tarball, Integrity string } `json:"dist"`
	}
	if err := json.NewDecoder(res.Body).Decode(&meta); err != nil {
		return nil, err
	}
	if !strings.HasPrefix(meta.Dist.Integrity, "sha512-") {
		return nil, fmt.Errorf("%s@%s has no sha512 integrity", pkg, version)
	}
	tgz, err := client.Get(meta.Dist.Tarball)
	if err != nil {
		return nil, err
	}
	defer tgz.Body.Close()
	data, err := io.ReadAll(tgz.Body)
	if err != nil {
		return nil, err
	}
	sum := sha512.Sum512(data)
	if got := "sha512-" + base64.StdEncoding.EncodeToString(sum[:]); got != meta.Dist.Integrity {
		return nil, fmt.Errorf("%s@%s: integrity mismatch", pkg, version)
	}
	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	tr := tar.NewReader(gz)
	out := map[string][]byte{}
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		for _, w := range wanted {
			if h.Name == "package/"+w {
				if out[w], err = io.ReadAll(tr); err != nil {
					return nil, err
				}
			}
		}
	}
	for _, w := range wanted {
		if out[w] == nil {
			return nil, fmt.Errorf("%s@%s: %s not found", pkg, version, w)
		}
	}
	return out, nil
}

// cmdFetchXterm refreshes the vendored terminal files in ui/. The results are committed.
func cmdFetchXterm() error {
	root, err := repoRoot()
	if err != nil {
		return err
	}
	ui := filepath.Join(root, "ui")
	client := http.DefaultClient
	xt, err := fetchNPMFiles(client, "@xterm/xterm", xtermVersion, []string{"lib/xterm.js", "css/xterm.css", "LICENSE"})
	if err != nil {
		return err
	}
	fit, err := fetchNPMFiles(client, "@xterm/addon-fit", xtermFitVersion, []string{"lib/addon-fit.js", "LICENSE"})
	if err != nil {
		return err
	}
	files := map[string][]byte{
		"xterm.js": xt["lib/xterm.js"], "xterm.css": xt["css/xterm.css"], "LICENSE-xterm.txt": xt["LICENSE"],
		"addon-fit.js": fit["lib/addon-fit.js"], "LICENSE-xterm-fit.txt": fit["LICENSE"],
		// The published bundles are UMD; loading them as side-effect modules uses the globalThis branch.
		"vendor.js": []byte("import './xterm.js';\nimport './addon-fit.js';\nexport const Terminal = globalThis.Terminal;\nexport const FitAddon = globalThis.FitAddon.FitAddon;\n"),
	}
	for name, data := range files {
		if err := os.WriteFile(filepath.Join(ui, name), data, 0o644); err != nil {
			return err
		}
	}
	fmt.Printf("Vendored @xterm/xterm %s and @xterm/addon-fit %s into ui/\n", xtermVersion, xtermFitVersion)
	return nil
}
