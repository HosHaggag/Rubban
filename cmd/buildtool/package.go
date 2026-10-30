package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

const modulePath = "github.com/HosHaggag/rubban"

func run(dir string, env []string, name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), env...)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func fileSHA256(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

type toolRecord struct {
	Name     string `json:"name"`
	Filename string `json:"filename"`
	SHA256   string `json:"sha256"`
	Source   string `json:"source"`
	License  string `json:"license"`
}

// bundleTools copies kubectl and helm named by RUBBAN_BUNDLE_KUBECTL / RUBBAN_BUNDLE_HELM into toolsDir.
func bundleTools(toolsDir, goos string) ([]string, error) {
	suffix := ""
	if goos == "windows" {
		suffix = ".exe"
	}
	var records []toolRecord
	for _, t := range []struct{ name, env string }{{"kubectl", "RUBBAN_BUNDLE_KUBECTL"}, {"helm", "RUBBAN_BUNDLE_HELM"}} {
		input := os.Getenv(t.env)
		if input == "" {
			continue
		}
		if err := copyFile(input, filepath.Join(toolsDir, t.name+suffix), 0o755); err != nil {
			return nil, err
		}
		sum, err := fileSHA256(input)
		if err != nil {
			return nil, err
		}
		records = append(records, toolRecord{Name: t.name, Filename: t.name + suffix, SHA256: sum, Source: filepath.Base(input), License: "Apache-2.0"})
	}
	var names []string
	if len(records) > 0 {
		data, _ := json.MarshalIndent(records, "", "  ")
		if err := os.WriteFile(filepath.Join(toolsDir, "tool-provenance.json"), append(data, '\n'), 0o644); err != nil {
			return nil, err
		}
	}
	for _, r := range records {
		names = append(names, r.Name)
	}
	return names, nil
}

func goBuild(root, goos, goarch, out, version string, desktop, gui bool) error {
	ld := "-s -w -X " + modulePath + "/internal/version.Version=" + version
	if gui {
		ld += " -H=windowsgui"
	}
	args := []string{"build", "-trimpath", "-ldflags", ld, "-o", out}
	env := []string{"GOOS=" + goos, "GOARCH=" + goarch}
	if desktop {
		args = append(args[:1], append([]string{"-tags", "desktop"}, args[1:]...)...)
	}
	if goos == "darwin" && desktop {
		env = append(env, "CGO_ENABLED=1")
	} else if goos == "windows" || !desktop {
		env = append(env, "CGO_ENABLED=0")
	}
	return run(root, env, "go", append(args, "./cmd/rubban")...)
}

func zipFolder(folder, zipFile string) error {
	_ = os.Remove(zipFile)
	if runtime.GOOS == "darwin" {
		return run("", nil, "ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", folder, zipFile)
	}
	return zipDirectory(folder, zipFile)
}

func releaseDir(root string) string {
	if d := os.Getenv("RUBBAN_RELEASE_DIR"); d != "" {
		abs, _ := filepath.Abs(d)
		return abs
	}
	return filepath.Join(root, "release")
}

func cmdPackage(args []string) error {
	fs := flag.NewFlagSet("package", flag.ContinueOnError)
	goos := fs.String("os", "", "windows or darwin")
	arch := fs.String("arch", "x64", "x64 or arm64")
	bin := fs.String("bin", "", "use this prebuilt desktop binary instead of running go build")
	cliBin := fs.String("cli-bin", "", "use this prebuilt console binary (Windows only)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *goos == "" {
		*goos = runtime.GOOS
	}
	goarch := map[string]string{"x64": "amd64", "arm64": "arm64"}[*arch]
	if goarch == "" || (*goos != "windows" && *goos != "darwin") {
		return fmt.Errorf("Unsupported target %s/%s", *goos, *arch)
	}
	if *goos == "windows" && *arch != "x64" {
		return errors.New("Windows builds are x64 only")
	}
	root, err := repoRoot()
	if err != nil {
		return err
	}
	version, err := readVersion(root)
	if err != nil {
		return err
	}
	out := releaseDir(root)
	if err := os.MkdirAll(out, 0o755); err != nil {
		return err
	}
	if *goos == "windows" {
		return packageWindows(root, out, version, *bin, *cliBin)
	}
	return packageMac(root, out, version, *arch, goarch, *bin)
}

func packageWindows(root, out, version, bin, cliBin string) error {
	name := "Rubban-" + version + "-Windows-x64"
	folder := filepath.Join(out, name)
	if err := os.RemoveAll(folder); err != nil {
		return err
	}
	if err := os.MkdirAll(folder, 0o755); err != nil {
		return err
	}
	if bin != "" {
		if err := copyFile(bin, filepath.Join(folder, "Rubban.exe"), 0o755); err != nil {
			return err
		}
	} else if err := goBuild(root, "windows", "amd64", filepath.Join(folder, "Rubban.exe"), version, true, true); err != nil {
		return err
	}
	if cliBin != "" {
		if err := copyFile(cliBin, filepath.Join(folder, "rubban-cli.exe"), 0o755); err != nil {
			return err
		}
	} else if err := goBuild(root, "windows", "amd64", filepath.Join(folder, "rubban-cli.exe"), version, false, false); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(folder, "VERSION"), []byte(version+"\n"), 0o644); err != nil {
		return err
	}
	for _, f := range []struct{ from, to string }{
		{"scripts/Install-Rubban.ps1", "Install-Rubban.ps1"}, {"README.md", "README.md"}, {"LICENSE", "LICENSE"},
		{"THIRD-PARTY-NOTICES.md", "THIRD-PARTY-NOTICES.md"}, {"CHANGELOG.md", "CHANGELOG.md"},
	} {
		if err := copyFile(filepath.Join(root, f.from), filepath.Join(folder, f.to), 0o644); err != nil {
			return err
		}
	}
	tools, err := bundleTools(filepath.Join(folder, "tools"), "windows")
	if err != nil {
		return err
	}
	zipFile := filepath.Join(out, name+".zip")
	if err := zipFolder(folder, zipFile); err != nil {
		return err
	}
	return printResult(map[string]any{"version": version, "zip": zipFile, "tools": nonNil(tools)})
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func printResult(v any) error {
	data, _ := json.MarshalIndent(v, "", "  ")
	fmt.Println(string(data))
	return nil
}

const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>Rubban</string>
  <key>CFBundleIconFile</key><string>rubban.icns</string>
  <key>CFBundleIdentifier</key><string>dev.rubban.desktop</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Rubban</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>%[1]s</string>
  <key>CFBundleVersion</key><string>%[1]s</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSRequiresAquaSystemAppearance</key><false/>
  <key>NSHumanReadableCopyright</key><string>Rubban contributors · MIT licence</string>
</dict>
</plist>
`

func packageMac(root, out, version, arch, goarch, bin string) error {
	name := "Rubban-" + version + "-macOS-" + arch
	folder := filepath.Join(out, name)
	if err := os.RemoveAll(folder); err != nil {
		return err
	}
	app := filepath.Join(folder, "Rubban.app")
	contents := filepath.Join(app, "Contents")
	for _, d := range []string{"MacOS", "Resources"} {
		if err := os.MkdirAll(filepath.Join(contents, d), 0o755); err != nil {
			return err
		}
	}
	exe := filepath.Join(contents, "MacOS", "Rubban")
	if bin != "" {
		if err := copyFile(bin, exe, 0o755); err != nil {
			return err
		}
	} else if err := goBuild(root, "darwin", goarch, exe, version, true, false); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(contents, "Info.plist"), []byte(fmt.Sprintf(infoPlist, version)), 0o644); err != nil {
		return err
	}
	if err := copyFile(filepath.Join(root, "assets", "rubban.icns"), filepath.Join(contents, "Resources", "rubban.icns"), 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(contents, "Resources", "VERSION"), []byte(version+"\n"), 0o644); err != nil {
		return err
	}
	tools, err := bundleTools(filepath.Join(contents, "Resources", "tools"), "darwin")
	if err != nil {
		return err
	}
	signature, err := signApp(app, exe)
	if err != nil {
		return err
	}
	if err := copyFile(filepath.Join(root, "scripts", "Install-Rubban.command"), filepath.Join(folder, "Install-Rubban.command"), 0o755); err != nil {
		return err
	}
	if err := copyFile(filepath.Join(root, "README.md"), filepath.Join(folder, "README.md"), 0o644); err != nil {
		return err
	}
	zipFile := filepath.Join(out, name+".zip")
	if err := zipFolder(folder, zipFile); err != nil {
		return err
	}
	return printResult(map[string]any{"version": version, "results": []any{map[string]any{"arch": arch, "zip": zipFile, "signature": signature, "tools": nonNil(tools)}}})
}

// signApp signs the bundle ad hoc: codesign on macOS, rcodesign elsewhere when installed.
func signApp(app, exe string) (string, error) {
	if runtime.GOOS == "darwin" {
		if err := run("", nil, "codesign", "--force", "--deep", "--sign", "-", app); err != nil {
			return "", err
		}
		if err := run("", nil, "codesign", "--verify", "--deep", "--strict", app); err != nil {
			return "", err
		}
		return "codesign (ad hoc)", nil
	}
	rc, err := exec.LookPath("rcodesign")
	if err != nil {
		return "unsigned (Install-Rubban.command signs it on the Mac)", nil
	}
	if err := run("", nil, rc, "sign", app); err != nil {
		return "", err
	}
	info, err := exec.Command(rc, "print-signature-info", exe).Output()
	if err != nil || !strings.Contains(string(info), "code_directory") {
		return "", errors.New("rcodesign did not produce a code signature")
	}
	return "rcodesign (ad hoc)", nil
}
