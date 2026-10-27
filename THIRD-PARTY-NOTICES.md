# Third-party software

Rubban's original source is MIT licensed. Dependency licenses apply separately.

- Electron 44.9.1: MIT, plus Chromium and included components. The Windows distribution retains Electron's `LICENSE` and `LICENSES.chromium.html`.
- xterm.js and FitAddon: MIT; published browser bundles retain their notices, and dependency license files remain in `node_modules`.
- ws, yaml, and @lydell/node-pty: MIT; dependency notices remain in `node_modules`.
- Fonts in `ui/fonts`: Inter (The Inter Project Authors), JetBrains Mono (The JetBrains Mono Project Authors) and Noto Kufi Arabic (Google LLC), each under the SIL Open Font License 1.1; the license texts are next to the font files.
- kubectl: Apache-2.0. Windows distribution includes the installed Docker Desktop kubectl v1.36.1 as a standalone open-source tool, not Docker Desktop itself. Its license and hash are recorded under `tools`.
- Helm: Apache-2.0. Windows distribution includes the standalone open-source Helm executable from the installed Lens distribution; the Lens manifest declares Helm 3.20.2. Its source origin, hash and upstream license are recorded under `tools`. No Lens-specific executable or application source is included.
- Node.js 24.19.0: MIT plus separately listed included components. Optional service runtime is copied from the existing bundled Node installation; the complete upstream Node license is retained alongside it.

See `tools/tool-provenance.json` in the Windows application resources and `runtime/provenance.json` beside the executable for exact byte identities. The tool version declarations do not prove all upstream bytes match a published release; hashes bind the actual local artifacts used in this build.
