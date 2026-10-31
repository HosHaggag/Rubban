package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/tc-hib/winres"
	"github.com/tc-hib/winres/version"
)

// Windows resources for Rubban.exe and rubban-cli.exe: the icon that Explorer, the taskbar and
// the window title bar show, the version block in the file's Properties, and the application
// manifest (per-monitor DPI awareness, common controls v6, long paths). The Go linker embeds any
// rsrc_windows_amd64.syso beside the main package, so the file is written there for the build
// and removed afterwards: it is generated, never committed.
const sysoName = "rsrc_windows_amd64.syso"

// Wails loads the window class icon from the executable's resource 32512 (IDI_APPLICATION) and
// dialog icons from resource 3 (RT_ICON); Explorer shows the first icon group in the file.
var iconIDs = []winres.Identifier{winres.ID(1), winres.ID(3), winres.ID(32512)}

// versionQuad turns "0.12.1" or "0.13.0-rc.1" into the four numbers Windows version resources use.
func versionQuad(v string) [4]uint16 {
	var quad [4]uint16
	v, _, _ = strings.Cut(v, "-")
	for i, part := range strings.SplitN(v, ".", 3) {
		n, _ := strconv.Atoi(part)
		quad[i] = uint16(n)
	}
	return quad
}

func windowsResources(iconPath, v string) (*winres.ResourceSet, error) {
	file, err := os.Open(iconPath)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	icon, err := winres.LoadICO(file)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", iconPath, err)
	}
	rs := &winres.ResourceSet{}
	for _, id := range iconIDs {
		if err := rs.SetIcon(id, icon); err != nil {
			return nil, err
		}
	}
	quad := versionQuad(v)
	rs.SetManifest(winres.AppManifest{
		Identity:            winres.AssemblyIdentity{Name: "Rubban", Version: quad},
		Description:         "Rubban Kubernetes Workbench",
		Compatibility:       winres.Win10AndAbove,
		ExecutionLevel:      winres.AsInvoker,
		DPIAwareness:        winres.DPIPerMonitorV2,
		UseCommonControlsV6: true,
		LongPathAware:       true,
	})
	info := version.Info{FileVersion: quad, ProductVersion: quad}
	info.SetFileVersion(v)
	info.SetProductVersion(v)
	for key, value := range map[string]string{
		version.CompanyName: "Rubban contributors", version.FileDescription: "Rubban Kubernetes Workbench", version.InternalName: "Rubban",
		version.LegalCopyright: "Rubban contributors · MIT licence", version.OriginalFilename: "Rubban.exe", version.ProductName: "Rubban",
	} {
		if err := info.Set(0x0409, key, value); err != nil {
			return nil, err
		}
	}
	rs.SetVersionInfo(info)
	return rs, nil
}

// writeSyso writes the resource object into dir (the main package) and returns how to remove it.
func writeSyso(iconPath, dir, v string) (func(), error) {
	rs, err := windowsResources(iconPath, v)
	if err != nil {
		return nil, err
	}
	target := filepath.Join(dir, sysoName)
	file, err := os.Create(target)
	if err != nil {
		return nil, err
	}
	if err := rs.WriteObject(file, winres.ArchAMD64); err != nil {
		file.Close()
		os.Remove(target)
		return nil, err
	}
	if err := file.Close(); err != nil {
		os.Remove(target)
		return nil, err
	}
	return func() { os.Remove(target) }, nil
}
