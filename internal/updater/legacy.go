package updater

import (
	"fmt"
	"strings"
)

// DefaultRepo is the GitHub repository releases and latest.json come from.
const DefaultRepo = defaultRepo

// Windows builds 0.12.0 to 0.14.0 look for a "windows-x64" download, which no manifest has (the
// key is "win32-x64"): their check ends in "Version X has no download for windows-x64" and,
// because they also take the macOS install path, they could not install an update even if one
// were listed. What they do show is the manifest's release notes, whose links open in the
// browser. The manifest therefore starts with a note that links the installer; builds with a
// working updater remove it before showing the notes.
const legacyMarker = "> **Seeing “no download for windows-x64”?**"

// LegacyWindowsNote is the first paragraph of the manifest notes for a release with an installer.
func LegacyWindowsNote(repo, version string) string {
	url := fmt.Sprintf("https://github.com/%s/releases/download/v%s/Rubban-%s-Setup.exe", repo, version, version)
	return legacyMarker + " Rubban 0.14.0 and earlier cannot install updates on Windows by themselves. " +
		"[Download the Rubban " + version + " installer](" + url + ") and run it once: it closes Rubban, puts the new version in its place " +
		"and keeps your clusters and settings. After that, updates install from Rubban itself.\n\n"
}

// StripLegacyNote removes LegacyWindowsNote from the start of the notes.
func StripLegacyNote(notes string) string {
	if !strings.HasPrefix(notes, legacyMarker) {
		return notes
	}
	if i := strings.Index(notes, "\n\n"); i >= 0 {
		return strings.TrimLeft(notes[i+2:], "\n")
	}
	return ""
}
