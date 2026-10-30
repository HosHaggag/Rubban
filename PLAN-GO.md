# Rubban → Go + Wails: conversion plan

Written 2026-10-31 against the 0.11.0 tree (`main` at `1041a19`) plus the uncommitted "console restart" work in `server/core.cjs`, `server/embed-proxy.cjs` and their tests. **Commit or land that work before starting; the port must include it.** `PLAN.md` (the Electron 1.0 residue) stays valid for the UI items; its backend items are folded into §11 here.

This document is the specification for the person doing the port. The current Node code is the reference implementation: when this plan and the code disagree, the code wins, and the difference goes into §12 as a question.

---

## 0. Goal, non-goals, targets

**Goal.** Replace Electron and the Node backend with one Go binary that uses Wails v3 for the desktop window and the OS webview. The UI in `ui/` moves unchanged apart from the two edits in §10. Every HTTP route, WebSocket protocol, file on disk, environment variable, zip layout and update path keeps working exactly as today, so a 0.11.0 install updates itself to the Go build through the existing in-app updater.

**Non-goals.** No UI rewrite, no framework, no new features, no behaviour changes beyond the ones listed in §12 (each one has a reason). Linux desktop stays unsupported; `rubban web` builds on Linux.

**Targets** (measured on the Windows x64 release zip, kubectl and helm excluded):

| Measure | Electron 0.11.0 | Target |
|---|---|---|
| Release zip | ~100 MB | ≤ 15 MB |
| Cold start to usable window | 1–2 s | ≤ 0.7 s |
| `go build` incremental | n/a | ≤ 5 s |
| CI release workflow | ~15 min | ≤ 10 min |
| Runtime processes at idle | Electron ×4 + Node | 1 |

**Toolchain.** Wails v3.0.0 shipped stable on 2026-10-26 and requires Go ≥ 1.26. The WSL checkout has Go 1.22; install 1.26 first. Windows builds need the WebView2 runtime at run time (present on Windows 11 and on Windows 10 with Edge); macOS builds need Xcode command line tools at build time and nothing at run time. Pin the Wails version in `go.mod` and do not track nightlies.

---

## 1. Architecture decisions (settled, do not reopen)

1. **The backend stays an HTTP + WebSocket server on `127.0.0.1`.** The Wails window loads `http://127.0.0.1:<port>/` exactly as Electron does now. This keeps `location.origin`, the token meta tag, the Host/Origin checks, the CSP, the WebSocket URLs and `npm run web` behaviour identical. Do **not** serve the UI through the Wails asset server: its origin is not a loopback HTTP origin, WebSockets would not work through it, and the security checks would have to change.

2. **The desktop bridge is HTTP, not Wails JS bindings.** `window.rubbanDesktop` (see §3.3) is defined by a small classic script `ui/desktop-bridge.js` that the Go server serves only in desktop mode (an empty file in web mode). It calls token-guarded `/api/desktop/*` endpoints and listens on `/api/desktop/events` (WebSocket) for updater state. The Go handlers call Wails runtime functions (open URL, set theme, dialogs). This avoids depending on whether Wails injects its runtime into an external-origin page, and web mode stays byte-identical.

3. **One module, one binary, subcommands.** `rubban` (no args) is the desktop app. `rubban web` is today's `npm run web`. `rubban mcp` is today's `node services/mcp.cjs`. `rubban version`. `rubban --smoke-test` keeps its meaning. On Windows two executables are built from the same package: `Rubban.exe` (`-H=windowsgui`, no console) and `rubban-cli.exe` (console subsystem) for `web`, `mcp` and `version`, because a GUI-subsystem exe cannot print to the parent console. macOS needs only the one binary inside the `.app`; it serves every subcommand there.

4. **Wails lives behind a build tag.** Package `internal/app` (window, menu, dialogs, theme, single instance) compiles only with `-tags desktop`. Without the tag, `cmd/rubban` builds a CGO-free binary where the default command prints "desktop support not built in; use `rubban web`" and exits 2. This keeps `go test ./...` and `rubban web` free of WebKitGTK on Linux and WSL, and keeps the server packages honest about not importing Wails.

5. **kubectl stays the Kubernetes client.** The live layer keeps spawning `kubectl proxy` per context and talking HTTP to it, exactly as `server/live.cjs` does. client-go is **not** used in this port (binary +30 MB, slower cold builds, and a second kubeconfig/exec-plugin implementation to keep in step with kubectl). Revisit after the port ships (§12).

6. **helm stays the Helm client.** Same reasoning.

7. **Node is removed from build and run.** Nothing in the build, release or runtime needs Node or npm. `package.json` shrinks to devDependencies for ESLint and the 22 `ui/*.test.mjs` unit tests, which stay on `node --test` because they exercise browser ES modules. Running them is optional for a Go-only contributor; CI runs them on Linux only.

8. **All build, packaging and release scripts are rewritten in Go** under `cmd/buildtool`, invoked as `go run ./cmd/buildtool <subcommand>`. No Task, no Make, no PowerShell for building. `Install-Rubban.ps1`, `Install-Rubban.command`, `apply-update.ps1` and `apply-update.sh` stay as scripts because they run on the user's machine without Go.

9. **The data directory, every file in it, every environment variable and every zip path keep their names.** §4.14 and §8 list them. A user upgrading from 0.11.0 keeps preferences, imported kubeconfigs, logs and the update folder.

10. **Behaviour parity is verified mechanically** with the parity harness in §13.1 before Electron code is deleted.

---

## 2. Target repository layout

```
go.mod                       module github.com/HosHaggag/rubban ; go 1.26
cmd/rubban/
  main.go                    subcommand dispatch; data dir; logger; shared startup
  desktop.go                 //go:build desktop   – calls internal/app
  desktop_stub.go            //go:build !desktop  – error message
cmd/buildtool/               package, fetch-tools, manifest, release-notes, check-version, release, fetch-xterm
internal/server/             port of server/core.cjs + actions/argocd/rabbitmq/extras/kubeconfigs/log/shell-env/start
  server.go                  Backend struct, Start/Close, mux, headers, auth, UI static files
  validate.go                every validator from §4.1
  runner.go                  one-shot kubectl/helm runner (§4.2)
  process.go                 spawn/kill, process registry, OS-specific kill (process_unix.go / process_windows.go)
  tools.go                   kubectl/helm resolution, Docker Desktop fallback, health
  prefs.go                   preferences.json
  kubeconfigs.go             imports, index.json, KUBECONFIG merge, cluster preference validation
  routes_core.go             health, contexts, namespaces, resources, events, discovery, resource, yaml, diff, apply, delete, scale, restart
  routes_metrics.go          /api/metrics + kubelet summary fallback
  routes_helm.go             helm list/charts/chart/release/mutations
  routes_actions.go          node, evict, cronjob, rollout-undo, patch, default-class, secret-data, serviceaccount-kubeconfig
  routes_prometheus.go       provider detection, range queries
  argocd.go                  /api/argocd
  rabbitmq.go                discovery + credential plan
  embedproxy.go              per-console reverse proxy with bridge injection
  forwards.go                port forwards + console lifecycle
  ws_logs.go  ws_watch.go  ws_terminal.go
  terminal.go  pty_unix.go  pty_windows.go  pty_none.go   scoped kubeconfig, shells
  extras.go                  /api/prometheus (direct URL), /api/ai
  shellenv.go                login-shell environment import (darwin/linux)
  yamlutil.go                objectYAML ordering, multi-document validation
internal/live/               port of server/live.cjs: proxy pool, discovery cache, resolver, ResourceWatch
internal/logging/            JSON-lines logger with rotation
internal/updater/            state machine, safeFetch, manifest, download, install; embeds scripts/
internal/updater/scripts/    apply-update.ps1, apply-update.sh (moved from desktop/update/)
internal/mcp/                stdio MCP bridge (today's services/mcp.cjs + kube-read.cjs)
internal/app/                //go:build desktop – Wails: window, menu, dialogs, theme, single instance, smoke test, /api/desktop handlers
internal/version/            Version string set by -ldflags at build time; falls back to "0.0.0-dev"
ui/                          unchanged except §10; embedded with //go:embed
ui/xterm.css                 vendored (today it is read from node_modules at run time)
assets/                      rubban.png, .ico, .icns (unchanged)
scripts/                     Install-Rubban.ps1, Install-Rubban.command only
.github/workflows/           ci.yml, release.yml rewritten for Go
package.json                 devDependencies only (eslint, globals); scripts: lint, test:ui
```

Delete at cutover (phase 8): `desktop/`, `server/`, `services/`, `scripts/*.cjs`, `package-lock.json`, `eslint.config.js` entries for `.cjs`, `ui/vendor-entry.js`.

---

## 3. The contract the UI depends on

The UI is the client; the Go server must satisfy this contract so `ui/` moves unchanged. Source of truth: `ui/kit.js` (`api`, `socketURL`, token), `desktop/preload.cjs` (bridge), and the route tables in §4.

### 3.1 Transport rules
- Base URL is `location.origin`. REST sends `X-Rubban-Token: <token>`; the server also accepts `Authorization: Bearer <token>`. WebSockets send `?token=`.
- The token is 32 random bytes as 64 lowercase hex chars, generated per process, compared with constant-time equality, and substituted for `__RUBBAN_TOKEN__` in every served `.html` file.
- Host header must be exactly `127.0.0.1:<port>` or `localhost:<port>`, else 403. If `Origin` is present it must be `http://127.0.0.1:<port>` or `http://localhost:<port>`, else 403. Static UI files need Host/Origin but no token. `/api/*` needs the token (401 on failure).
- Every response carries: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`, `X-Frame-Options: DENY`, `Cache-Control: no-store`.
- UI files (and only those) carry the CSP:
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:<port> ws://localhost:<port>; frame-src http://127.0.0.1:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`
- JSON responses: `Content-Type: application/json; charset=utf-8`. Errors are always `{"error":"<message ≤ 6000 chars>"}` with the status from §4.1. The UI branches on 403, 404 and 503, and on the word "helm" inside a 503 message.
- Request bodies: read for POST/PUT/PATCH and for DELETE with a body; ≤ 2 MiB (413); `Content-Type` must be `application/json` or `application/*+json` (415); must parse to a JSON object, not an array (400); empty body = `{}`.
- Server limits: request timeout 30 s, header timeout 15 s, keep-alive 5 s, ≤ 64 headers. WebSocket max payload 64 KiB, no compression.
- Static files: GET/HEAD only; `/` → `ui/index.html`; the path `/node_modules/@xterm/xterm/css/xterm.css` must keep serving xterm's CSS (serve the vendored `ui/xterm.css`); allowed extensions html js css svg png ico woff woff2 ttf; `/desktop-bridge.js` as in §3.3.

### 3.2 Endpoint list (the UI calls exactly these)
REST: `GET /api/health`, `GET /api/contexts`, `GET|PUT /api/preferences`, `GET /api/discovery`, `GET /api/resources`, `GET /api/events`, `GET /api/resource`, `GET /api/yaml`, `POST /api/diff`, `POST /api/apply`, `POST /api/delete`, `POST /api/scale`, `POST /api/restart`, `POST /api/evict`, `POST /api/node`, `POST /api/cronjob`, `POST /api/default-class`, `POST /api/patch`, `POST /api/rollout-undo`, `POST /api/serviceaccount-kubeconfig`, `GET /api/secret-data`, `GET /api/metrics`, `GET /api/prometheus/provider`, `POST /api/prometheus/range`, `POST /api/prometheus`, `POST /api/ai`, `GET /api/helm`, `GET /api/helm/charts`, `GET /api/helm/chart`, `GET /api/helm/release`, `POST /api/helm`, `GET|POST /api/forwards`, `DELETE /api/forwards/:id`, `GET|POST /api/kubeconfigs`, `DELETE /api/kubeconfigs/:id`, `POST /api/argocd`, `GET /api/rabbitmq`, `POST /api/rabbitmq/credentials`, `POST /api/rabbitmq/open`. Also served though unused by the UI: `GET /api/namespaces`, `POST /api/ingressclass-default`.
WebSocket: `/api/watch`, `/api/logs`, `/api/terminal`. Any other upgrade path is rejected with a raw `HTTP/1.1 <status> Rejected`.

### 3.3 Desktop bridge (`window.rubbanDesktop`)
Shape, frozen, defined by `ui/desktop-bridge.js` in desktop mode only:

| Member | Behaviour | Go endpoint |
|---|---|---|
| `platform` | `'win32'`, `'darwin'` or `'linux'` (the UI compares against `'darwin'` for ⌘) | inlined into the served script |
| `openExternal(url)` | Promise; only http/https URLs without credentials; otherwise rejects with "Only web links can open externally." | `POST /api/desktop/open-external {url}` → Wails open-URL |
| `setTheme(pref)` | `system`/`light`/`dark`; others ignored | `POST /api/desktop/theme {theme}` → Wails window/app theme |
| `updates.getState()` / `check()` / `download()` / `install()` | Promises returning the updater state (§6) | `GET /api/desktop/updates`, `POST /api/desktop/updates/{check,download,install}` |
| `updates.onState(fn)` | returns unsubscribe | WebSocket `/api/desktop/events`, messages `{type:'update-state', state}` |
| `saveFile(name, text)` (new, §10) | Promise; native Save dialog, writes the text | `POST /api/desktop/save-file {name, text}` → Wails save dialog |

`/api/desktop/*` and `/api/desktop/events` are registered only when the server runs inside the desktop app; in web mode they return 404 and `desktop-bridge.js` is served empty. They use the same token and Host/Origin checks as every other route. Smoke mode (§5.6) also registers `POST /api/desktop/renderer-error`.

---

## 4. Backend specification

Port file by file. Keep the Node function names as Go identifiers where sensible so the two trees can be read side by side during review. Line numbers below refer to the current `.cjs` files.

### 4.1 Validators and errors (`validate.go`, from core.cjs 26–105, 691)
- `problem(msg, status)` → `type Problem struct{Status int; Msg string}` implementing `error`. Handlers return errors; the mux writes `{error}` with `Status` or 500. Status ≥ 500 is logged with `{route}`.
- Status codes in use: 400 validation, 401 token, 403 Host/Origin, 404, 405, 409, 413, 415, 499 cancelled, 502 CLI non-zero/bad JSON, 503 tool missing or backend closed, 504 timeout.
- `validateText(v, label, required=true, max=512)`: string, ≤ max, no bytes `0x00–0x1f` or `0x7f`.
- `validateName`: max 253, `^[A-Za-z0-9][A-Za-z0-9._:@-]*$`.
- `validateResource`: max 253, `^[a-z][a-z0-9.-]*$`.
- `validateNamespace(v, all)`: max 63, optional; `''` ok; `'*'` only when `all` (else 400 "Choose one namespace"); else `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`.
- `contextArgs(v)` → `["--context=<text>"]`, required. `namespaceArgs(v, all)` → `''`/`'*'` → `["--all-namespaces"]` when `all` else nothing; otherwise `["--namespace=<ns>"]`.
- `integer(v, label, min, max, fallback)`: number or `^-?\d+$` string, safe integer in range; empty → fallback.
- `validateSelector`: max 2000, `^[A-Za-z0-9_./=,!() -]+$`, must not contain `--`.
- `validateYAML`: 1 B – 1 MiB; every non-null document is a mapping with string `apiVersion` and `kind`; alias count ≤ 100; at least one document. Use `gopkg.in/yaml.v3` with a decoder loop; count aliases by walking nodes.
- `validateChart`: `http(s)://` or `oci://` URL without userinfo or fragment, or `^[A-Za-z0-9][A-Za-z0-9._/-]*$` with no `..` segment and no drive letter; max 2048.
- `objectYAML`: emit keys in the order apiVersion, kind, metadata, then the rest in source order, no line wrapping. Decode JSON into `yaml.Node` (or an ordered map) so order survives; `encoding/json` maps lose it.

### 4.2 Runner and processes (`runner.go`, `process.go`, from core.cjs 158–340)
- `spawn`: never a shell; each argument its own argv element; reject arguments containing NUL; `windowsHide`; on Unix `Setpgid` so each child owns a process group; env defaults to `kubeEnv()` = process env + `KUBECONFIG` merge (§4.4). Every child is tracked in a registry; `Close()` kills all.
- `kill`: Windows `taskkill.exe /PID <pid> /T /F` from `%SystemRoot%\System32`, falling back to `Process.Kill`; Unix `syscall.Kill(-pid, SIGTERM)` falling back to `Process.Kill`. No SIGKILL escalation (parity). Kill at most once per process.
- `run(cmd, args, opts)`: timeout default 60 s, max 600 s (504); combined stdout+stderr cap default 12 MiB, max 64 MiB (502); `allowExitCodes` default `{0}`; stdin always a pipe, `input` written then closed; cancellation from the request context → 499 and kill; non-zero exit → 502 `"<basename> exited with code N: <stderr or stdout ≤ 5000 chars>"`; spawn failure → 503.
- Tool resolution (`tools.go`): explicit path if the file exists (desktop passes `<appRoot>/tools/kubectl[.exe]` and `helm[.exe]` when present), else PATH with PATHEXT on Windows and X_OK on Unix; on Windows kubectl also falls back to `%ProgramFiles%\Docker\Docker\resources\bin\kubectl.exe`. `requireTool` → 503 "<tool> is not installed…" (the helm message must contain "helm"). `/api/health` reports `tools:{kubectl:{available,path},helm:{…}}` computed once at start.

### 4.3 Preferences (`prefs.go`, core.cjs 417)
`<dataDir>/preferences.json`, pretty JSON + trailing newline, mode 0600, written atomically (`.<12hex>.tmp` created exclusively, then rename), ≤ 256 KiB serialised. `PUT` replaces the whole object and echoes it. Server validates only `theme ∈ {system,light,dark}` and `clusters` (§4.4). Known keys: `theme`, `clusters`, `favoriteContexts`, `prometheusByContext`, `prometheusUrl`, `aiCommand`, `nodeShellImage`, `tourCompletedVersion`, `updates.auto`. Unknown keys pass through untouched.

### 4.4 Kubeconfigs (`kubeconfigs.go`, from kubeconfigs.cjs)
- `<dataDir>/kubeconfigs/` mode 0700; `index.json` (JSON array, atomic write via `.<8hex>.tmp`, 0600); `<id>.yaml` verbatim content, 0600; id is 16 hex chars.
- Index entry `{id, name ≤80, source:'file'|'paste', fileName ≤200 (file only), addedAt ISO, contexts:[…]}`. `readIndex` drops entries whose id is malformed or whose `.yaml` is missing; corrupt index reads as empty; **validate that `contexts` is an array and skip bad entries** (PLAN.md A14). Cache the parsed index in memory and invalidate on write (A26).
- Import validation: non-empty, ≤ 1 MiB (413), YAML mapping, `apiVersion: v1`, `kind: Config`, `clusters`/`contexts`/`users` arrays, ≥ 1 context, context names 1–253 chars, de-duplicated. 409 on clash with any existing context name. **Also reject when any imported `clusters[].name` or `users[].name` clashes with an existing file** (A20: kubectl's merge is first-file-wins for clusters and users too, so a clash silently points the imported context at the wrong server). Existing names come from `kubectl config view -o json` under the current merge; **if kubectl is missing, compute names from the index files alone and do not fail the import** (A23).
- Merge: no imports → `KUBECONFIG` untouched; otherwise `KUBECONFIG = (env.KUBECONFIG || ~/.kube/config) + listSeparator + imported files in index order`. The user's own kubeconfig is never written. `sourceOf(ctx)` → import id or `"default"`.
- `validateClusters`: map of ≤ 500 entries, keys 1–253 chars, each `{label ≤80, icon ∈ CLUSTER_ICONS (kubeconfigs.cjs:9), color #rrggbb, env ∈ production|staging|development|other|''}`.

### 4.5 Core routes (`routes_core.go`, core.cjs 746–909)
| Route | Behaviour to reproduce |
|---|---|
| `GET /api/health` | `{version, tools, platform, live:bool}`; spawns nothing |
| `GET /api/contexts` | `kubectl config view --output=json` (no `--raw`) → `{current, contexts:[{source,name,cluster,user,namespace (default "default"),current}]}` |
| `GET /api/kubeconfigs`, `POST` (201), `DELETE /:id` (`{removed:true}`, 404 unknown) | §4.4 |
| `GET /api/namespaces` | live LIST, fallback `kubectl --context=X get namespaces --output=json` |
| `GET /api/resources`, `GET /api/events` (resource forced to `events`) | live paginated LIST; fallback `kubectl get <res> --context=X [--namespace=N|--all-namespaces] [--selector=] [--field-selector=] --output=json`, 64 MiB cap; `get` must precede `--all-namespaces`. Redact Secrets (§4.13) |
| `GET /api/discovery` | live aggregated discovery, 5-min cache, `?refresh=1`; fallback `kubectl get --raw=/api/v1`, `--raw=/apis`, then ≤ 6 concurrent `--raw=/apis/<gv>`; groupVersion must match `^[a-z0-9.-]+/v[a-z0-9]+$`; subresources (name contains `/`) excluded; result `{resources:[{name,kind,namespaced,group,version,verbs,shortNames,singular,priority}], warnings}`; `group` is `''` for core |
| `GET /api/resource` | live GET (namespaced + empty ns → `default`); fallback `kubectl … get <res> <name> --output=json`; Secrets redacted |
| `GET /api/yaml` | `{yaml}` via `objectYAML`; fallback `--output=yaml`; **not redacted** (deliberate reveal) |
| `POST /api/diff` | `kubectl --context --namespace diff --filename=-`, YAML on stdin, exit 0 and 1 allowed → `{diff, changed: code==1}` |
| `POST /api/apply` | `… apply --filename=-` → `{output}` |
| `POST /api/delete` | `delete <res> <name> --wait=false` |
| `POST /api/scale` | `scale <res> <name> --replicas=N`, N 0..1e6 |
| `POST /api/restart` | resource must match `^(deployments?|daemonsets?|statefulsets?)(\.apps)?$`; `rollout restart <res>/<name>` |
| `GET|PUT /api/preferences` | §4.3 |

### 4.6 Metrics (`routes_metrics.go`, core.cjs 452–492, 826)
Raw GET `/apis/metrics.k8s.io/v1beta1/nodes` and `…/[namespaces/<ns>/]pods`, plus a metadata-only node list (`Accept: application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1`). Nodes missing from metrics-server: read `GET /api/v1/nodes/<n>/proxy/stats/summary?only_cpu_and_memory=true` for up to 20 nodes, 8 s timeout (fallback command `kubectl get --raw=… --request-timeout=8s`), synthesise node and pod items in metrics format (`cpu "<n>n"`, memory in bytes, `source:'kubelet'`); cache failures 60 s per context+node; report in `missingNodes`. Response `{nodes:{items}, pods:{items}, warnings:[], missingNodes:{}}`.

### 4.7 Helm (`routes_helm.go`, core.cjs 691–720, 851–877; actions.cjs 107–160)
- `GET /api/helm`: `helm list --all --output=json --kube-context=X [--namespace|--all-namespaces]` + `helm repo list --output=json` (exit 1 allowed → `[]`).
- `GET /api/helm/charts`: `helm search repo --output=json` + `repo list` (exit 1 allowed; "no repositories" text suppressed).
- `GET /api/helm/chart?chart&version`: `helm show readme`, `helm show values` (4 MiB each), `helm search repo <chart> --versions --output=json` (≤ 200 versions), all in parallel, each failure a warning.
- `GET /api/helm/release`: `helm get values -o yaml`, `get values --all`, `get notes` (exit 1 allowed), `get manifest` (16 MiB) parsed into `resources:[{apiVersion,kind,name,namespace}]`, `history --max=50 -o json`; only a `history` failure is fatal.
- `POST /api/helm` actions: `repo-add {repo,url}` (http/https, no credentials or fragment), `repo-remove`, `repo-update [repo]`, `install`/`upgrade {name, chart (validateChart), version?, values? ≤1 MiB YAML parsed for validity, on stdin with --values=-}`, `uninstall`, `rollback {revision 1..1e6}`; all with `--kube-context --namespace`; timeout 300 s; response `{output: stdout+stderr}`.

### 4.8 Actions (`routes_actions.go`, from actions.cjs)
- `POST /api/node {context,name,action}`: cordon/uncordon; drain → `drain <n> --timeout=<10..3600, default 300>s --ignore-daemonsets=<≠false> --delete-emptydir-data=<≠false> --force=<==true> [--grace-period=-1..3600]`, process timeout = timeout + 30 s.
- `POST /api/evict`: live only (503 otherwise); POST `/api/v1/namespaces/<ns>/pods/<n>/eviction` with `{apiVersion:'policy/v1',kind:'Eviction',metadata:{name,namespace}}`; PDB rejections pass through as 429; result `{output:"pod/<n> evicted"}`.
- `POST /api/cronjob`: trigger → `create job <name[:44]>-manual-<6hex> --from=cronjob/<name>` (dots → `-`); suspend/resume → `patch cronjob <n> --type=merge --patch={"spec":{"suspend":bool}}`.
- `POST /api/rollout-undo`: `rollout undo <res>/<n> --to-revision=R` (1..1e9), same resource regex as restart.
- `POST /api/patch`: `type ∈ merge|strategic|json` default merge; patch object or array ≤ 1 MiB (413); `patch <res> <n> --type=T --patch=<json>`.
- `POST /api/default-class {context, kind ∈ ingressclasses|storageclasses, name}` and legacy `POST /api/ingressclass-default`: live LIST (404 if missing); **set the new default first**, then clear others with `annotate <kind> <n> <key>=<bool> --overwrite`; StorageClass also removes legacy `storageclass.beta.kubernetes.io/is-default-class-`; no-op when already default.
- `GET /api/secret-data` → `{type, data, resourceVersion}` (live raw GET or `kubectl get secret -o json`).
- `POST /api/serviceaccount-kubeconfig {hours 1..8760 default 24}`: `kubectl create token <sa> --duration=Hh` and `kubectl config view --raw --minify --flatten --context=X -o json` in parallel; build the YAML kubeconfig (cluster server, CA data, insecure flag, tls-server-name; user `<sa>@<ns>` with the token; context `<user>-<cluster>`); `{kubeconfig, expiresInHours}`.

### 4.9 Prometheus (`routes_prometheus.go`, actions.cjs 14–106; `extras.go` 74)
- Provider resolution per context, cached 5 min including errors: `preferences.prometheusByContext[ctx]` with `mode:'off'` → 404; `mode:'service'` → `{namespace, service, port, prefix matching ^/[A-Za-z0-9._~\-/]*$, scheme}`; else auto-detect: LIST all services, score names with the `PROMETHEUS_CANDIDATES` table (thanos query 100 … generic prometheus 40, +5 for monitoring-like namespaces), choose port from `[9090,10902,9091,8481,8428,80,443]` preferring http/web/query names, probe the top 4 with `query=vector(1)` through the API-server service proxy `/api/v1/namespaces/<ns>/services/<scheme>:<svc>:<port>/proxy<prefix>/api/v1/query`.
- `GET /api/prometheus/provider?context&refresh=1` → `{provider}` or `{provider:null,error}`, always 200.
- `POST /api/prometheus/range {queries: 1–16 keys matching ^[A-Za-z0-9_-]{1,40}$, each ≤ 4000; start?, end?, step 5..86400 default 60}`: live only; default last hour; reject `(end-start)/step > 11000`; ≤ 50 series per key; `{provider,start,end,step,series:{key:[{metric,values:[[t,v]]}]},errors:{key:msg}}`; 404 when the provider is gone.
- `POST /api/prometheus {query ≤16000, start?, end?, step?}` (extras): direct `fetch` of `preferences.prometheusUrl` (http/https, no userinfo or hash) `/api/v1/query` or `/query_range`, no redirects, 15 s, 12 MiB, must be JSON, returned verbatim. Errors here are 500 and logged (parity).

### 4.10 AI (`extras.go` 86)
`POST /api/ai {command ∈ codex|claude|gemini|opencode (default prefs.aiCommand then codex), prompt ≤ 32000, context?}`; resolve the CLI on PATH; args: codex `exec --skip-git-repo-check --sandbox read-only -`, claude `-p`, gemini none, opencode `run`; prompt on stdin after the fixed safety preamble (copy the text verbatim from extras.cjs); 180 s; 2 MiB; `{output: stdout||stderr}`. On Windows `.cmd`/`.bat` wrappers run through `cmd.exe /d /s /c` and arguments containing any of `\r \n % ! & | < > ^ "` are rejected.

### 4.11 Argo CD (`argocd.go`, from argocd.cjs)
Everything is `kubectl get|patch|annotate|delete applications.argoproj.io <n>` against the CRD; no Argo API server, no credentials. Actions and their guards: `refresh`/`hard-refresh` (annotate `argocd.argoproj.io/refresh=normal|hard --overwrite`); `sync` (409 if `app.operation` exists; patch `{metadata:{resourceVersion}, operation}` from `syncOperation(options)` with `prune, dryRun, force, applyOnly→strategy apply, SYNC_OPTIONS booleans, prunePropagationPolicy ∈ foreground|background|orphan, revision ^[A-Za-z0-9][A-Za-z0-9._/@:+~-]*$ ≤256, resources ≤1000 {group,kind,name,namespace}, retry limit 1..100 default 5 with backoff 5s ×2 max 3m, initiatedBy {username:'rubban'}`); `rollback {id}` (409 if an operation runs or auto-sync is on; 404 if id not in `status.history`; writes revisions/sources or revision/source plus prune/dryRun); `terminate` (409 unless `status.operationState.phase=='Running'`; patch phase `Terminating` with resourceVersion guard); `auto-sync {enabled,prune,selfHeal,allowEmpty}` → `spec.syncPolicy.automated` object or null; `delete {cascade ∈ foreground(default)|background|none}` rewrites finalizers (`resources-finalizer.argocd.argoproj.io[/background]`) with resourceVersion guard, then `delete … --wait=false`.

### 4.12 RabbitMQ and the embedded console (`rabbitmq.go`, `embedproxy.go`, `forwards.go`)
- `GET /api/rabbitmq?context&namespace(*)` → `{items:[{id:"ns/svc", namespace, service, port, portName, scheme, headless, kind, image, version, pods:{ready,total}, pod, amqpPort, login:{username:<description>, password:<description>}}]}`; never values.
- Management port: 15672 or names `management|http-stats|http-management|mgmt|rabbitmq-management` or targetPort `management`; TLS fallback 15671 or `management-tls|https-stats|management-https`. Services grouped by namespace+selector; non-headless beats headless, http beats https; prefer a Ready pod; skip when a pod exists without a RabbitMQ container (image `/rabbitmq/` not an exporter, or port 15672, or container named rabbitmq).
- Credential plan: Cluster Operator labels (`app.kubernetes.io/part-of=rabbitmq`, `app.kubernetes.io/name=X` → Secret `X-default-user` keys username/password); else container env `RABBITMQ_DEFAULT_USER/_PASS` or `RABBITMQ_USERNAME/_PASSWORD` from literal (reject `$(`), `secretKeyRef`, `<VAR>_FILE` resolved through a mounted Secret volume honouring `items`, or `envFrom` secretRef with prefix; defaults `guest/guest`, Bitnami `user`.
- `POST /api/rabbitmq/credentials` → `{username,password,source}` plaintext. `POST /api/rabbitmq/open` → `{forwardId, localPort, url:"http://127.0.0.1:<embedPort>/", origin}`.
- Port forwards: `kubectl --context [--namespace] port-forward <res>/<name> [<local>]:<remote> --address=127.0.0.1`, stdout/stderr captured; readiness from `Forwarding from (?:127\.0\.0\.1|\[::1\]):(\d+)` in the last 8000 chars; statuses `starting|ready|error|stopped`; duplicate active local port 409; `DELETE` kills, closes the console, and waits ≤ 3 s for exit before replying. `forwardView` = `{id, context, namespace, resource, name, localPort, remotePort, status, error?, createdAt, embedPort?}`.
- Embed proxy: its own listener on `127.0.0.1:0` per console; Host must be the proxy's own `127.0.0.1:<p>`/`localhost:<p>`; `GET /__rubban/bridge.js` built from the two parent origins and a per-proxy 32-byte hex `loginToken`; `GET /__rubban/login` requires `X-Rubban-Embed-Token` (constant-time) and same-origin Origin if present, returns the credentials or 502; proxying forwards `req.url` byte for byte with `accept-encoding: identity`, keep-alive ≤ 6 sockets, TLS upstream without verification; strips `X-Frame-Options`, replaces `frame-ancestors` with the parent origins; buffers `text/html` (≤ 2 MiB, else 502) to inject `<script src="/__rubban/bridge.js">` before `</head>`, else after `<body>`, else at start, fixing content-length/transfer-encoding/etag and setting `no-store`; GET/HEAD retried once on upstream error, other methods not; failure 502 "The port forward is not answering…". Console lifecycle (uncommitted `openEmbeddedForward`): one console per `[context, ns, resource, name, remotePort]`; reuse or start a forward, poll every 150 ms up to 25 s; if the forward dies, restart it once for all concurrent requests and drop the dead one. Copy the bridge script's JavaScript verbatim from `embed-proxy.cjs` (postMessage protocol `rubban:connect/ready/login/login-sent/authenticated/login-failed/login-timeout/credentials-unavailable`, 20 s timeout, 150 ms polling).

### 4.13 Secret redaction (`live/sanitize.go`, core.cjs 207)
Lists and single objects: drop `data` and `stringData`, add `dataKeys:[…]`, strip annotation `kubectl.kubernetes.io/last-applied-configuration`. Applies when the resource matches `^(?:secrets?)(?:\..*)?$` or kind is `Secret`/`SecretList`. The live path always strips `metadata.managedFields`. Only `/api/yaml`, `/api/secret-data`, `/api/rabbitmq/credentials` and the embed `/__rubban/login` return values. Secret values never appear in `/api/watch` messages.

### 4.14 Live layer (`internal/live`, from live.cjs)
- **Proxy pool**: one `kubectl --context=X proxy --address=127.0.0.1 --port=0 --api-prefix=/rubban-<32hex>/ --accept-hosts=^127\.0\.0\.1$` per context; ready on stdout `Starting to serve on 127.0.0.1:(\d+)`; 30 s start timeout; base `http://127.0.0.1:<port>/rubban-<hex>`; reference-counted leases; idle 10 min → kill (sweeper ≤ 30 s); connection-lost errors invalidate the proxy and the next acquire relaunches. `requestJSON`: 60 s default, 96 MiB cap; Kubernetes statuses 400/401/403/404/409/410/422/429 pass through, others → 502. `viaLive` falls back to one-shot kubectl only when the proxy failed to spawn (503) or to start (504), never on 502.
- **Discovery cache**: 5 min per context; aggregated discovery with `Accept: application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList,…` and a legacy fallback of 8 concurrent group requests; unknown resource → one refresh, then 404. `resolveResource` scoring: `name.group` / `name.version.group` exact (core `name.version`) = 0; exact plural = 1000 + priority; singular/kind/shortName = 100000 + priority; lowest wins. A resource whose verbs lack `list` → 405.
- **ResourceWatch**: shared per `[context, group, version, resource, scopedNs, selectors]`; LIST paginated `limit=500` + `continue`, 120 s per page; items get `apiVersion`/`kind` (List kind minus `List`) and are sanitised; WATCH `watch=1&resourceVersion&allowWatchBookmarks=true&timeoutSeconds=290` + selectors, newline-delimited JSON, one event line ≤ 16 MiB, restart after 150 s of silence, coalesce and flush every 150 ms, BOOKMARK updates resourceVersion, ERROR 410 → re-list and emit the diff (upserts where resourceVersion changed, deletes for missing keys). Errors: LIST 401/403/404 fatal; WATCH 401/404 fatal; WATCH 403 or no `watch` verb → poll mode (LIST every 15 s, status `polling`); 410 → clear RV and re-list; connection lost → invalidate proxy, retry after 250 ms; else backoff `min(30s, 1s·2^(n-1)) × [0.75,1.25)`, re-list from scratch after 3 failures; `resync=1` aborts and re-lists. Last subscriber leaves → linger 2 min. Keys: `metadata.uid` else `ns/name`.

### 4.15 WebSocket streams (`ws_*.go`)
Use `github.com/coder/websocket`. Upgrade only after the Host/Origin/token checks. Max payload 64 KiB, no compression. If a socket's buffered unsent data exceeds 4 MiB, terminate it.

- **`/api/watch`** messages to the client: `{type:'status', state ∈ connecting|live|polling|reconnecting|error, message, attempt?}`, `{type:'reset'}`, `{type:'items', items:[≤250]}`, `{type:'synced', resourceVersion, count}`, `{type:'changes', upserts:[≤250], deletes:[keys] (first chunk only)}`, `{type:'error', error, status}` then close 1000 after the queue drains, `{type:'unavailable', message}` then close (no live layer). One message in flight at a time; queue > 5000 → terminate. Client messages ignored.
- **`/api/logs`**: query `context, namespace, pod | selector (validateSelector; adds --selector --prefix=true --max-log-requests=<1..50, default 20> and --all-containers=true when no container), follow (default true; only 'false' disables), tail -1..100000 default 100, container ('*' → --all-containers=true, plus --prefix=true when not using a selector), timestamps=true, since 1..2592000 → --since=Ns, previous=true|false`. Command `kubectl --context --namespace logs …`. Server sends **raw UTF-8 text frames** with stdout and stderr interleaved; non-zero exit → `\n[process exited with code N]\n` then close 1000 "Log stream ended"; spawn error → `[error] …` close 1011; validation → `[error] …` close 1008. Close kills kubectl.
- **`/api/terminal`**: §4.16.

### 4.16 Terminal (`terminal.go`, `pty_*.go`, core.cjs 183–224, 1022–1140)
- Query: `cols 20..500 default 100`, `rows 5..300 default 30`, `context, namespace, pod, container, attach=true, node, image (default busybox:1.36, ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ≤300)`.
- Modes: **node** → `kubectl --context --namespace=kube-system debug node/<n> --stdin=true --image=<img> --profile=sysadmin [--tty=true] -- chroot /host /bin/sh -c 'if [ -x /bin/bash ]; then exec /bin/bash -l; else exec /bin/sh -l; fi'`, capture `debugging pod (node-debugger-[a-z0-9.-]+)` and delete it on exit (`delete pod <n> -n kube-system --wait=false --ignore-not-found=true`, 30 s). **exec/attach** → `kubectl … exec|attach --stdin=true [--tty=true] <pod> [--container=] [-- /bin/sh -c 'if [ -x /bin/bash ]; then exec /bin/bash; else exec /bin/sh; fi']`. **local** → Windows PowerShell; else `$SHELL`, `/bin/zsh` (macOS), `/bin/bash`, `/bin/sh`; unscoped = login shell `-l`; scoped (context given) skips startup files (`bash --noprofile --norc`, `zsh -f`, `fish --no-config`, else `/bin/sh`) and gets a minified kubeconfig from `kubectl config view --raw --minify --flatten --context=X -o json` (20 s) with the namespace overridden, written to `<dataDir>/terminals/<16hex>.kubeconfig` (0600, dir 0700); failure to prepare it → 502 (fail closed).
- Env: process env + `TERM=xterm-256color` + kubeEnv + `KUBECONFIG=<scoped file>` + `RUBBAN_CONTEXT`. Cwd: home for local, dataDir otherwise.
- PTY: use `github.com/aymanbagabas/go-pty` (creack/pty on Unix, ConPTY on Windows) unless `RUBBAN_DISABLE_PTY=1`; otherwise pipes, stripping `--tty=true`. Verify the library's ConPTY resize and close behaviour on Windows 10 before relying on it; `github.com/UserExistsError/conpty` is the fallback choice.
- Messages: server → `{type:'status', mode:'pty'|'pipes', message}`, `{type:'data', data}`, `{type:'exit', code}` then close 1000, `{type:'error', error}` (spawn 1011, validation 1008). Client → `{type:'input', data ≤ 32 KiB}`, `{type:'resize', cols, rows}` (ignored in pipes), anything else → `{type:'error'}`, socket stays open.
- Cleanup on close: kill, delete debug pod, delete scoped kubeconfig. Wipe `<dataDir>/terminals/` at start and on close.

### 4.17 Shell environment import (`shellenv.go`, from shell-env.cjs)
Desktop only, non-Windows, skipped by `RUBBAN_SKIP_SHELL_ENV=1`: run `$SHELL` (`/bin/zsh` on darwin, `/bin/bash` elsewhere) with `-ilc <script>`, 5 s timeout, stdin closed, env `DISABLE_AUTO_UPDATE=true ZSH_DISABLE_COMPFIX=true RUBBAN_SHELL_PROBE=1`; script prints marker `__RUBBAN_ENV__` then `KEY=value` for the allowlist (PATH, KUBECONFIG, proxy vars, gcloud/AWS/Azure vars, SSL_CERT_FILE, NODE_EXTRA_CA_CERTS, LANG); parse only after the last marker; on timeout parse partial output. New PATH = current ∪ shell PATH ∪ existing common tool folders (Homebrew, gcloud SDK, krew, `.rd`, `.local/bin`, Docker.app), de-duplicated in that order; other vars set only when unset. Apply with `os.Setenv` before the backend starts so children inherit it.

### 4.18 Logging (`internal/logging`, from log.cjs)
`<dataDir>/logs/rubban.log`, mode 0600, synchronous append, JSON lines `{time, level, message, stack?, …extra}`; rotate when size + line > 5 MiB: delete `.3`, shift `.2→.3`, `.1→.2`, current → `.1`; size tracked in memory seeded from stat; levels info/warn/error; swallow I/O errors. Desktop logs uncaught panics (recovered at the top of every goroutine we own), renderer errors (§5.6) and request errors ≥ 500. `rubban web` keeps today's behaviour of no file logging unless `--log` is passed (new flag, optional).

### 4.19 Web mode (`rubban web`, from start.cjs)
Data dir `RUBBAN_DATA_DIR` or `<cwd>/data`; no tool paths, no shell-env import; bind `127.0.0.1:${RUBBAN_PORT:-0}`; write `<dataDir>/connection.json` `{url, port, token, pid}` 0600; print the URL and the file path; SIGINT/SIGTERM → close backend, delete connection.json, exit 0.

### 4.20 Data directory resolution and persisted files
| Mode | Directory |
|---|---|
| Desktop | `RUBBAN_DATA_DIR`; else packaged Windows `<parent of the exe folder>/Rubban-Data` (portable layout); packaged macOS `~/Library/Application Support/Rubban`; development `<repo>/data` |
| Web | `RUBBAN_DATA_DIR`, else `./data` |

Files: `preferences.json`, `kubeconfigs/index.json` + `<id>.yaml`, `terminals/*.kubeconfig` (ephemeral), `connection.json`, `logs/rubban.log[.1-3]`, `update-state.json`, `updates/…`, `port` (new, §12). `desktop-profile/` (Electron's) is no longer written; leave it alone if present.

Environment variables to honour unchanged: `RUBBAN_DATA_DIR`, `RUBBAN_SMOKE_DIR`, `RUBBAN_DISABLE_UPDATES`, `RUBBAN_SKIP_SHELL_ENV`, `RUBBAN_DISABLE_PTY`, `RUBBAN_PORT`, `RUBBAN_NO_START`, `RUBBAN_BUNDLE_KUBECTL`, `RUBBAN_BUNDLE_HELM`, `RUBBAN_RELEASE_DIR`, `RUBBAN_CONNECTION_FILE`, `RUBBAN_API_URL`, `RUBBAN_API_TOKEN`, `RUBBAN_KUBECTL`; set for children: `RUBBAN_CONTEXT`, `RUBBAN_SHELL_PROBE`. `ELECTRON_RUN_AS_NODE` and `electron_config_cache` disappear.

---

## 5. Desktop shell (`internal/app`, Wails v3, from desktop/main.cjs)

5.1 **Startup order.** Shell-env import (non-Windows) → resolve data dir, create it → logger → single-instance lock (second launch focuses the running window and exits) → resolve bundled tools (`<appRoot>/tools/`; `appRoot` is the exe's folder on Windows and `Rubban.app/Contents/Resources` on macOS) → start backend on `127.0.0.1` with the persisted port (§12 item 1) → write `connection.json {url, port, token, pid}` 0600 → create window → start updater.

5.2 **Window.** Title `Rubban · رُبّان`, 1540×970, min 1050×700, background `#1f2123` when the OS theme is dark else `#ffffff`, hidden when `--smoke-test`, native frame, icon from `assets/`. URL = backend URL. Navigation away from the backend origin is blocked; `window.open` and external navigations go to the system browser only for http/https URLs without credentials. Zoom in/out/reset and fullscreen are wired to Wails window calls. Dev tools toggle on `CmdOrCtrl+Shift+I` in all builds (parity). Closing the window quits the app on every platform, macOS included.

5.3 **Menu** (same items and roles): *Rubban* (macOS: About, separator) Reload `CmdOrCtrl+R`, (macOS: hide/hide others/unhide), Quit. *Edit* undo/redo/cut/copy/paste/select all. *View* reset zoom, zoom in, zoom out, fullscreen, Developer tools. *Window* (macOS role). *Help* Check for updates…, Open log folder, About Rubban. Dialog texts copied verbatim from main.cjs 81–86 and 130; `checkFromMenu` branches on the returned status, never assumes an update exists (PLAN.md A27).

5.4 **Theme.** `POST /api/desktop/theme` sets the Wails application/window theme to system/light/dark; read `theme` from `preferences.json` **before** creating the window so an explicit Light/Dark choice does not flash (A10).

5.5 **Permissions.** Deny everything the webview asks for except clipboard write from the backend origin, where the platform exposes a hook; where it does not (WKWebView), document the behaviour in §12.

5.6 **`--smoke-test`.** Window hidden; register `POST /api/desktop/renderer-error`; `desktop-bridge.js` installs `window.onerror` and `unhandledrejection` handlers in smoke mode that post `{message, stack}`; after 2200 ms evaluate `{title: document.title, ready: document.readyState, bodyLength: innerText.length, body: innerText.slice(0,3000)}` through Wails' JS execution; if `RUBBAN_SMOKE_DIR` is set write `<dir>/desktop-smoke.json` `{title, ready, bodyLength, body, rendererErrors:[…]}` (the PNG preview is dropped, §12); always print one stdout line `{"smoke":true,"title":…,"ready":…,"bodyLength":…,"rendererErrors":[…]}` (on Windows write it to the file as well, since the GUI exe has no stdout); exit 0 when there are no renderer errors, else stop updater, close backend, delete connection.json, exit 1.

5.7 **Lifecycle.** Fatal startup error: log, close backend, delete connection.json, show an error dialog unless smoke, exit 1. Quit: stop updater, close backend (kills all children, wipes `terminals/`), delete connection.json. Panics in our goroutines are logged with `{kind}` and the first one shows the "Rubban hit an unexpected error" dialog with the log path.

5.8 **Windows specifics.** Build `Rubban.exe` with `-H=windowsgui`, version resource and icon (use `github.com/tc-hib/go-winres` or Wails' own resource embedding) with CompanyName `Rubban contributors`, FileDescription `Rubban Kubernetes Workbench`, ProductName `Rubban`. Set the AppUserModelID `dev.rubban.desktop`. Use Wails' WebView2 "download bootstrapper if missing" mode; document the offline case in the README.

---

## 6. Updater (`internal/updater`, from desktop/updater.cjs and desktop/update/*)

Port verbatim; it is already self-contained logic.
- Constants: max download 500 MiB; allowed hosts `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`; first check 20 s after start, then every 6 h; disabled when not packaged or `RUBBAN_DISABLE_UPDATES=1`; automatic checks only when `preferences.updates.auto !== false`.
- Version parsing `^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$` with semver pre-release ordering.
- `safeFetch`: https only, no credentials, allowed host on every hop, manual redirects ≤ 6, `User-Agent: Rubban/<current>`.
- Manifest `https://github.com/HosHaggag/Rubban/releases/latest/download/latest.json` = `{version, assets:{"win32-x64":{name,sha256,size}, "darwin-arm64":…, "darwin-x64":…}, notes}`; key is `<platform>-<arch>` using the **Node names** (`win32`, `darwin`, `x64`, `arm64`) so existing 0.11.0 installs keep matching. Validation: name `^Rubban-[0-9A-Za-z.+-]+\.zip$`, sha256 64 hex, 0 < size ≤ 500 MiB, notes cut at 20000 chars. Download URL `https://github.com/HosHaggag/Rubban/releases/download/v<version>/<name>`.
- State `{status ∈ idle|checking|up-to-date|available|downloading|ready|installing|error, current, latest, notes, progress, error, lastCheck, disabled, result}`; transitions exactly as updater.cjs; **a failed periodic check must not overwrite `ready`** when the verified zip is still on disk (A22); report `ready` only after re-hashing the file (A3); emit progress only when the integer percentage changes (A25). Persist `update-state.json {lastCheck, latest, notes}`.
- Download to `<dataDir>/updates/<name>.part` (0600) streaming SHA-256, abort over 500 MiB or `size+1024`, verify exact size and hash, rename, delete everything else except `result.json`.
- Install: refuse when the executable is under `/Volumes/` or under `os.TempDir()` using `filepath.EvalSymlinks` on both sides (A4); copy the embedded helper script into `updates/` (0755 on macOS); Windows `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File apply-update.ps1 -Zip … -Install <exe dir> -ProcessId <pid> -Exe <exe> -ResultFile … -Version …`; macOS `/bin/bash apply-update.sh <zip> <Rubban.app> <pid> <result.json> <version>`; detached; then quit. `apply-update.sh` must escape `installedTo` as well as `message` (A5). Read and delete `updates/result.json` on start and emit it as `state.result`.
- **Upgrade path from 0.11.0.** The 0.11.0 app's own `apply-update.ps1` extracts the new zip, requires `Rubban.exe` and `Install-Rubban.ps1` at the zip's top folder, and runs the **new** `Install-Rubban.ps1 -Source -Destination -NoStart`. Keep those names and parameters. The new installer must recognise both the old layout (`resources\app\package.json`) and the new one (`VERSION` file next to the exe) as "a Rubban install" before emptying the destination, and must print the version from `VERSION`. macOS `apply-update.sh` only needs `Rubban.app`; keep it.

---

## 7. MCP bridge (`internal/mcp`, `rubban mcp`, from services/mcp.cjs + kube-read.cjs)

Use the official `github.com/modelcontextprotocol/go-sdk` stdio transport if it reproduces the behaviour below without pulling in a large dependency tree; otherwise hand-roll newline-delimited JSON-RPC as today (it is ~300 lines).
- Connection: `--connection-file <path>` or `RUBBAN_CONNECTION_FILE`; file ≤ 8192 bytes and on POSIX not group/world readable; `RUBBAN_API_URL`/`RUBBAN_API_TOKEN` override; URL must be exactly `http(s)://127.0.0.1:<port>/` with no path, query, fragment or credentials; token printable ASCII ≤ 4096.
- Protocol versions `2024-11-05`, `2025-03-26`, `2025-06-18` (others answered with `2025-06-18`); lifecycle new → initialize → initializing → `notifications/initialized` → ready; second initialize -32600; methods before ready -32002; `ping` always; line limit 64 KiB (-32600, close input); parse error -32700; ≤ 8 in-flight (-32000); internal -32603. `serverInfo {name:'rubban-read-only', version:'0.1.0'}`, `capabilities.tools.listChanged:false`, same `instructions` text.
- Tools `list_contexts`, `list_resources {context, resource ∈ RESOURCES (30 names, no secrets), namespace?}`, `resource_details {+name}`, `metrics {context, namespace?}`, each a GET to the backend with Bearer token, no redirects, 20 s, 4 MiB; annotations readOnly/idempotent/openWorld; results as one text content item with the JSON; failures `isError:true` with a generic message. Diagnostics to stderr only.
- README §9 launch instructions change from `ELECTRON_RUN_AS_NODE=1 …` to `rubban-cli.exe mcp --connection-file …` (Windows) and `Rubban.app/Contents/MacOS/Rubban mcp --connection-file …` (macOS). `assemble-runtime` and `Rubban-MCP.cmd` are deleted.

---

## 8. Build, packaging, release, CI (`cmd/buildtool`)

8.1 **Building.** `go build -tags desktop -trimpath -ldflags "-s -w -X github.com/HosHaggag/rubban/internal/version.Version=<v> [-H=windowsgui]" ./cmd/rubban`. Windows binaries cross-compile from Linux/WSL only if the Wails v3 Windows backend is CGO-free in the pinned version; verify once, otherwise build on the Windows runner as CI does anyway. macOS must build on macOS (CGO, Cocoa); build arm64 and amd64 separately as today (no universal binary; the manifest keys are per arch).

8.2 **`buildtool package --os windows|darwin --arch x64|arm64`** reproduces today's zips exactly:
```
Rubban-<v>-Windows-x64.zip
└── Rubban-<v>-Windows-x64/
    ├── Rubban.exe              ├── rubban-cli.exe
    ├── VERSION                 ├── Install-Rubban.ps1      ├── README.md
    ├── LICENSE                 ├── THIRD-PARTY-NOTICES.md  ├── CHANGELOG.md
    └── tools/  kubectl.exe, helm.exe, tool-provenance.json   (only when RUBBAN_BUNDLE_* are set)

Rubban-<v>-macOS-<arm64|x64>.zip
└── Rubban-<v>-macOS-<arch>/
    ├── Rubban.app/Contents/{Info.plist, MacOS/Rubban, Resources/rubban.icns, Resources/tools/…, Resources/VERSION}
    ├── Install-Rubban.command  └── README.md
```
`Info.plist`: `CFBundleIdentifier dev.rubban.desktop`, `CFBundleName Rubban`, `CFBundleShortVersionString`/`CFBundleVersion <v>`, `LSApplicationCategoryType public.app-category.developer-tools`, `NSHighResolutionCapable`, `LSMinimumSystemVersion 13.0`, `NSRequiresAquaSystemAppearance false`. Signing as today: `codesign --force --deep --sign -` + `--verify --deep --strict` on macOS; `rcodesign` when present elsewhere; otherwise unsigned and the installer re-signs. `tool-provenance.json` = `[{name, filename, sha256, source, license:'Apache-2.0'}]`. Zip: `ditto -c -k --sequesterRsrc --keepParent` on macOS, otherwise `archive/zip` with the entry prefix `<folder>/`, sorted entries, deflate only when smaller, UTF-8 flag, Unix modes in external attributes, symlinks stored as link entries (port of zip-writer.cjs). Output dir `RUBBAN_RELEASE_DIR` or `release/`; print `{version, zip, tools}`.

8.3 **Other subcommands** (ports of the `.cjs` scripts): `fetch-tools <os> <arch> <outDir>` (dl.k8s.io + get.helm.sh with `.sha256`/`.sha256sum` verification, 15-min timeout, 0755; versions from `scripts/tool-versions.json` → move to `cmd/buildtool/tool-versions.json`); `write-manifest <dir>` (`SHA256SUMS.txt` + `latest.json` with the Node-style keys; notes from CHANGELOG; fail when no asset matches); `check-version` (`GITHUB_REF_NAME` minus `v` must equal the `VERSION` file and have a non-empty CHANGELOG section; `VERSION` at the repo root becomes the single source of truth, read by buildtool and embedded into the binary); `release-notes <version>`; `release <major|minor|patch|x.y.z>` (clean tree, bump `VERSION`, commit `Release <v>`, tag `v<v>`); `fetch-xterm` (download the pinned `@xterm/xterm` and `@xterm/addon-fit` tarballs from the npm registry, verify the `dist.integrity` hash, copy `lib/xterm.js`, `lib/addon-fit.js`, `css/xterm.css` and both LICENSE files into `ui/`, regenerate `ui/vendor.js`); the vendored files are committed.

8.4 **CI** (`ci.yml`): matrix ubuntu/windows/macos with `actions/setup-go` reading `go.mod`; steps `go vet ./...`, `go test ./...` (Linux without the desktop tag; Windows and macOS with `-tags desktop` so `internal/app` compiles), `staticcheck` or `golangci-lint` with a committed config; Linux additionally `npm ci && npm run lint && npm run test:ui`; a `package-smoke` job on Windows that runs `buildtool package` and the smoke test. **`release.yml`** on `v*` tags: `check-version` → windows job (fetch-tools, package, smoke-test the zip as today with `RUBBAN_DISABLE_UPDATES=1`, `RUBBAN_DATA_DIR`, `RUBBAN_SMOKE_DIR`, assert exit code and empty `rendererErrors`) → macOS job (arm64 + x64, smoke the arm64 build) → publish (download `release-*`, `write-manifest`, `release-notes`, `softprops/action-gh-release@v2` with the zips, `SHA256SUMS.txt`, `latest.json`, pre-release when the tag contains `-`). Keep artifact names `smoke-windows`, `smoke-macos`, `release-windows`, `release-macos`.

8.5 **Installers.** `Install-Rubban.ps1`: keep parameters and behaviour; read the version from `VERSION`; recognise old and new layouts; stop copying `resources\app\tools` logic in favour of `tools\`; shortcut description unchanged. `Install-Rubban.command`: unchanged except nothing references `resources/app`.

---

## 9. Phases and acceptance criteria

Each phase ends with `go vet`, `go test ./...` green, the phase's acceptance list checked, and a commit. Do not start deleting Node code before phase 8. Work on a branch `go-port`; `main` keeps shipping Electron until cutover.

**Phase 0 — Toolchain and skeleton (½ day).** Go 1.26 in WSL and on the Windows clone; `go.mod`; layout from §2; `cmd/rubban version` prints `0.0.0-dev`; `go:embed` of `ui/`; `fetch-xterm` subcommand and the vendored `ui/xterm.css`; `VERSION` file = `0.12.0`. Accept: `go build ./...` on Linux without the desktop tag and `go build -tags desktop` on Windows and macOS both succeed (an empty Wails window is fine).

**Phase 1 — Core server and web mode (3–4 days).** §3.1, §4.1–4.5 (fallback kubectl paths only, `live:false`), §4.19, logging. Accept: `rubban web` serves the UI in a browser; Welcome page lists contexts; a context opens with snapshot lists (`/api/watch` answers `unavailable`); diff/apply/delete/scale/restart work against a kind cluster; Secrets are redacted in lists and revealed by YAML; preferences and kubeconfig import/remove persist; the Go tests mirror the `core.test.cjs` cases for these routes (fake runner interface, `httptest`).

**Phase 2 — Live layer (3–4 days).** §4.13–4.15 watch. Accept: `live:true`; lists load through the proxy; a pod created with kubectl appears without refresh; delete removes the row; watch survives killing the `kubectl proxy` process (reconnects); 403 on a resource switches to polling; the `live.test.cjs` matrix passes against a fake API server in Go.

**Phase 3 — Remaining routes (4–5 days).** §4.6–4.12. Accept: every endpoint in §3.2 answers; `actions.test.cjs`, `rabbitmq.test.cjs` and `extras.test.cjs` cases pass in Go; RabbitMQ console opens inside the iframe and signs in; port forward opens in the browser; Helm pages work with a chart repo added; Argo CD actions verified against a cluster with Argo installed or with the fake API server.

**Phase 4 — Streams and terminal (3 days).** §4.15 logs, §4.16. Accept: pod logs stream and stop on close; workload logs by selector with prefixes; exec, attach, node shell (debug pod deleted on close) and local scoped shell work on Windows (ConPTY) and macOS; resize propagates; `RUBBAN_DISABLE_PTY=1` falls back to pipes; the `terminals/` folder is empty after quit.

**Phase 5 — Desktop shell (4–5 days).** §5, §3.3, `desktop-bridge.js`, §10 edits. Accept: the window opens on Windows 10, Windows 11 and macOS 13+; theme switching follows System/Light/Dark without a flash; external links open in the browser; clipboard copy works; kubeconfig download uses the native Save dialog; second launch focuses the first; `--smoke-test` writes `desktop-smoke.json` and exits 0; cold start ≤ 0.7 s on the owner's Windows machine; Electron-only behaviours from §12 are documented.

**Phase 6 — Updater and MCP (2–3 days).** §6, §7. Accept: `updater` unit tests ported (8 cases); a throwaway GitHub release (pre-release tag on a fork or a `-rc` tag) is detected, downloaded, verified and installed on both platforms with the previous version restored on a forced failure; `rubban mcp` passes the 3 `services.test.cjs` cases and works from Claude Desktop or another MCP client.

**Phase 7 — Build, packaging, release, CI (2–3 days).** §8. Accept: `buildtool package` zips match the layouts in §8.2; `ci.yml` green on all three runners; a `v0.12.0-rc.1` tag runs `release.yml` end to end and publishes a pre-release with `latest.json`; sizes recorded against §0.

**Phase 8 — Cutover (1–2 days).** Delete `desktop/`, `server/`, `services/`, `scripts/*.cjs`, `package-lock.json`; shrink `package.json`; rewrite README §2–§5, §7, §9, §11 (install, build from source with Go, data folder, MCP launch, project layout); CHANGELOG `0.12.0: Rubban is now a single Go binary`; fold the remaining PLAN.md backend items into "done"; merge to `main`; tag `v0.12.0`; perform the 0.11.0 → 0.12.0 in-app update on Windows and macOS (PLAN.md B4) and record the result in CHANGELOG.

Total: roughly 5–6 working weeks for one person who knows Go, including the parity harness in §13.

---

## 10. UI changes allowed (nothing else)

1. `ui/index.html`: add `<script src="/desktop-bridge.js"></script>` immediately before the `app.js` module script. The CSP already allows it. The server serves an empty file in web mode.
2. `ui/kit.js` download helper (~line 480): when `globalThis.rubbanDesktop?.saveFile` exists, call it instead of the Blob + `<a download>` path. The web build keeps the Blob path. Reason: WKWebView does not perform `<a download>` and WebView2 shows a browser-style download bar.
3. `ui/desktop-bridge.js` (new, classic script, no imports): defines `globalThis.rubbanDesktop` as in §3.3 using `fetch` with the token from the meta tag and a WebSocket to `/api/desktop/events` with auto-reconnect. Must be ESLint-clean under the `ui/**` browser config.

The vendored `ui/xterm.js`, `ui/addon-fit.js`, `ui/vendor.js` and the new `ui/xterm.css` are regenerated by `buildtool fetch-xterm`, not edited.

---

## 11. Carry-over from PLAN.md

Backend and desktop items absorbed into this plan (do them as part of the port, not as separate fixes): A3, A4, A5, A10, A14, A20, A22, A23, A25, A26, A27 (sections above name them). A6 (`dismissResult` over the bridge) becomes `POST /api/desktop/updates/dismiss`; wire it in `updates.js` only if trivially safe, otherwise leave it. UI-only items stay in PLAN.md and are unaffected: A8, A9, A11, A12, A13, A16/A28, A17, A18, A19, A21, A24, A29 (A29 disappears with main.cjs). Decisions B1 (production guard is UI-only; no server change) and B2 (code signing: when certificates exist, add `signtool`/`codesign --options runtime` + `notarytool` to `release.yml` and verify the signature in the updater) are unchanged.

---

## 12. Deliberate behaviour changes and open questions

Changes the port makes on purpose:
1. **Stable loopback port per data directory.** Electron loads `http://127.0.0.1:<random port>` each launch, so `localStorage` (theme, column widths, dock height, log options) is keyed to a different origin every run and is lost. The Go desktop persists the first free port it binds in `<dataDir>/port` and tries it first next time, falling back to a new free port. Web mode keeps `RUBBAN_PORT`. Verify the claim on 0.11.0 before relying on it as a selling point; the fix is right either way.
2. **No `desktop-preview.png`** from the smoke test (Wails has no page capture); the JSON is what CI asserts on anyway.
3. **`rubban web` gains `--log <dir>`** (optional) so self-hosted runs can keep a log file. Off by default to match today.
4. **MCP launch command** changes (§7). Document in README §9 and CHANGELOG.
5. **Windows ships two executables** (§1.3). The installer copies both.
6. **`VERSION` file** replaces `package.json` as the version source for the installer, buildtool and the binary.

Questions for the owner (answer before the phase that needs them; default in bold):
- Q1 (phase 5). Developer tools in release builds: **keep** the menu item as today, or hide it behind an environment variable?
- Q2 (phase 5). On WKWebView the clipboard permission hook does not exist; `navigator.clipboard.writeText` works on a secure localhost origin anyway. **Accept** and drop the Electron-style permission handler on macOS?
- Q3 (phase 6). Keep the `0.1.0` MCP `serverInfo.version` string or report the app version? **Report the app version** (clients only display it).
- Q4 (later). Replace `kubectl proxy` with client-go once the port is stable? Not in scope; note the trade-off from §1.5 in CHANGELOG discussion if raised.
- Q5 (phase 7). Version number for the first Go release: **0.12.0** (the updater treats it as a normal upgrade); 1.0.0 only after B4 is verified.

---

## 13. Verification protocol

13.1 **Parity harness** (`cmd/buildtool parity`, or a Go test under `internal/server/parity_test.go` with `-run Parity -args -old <url> -token <t>`): start the 0.11.0 backend with `npm run web` and the Go backend with `rubban web` against the same kind cluster and the same copied data directory. For every GET route in §3.2 with a fixed set of query parameters (health, contexts, kubeconfigs, discovery, resources for pods/deployments/secrets/configmaps/nodes/events/customresourcedefinitions in `*` and one namespace, resource and yaml for one object of each, metrics, helm list/charts, forwards, rabbitmq, prometheus/provider) fetch both, normalise volatile fields (`resourceVersion`, `managedFields`, timestamps, `version`, `path`, `platform`, `live`, `current`), and diff. Zero differences before phase 8. Also compare the `/api/watch` snapshot (`reset`…`synced`) item sets for the same resources.

13.2 **Manual checklist on real machines** (owner's Windows box via the `Rubban-verify` clone, and a Mac): the README §4 first-run flow; every destructive action against a kind cluster only (never the three production GKE contexts, see PLAN.md §D); terminal in all four modes; RabbitMQ console; Helm install/upgrade/rollback/uninstall of a public chart; in-app update from 0.11.0 to the release candidate; `rubban mcp` from an MCP client; `--smoke-test` locally.

13.3 **Windows notes** (from PLAN.md §D, still true): WSL has no Node and Go 1.22; install Go 1.26 on both. Sync to the Windows clones with the same `rsync` line. `powershell.exe -NoProfile -Command` with `go.exe` works without the `npm.cmd` dance. `ELECTRON_RUN_AS_NODE` no longer matters. A running `Rubban.exe` locks the binary on Windows; close it before rebuilding into the same folder.

13.4 **Done means**: all §9 acceptance lists ticked, §0 targets measured and written into CHANGELOG 0.12.0, `go test ./...` and the UI tests green on the three CI runners, the parity harness at zero differences, and the 0.11.0 → 0.12.0 update performed on both platforms.
