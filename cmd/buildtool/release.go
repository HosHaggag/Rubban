package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// repoRoot is the directory holding VERSION: the current directory or the nearest parent.
func repoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "VERSION")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", errors.New("VERSION not found; run buildtool from inside the repository")
		}
		dir = parent
	}
}

var versionRE = regexp.MustCompile(`^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$`)

func readVersion(root string) (string, error) {
	data, err := os.ReadFile(filepath.Join(root, "VERSION"))
	if err != nil {
		return "", err
	}
	v := strings.TrimSpace(string(data))
	if !versionRE.MatchString(v) {
		return "", fmt.Errorf("VERSION %q is not a version", v)
	}
	return v, nil
}

// releaseNotes returns the CHANGELOG.md section for a version.
func releaseNotes(changelog, version string) (string, error) {
	lines := strings.Split(strings.ReplaceAll(changelog, "\r\n", "\n"), "\n")
	start := -1
	for i, line := range lines {
		if !strings.HasPrefix(line, "## ") {
			continue
		}
		heading := strings.TrimSpace(line[3:])
		if f := strings.FieldsFunc(heading, func(r rune) bool { return r == ' ' || r == '\t' || r == ':' }); len(f) > 0 && f[0] == version {
			start = i
			break
		}
	}
	if start < 0 {
		return "", fmt.Errorf("CHANGELOG.md has no section for %s", version)
	}
	end := len(lines)
	for i := start + 1; i < len(lines); i++ {
		if strings.HasPrefix(lines[i], "## ") {
			end = i
			break
		}
	}
	body := strings.TrimSpace(strings.Join(lines[start+1:end], "\n"))
	if body == "" {
		return "", fmt.Errorf("The CHANGELOG.md section for %s is empty", version)
	}
	return body, nil
}

func cmdReleaseNotes(args []string) error {
	if len(args) != 1 {
		return errors.New("usage: buildtool release-notes <version>")
	}
	root, err := repoRoot()
	if err != nil {
		return err
	}
	data, err := os.ReadFile(filepath.Join(root, "CHANGELOG.md"))
	if err != nil {
		return err
	}
	notes, err := releaseNotes(string(data), args[0])
	if err != nil {
		return err
	}
	fmt.Println(notes)
	return nil
}

// checkVersion fails unless the tag matches the VERSION file and the changelog has a section for it.
func checkVersion(tag, version, changelog string) error {
	wanted := strings.TrimPrefix(tag, "v")
	if wanted == "" {
		return errors.New("No tag given (GITHUB_REF_NAME is empty)")
	}
	if wanted != version {
		return fmt.Errorf("Tag %s does not match the VERSION file (%s)", tag, version)
	}
	_, err := releaseNotes(changelog, version)
	return err
}

func cmdCheckVersion() error {
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
	if err := checkVersion(os.Getenv("GITHUB_REF_NAME"), version, string(changelog)); err != nil {
		return err
	}
	fmt.Printf("Release %s is consistent\n", version)
	return nil
}

var plainVersionRE = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

func bump(version, kind string) (string, error) {
	if plainVersionRE.MatchString(kind) {
		return kind, nil
	}
	base := strings.SplitN(version, "-", 2)[0]
	parts := strings.Split(base, ".")
	if len(parts) != 3 {
		return "", fmt.Errorf("cannot bump %q", version)
	}
	n := make([]int, 3)
	for i, p := range parts {
		v, err := strconv.Atoi(p)
		if err != nil {
			return "", fmt.Errorf("cannot bump %q", version)
		}
		n[i] = v
	}
	switch kind {
	case "major":
		return fmt.Sprintf("%d.0.0", n[0]+1), nil
	case "minor":
		return fmt.Sprintf("%d.%d.0", n[0], n[1]+1), nil
	case "patch":
		return fmt.Sprintf("%d.%d.%d", n[0], n[1], n[2]+1), nil
	}
	return "", errors.New("usage: buildtool release <major|minor|patch|x.y.z>")
}

func git(root string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = root
	cmd.Stderr = os.Stderr
	out, err := cmd.Output()
	return strings.TrimSpace(string(out)), err
}

// cmdRelease bumps VERSION, checks the changelog, commits and tags. Push with: git push origin main --tags
func cmdRelease(args []string) error {
	if len(args) != 1 {
		return errors.New("usage: buildtool release <major|minor|patch|x.y.z>")
	}
	root, err := repoRoot()
	if err != nil {
		return err
	}
	if status, err := git(root, "status", "--porcelain"); err != nil || status != "" {
		return errors.New("The working tree is not clean. Commit or stash first.")
	}
	current, err := readVersion(root)
	if err != nil {
		return err
	}
	next, err := bump(current, args[0])
	if err != nil {
		return err
	}
	changelog, err := os.ReadFile(filepath.Join(root, "CHANGELOG.md"))
	if err != nil {
		return err
	}
	if _, err := releaseNotes(string(changelog), next); err != nil {
		return err
	}
	if next != current {
		if err := os.WriteFile(filepath.Join(root, "VERSION"), []byte(next+"\n"), 0o644); err != nil {
			return err
		}
	}
	if _, err := git(root, "add", "VERSION"); err != nil {
		return err
	}
	if status, _ := git(root, "status", "--porcelain"); status != "" {
		if _, err := git(root, "commit", "-m", "Release "+next); err != nil {
			return err
		}
	}
	if _, err := git(root, "tag", "v"+next); err != nil {
		return err
	}
	fmt.Printf("Tagged v%s. Push with: git push origin main --tags\n", next)
	return nil
}

var _ = bufio.NewReader
