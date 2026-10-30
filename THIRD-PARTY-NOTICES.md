# Third-party software

Rubban's own source is MIT licensed. Dependency licences apply separately.

## Go modules compiled into the binary

The exact versions are in `go.mod`; each module carries its licence text in its source.

- Wails v3 (`github.com/wailsapp/wails/v3`): MIT. The desktop window, menus and dialogs over the system web view.
- `github.com/coder/websocket`: ISC.
- `github.com/aymanbagabas/go-pty` and `github.com/creack/pty`: MIT. Pseudo-terminals for the terminal dock.
- `gopkg.in/yaml.v3`: MIT and Apache-2.0.
- Modules pulled in by Wails (`github.com/adrg/xdg`, `github.com/go-ole/go-ole`, `github.com/godbus/dbus/v5`, `github.com/mattn/go-colorable`, `github.com/mattn/go-isatty`, `github.com/u-root/u-root`, `golang.org/x/crypto`, `golang.org/x/sys`): MIT, BSD or Apache-2.0.

## Browser files vendored in `ui/`

- xterm.js and its fit addon: MIT. The published bundles keep their notices; see `ui/LICENSE-xterm.txt` and `ui/LICENSE-xterm-fit.txt`. Refreshed with `go run ./cmd/buildtool fetch-xterm`, which verifies the npm registry's integrity hash.
- Fonts in `ui/fonts`: Inter (The Inter Project Authors), JetBrains Mono (The JetBrains Mono Project Authors) and Noto Kufi Arabic (Google LLC), each under the SIL Open Font License 1.1; the licence texts are next to the font files.

## Command-line tools bundled in release builds

- kubectl: Apache-2.0. Downloaded from `dl.k8s.io` and checksum-verified at build time.
- Helm: Apache-2.0. Downloaded from `get.helm.sh` and checksum-verified at build time.

Their names, SHA-256 hashes and origins are recorded in `tools/tool-provenance.json`, next to `Rubban.exe` on Windows and in `Rubban.app/Contents/Resources/tools` on macOS. Credential plugins are never bundled.

## System components used at run time, not distributed

- Microsoft Edge WebView2 (Windows) and WebKit (macOS) render the interface.
