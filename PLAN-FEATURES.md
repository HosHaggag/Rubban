# Rubban — next features (implementation plan)

Written for the model that implements it. Eight features, each self-contained, in the order to build them. Everything below refers to the code as of commit `1896293` (0.12.2: Go backend, Wails shell, plain ES-module UI). `PLAN.md` and `PLAN-GO.md` are historical — do not follow them.

---

## 0. How to work in this repository

**Layout.** `cmd/rubban` (entry: desktop / `web` / `mcp`), `internal/server` (HTTP + WebSocket API, kubectl runner, forwards, terminals, logs), `internal/live` (one `kubectl proxy` per context, shared LIST+WATCH streams, discovery), `internal/app` (desktop shell), `internal/updater`, `ui/` (no build step: `index.html`, `app.js` is the shell, one module per area, `kit.js` has `el()`, `state`, `hooks`, `api/get/post`, `table()`, `panel()`, `modal()`, `confirmAction()`), `cmd/buildtool` (packaging).

**Backend conventions.**
- Routes: `internal/server/routes_core.go` `dispatch()` is a `switch` on method + route; other files add handlers with `registerRoutes(func(b *Backend, q *request) (any, int, bool, error))` from an `init()` (see `argocd.go:386`). Handlers return `(value, status, error)`; errors are `problem(msg, status)` / `bad(msg)` from `validate.go`. Validate every input with the helpers there (`validateName`, `validateNamespace`, `validateResource`, `validateText`, `integer`, `contextArgs`, `namespaceArgs`).
- Cluster reads go through `access.go`: `b.listObjects`, `b.getObject`, `b.rawGet`, `b.liveRequest` (prefer the live layer, kubectl fallback only when the proxy cannot start). Writes stay on kubectl: `b.kube(ctx, args, RunOptions{...})` — never a shell, args validated.
- Secrets: list payloads are sanitized (`internal/live/sanitize.go`, `redactSecret`); never return Secret values from a list/search/watch.
- Child processes: `b.spawnChild` (`forwards.go:48`) with `childHooks`, testable through `fwdState.spawn` / the fake spawner in `terminal_test.go`.
- Preferences: `prefs.go` `writePreferences` validates known keys — add validation for any new key you store there.
- Tests: `go test ./...` (`-tags desktop` on Windows/macOS). HTTP tests use `newFixture(t, handler)` in `server_test.go` (a fake kubectl runner keyed on args; no live layer, so the kubectl fallback paths run) and `f.do(method, route, body, headers)`. Watch/live tests use `internal/live/livetest`.

**UI conventions.**
- Pages are functions in `app.js` chosen in `render()` by `tab.section`; add a `case` there and a `leaf(...)` in `NAV` or a rail button in `index.html`. Views subscribe to data with `liveList({ resource, context, namespace, signal, onData, onStatus, onError })` (one shared feed per context+namespace+resource, backed by `/api/watch`). Page-scoped work uses `state.pageAbort.signal`; context-scoped work uses `state.contextAbort.signal`.
- Tabs: each tab is `{ id, context, namespace, section, resource, title, trail }` (`app.js` top: `activeTab`, `homeTab`, `openView`, `activateTab`, `closeTab`, `saveTabs`). Cross-cluster features must read a tab's `context`, not only `state.context`.
- Details drawer: `showResource(item, resource, { tab })`; row actions in `ops.js` `rowMenu`; dock sessions (logs, terminals) in `dock.js` (`openLogs(target)`, `openTerminal(target)`).
- Colours only from CSS tokens in `style.css` (both themes). Icons: `icon(name)` in `app.js` (`ICONS` map) and `clusterIcon()` for clusters.
- Pure logic goes in its own module with a `node --test` file (`ui/*.test.mjs`, run with `npm run test:ui`); DOM code is covered by the smoke test only.

**Project rules (unchanged).** No animations or transitions. No confirmation dialogs except the production guard (`confirmAction(message, name, { destructive: true })` in `kit.js`; it prompts only on clusters tagged production and only when `destructive` is set — the editors today call it without that flag, so they never prompt). The renderer never reaches the internet. kubectl/helm run without a shell with validated arguments. Secret values never appear in list/watch payloads.

**Verify every feature with:** `go vet ./... && go test ./...`, `npm run lint`, `npm run test:ui`, then a packaged smoke run: `go run ./cmd/buildtool package --os windows` and, on Windows, `Expand-Archive` the zip and run `Rubban.exe --smoke-test` with `RUBBAN_DATA_DIR`, `RUBBAN_SMOKE_DIR` and `RUBBAN_DISABLE_UPDATES=1` set; `desktop-smoke.json` must have `rendererErrors: []` (the first run after extracting can time out while WebView2 creates its profile — run it twice before concluding). On this machine Go lives in WSL (`/usr/local/go`), Node only on Windows in `C:\Users\Hossam Haggag\Rubban-verify` (`npm.cmd`, see `PLAN.md` §D for the PowerShell incantations); the owner's kubeconfig has three production GKE clusters — never run mutating actions against them.

**Per feature:** one commit; a bullet under a new `## 0.13.0` section in `CHANGELOG.md`; README §4 (usage) and §6 (permissions) updated where they apply; tests listed in the section added and passing.

**Order:** 2 → 6 → 9 → 4 → 3 → 1 → 5 → 7. Feature 7 reuses the diff renderer from feature 4; feature 1 and 3 reuse the per-tab contexts from the tab work already landed. Numbers below keep the numbering of the original list (8 and 10 are intentionally absent).

---

## 2. Credential health and re-auth (S)

**Goal.** When a context's credentials are expired or its exec plugin fails, say so where the user looks (tab, cluster selector, a banner in the page) and offer the one command that fixes it, run inside Rubban's terminal dock. Today the first symptom is "discovery unavailable" and a toast with `gke-gcloud-auth-plugin.exe failed with exit code 1`.

**Backend.**
- New `internal/server/credentials.go`:
  - `classifyAuthFailure(message string) (authFailure, bool)` — regex table over error text: `exec: executable (\S+) failed`, `getting credentials`, `Unauthorized`, `the server has asked for the client to provide credentials`, `invalid_grant`, `Reauthentication (is )?required|RefreshError` (gcloud), `AADSTS|az login` (Azure), `ExpiredToken|SSO session|aws sso login` (AWS), `oidc`. Result: `{Kind: "exec-plugin"|"unauthorized", Plugin: "gke-gcloud-auth-plugin"|"kubelogin"|"aws"|"aws-iam-authenticator"|"oidc-login"|"", Message}`.
  - Per-context state on `Backend`: `authState map[string]authStatus{Status: "ok"|"expired"|"unknown", Message, Plugin, Since time.Time}` behind a mutex; `b.noteAuthFailure(context, err)` and `b.clearAuth(context)`.
  - Hook points: `access.go` `liveProblem` (live errors with `KubeStatus == 401` or `ProxyUnavailable` whose message classifies), `ws_watch.go` where an `error` message is sent, and `runner.go` when a kubectl run exits non-zero and its stderr classifies. On classification also set `Problem.Code = "credentials"` — add `Code string \`json:"code,omitempty"\`` and `Plugin` to `Problem` in `validate.go` so the JSON error carries it; in watch `error` messages add the same fields.
  - `GET /api/contexts` adds per context `"auth": {"status","message","plugin","remedy"}`. `remedy` comes from the context's user in `kubectl config view -o json` (`users[].user.exec.command`, `.args`, `.env`; exec config is shown, tokens are not): `gke-gcloud-auth-plugin` → `{"preset":"gcloud-login","label":"gcloud auth login"}`; `kubelogin`/`az` → `az-login`; `aws`/`aws-iam-authenticator` → `aws-sso-login` with `profile` taken from the exec `env` `AWS_PROFILE` (validate `^[A-Za-z0-9_.-]{1,64}$`); anything else → `{"preset":"","label":"Sign in with your identity provider, then retry"}`.
  - `POST /api/contexts/recheck {context}` → `b.clearAuth`, invalidate the live pool entry for that context (today only `Lease.Invalidate()` and the private `Pool.invalidate` exist in `internal/live/pool.go`; add `Live.Invalidate(context)` that drops the entry and stops its proxy), return `{ok:true}`.
  - Terminal presets: `terminal.go` `planTerminal` accepts `run=<preset>` only from an allowlist map `preset → argv` (`gcloud-login` → `["gcloud","auth","login"]`, `az-login` → `["az","login"]`, `aws-sso-login` → `["aws","sso","login","--profile",<profile>]`, profile read from the server-side remedy, not from the client). `mode = "local"`, the command replaces the shell, env as for a local shell of that context. Reject any other `run` value with 400.
- Tests (`credentials_test.go`, `terminal_test.go`, `server_test.go`): classification table; `/api/contexts` shows `auth.status = "expired"` after the fake runner returns exit 1 with gke stderr for a `get`; remedy mapping from an exec config; recheck clears it; `run=` unknown preset → 400; `aws-sso-login` profile validation.

**UI.**
- New `ui/credentials.js`: `statusOf(context)` from the last `/api/contexts` payload plus live updates; `hooks.authProblem(context, problem)` called from `liveList`'s `onError` path in `app.js` (`openFeed` `fail`) and from `api()` in `kit.js` when a response has `code === "credentials"` (the request's context comes from the body/query — pass it through `api()` options as `options.context` where known, otherwise `state.context`).
- Banner at the top of `#main` (`.auth-banner`, both themes) when the active tab's context is expired: "Credentials for *Tracking · prod* expired — gke-gcloud-auth-plugin. [Sign in again] [Dismiss]". *Sign in again* → `hooks.openTerminal({ context, run: remedy.preset, title: 'Sign in · ' + label })`; `dock.js` passes `run` in the socket query. When the session reports `exit` with code 0 → `post('/api/contexts/recheck', {context})`, then `selectContext(context, { namespace: state.namespace, fromTab: true })` so feeds reconnect. Exit non-zero → status line "Sign-in failed; try again".
- Indicators: `renderTabs` adds class `auth-expired` to `.tab-cluster` (amber ring, tooltip with the message); the switcher row and the hotbar button show the same ring (`clusterui.js` `row()` and `renderCluster()`); the welcome list shows "credentials expired" as a badge.
- Settings › Prerequisites: a line per context with auth status and the remedy label.
- Tests: `ui/credentials.test.mjs` for the pure helpers (banner text, which contexts need attention).

**Acceptance.** With an expired gcloud token: tab mark and banner appear within one failed request; *Sign in again* opens the dock running `gcloud auth login`; after the browser login completes, lists reload without pressing anything else. A context without exec plugin shows the generic remedy and no button.

---

## 6. Persistent, self-healing port forwards (S)

**Goal.** Forwards created from the Port Forwarding page or a row menu survive kubectl dying ("lost connection to pod") and Rubban restarts, keeping their local port.

**Backend** (`internal/server/forwards.go`).
- Persist user forwards: `<dataDir>/forwards.json` `[{id, context, namespace, resource, name, localPort, remotePort}]`, written with `writeFileAtomic` (`prefs.go`) on create, stop and when a `localPort: 0` forward learns its port (so the restart reuses it). Console forwards (`fwdConsole`) are not persisted.
- `fwdState.restore()` called from `Backend.Start` after tools resolve: start each saved forward with its saved `localPort`; if the port is busy → status `error`, `lastError: "local port 5432 is in use"`, still listed so the user can change it.
- Auto-restart: in `exited()` (status not `stopped`): schedule `restart(f)` with backoff 1, 2, 4 … 30 s; reset the backoff after 60 s of `ready`; give up after 10 consecutive failures → status `error` with the last stderr line. Reuse `ready()` and share the restart with console consumers (`fwdRestart`). Fields on `fwdView`: `restarts int`, `lastError string`, `keep bool` (true for user forwards), `startedAt`.
- `POST /api/forwards/{id}/restart` → immediate restart (clears the failure count). `DELETE` keeps its meaning (stop and forget).
- Tests (`forwards_test.go`, fake spawner): child exits 1 → respawned with the same args and port, `restarts == 1`; ten failures → `error`; `restore()` starts what `forwards.json` lists and `DELETE` removes it from the file; console forwards are never written.

**UI** (`app.js` `forwardsPage`, `ops.js` `forwardDialog`).
- Columns: Status (`ready · restarted 2×` / `error: …` with a *Restart* button), Local → Remote, cluster (icon + label, since forwards span clusters), Open in browser, Stop. Footer note: "Forwards are restored when Rubban starts."
- Sidebar: the Port Forwarding entry (`NAV` leaf with section `forwards`; there is no rail button for it) shows a count badge of active forwards (same style as the updates dot), updated from `/api/forwards` every 15 s while any exist (a small poller in a new `ui/forwards.js` module so the badge works on every page).
- Tests: none beyond Go; keep the page DOM-only.

**Acceptance.** Create a forward to a pod, delete the pod: the forward turns `error`, then `ready` again on the new pod with the same local port. Quit and relaunch Rubban: the forward is back.

---

## 9. RBAC "Can I?" per cluster (S)

**Goal.** Turn README §6 into a live check so an empty Helm page or a 403 becomes "you lack `get secrets` in `monitoring`".

**Backend.**
- `internal/server/access_check.go`: a fixed table `accessChecks []accessCheck{ID, Feature, Verb, Resource, Subresource, Group, Scope: "namespace"|"cluster", Namespace override}` mirroring README §6: browse (`list`+`watch` pods, deployments, services, events, nodes), details (`get` pods), logs (`get` pods/log), exec (`create` pods/exec), attach, port-forward (`create` pods/portforward), secrets (`get` secrets), metrics (`list` pods.metrics.k8s.io, nodes.metrics.k8s.io), kubelet summary (`get` nodes/proxy), Prometheus (`get` services/proxy in the configured Prometheus namespace, from `prometheusByContext`), edit (`patch` deployments), scale (`patch` deployments/scale), delete (`delete` pods), node shell (`create` pods in `kube-system`), Helm (`list` secrets — release storage), Argo CD (`get`, `patch`, `delete` applications.argoproj.io in `argocd`; only when discovery has the group), CRDs (`list` customresourcedefinitions).
- `POST /api/access/check {context, namespace}` → for each check a `SelfSubjectAccessReview` via `b.liveRequest(ctx, context, "POST", "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews", body, ...)`, 8 in parallel, 10 s overall timeout; kubectl fallback `auth can-i <verb> <resource>[/<sub>] [-n ns]` with `AllowExit: {0,1}` (1 = denied). Also `POST /apis/authentication.k8s.io/v1/selfsubjectreviews` for the identity (`status.userInfo.username`, groups), optional on failure. Response `{user, groups, checks: [{id, feature, verb, resource, namespace, allowed, reason}]}`. Cache per context+namespace for 5 minutes; `refresh: true` bypasses.
- Tests: fake runner answers `auth can-i` with `yes`/`no` → allowed flags and args assertions; table has no duplicate IDs; Argo check skipped when the group is absent.

**UI.**
- Settings › new panel `Access · <cluster>` (above Metrics): identity line, table Feature / Permission / Result (`✓`/`✗` with the reason in a tooltip), namespace selector (defaults to the current one), *Re-check* and *Copy as text* (for sending to an admin).
- `displayError` (`kit.js`) adds a *Check my access* link when `error.status === 403`, opening Settings scrolled to the panel (`openView('settings')` then `document.querySelector('#access-panel')?.scrollIntoView()`).
- Clusters page row: a small *Access* link that opens the same panel for that cluster (sets the tab's context first).
- README §6: add "Settings › Access checks these for you."

**Acceptance.** On a cluster with a read-only kubeconfig the panel shows ✗ on edit/scale/delete and the Helm row explains the empty Helm page.

---

## 4. Apply with diff and server-side dry-run (M)

**Goal.** No YAML reaches a cluster without the user seeing the exact change and the admission result. Today *Preview diff* is optional and *Apply* is one click (plus the production guard).

**Backend** (`routes_core.go` `routeDiffApply`).
- `POST /api/apply/preview {context, namespace, yaml}` → runs in sequence: `kubectl diff --field-manager=rubban --filename=-` (`AllowExit {0,1}`; exit 1 = changes) and `kubectl apply --dry-run=server --field-manager=rubban -o json --filename=-`. Response `{diff, changed, objects: [{kind, namespace, name, created: bool}], warnings: [...], error}` — `warnings` are stderr lines starting with `Warning:`; a dry-run failure (admission webhook, schema) is returned as `error` with status 200 so the UI can show it inline, not as a toast. Multi-document YAML is allowed (same as today). `created` = the object is absent in the diff's left side.
- `POST /api/apply` gains `--field-manager=rubban`, and requires `previewHash` (SHA-256 of the YAML the preview saw, returned by the preview) — mismatch → 409 "The manifest changed since the preview". `--force-conflicts` is never passed; a server-side-apply conflict is shown verbatim.
- Tests: preview builds both commands with the right flags, parses warnings, `changed` from exit code, dry-run error surfaced in the body; apply refuses a stale hash.

**UI.**
- New `ui/diff.js` (pure, tested): `parseUnified(text)` → hunks/lines with `kind: 'add'|'del'|'ctx'|'meta'`; `renderUnified(lines)` → DOM with `.diff-add` / `.diff-del` classes (token colours added to `style.css` for both themes).
- Both editors (`app.js` ~1081 Create and ~1185 YAML tab) switch to a two-step bar: **Review** → shows the coloured diff, the list of objects (`Deployment api (update)`, `ConfigMap x (create)`), warnings in an amber callout, dry-run errors in a red one; **Apply 3 changes** is enabled only after a successful preview and disabled again on any editor input (compare the hash). "No changes" → Apply stays disabled. Production guard unchanged (`confirmAction`).
- The YAML tab's *Preview diff* button is removed (Review replaces it).
- Tests: `ui/diff.test.mjs` for `parseUnified`.

**Acceptance.** Editing a Deployment's image shows one red and one green line and `Deployment api (update)`; an invalid field shows the server's validation error without applying; editing after Review disables Apply until Review runs again.

---

## 3. Global search across open clusters (M)

**Goal.** Ctrl+K finds *resources* by name in every cluster that has a tab open, not only views.

**Backend.**
- `GET /api/search?context=&q=&limit=` (q 2–64 chars, `validateText`; limit ≤ 50). Kinds searched, in this order: pods, deployments, statefulsets, daemonsets, jobs, cronjobs, services, ingresses, configmaps, secrets (names only — `redactSecret`), persistentvolumeclaims, namespaces, nodes, plus `applications.argoproj.io` when discovery has the group. Lists come from `b.listObjects` in parallel (bounded 6) over all namespaces; a per-context memo of each kind's name index for 20 s (`sync.Map` of `{at, entries}`) keeps keystrokes cheap on large clusters — if `internal/live` already holds a watch for that kind, add `Live.CachedItems(context, resource, namespace) (items, ok)` and use it instead of a LIST.
- Matching on `metadata.name` and the labels `app`, `app.kubernetes.io/name`: rank prefix > word-boundary > substring, then shorter names first; return `{results: [{resource, kind, namespace, name, labels(app only), status: short text (pod phase / ready replicas)}]}` capped at `limit`, plus `{truncated: true}` when more matched.
- Tests: ranking, limit/truncation, secrets have only names, Argo kind only when discovered; input validation.

**UI** (`app.js` `commandResults`).
- After the view matches, when `query.length >= 2`: a "Resources" group. The palette issues one `/api/search` per **open tab context** (`new Set(state.tabs.map(t => t.context))`), debounced 250 ms, aborting the previous round; results are grouped by cluster (icon + label as a group heading) then kind, with the namespace in small text. A spinner row per cluster while pending; a per-cluster error row (e.g. credentials expired → the feature-2 remedy link).
- Enter / click: if the result's context is not the current tab's, `selectContext(context)` moves the current tab there (same as the switcher), then `showResource({ metadata: { name, namespace }, kind }, resource)` (it fetches the full object). Ctrl+Enter opens it in a new tab (`newClusterTab` then show).
- Keyboard navigation already exists (`#command-results button`); keep headings non-focusable.
- Tests: `ui/search-rank.test.mjs` if any ranking happens client-side (it should not — the server ranks; the client only groups).

**Acceptance.** With prod and staging tabs open, typing `payments` shows the deployment and pods in both clusters under their cluster headings within ~300 ms on a 2 000-pod cluster; Enter opens the details drawer in the right cluster.

---

## 1. Problems inbox across clusters (M)

**Goal.** One page listing what is wrong in every open cluster, with a count on the rail, so Rubban is worth keeping open.

**Rules** — new `ui/problems-rules.js` (pure, unit-tested; input: items from the existing feeds, output: `{id, context, resource, namespace, name, severity: 'critical'|'warning'|'info', title, detail, since}`; `id = context|resource|namespace|name|rule`):
- Pods: container waiting reason `CrashLoopBackOff`, `ImagePullBackOff`, `ErrImagePull`, `CreateContainerConfigError`, `InvalidImageName` (critical); last termination `OOMKilled` within 1 h (warning); `restartCount ≥ 5` with `lastState.terminated.finishedAt` within 1 h (warning); phase `Pending` for > 5 min, with `PodScheduled=False/Unschedulable` → critical "Unschedulable: <message>", otherwise warning; `Running` with `Ready=False` for > 5 min (warning); `Failed` phase for non-Job pods (warning); `Evicted` (info).
- Workloads: Deployment/StatefulSet/DaemonSet with `availableReplicas < spec.replicas` for > 5 min, or condition `Progressing=False` with `ProgressDeadlineExceeded` (critical); Job with condition `Failed=True` (warning); CronJob whose last schedule is older than 2× its schedule interval — skip (needs cron parsing); PVC `Pending` > 5 min (warning).
- Nodes: `Ready≠True` (critical); `MemoryPressure`/`DiskPressure`/`PIDPressure=True` (critical); `spec.unschedulable` (info "cordoned").
- Argo CD (only when the CRD exists in `state.crds` / discovery): `status.sync.status == OutOfSync` (warning), `status.health.status in {Degraded, Missing}` (critical), `Unknown` (info).
- Time-based rules re-evaluate every 30 s (a timer, like `tickAges`).

**Data** — new `ui/problems.js`: for every distinct context among open tabs keep one `AbortController` and subscribe with `liveList` to pods, deployments, statefulsets, daemonsets, jobs, persistentvolumeclaims, nodes and, when present, `applications.argoproj.io`, all namespaces. Subscribe when a tab for the context appears, drop when its last tab closes (hook into `renderTabs`/`closeTab` via a `hooks.tabsChanged()` callback). Keep a `Map<context, problems[]>`; recompute on each `onData` (debounced 200 ms) and on the 30 s tick; feed errors become one `info` problem "Cluster not reachable: …" (links to feature 2 when `code === 'credentials'`). Snoozed ids (`rubban.problems.snoozed`, `localStorage`, 1 h) are filtered out. Large clusters: the pods feed is already what the Pods view opens; accept the cost, but open it lazily — only after the first `render()` of a tab on that context.

**UI.**
- Rail button *Problems* (`index.html` rail, icon `alert`: add to `ICONS`) with a badge: red with the critical count, amber with the warning count, hidden at zero. Section `problems` added to `globalPages` in `render()` (spans clusters).
- Page: filters (severity chips, cluster select, namespace text, "only this tab's cluster" toggle), then rows grouped by cluster (icon + label): severity dot, kind/name, namespace, title, detail (muted), since (age), actions: *Open* (switch the current tab to that context if needed, then `showResource`), *Logs* for pods (`logsFor`), *Snooze 1 h*. Row click = Open. Empty state: "Nothing to report in 2 clusters".
- Tabs: the cluster mark on each tab gets a small red/amber dot when that context has critical/warning problems (tooltip with the count) — `renderTabs` asks `problems.countsFor(context)`.
- Tests: `ui/problems-rules.test.mjs` with fixture objects for each rule, the time thresholds (inject `now`), and id stability.

**Acceptance.** A pod in CrashLoopBackOff in staging shows within 2 s on the rail badge while the prod tab is active; Open lands on that pod's details in the staging cluster; snoozing removes it for an hour; closing the staging tab removes staging's problems.

---

## 5. Multi-pod log tail with filters (M)

**Goal.** Tail every pod of a workload at once, colour-coded per pod, with include/exclude filters and pause — the `stern` experience inside the dock. Selector mode exists today (`kubectl logs -l … --prefix`), but new pods are not picked up and lines are not distinguishable.

**Backend** (`ws_logs.go`).
- Selector mode becomes a `multiLogSession`: list pods by selector (`b.listObjects`), start one `kubectl logs --follow --tail=N [--container=c|--all-containers] <pod>` per pod (bounded by `maxRequests`, default 20) through `b.spawnChild`, prefix each line with `[pod/container] `, and every 10 s (or via `Live.Watch` on pods with the selector when the live layer is up) start readers for new pods and stop readers of deleted ones. Per-pod readers restart once on exit while the pod is still Running (container restarts).
- Control messages go to the client as **binary** WebSocket frames (unambiguous against JSON log lines): `{"type":"pods","items":[{"pod","containers":[...],"phase"}]}` on every change and `{"type":"reader","pod","container","state":"started"|"ended","code"}`. Text frames stay raw log text.
- Keep the single-pod path unchanged.
- Tests: `ws_logs_test.go` with a fake spawner: two pods → two readers with the right args and prefixes; a pod appearing in the next poll gets a reader; a deleted pod's reader is killed; the binary control frame is sent.

**UI** (`dock.js` `openLogs`, new `ui/logs-util.js` for pure helpers).
- Keep the single text node (the search highlighter depends on it). Pod colouring uses the CSS Highlight API: `logs-util.podOf(line)` parses the `[pod/container] ` prefix; maintain one `Highlight` per pod (`rubban-pod-0` … `rubban-pod-7`, colours from tokens `--log-pod-0…7` in both themes) with ranges added incrementally on `append`. Legend chips in the toolbar (pod name in its colour; click = toggle that pod's lines).
- Filters: *Include* and *Exclude* inputs (plain text or `/regex/`), applied at render time over a kept raw buffer (`lines[]`, capped at the existing 4 MB budget): changing a filter re-renders the text node from the buffer; `append` only shows lines that pass. *Pause* button: keep buffering, stop rendering; resuming renders the backlog.
- Binary frames: parse `pods` to refresh the legend and the container select; `reader` to show "waiting for pods…" / "3 pods" in the status line.
- Entry points unchanged (`ops.js` `logsFor` with `workloadSelector`); add *Logs (all pods)* to the Workloads overview rows if missing.
- Tests: `ui/logs-util.test.mjs` — prefix parsing, include/exclude with text and regex, pod colour assignment stability.

**Acceptance.** Logs of a 3-replica Deployment show three colours; scaling to 4 adds the fourth pod's lines without reopening; `exclude: healthz` drops the probe lines; Pause holds the view and Resume catches up.

---

## 7. Compare across clusters (M)

**Goal.** With prod and staging open, answer "what differs?" for one resource: side-by-side YAML with noise removed.

**Backend.**
- `POST /api/compare {left: {context, namespace, resource, name}, right: {…}}` → `b.getObject` on both (secrets refused with 400: compare key names only via a `keys` mode later, not now), normalise with `normalizeForCompare(obj)`: drop `metadata.managedFields`, `uid`, `resourceVersion`, `creationTimestamp`, `generation`, `selfLink`, `status`, the annotations `kubectl.kubernetes.io/last-applied-configuration`, `deployment.kubernetes.io/revision`, `autoscaling.alpha.kubernetes.io/*`; `includeStatus: true` keeps `status`. Encode as YAML with sorted keys: `json.Marshal` of the normalised `map[string]any` sorts keys, then `objectYAML(raw)` in `yamlutil.go` turns it into YAML. Response `{left: yaml, right: yaml, leftMeta: {context, namespace, name}, rightMeta: {…}}`. Both reads in parallel; either failure is reported for its side.
- Tests: normalisation drops exactly that list and keeps everything else; sorted output is stable.

**UI.**
- `ui/diff.js` (from feature 4) gains `lineDiff(a, b)` (Myers or LCS on lines) and `renderSideBySide(a, b)` → two aligned columns with `.diff-add` / `.diff-del` / `.diff-gap` rows, each column headed by the cluster icon + label + namespace.
- Entry: details drawer action bar (`details.js` `detailActions`) → *Compare…* → `modal` with: cluster (open tab contexts first, then every context), namespace (defaults to the same name), name (defaults to the same). Opens a view tab `section: 'compare'` (title `Compare · <name>`, cluster = the current one) rendered by a new `comparePage()` in `app.js`: toolbar with *Hide unchanged*, *Include status*, *Swap sides*, *Copy diff*; a summary line "12 lines differ · image, replicas, env" (top-level keys that differ).
- Tests: `ui/diff.test.mjs` — `lineDiff` on small cases (insert, delete, move), `renderSideBySide` alignment counts.

**Acceptance.** Compare `deployment/api` prod vs staging: image tags and replica counts are highlighted, `status` and `managedFields` do not appear, *Hide unchanged* collapses the rest; swapping sides flips colours.

---

## Hand-off checklist (per feature)

- [ ] Go: new code has table tests; `go vet ./... && go test ./...` clean (run `-tags desktop` on Windows/macOS too).
- [ ] UI: pure logic in its own module with a `node --test` file; `npm run lint` and `npm run test:ui` clean.
- [ ] Packaged smoke run passes (`rendererErrors: []`).
- [ ] `CHANGELOG.md` `## 0.13.0` bullet, README §4/§6 updated, no new confirmation dialogs, no animations, no colours outside `style.css` tokens, no Secret values in any new payload.
- [ ] Commit message explains the why; one feature per commit.
