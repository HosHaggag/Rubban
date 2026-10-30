package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

//go:embed tool-versions.json
var toolVersionsJSON []byte

type toolVersions struct {
	Kubectl string `json:"kubectl"`
	Helm    string `json:"helm"`
}

type toolURLs struct {
	Kubectl, KubectlChecksum string
	Helm, HelmChecksum       string
	HelmFile, HelmInner      string
}

var osNames = map[string]string{"win32": "windows", "windows": "windows", "darwin": "darwin", "linux": "linux"}
var archNames = map[string]string{"x64": "amd64", "amd64": "amd64", "arm64": "arm64"}

func urlsFor(platform, arch string, v toolVersions) (toolURLs, error) {
	osName, cpu := osNames[platform], archNames[arch]
	if osName == "" || cpu == "" {
		return toolURLs{}, fmt.Errorf("Unsupported target %s-%s", platform, arch)
	}
	exe, ext := "", "tar.gz"
	if osName == "windows" {
		exe, ext = ".exe", "zip"
	}
	k := fmt.Sprintf("https://dl.k8s.io/release/%s/bin/%s/%s/kubectl%s", v.Kubectl, osName, cpu, exe)
	file := fmt.Sprintf("helm-%s-%s-%s.%s", v.Helm, osName, cpu, ext)
	h := "https://get.helm.sh/" + file
	return toolURLs{Kubectl: k, KubectlChecksum: k + ".sha256", Helm: h, HelmChecksum: h + ".sha256sum", HelmFile: file, HelmInner: fmt.Sprintf("%s-%s/helm%s", osName, cpu, exe)}, nil
}

var sha256RE = regexp.MustCompile(`^[0-9a-f]{64}$`)

// verifyChecksum accepts "<hash>" or "<hash>  <name>" checksum files.
func verifyChecksum(data []byte, checksumText, label string) error {
	fields := strings.Fields(checksumText)
	expected := ""
	if len(fields) > 0 {
		expected = strings.ToLower(fields[0])
	}
	if !sha256RE.MatchString(expected) {
		return fmt.Errorf("%s: the published checksum is not a SHA-256", label)
	}
	sum := sha256.Sum256(data)
	if actual := hex.EncodeToString(sum[:]); actual != expected {
		return fmt.Errorf("%s: checksum mismatch (expected %s, got %s)", label, expected, actual)
	}
	return nil
}

func download(client *http.Client, url string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("Download failed (%d): %s", res.StatusCode, url)
	}
	return io.ReadAll(res.Body)
}

// extractHelm pulls one file out of the helm release archive (zip on Windows, tar.gz elsewhere).
func extractHelm(archive []byte, file, inner string) ([]byte, error) {
	if strings.HasSuffix(file, ".zip") {
		zr, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
		if err != nil {
			return nil, err
		}
		for _, f := range zr.File {
			if f.Name == inner {
				rc, err := f.Open()
				if err != nil {
					return nil, err
				}
				defer rc.Close()
				return io.ReadAll(rc)
			}
		}
		return nil, fmt.Errorf("%s not found in %s", inner, file)
	}
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil, fmt.Errorf("%s not found in %s", inner, file)
		}
		if err != nil {
			return nil, err
		}
		if h.Name == inner {
			return io.ReadAll(tr)
		}
	}
}

func fetchTools(client *http.Client, platform, arch, outDir string, v toolVersions) (map[string]string, error) {
	urls, err := urlsFor(platform, arch, v)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return nil, err
	}
	exe := ""
	if osNames[platform] == "windows" {
		exe = ".exe"
	}
	kubectl, err := download(client, urls.Kubectl)
	if err != nil {
		return nil, err
	}
	sum, err := download(client, urls.KubectlChecksum)
	if err != nil {
		return nil, err
	}
	if err := verifyChecksum(kubectl, string(sum), "kubectl"); err != nil {
		return nil, err
	}
	kubectlPath := filepath.Join(outDir, "kubectl"+exe)
	if err := os.WriteFile(kubectlPath, kubectl, 0o755); err != nil {
		return nil, err
	}
	archive, err := download(client, urls.Helm)
	if err != nil {
		return nil, err
	}
	sum, err = download(client, urls.HelmChecksum)
	if err != nil {
		return nil, err
	}
	if err := verifyChecksum(archive, string(sum), "helm"); err != nil {
		return nil, err
	}
	helm, err := extractHelm(archive, urls.HelmFile, urls.HelmInner)
	if err != nil {
		return nil, err
	}
	helmPath := filepath.Join(outDir, "helm"+exe)
	if err := os.WriteFile(helmPath, helm, 0o755); err != nil {
		return nil, err
	}
	return map[string]string{"kubectl": kubectlPath, "helm": helmPath}, nil
}

func cmdFetchTools(args []string) error {
	if len(args) != 3 {
		return errors.New("usage: buildtool fetch-tools <win32|windows|darwin> <x64|arm64> <outDir>")
	}
	var v toolVersions
	if err := json.Unmarshal(toolVersionsJSON, &v); err != nil {
		return err
	}
	out, _ := filepath.Abs(args[2])
	result, err := fetchTools(http.DefaultClient, args[0], args[1], out, v)
	if err != nil {
		return err
	}
	data, _ := json.Marshal(result)
	fmt.Println(string(data))
	return nil
}
