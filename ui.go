// Package rubban embeds the web UI so the binary is self-contained.
package rubban

import (
	"embed"
	"io/fs"
)

//go:embed ui
var uiFiles embed.FS

// UI returns the embedded ui/ directory as a file system rooted at ui/.
func UI() fs.FS {
	sub, err := fs.Sub(uiFiles, "ui")
	if err != nil {
		panic(err)
	}
	return sub
}
