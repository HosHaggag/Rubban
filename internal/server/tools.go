package server

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// findExecutable resolves a program like the Node backend did: an explicit path, or PATH with
// PATHEXT on Windows and the executable bit elsewhere.
func findExecutable(requested, fallback string) string {
	if requested == "" || strings.ContainsRune(requested, 0) {
		return ""
	}
	windows := runtime.GOOS == "windows"
	names := []string{requested}
	if windows && filepath.Ext(requested) == "" {
		pathext := os.Getenv("PATHEXT")
		if pathext == "" {
			pathext = ".COM;.EXE;.BAT;.CMD"
		}
		for _, ext := range strings.Split(pathext, ";") {
			if ext != "" {
				names = append(names, requested+strings.ToLower(ext))
			}
		}
	}
	var dirs []string
	if strings.ContainsAny(requested, `/\`) {
		dirs = []string{""}
	} else {
		dirs = filepath.SplitList(os.Getenv("PATH"))
	}
	for _, dir := range dirs {
		for _, name := range names {
			candidate := name
			if dir != "" {
				candidate = filepath.Join(strings.Trim(dir, `"`), name)
			}
			st, err := os.Stat(candidate)
			if err != nil || !st.Mode().IsRegular() {
				continue
			}
			if !windows && st.Mode().Perm()&0o111 == 0 {
				continue
			}
			if abs, err := filepath.Abs(candidate); err == nil {
				return abs
			}
			return candidate
		}
	}
	if fallback != "" && fallback != requested {
		return findExecutable(fallback, "")
	}
	return ""
}

// ToolInfo is reported by /api/health.
type ToolInfo struct {
	Available bool    `json:"available"`
	Path      *string `json:"path"`
}

func dockerKubectl() string {
	if runtime.GOOS != "windows" {
		return ""
	}
	pf := os.Getenv("ProgramFiles")
	if pf == "" {
		pf = `C:\Program Files`
	}
	return filepath.Join(pf, "Docker", "Docker", "resources", "bin", "kubectl.exe")
}

func resolveTool(opts Options, name string) (string, ToolInfo) {
	requested := name
	explicit := ""
	fallback := ""
	switch name {
	case "kubectl":
		explicit = opts.KubectlPath
		if explicit == "" {
			fallback = dockerKubectl()
		}
	case "helm":
		explicit = opts.HelmPath
	}
	if explicit != "" {
		requested = explicit
	}
	resolved := findExecutable(requested, fallback)
	info := ToolInfo{Available: resolved != "" || opts.Runner != nil}
	if resolved != "" {
		info.Path = &resolved
		return resolved, info
	}
	return requested, info
}

func (b *Backend) requireTool(name string) (string, error) {
	info := b.tools[name]
	if !info.Available {
		return "", problem(name+" is not installed or configured. Set its executable path and restart Rubban.", 503)
	}
	return b.toolPath[name], nil
}
