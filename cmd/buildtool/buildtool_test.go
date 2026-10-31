package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const changelog = "# Changelog\n\n## 0.12.0: Go\n\n- one\n\n## 0.11.0\n\n- old\n\n## 0.10.0\n\n"

func TestReleaseNotes(t *testing.T) {
	got, err := releaseNotes(changelog, "0.12.0")
	if err != nil || got != "- one" {
		t.Fatalf("%q %v", got, err)
	}
	if _, err := releaseNotes(changelog, "9.9.9"); err == nil {
		t.Fatal("missing section accepted")
	}
	if _, err := releaseNotes(changelog, "0.10.0"); err == nil || !strings.Contains(err.Error(), "empty") {
		t.Fatalf("empty section accepted: %v", err)
	}
}

func TestCheckVersion(t *testing.T) {
	if err := checkVersion("v0.12.0", "0.12.0", changelog); err != nil {
		t.Fatal(err)
	}
	for _, tag := range []string{"", "v0.11.0", "v0.12.1"} {
		if checkVersion(tag, "0.12.0", changelog) == nil {
			t.Fatalf("tag %q accepted", tag)
		}
	}
	if checkVersion("v0.13.0", "0.13.0", changelog) == nil {
		t.Fatal("version without changelog accepted")
	}
}

func TestBump(t *testing.T) {
	for in, want := range map[string]string{"major": "1.0.0", "minor": "0.12.0", "patch": "0.11.4", "2.0.1": "2.0.1"} {
		got, err := bump("0.11.3", in)
		if err != nil || got != want {
			t.Errorf("%s: %q %v", in, got, err)
		}
	}
	if _, err := bump("0.11.3", "sideways"); err == nil {
		t.Fatal("bad kind accepted")
	}
}

func TestBuildManifestKeysUseNodeNames(t *testing.T) {
	files := []fileInfo{
		{"Rubban-0.12.0-Windows-x64.zip", strings.Repeat("a", 64), 10},
		{"Rubban-0.12.0-macOS-arm64.zip", strings.Repeat("b", 64), 20},
		{"Rubban-0.11.0-macOS-x64.zip", strings.Repeat("c", 64), 30},
	}
	sums, latest, err := buildManifest(files, "0.12.0", "notes")
	if err != nil {
		t.Fatal(err)
	}
	if len(latest.Assets) != 2 || latest.Assets["win32-x64"].Name != "Rubban-0.12.0-Windows-x64.zip" || latest.Assets["darwin-arm64"].Size != 20 {
		t.Fatalf("assets %v", latest.Assets)
	}
	if !strings.Contains(sums, strings.Repeat("c", 64)+"  Rubban-0.11.0-macOS-x64.zip\n") {
		t.Fatalf("sums %q", sums)
	}
	if _, _, err := buildManifest(files[2:], "0.12.0", ""); err == nil {
		t.Fatal("no matching asset accepted")
	}
}

func TestToolURLsAndChecksums(t *testing.T) {
	v := toolVersions{Kubectl: "v1.34.1", Helm: "v3.20.2"}
	u, err := urlsFor("win32", "x64", v)
	if err != nil || u.Kubectl != "https://dl.k8s.io/release/v1.34.1/bin/windows/amd64/kubectl.exe" || u.HelmFile != "helm-v3.20.2-windows-amd64.zip" || u.HelmInner != "windows-amd64/helm.exe" || u.HelmChecksum != "https://get.helm.sh/helm-v3.20.2-windows-amd64.zip.sha256sum" {
		t.Fatalf("%+v %v", u, err)
	}
	if u, _ := urlsFor("darwin", "arm64", v); u.HelmFile != "helm-v3.20.2-darwin-arm64.tar.gz" || !strings.HasSuffix(u.Kubectl, "/darwin/arm64/kubectl") {
		t.Fatalf("%+v", u)
	}
	if _, err := urlsFor("plan9", "x64", v); err == nil {
		t.Fatal("bad target")
	}
	data := []byte("hello")
	const hello = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
	if verifyChecksum(data, hello+"  helm.tgz\n", "x") != nil || verifyChecksum(data, strings.ToUpper(hello), "x") != nil {
		t.Fatal("good checksum rejected")
	}
	if verifyChecksum(data, strings.Repeat("0", 64), "x") == nil || verifyChecksum(data, "not-a-hash", "x") == nil {
		t.Fatal("bad checksum accepted")
	}
}

func TestExtractHelm(t *testing.T) {
	var zb bytes.Buffer
	zw := zip.NewWriter(&zb)
	w, _ := zw.Create("windows-amd64/helm.exe")
	_, _ = w.Write([]byte("EXE"))
	_ = zw.Close()
	got, err := extractHelm(zb.Bytes(), "helm.zip", "windows-amd64/helm.exe")
	if err != nil || string(got) != "EXE" {
		t.Fatalf("zip: %q %v", got, err)
	}
	var tb bytes.Buffer
	gz := gzip.NewWriter(&tb)
	tw := tar.NewWriter(gz)
	_ = tw.WriteHeader(&tar.Header{Name: "darwin-arm64/helm", Mode: 0o755, Size: 3})
	_, _ = tw.Write([]byte("BIN"))
	_ = tw.Close()
	_ = gz.Close()
	if got, err := extractHelm(tb.Bytes(), "helm.tar.gz", "darwin-arm64/helm"); err != nil || string(got) != "BIN" {
		t.Fatalf("tar: %q %v", got, err)
	}
	if _, err := extractHelm(tb.Bytes(), "helm.tar.gz", "missing"); err == nil {
		t.Fatal("missing member accepted")
	}
}

func TestZipDirectory(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "Pkg")
	_ = os.MkdirAll(filepath.Join(dir, "sub"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "a.txt"), bytes.Repeat([]byte("abcd"), 1000), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "run.sh"), []byte("#!/bin/sh\n"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "sub", "ü.txt"), []byte("x"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "empty"), nil, 0o644)
	if runtime.GOOS != "windows" {
		_ = os.Symlink("a.txt", filepath.Join(dir, "link"))
	}
	zipFile := filepath.Join(root, "out.zip")
	if err := zipDirectory(dir, zipFile); err != nil {
		t.Fatal(err)
	}
	zr, err := zip.OpenReader(zipFile)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	seen := map[string]*zip.File{}
	var names []string
	for _, f := range zr.File {
		seen[f.Name] = f
		names = append(names, f.Name)
		if !strings.HasPrefix(f.Name, "Pkg/") && f.Name != "Pkg/" {
			t.Fatalf("entry %q lacks the folder prefix", f.Name)
		}
	}
	a := seen["Pkg/a.txt"]
	if a == nil || a.Method != zip.Deflate || a.CompressedSize64 >= a.UncompressedSize64 {
		t.Fatalf("compressible file not deflated: %+v", a)
	}
	if s := seen["Pkg/run.sh"]; s == nil || s.Method != zip.Store || (runtime.GOOS != "windows" && s.Mode().Perm() != 0o755) {
		t.Fatalf("small file: %+v", s)
	}
	if seen["Pkg/sub/"] == nil || !seen["Pkg/sub/"].Mode().IsDir() || seen["Pkg/sub/ü.txt"] == nil || seen["Pkg/empty"] == nil {
		t.Fatalf("entries %v", names)
	}
	if l := seen["Pkg/link"]; runtime.GOOS != "windows" {
		if l == nil || l.Mode()&os.ModeSymlink == 0 {
			t.Fatalf("symlink not stored as a link: %+v", l)
		}
		rc, _ := l.Open()
		target, _ := io.ReadAll(rc)
		rc.Close()
		if string(target) != "a.txt" {
			t.Fatalf("link target %q", target)
		}
	}
	rc, _ := a.Open()
	body, _ := io.ReadAll(rc)
	rc.Close()
	if !bytes.Equal(body, bytes.Repeat([]byte("abcd"), 1000)) {
		t.Fatal("round trip differs")
	}
	// Sorted entries.
	for i := 1; i < len(names); i++ {
		if strings.HasPrefix(names[i], "Pkg/sub/") && names[i-1] > names[i] && !strings.HasPrefix(names[i-1], "Pkg/sub") {
			t.Fatalf("unsorted: %v", names)
		}
	}
}

func TestBundleToolsRecordsProvenance(t *testing.T) {
	src := filepath.Join(t.TempDir(), "kubectl-src")
	_ = os.WriteFile(src, []byte("kubectl-binary"), 0o755)
	t.Setenv("RUBBAN_BUNDLE_KUBECTL", src)
	t.Setenv("RUBBAN_BUNDLE_HELM", "")
	dir := filepath.Join(t.TempDir(), "tools")
	names, err := bundleTools(dir, "windows")
	if err != nil || len(names) != 1 || names[0] != "kubectl" {
		t.Fatalf("%v %v", names, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "kubectl.exe")); err != nil {
		t.Fatal(err)
	}
	prov, _ := os.ReadFile(filepath.Join(dir, "tool-provenance.json"))
	if !strings.Contains(string(prov), `"filename": "kubectl.exe"`) || !strings.Contains(string(prov), `"license": "Apache-2.0"`) {
		t.Fatalf("provenance %s", prov)
	}
}

func TestWindowsResourcesObject(t *testing.T) {
	if got := versionQuad("0.13.0-rc.1"); got != [4]uint16{0, 13, 0, 0} {
		t.Fatalf("versionQuad: %v", got)
	}
	root, err := repoRoot()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	remove, err := writeSyso(filepath.Join(root, "assets", "rubban.ico"), dir, "0.12.1")
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(dir, sysoName))
	if err != nil {
		t.Fatal(err)
	}
	// A COFF object for x86-64 (machine 0x8664) carrying the icon groups, manifest and version block.
	if len(data) < 4096 || data[0] != 0x64 || data[1] != 0x86 {
		t.Fatalf("not an amd64 COFF object: %d bytes, machine %x %x", len(data), data[0], data[1])
	}
	if !bytes.Contains(data, []byte(".rsrc")) {
		t.Fatal("object has no .rsrc section")
	}
	remove()
	if _, err := os.Stat(filepath.Join(dir, sysoName)); !os.IsNotExist(err) {
		t.Fatal("the .syso should be removed after the build")
	}
}

func TestManifestListsTheSetupWhenThereIsOne(t *testing.T) {
	zip := fileInfo{"Rubban-0.13.0-Windows-x64.zip", strings.Repeat("a", 64), 10}
	setup := fileInfo{"Rubban-0.13.0-Setup.exe", strings.Repeat("d", 64), 40}
	old := fileInfo{"Rubban-0.12.0-Setup.exe", strings.Repeat("e", 64), 40}
	sums, latest, err := buildManifest([]fileInfo{old, setup, zip}, "0.13.0", "n")
	if err != nil {
		t.Fatal(err)
	}
	if latest.Assets["win32-x64-setup"] != setup || latest.Assets["win32-x64"] != zip || len(latest.Assets) != 2 {
		t.Fatalf("assets %v", latest.Assets)
	}
	if !strings.Contains(sums, strings.Repeat("d", 64)+"  Rubban-0.13.0-Setup.exe\n") {
		t.Fatalf("sums %q", sums)
	}
	// Without a setup the manifest is what it was, and a setup alone is not a release.
	_, plain, err := buildManifest([]fileInfo{zip}, "0.13.0", "n")
	if err != nil || len(plain.Assets) != 1 || plain.Assets["win32-x64-setup"].Name != "" {
		t.Fatalf("without setup: %v %v", plain.Assets, err)
	}
	if _, _, err := buildManifest([]fileInfo{setup}, "0.13.0", "n"); err == nil {
		t.Fatal("a setup without a zip was accepted")
	}
}

func TestDescribeReleaseFilesIncludesTheSetup(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"Rubban-0.13.0-Windows-x64.zip", "Rubban-0.13.0-Setup.exe", "notes.md", "other.exe"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(name), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	files, err := describeZips(dir)
	if err != nil || len(files) != 2 || files[0].Name != "Rubban-0.13.0-Setup.exe" || files[1].Name != "Rubban-0.13.0-Windows-x64.zip" {
		t.Fatalf("%v %v", files, err)
	}
}
