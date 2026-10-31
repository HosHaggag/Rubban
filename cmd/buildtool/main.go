// Command buildtool packages, checks and releases Rubban.
//
//	go run ./cmd/buildtool <subcommand> [args]
package main

import (
	"fmt"
	"os"
)

const usage = `usage: go run ./cmd/buildtool <subcommand>

  package --os windows|darwin --arch x64|arm64   build the release zip into release/
  fetch-tools <os> <arch> <outDir>               download checksum-verified kubectl and helm
  installer                                      build the Windows installer (Inno Setup) from the Windows zip folder in release/
  write-manifest <dir>                           write SHA256SUMS.txt and latest.json for the zips in <dir>
  release-notes <version>                        print the CHANGELOG section for a version
  check-version                                  fail unless GITHUB_REF_NAME matches VERSION and CHANGELOG
  release <major|minor|patch|x.y.z>              bump VERSION, commit and tag
  fetch-xterm                                    refresh the vendored terminal bundles in ui/
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	var err error
	args := os.Args[2:]
	switch os.Args[1] {
	case "package":
		err = cmdPackage(args)
	case "fetch-tools":
		err = cmdFetchTools(args)
	case "installer":
		err = cmdInstaller()
	case "write-manifest":
		err = cmdWriteManifest(args)
	case "release-notes":
		err = cmdReleaseNotes(args)
	case "check-version":
		err = cmdCheckVersion()
	case "release":
		err = cmdRelease(args)
	case "fetch-xterm":
		err = cmdFetchXterm()
	default:
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
