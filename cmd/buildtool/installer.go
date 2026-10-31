package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// inno finds Inno Setup's compiler: on PATH, or in its default install folders.
func inno() (string, error) {
	if p, err := exec.LookPath("ISCC"); err == nil {
		return p, nil
	}
	for _, env := range []string{"ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"} {
		base := os.Getenv(env)
		if base == "" {
			continue
		}
		for _, rel := range []string{filepath.Join("Inno Setup 6", "ISCC.exe"), filepath.Join("Programs", "Inno Setup 6", "ISCC.exe")} {
			if p := filepath.Join(base, rel); fileExists(p) {
				return p, nil
			}
		}
	}
	return "", errors.New("Inno Setup 6 was not found (ISCC.exe). Install it from https://jrsoftware.org/isinfo.php, or add its folder to PATH.")
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

// cmdInstaller compiles installer/rubban.iss over the folder `package --os windows` built, which
// leaves release/Rubban-<version>-Setup.exe next to the zip.
func cmdInstaller() error {
	if runtime.GOOS != "windows" {
		return errors.New("the installer is built on Windows")
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
	folder := filepath.Join(out, "Rubban-"+version+"-Windows-x64")
	if !fileExists(filepath.Join(folder, "Rubban.exe")) {
		return fmt.Errorf("%s is missing: run `go run ./cmd/buildtool package --os windows` first", folder)
	}
	iscc, err := inno()
	if err != nil {
		return err
	}
	// The release folder is passed in, so RUBBAN_RELEASE_DIR applies to the installer too.
	cmd := exec.Command(iscc, "/Qp", "/DVersion="+version, "/DRelease="+out, filepath.Join(root, "installer", "rubban.iss"))
	cmd.Dir = root
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("ISCC failed: %w", err)
	}
	setup := filepath.Join(out, "Rubban-"+version+"-Setup.exe")
	if !fileExists(setup) {
		return fmt.Errorf("ISCC did not produce %s", setup)
	}
	return printResult(map[string]any{"version": version, "setup": setup})
}
