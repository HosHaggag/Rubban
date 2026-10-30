# Rubban 1.0 plan

Implementation plan for the next model working on this repository. It covers nine requests from the owner, in the order they should be built. Read `README.md` and `HANDOFF.md` first; this file takes precedence where they disagree.

Project rules that still apply to every workstream (from `HANDOFF.md`):

- No animations or transitions anywhere (`ui/style.css` line 22 forces `animation:none; transition:none`).
- No confirmation dialogs for actions (`confirmAction` in `ui/kit.js` resolves immediately). Workstream 3 adds one deliberate exception, described there.
- Secret values never appear in list/watch payloads. kubectl and helm run without a shell with validated arguments.
- The backend listens on `127.0.0.1` only, behind the token in `<meta name="rubban-token">`; the renderer's CSP (`ui/index.html` line 6) allows `connect-src 'self'` only, so **the renderer cannot reach the internet**. Anything that talks to GitHub must run in the Electron main process (`desktop/main.cjs`) or the backend (`server/`).
- Tests are plain `node --test` (`npm test`). Backend tests inject a fake runner (`makeRunner` in `server/core.test.cjs`); UI tests import pure modules (`ui/views.test.mjs`). Add tests in the same style for every workstream.
- Code style: dense, long lines, few comments, `const` arrow helpers, `el()`/`button()`/`panel()` from `ui/kit.js` for DOM. Match it.

Validation at the end of every workstream: `npm test`, `npm start` on Windows (see "Running on Windows" at the end), and the acceptance list of that workstream.

---

## Order of work

| # | Workstream | Depends on |
|---|---|---|
| 0 | Repository hygiene and production-readiness fixes — **done 2026-10-30** (see 0.3 for what is still open) | – |
| 1 | Remove every trace of the earlier product names — **done 2026-10-30** | – |
| 2 | Light theme, default = system preference | – |
| 3 | Cluster switcher: icons, names, kubeconfig import | – |
| 4 | Onboarding tour | 2, 3 (the tour points at the new switcher and theme setting) |
| 5 | CI pipeline and GitHub Releases for Windows and macOS | 0, 1 |
| 6 | In-app updater (update icon, download, silent install, relaunch) | 5 (asset names and checksum file) |

Workstreams 1–3 are independent of each other and can be done in parallel by separate agents if the orchestrator wants; 4, 5 and 6 come after.

---

## 0. Repository hygiene and production readiness

### 0.1 Assessment (why it is not production-ready yet)

What is already good: a real security model (loopback + token + Host/Origin checks, secret redaction, argument validation, sandboxed renderer with CSP), a tiny dependency surface (5 runtime deps), windowed tables that handle thousands of rows, 75 passing unit tests, and working Windows/macOS packaging scripts.

What blocks "production" today:

1. **No CI, no releases, no updater, no code signing.** Users get a zip, a SmartScreen warning and no way to learn about new versions. Workstreams 5 and 6 fix the first three; signing is a paid certificate decision for the owner (see 5.6).
2. **Internal AI-session documents are in the repo.** `HANDOFF.md` and `FEATURE-PARITY.md` are working notes. They mention sandboxes, "Codex", an unpacked Lens ASAR and unfinished acceptance runs. They must not ship in a public repository or in the release zip (`scripts/package-*.cjs` copies `README.md` only, but `prepare-stage.cjs` copies every root file, so they end up inside `resources/app`).
3. **Dead backend surface.** The UI no longer has Team, Extensions, Cloud, Flux, Security or Cost pages, but `server/extras.cjs` still serves cloud import (`aws eks update-kubeconfig`, `gcloud`, `az`), extensions loading from `<dataDir>/extensions`, OpenCost and the AI CLI runner, and `services/team-hub.cjs` + `services/agent.cjs` still exist. Every unused endpoint is attack surface and documentation debt.
4. **Unverified claims.** `HANDOFF.md` lists acceptance work that was never done: the actions suite against a real cluster, Windows ConPTY sessions, a physical macOS launch. The owner has now launched the app on Windows and connected to real GKE clusters, which closes part of this; the rest stays open.
5. **Maintainability.** `ui/app.js` is 131 KB in 1,338 lines with lines up to 917 characters; `server/core.cjs` is 67 KB. There is no linter, no formatter, no type checking. Keep the style, but add `eslint` (flat config, `recommended` only, no style rules) so CI catches undefined variables and unused code.
6. **Two lockfiles.** `package-lock.json` and `pnpm-lock.yaml` + `pnpm-workspace.yaml` both exist. The README and scripts use npm. Delete the pnpm files.
7. **Owner-specific paths in docs.** README 5 says the repository lives at `~/rased/repos/devops/rubban`. Replace with generic wording.
8. **No log file.** Errors go to the console only. Users of a packaged app cannot report anything. Write the main-process and backend logs to `<dataDir>/logs/rubban.log` (rotate at 5 MB, keep 3) and add "Open log folder" to the Help menu and Settings.
9. **No crash isolation for the backend.** If `backend.start()` throws, `fatal()` shows a dialog and exits. Fine. But runtime errors in route handlers are caught per request; uncaught exceptions in the main process are not. Add `process.on('uncaughtException'|'unhandledRejection')` handlers in `desktop/main.cjs` that log and show one dialog.
10. **Destructive actions on production clusters have no guard.** The owner asked for no confirmation windows, and three of their four contexts are production. Workstream 3 adds per-cluster metadata including an environment tag; use it: when a cluster is tagged `production`, destructive actions (delete, bulk delete, drain, evict, scale to 0, Helm uninstall, Argo CD delete) require typing the resource name once. This is the only confirmation in the app and it is opt-in by tagging. Document it.
11. **Electron and dependency currency.** Pin and update `electron` (44.9.1 now) on each release; add Dependabot (`.github/dependabot.yml`, npm, weekly).

Verdict for the owner: *solid weekend project with unusually good security hygiene; not production until 0, 1, 5 and 6 are done and the dead code is gone.* Items 2, 3, 6, 7 are required before making the repository public.

### 0.2 Steps

1. Delete `HANDOFF.md`, `FEATURE-PARITY.md`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`. Move anything still useful from `FEATURE-PARITY.md` (what each view shows, which permissions are needed) into `README.md` §6 or a new `docs/FEATURES.md` **without** any reference to other products.
2. Remove dead backend features. In `server/extras.cjs` delete the cloud import, extensions, OpenCost/cost, team and integration handlers and their routes; keep the AI CLI runner only if the AI page stays (it does: `ui/app.js` `aiPage()`, rail button `data-section="ai"`). Delete `services/team-hub.cjs`, `services/agent.cjs`, their tests in `services/services.test.cjs`, the `team` and `agent` scripts in `package.json`, and their sections in `services/README.md` and `README.md` §9. Keep `services/mcp.cjs`. Delete `costPage`, `integrationPage` and the `opencostUrl` field in `settingsPage()` in `ui/app.js`, and `/api/cost` tests in `server/extras.test.cjs`.
3. Add `eslint` 9 as a devDependency with `eslint.config.js` (`@eslint/js` recommended, globals for browser in `ui/`, node in the rest, `.cjs` as commonjs). Add `"lint": "eslint ."` and run it in CI. Fix only real errors it reports; do not reformat.
4. Logging: new `server/log.cjs` exporting `createLogger(dir)` with `info/warn/error`, writing JSON lines to `<dataDir>/logs/rubban.log` with size rotation. Use it from `desktop/main.cjs` (`fatal`, window `console-message` errors, update events) and `server/core.cjs` (request errors with status ≥ 500, kubectl spawn failures). Add `Help › Open log folder` (`shell.openPath`) in `desktop/main.cjs` and a button in Settings › About.
5. `desktop/main.cjs`: add `process.on('uncaughtException')` / `process.on('unhandledRejection')` → log, one `dialog.showErrorBox`, do not exit if the window is alive.
6. `.github/dependabot.yml` for npm, weekly.
7. `README.md`: generic build path; remove references to any other product by name (see workstream 1 and the legal note); add "Logs" row to §7 and §8.
8. Update `CHANGELOG.md` with a `0.11.0` section listing these removals.

Acceptance: `npm test` passes, `npm run lint` passes, `grep -rn -iE "codex|sandbox|asar|parity" --exclude-dir=node_modules --exclude-dir=.git .` returns nothing outside `CHANGELOG.md`, the release zip's `resources/app` contains no `HANDOFF.md`/`FEATURE-PARITY.md`.

### 0.3 Status after the first pass (2026-10-30)

Steps 1–8 were applied (see the `0.11.0` section of `CHANGELOG.md`). Still open from this workstream:

- `npm run lint` reports 19 pre-existing errors (unused variables in `ui/app.js`, `ui/details.js`, `server/live.test.cjs`, `scripts/*`; `no-control-regex` in `services/mcp.cjs` and `ui/details.js`; `no-empty` in `server/start.cjs`; `no-useless-escape` in `ui/format.js`). Fix each one properly (remove the unused binding, add `// eslint-disable-next-line no-control-regex` only where the control characters are intentional, give the empty catch a comment) — do not relax the config.
- `server/core.test.cjs` "independent preferences are persisted atomically…" sometimes fails on Windows with `ENOTEMPTY` while removing the fixture's temp `data` directory. Make the fixture's cleanup retry (`fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })`).
- Workstream 5 must run `npm ci` in CI; the lockfile must be regenerated whenever `package.json` changes.

---

## 1. Remove the earlier product names for good

Done. Compatibility code, installer clean-up, documentation and the licence holder were rewritten so that only "Rubban" remains. Note for the owner: the repository's initial commit still contains the old files, so the names remain in git history; removing them from history would need a rewrite of `main` (`git filter-repo`) before the repository is made public, which is only worth doing if that matters to you.

Acceptance (already met): a case-insensitive grep for the two earlier names over the working tree (excluding `.git` and `node_modules`) prints nothing; `npm test` passes; `Install-Rubban.ps1` still installs over an existing Rubban install and keeps `resources\app\tools`.

---

## 2. Light theme with "System" as the default

### 2.1 Current state

- All colours are CSS custom properties on `:root` in `ui/style.css` lines 11–24, plus `color-scheme:dark`. Everything else uses `var(--…)`, with a few hard-coded hex values (`#0008`, `#000c` shadows on lines 283 and 315, `#4c5053` on line 132 — grep `#[0-9a-fA-F]{3,8}` outside `:root` and replace each with a token).
- The terminal palette is the constant `XTERM_THEME` in `ui/dock.js` line 9, applied when a `Terminal` is created (line 168).
- Chart colours live in `ui/charts.js` (grep `#` there).
- Electron sets `backgroundColor: '#1f2123'` in `desktop/main.cjs` line 60 (the colour shown before the page paints).
- Preferences are a JSON object round-tripped through `GET/PUT /api/preferences` (`server/core.cjs` lines 846–848, `readPreferences`/`writePreferences` lines 396–416). The settings page is `settingsPage()` in `ui/app.js` line 1221; `state.preferences` is loaded in `init()` line 1302.
- There is no inline script allowed (CSP `script-src 'self'`), so the theme must be applied from `ui/app.js` as early as possible.

### 2.2 Design

- Preference `theme`: `'system' | 'light' | 'dark'`, default `'system'`.
- CSS: keep the dark tokens as the `:root` default, add `:root[data-theme="light"] { … }` with a full light token set, and apply dark/light from the system when `data-theme` is absent or `"system"` via `@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { …light tokens… } }`. Put the light token block in a CSS custom property set once and reuse it in both places (duplicate the block; it is ~12 lines).
- Light palette (same roles as the dark tokens; chosen for the same contrast ratios): `--bg:#ffffff; --side:#f4f5f7; --panel:#ffffff; --panel-2:#f4f5f7; --raised:#f4f5f7; --well:#eceef1; --line:#d9dce1; --line-soft:#e6e8ec; --line-strong:#b8bdc6; --text:#2b2f36; --strong:#15181d; --cell:#363b43; --muted:#5d6570; --dim:#6b7380; --accent:#2f6f9a; --accent-soft:#2f6f9a14; --accent-line:#2f6f9a80; --accent-text:#245c82; --on-accent:#ffffff; --accent-hover:#2a6189; --good:#2f8f4e; --warn:#a9711a; --bad:#b4403a; --info:#245c82; --magenta:#8a4d8a; --teal:#2a7c70; --bad-text:#9d2f2a; --warn-text:#8c5a0e; --info-text:#1f4f70; --input:#ffffff; --button:#f4f5f7; --hover:#e9ebef; --selected:#e4ecf3; --nav-hover:#eef0f3; --track:#e4e6ea; --badge:#dfe2e7; --chip:#eceef1; color-scheme:light;`. Shadows: add `--shadow-drawer` and `--shadow-dialog` tokens (dark `#0008`/`#000c`, light `#0002`/`#0004`).
- JS: new `ui/theme.js` exporting `applyTheme(preference)`, `currentTheme()` (`'light' | 'dark'` after resolving `system` with `matchMedia('(prefers-color-scheme: dark)')`), `onThemeChange(listener)`. It sets `document.documentElement.dataset.theme` (`light`/`dark`; removes the attribute for `system`), caches the preference in `localStorage['rubban.theme']` so the first paint of the next launch is right before preferences arrive, and re-dispatches on `matchMedia` change while in `system`.
- `ui/app.js`: call `applyTheme(localStorage['rubban.theme'] || 'system')` at module top (before anything renders); after `state.preferences` loads in `init()`, call `applyTheme(state.preferences.theme || 'system')`. In `settingsPage()` add panel "Appearance" with a three-option control (System · Light · Dark) saved through the existing `save()` helper.
- `ui/dock.js`: turn `XTERM_THEME` into `xtermTheme(name)` returning dark or light palettes; on `onThemeChange`, set `terminal.options.theme` on every open terminal (keep a `Set` of terminals).
- `ui/charts.js`: read colours from `getComputedStyle(document.documentElement).getPropertyValue('--…')` at draw time instead of constants, and redraw open charts on theme change (charts are redrawn when the view renders; a `render()` on theme change is enough — call `refreshView()` from the listener).
- `desktop/main.cjs` + `desktop/preload.cjs`: expose `setTheme(preference)` over IPC `rubban:set-theme` → `nativeTheme.themeSource = preference` (Electron honours `'system' | 'light' | 'dark'`), and choose `backgroundColor` at window creation from `nativeTheme.shouldUseDarkColors` (`#1f2123` or `#ffffff`). Validate the sender like `rubban:open-external` does.
- The embedded RabbitMQ console and xterm CSS are unaffected.

### 2.3 Tests

- `ui/theme.test.mjs`: `resolve('system', prefersDark=true) === 'dark'`, `resolve('light', true) === 'light'`; the module must be importable in Node (guard `window`/`document` access inside functions, not at module top).
- `server/core.test.cjs`: `PUT /api/preferences` with `theme: 'light'` round-trips; unknown values are rejected with 400 (add a small allow-list validation in `writePreferences` for `theme`).

Acceptance: switching in Settings changes the whole UI, terminal and charts immediately; "System" follows a Windows/macOS theme change without restart; a fresh profile starts in the system theme with no dark flash on a light system; every surface in the light theme stays readable (check tables, drawer, dialogs, command palette, dock, badges, status bar, Argo CD cards, RabbitMQ page, logs viewer).

---

## 3. Cluster switcher: icons, names, kubeconfig import

### 3.1 Current state

- Contexts come from `GET /api/contexts` → `kubectl config view --output=json` (`server/core.cjs` lines 721–724). `kubectl` uses the default kubeconfig search (`KUBECONFIG` env or `~/.kube/config`). Every kubectl/helm invocation goes through `kube()`/`helm()` in `server/core.cjs` (find the spawn site: grep `execFile\|spawn(` in `server/core.cjs`, `server/live.cjs`, `server/actions.cjs`, `server/rabbitmq.cjs`, `server/extras.cjs`); scoped terminal kubeconfigs are made by `scopedKubeconfig()` line 970 with `kubectl config view --raw --minify --flatten --context=…`.
- README §7 and §10 promise "Rubban never writes to your kubeconfig". Keep that promise.
- UI: `<select id="context">` in the sidebar (`ui/index.html` line 18), a pin button and a hotbar `#context-favorites` rendered by `renderFavorites()` (`ui/app.js` line 1260) as 2-letter initials buttons; `selectContext(name)` line 363 is the single entry point for switching and keys everything on the **context name**; the welcome page `welcome()` line 408 lists contexts as rows. Preferences hold `favoriteContexts: string[]`.

### 3.2 Design

**Data model** (in `preferences.json`, validated in `writePreferences`):

```json
"clusters": {
  "<context name>": { "label": "Tracking · staging", "icon": "gcp", "color": "#2f8f4e", "env": "staging" }
}
```

`icon` is one of a built-in set of ids; `color` is a hex colour; `env` is `'production' | 'staging' | 'development' | 'other' | ''`. Missing entries fall back to: label = context name, icon guessed from the name (`gke_` → `gcp`, `arn:aws:eks` or `eks` → `aws`, `aks`/`azure` → `azure`, `docker-desktop`/`kind`/`minikube`/`k3d` → `local`, else `cluster`), colour from a fixed 8-colour palette hashed by name, env guessed from the name (`prod` → production, `stag`/`stg` → staging, `dev` → development).

**Imported kubeconfigs** are stored, never merged into the user's file:

- Directory `<dataDir>/kubeconfigs/`, one file per import: `<id>.yaml` (mode `0o600`) plus `index.json` listing `{ id, name, source: 'paste' | 'file', fileName, addedAt, contexts: [names] }`.
- Backend builds `KUBECONFIG` for **every** kubectl/helm spawn as `<user's KUBECONFIG or ~/.kube/config>` + path separator + each imported file. kubectl merges them (first definition of a name wins). Implement once as `kubeEnv()` in `server/core.cjs` and pass `env: kubeEnv()` at every spawn site listed above (including `server/live.cjs` which starts `kubectl proxy` per cluster, `scopedKubeconfig`, the local terminal env on line 1039, and helm). Imported files that would shadow an existing context name are rejected at import with a clear message listing the clashing names.
- Routes (all behind the existing token):
  - `GET /api/kubeconfigs` → the index (never the file contents).
  - `POST /api/kubeconfigs` body `{ name, content, source, fileName }`: parse with `yaml`, require `apiVersion: v1`, `kind: Config`, arrays `clusters`, `contexts`, `users` with at least one context, size ≤ 1 MB, reject clashing context names, write the file, update the index, then invalidate the contexts cache and return the new entry.
  - `DELETE /api/kubeconfigs/:id`: remove file and index entry; if the current context came from it, the UI calls `selectContext('')`.
  - `GET /api/contexts` additionally returns `source: 'default' | '<import id>'` per context (resolve by running `kubectl config view --output=json` once per file with `KUBECONFIG=<that file>` and caching the name sets; refresh on import/delete and on "Reload contexts").
- File import in the renderer uses `<input type="file" accept=".yaml,.yml,.kubeconfig,.config,*/*">` and `File.text()`; it works in Electron and in `npm run web`, and needs no new IPC. Paste import is a `<textarea>`. Both post the content; the file path never leaves the renderer.
- Never log kubeconfig contents. The `GET` routes never return them. The "Reveal"-style read does not exist for kubeconfigs.

**UI**

- Replace the `<select id="context">` with a `button#context-switcher` that shows the current cluster's icon, label and env badge and opens a popover (`<dialog class="switcher">`, like the command palette): a search box, then the list of contexts grouped **Pinned** / **All**, each row = icon in the cluster colour, label, context name in small text, env badge, source badge ("imported"), and a ⋯ menu (Pin/Unpin, Rename…, Change icon…, Set environment…, Remove import). Arrow keys + Enter select. `Ctrl+Shift+K` opens it (add to shortcuts in Settings). Keep `#context` as a hidden element only if other code reads `$('#context').value` (grep; otherwise remove).
- Hotbar `#context-favorites`: show the icon in the colour with the label as tooltip instead of initials; drag-to-reorder with pointer events (no animations); order saved in `favoriteContexts`.
- New page `clusters` (sidebar leaf "Clusters" under the global pages list `globalPages` on line 426; also reachable from the switcher footer "Manage clusters…"): a table of all contexts with inline edit of label, icon picker (grid of the built-in icons), colour picker (the 8 palette swatches + custom hex), env dropdown, pin toggle, source and a Remove button for imported ones; above it two panels "Paste a kubeconfig" and "Import a kubeconfig file". After import, the new contexts appear immediately and the first one is selected if nothing was selected.
- `welcome()`: use the same rows (icon + label + env) and add the two import entry points so a first-time user with no kubeconfig can paste one.
- Everywhere the context name is displayed to the user (`#workspace-context` status bar, breadcrumb, tab titles if they include it, terminal titles in `ui/dock.js`), show the label and keep the name in `title=`.
- Icon set (`ui/cluster-icons.js`, inline SVG strings, 16×16, stroke-based like the existing `icon()` helper in `ui/app.js` line 55): `cluster, gcp, aws, azure, local, production, staging, development, database, globe, shield, flask, rocket, star, bolt, box`. Draw them originally; do not copy any vendor logo.

**Production guard (see 0.1 item 10)**: in `ui/kit.js`, `confirmAction` currently resolves immediately. Change its signature to `confirmAction({ destructive, resourceName })` and make it show a type-the-name dialog only when `destructive` and the current cluster's `env === 'production'`. Update the destructive call sites to pass `destructive: true` (delete, bulk delete, drain, evict, scale when replicas is 0, Helm uninstall, Argo CD delete). Everything else keeps no dialog.

### 3.3 Tests

- `server/core.test.cjs`: `kubeEnv()` joins the default path and imported files with `path.delimiter`; `POST /api/kubeconfigs` rejects non-Config YAML, >1 MB, and clashing names; written file has mode `0o600` (skip on Windows); `DELETE` removes it; `GET /api/contexts` reports `source`. Use the fake runner: respond to `config view` depending on `options.env.KUBECONFIG`.
- `ui/views.test.mjs` or a new `ui/clusters.test.mjs`: `guessIcon('gke_proj_region_name') === 'gcp'`, `guessEnv('tracking-prod') === 'production'`, label fallback.

Acceptance: switch clusters from the popover with the mouse and keyboard; rename a cluster, pick an icon and colour, see it in the hotbar, status bar and tabs; paste a kubeconfig, see its contexts appear, connect, remove it; import a file; restart Rubban and everything persists; `~/.kube/config` is byte-identical before and after (`sha256sum`).

---

## 4. Onboarding tour

### 4.1 Design

No library. New module `ui/tour.js` exporting `startTour({ reason: 'first-run' | 'manual' })`.

- A step is `{ id, target: () => Element | null, title, body, placement: 'right' | 'bottom' | 'left' | 'top', before?: async () => void, when?: () => boolean }`.
- Rendering: a fixed full-screen overlay `div.tour-overlay` that dims everything except a rectangle around the target (one element with `box-shadow: 0 0 0 100vmax var(--tour-dim)` positioned over the target's `getBoundingClientRect()` with 6 px padding; this leaves the target clickable because the overlay element itself is only the cut-out rectangle with `pointer-events: none` and a separate transparent backdrop with `pointer-events: auto` that blocks clicks outside) and a card `div.tour-card` with title, body, step counter "3 of 10", buttons **Back**, **Next**/**Finish**, and **Skip tour**. `Esc` skips. Reposition on `resize` and `scroll` (capture). No animations.
- Steps that need a connected cluster are gated with `when: () => Boolean(state.context)`; when skipped, the card for the previous step says "Connect a cluster to see this".
- Steps (in order; targets are existing selectors unless noted):
  1. `#context-switcher` — "Pick a cluster. Rubban reads your kubeconfig and never changes it. Pin clusters here for one-click switching." (`before`: open nothing.)
  2. `#namespace` — "Scope every view to a namespace, or keep all."
  3. `#navigation` — "Everything in the cluster is in the sidebar: workloads, config, network, storage, Helm, Argo CD, RabbitMQ, custom resources. Press / to filter."
  4. `#command-open` — "Ctrl+K jumps to any view or resource."
  5. (`when` cluster) first row of the Pods table — `before`: `openView('workloads', 'pods')` and wait for `#main table tbody tr`. "Click a row for details: overview, metrics, YAML and events."
  6. (`when` cluster) the row's ⋮ button — "Row actions: edit YAML, scale, restart, logs, shell, delete. Right-click works too."
  7. `#local-terminal` — "Open a terminal already pointed at this cluster. Pod exec, attach and node shells open in the same dock."
  8. `#create-manifest` — "Create any resource from a template or your own YAML."
  9. `[data-section="settings"]` — "Theme, metrics source, node shell image and shortcuts live in Settings."
  10. `#update-button` (workstream 6; `when: () => document.querySelector('#update-button')`) — "Rubban checks GitHub for new versions and installs them in place."
  11. Final card without a target: "You're set. Restart the tour any time from Settings › Help or the command palette."
- Persistence: `preferences.tourCompletedVersion = <major.minor of package version>` on Finish or Skip. `init()` in `ui/app.js` starts the tour after contexts and preferences are loaded when the key is missing. Settings › Help gets "Show the tour"; the command palette gets a "Take the tour" command (add to `allNav()` or a commands list in `commandResults()`).
- Styles in `ui/style.css` under `/* Tour */`, using tokens so it works in both themes.
- Add `rubban-tour` to the list in README §4 "First run".

### 4.2 Tests

`ui/tour.test.mjs`: the step list filters by `when`; `placement` fallback flips when the card would overflow the viewport (pure function `placeCard(targetRect, cardSize, viewport, preferred)` → `{ top, left, placement }`); progress persists via the injected `savePreference` callback.

Acceptance: a fresh profile shows the tour after the welcome page loads; Skip and Finish both stop it from reappearing; the tour works with and without a connected cluster; it is readable in both themes; keyboard only (Tab/Enter/Esc) can complete it.

---

## 5. CI pipeline and GitHub Releases

### 5.1 Current state

- `npm run package:win` (`scripts/package-win.cjs`) → `release/Rubban-<v>-Windows-x64.zip`; runs on any OS.
- `npm run package:mac` (`scripts/package-mac.cjs`) → `release/Rubban-<v>-macOS-arm64.zip` and `-x64.zip`; needs macOS (codesign) or Linux with `rcodesign`; must not run on Windows (symlinks).
- Both read `version` from `package.json`. Optional `RUBBAN_BUNDLE_KUBECTL`/`RUBBAN_BUNDLE_HELM` bundle CLIs into `resources/app/tools` with `tool-provenance.json`.
- Remote `origin` is `git@github.com:HosHaggag/Rubban.git`; the GitHub API returns 404 for it (private or not yet created). The owner must create/push the repository before the release workflow can run. `gh` is not installed in WSL.

### 5.2 Decisions

- Bundle **official** kubectl and helm in every release so users need no extra installs (and so the Windows build stops depending on a copy taken from another product's install, see the legal note). Download them in CI from `https://dl.k8s.io/release/<ver>/bin/<os>/<arch>/kubectl[.exe]` and `https://get.helm.sh/helm-<ver>-<os>-<arch>.{zip,tar.gz}`, verify their published SHA-256 (`<url>.sha256` for kubectl; `https://get.helm.sh/helm-<ver>-<os>-<arch>.<ext>.sha256sum` for helm), and pass them via the existing env variables. Pin the versions in `scripts/tool-versions.json` and let Dependabot-style bumps be manual.
- Release = pushing a tag `v<version>` that matches `package.json`. The workflow refuses mismatches.
- Assets: `Rubban-<v>-Windows-x64.zip`, `Rubban-<v>-macOS-arm64.zip`, `Rubban-<v>-macOS-x64.zip`, `SHA256SUMS.txt`, plus `latest.json` (`{ "version", "assets": { "win32-x64": {name, sha256, size}, "darwin-arm64": …, "darwin-x64": … }, "notes": "<changelog section>" }`) which the updater (workstream 6) reads. GitHub also gives `releases/latest` through the API; `latest.json` avoids parsing and gives checksums in one request.
- Release notes come from the matching `## <version>` section of `CHANGELOG.md` (new `scripts/release-notes.cjs <version>` prints it; fails if missing).

### 5.3 Files

`scripts/fetch-tools.cjs <platform> <arch> <outDir>`: downloads and verifies kubectl and helm as above, prints the two paths. Unit test with an injected fetch: checksum mismatch throws.

`scripts/check-version.cjs`: exits non-zero if `GITHUB_REF_NAME` (without `v`) ≠ `package.json` version and if `CHANGELOG.md` has no section for it.

`scripts/write-manifest.cjs <releaseDir>`: writes `SHA256SUMS.txt` (sha256sum format) and `latest.json`.

`.github/workflows/ci.yml`:

```yaml
name: CI
on: { push: { branches: [main] }, pull_request: {} }
jobs:
  test:
    strategy: { matrix: { os: [ubuntu-latest, windows-latest, macos-latest] } }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - run: npm ci --no-audit --no-fund
        env: { ELECTRON_SKIP_BINARY_DOWNLOAD: 1 }
      - run: npm run lint
      - run: npm test
  package-smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - uses: actions/cache@v4
        with: { path: ~/.cache/electron, key: electron-${{ hashFiles('package-lock.json') }} }
      - run: npm ci --no-audit --no-fund
      - run: npm run package:win          # cross-builds; proves packaging on every PR
```

`.github/workflows/release.yml`:

```yaml
name: Release
on: { push: { tags: ['v*'] } }
permissions: { contents: write }
jobs:
  check:
    runs-on: ubuntu-latest
    steps: [checkout, setup-node, run: node scripts/check-version.cjs]
  windows:
    needs: check
    runs-on: windows-latest
    steps:
      - checkout; setup-node 24; cache ~/AppData/Local/electron/Cache; npm ci
      - run: node scripts/fetch-tools.cjs win32 x64 tools-dl
      - run: npm run package:win
        env: { RUBBAN_BUNDLE_KUBECTL: tools-dl/kubectl.exe, RUBBAN_BUNDLE_HELM: tools-dl/helm.exe }
      - run: npm test                      # the ZIP-contents test runs on Windows too
      - uses: actions/upload-artifact@v4
        with: { name: windows, path: release/*.zip }
  macos:
    needs: check
    runs-on: macos-latest                  # arm64 host; package:mac builds both arches
    steps:
      - checkout; setup-node 24; cache ~/Library/Caches/electron; npm ci
      - run: node scripts/fetch-tools.cjs darwin arm64 tools-arm64 && node scripts/fetch-tools.cjs darwin x64 tools-x64
      - run: npm run package:mac -- --arch=arm64
        env: { RUBBAN_BUNDLE_KUBECTL: tools-arm64/kubectl, RUBBAN_BUNDLE_HELM: tools-arm64/helm }
      - run: npm run package:mac -- --arch=x64
        env: { RUBBAN_BUNDLE_KUBECTL: tools-x64/kubectl, RUBBAN_BUNDLE_HELM: tools-x64/helm }
      - run: ditto -x -k release/Rubban-*-macOS-arm64.zip /tmp/smoke && /tmp/smoke/*/Rubban.app/Contents/MacOS/Rubban --smoke-test
        env: { RUBBAN_SMOKE_DIR: /tmp/smoke-out }
      - upload-artifact macos: release/*.zip
  publish:
    needs: [windows, macos]
    runs-on: ubuntu-latest
    steps:
      - checkout; setup-node
      - download-artifact (all) into release/
      - run: node scripts/write-manifest.cjs release
      - run: node scripts/release-notes.cjs "${GITHUB_REF_NAME#v}" > notes.md
      - uses: softprops/action-gh-release@v2
        with: { files: 'release/*', body_path: notes.md, draft: false, prerelease: ${{ contains(github.ref_name, '-') }} }
```

Note on `package-mac.cjs`: when both `--arch` runs happen in the same job they overwrite nothing (separate zip names). The smoke test uses the existing `--smoke-test` flag in `desktop/main.cjs` line 36; it exits non-zero on renderer errors? Today it only prints them — make `--smoke-test` exit 1 when `rendererErrors.length > 0`.

### 5.4 Release procedure (document in README §5.3)

```bash
npm version minor            # bumps package.json + package-lock, commits, tags v0.11.0
# edit CHANGELOG.md: add the "## 0.11.0" section, amend the commit, move the tag
git push origin main --tags  # the Release workflow builds and publishes
```

Or a `scripts/release.cjs` that bumps, checks the changelog, commits and tags in one go.

### 5.5 Owner prerequisites (cannot be automated here)

1. Create the GitHub repository `HosHaggag/Rubban` (public, if the owner decides to open-source after the legal scrub) and push `main`.
2. Nothing else: the workflow uses the default `GITHUB_TOKEN`.

### 5.6 Code signing (owner decision, not in scope)

Windows SmartScreen warnings disappear only with an EV/OV code-signing certificate (Azure Trusted Signing is the cheapest route today, roughly 10 USD/month) and macOS Gatekeeper warnings only with an Apple Developer ID (99 USD/year) plus notarization. When the owner buys them: add a `sign` step in both jobs (`signtool` / `codesign --options runtime` + `notarytool`) and switch `Install-Rubban.command` to stop ad hoc re-signing. The updater (6) must then verify the signature of the downloaded app instead of relying on the checksum alone.

Acceptance: pushing `v0.11.0` produces a GitHub Release with three zips, `SHA256SUMS.txt`, `latest.json` and the changelog as body; CI runs on every PR on all three OSes.

---

## 6. In-app updater

### 6.1 Constraints

- Packaged with `@electron/packager` as plain folders (no asar, no NSIS/DMG), ad hoc or unsigned. `electron-updater`/Squirrel need signed installers; do not use them. Write a small updater.
- The renderer cannot reach GitHub (CSP). The main process does the check, the download and the hand-off to an installer script; the renderer only shows state and triggers actions over IPC.
- Windows cannot overwrite a running `.exe`. The replacement must happen from a detached process after Rubban exits. Same approach on macOS for consistency.
- Install locations: Windows either `%USERPROFILE%\Rubban\Rubban-Windows` (installed) or any folder (portable zip). Use `path.dirname(process.execPath)` as the install folder in both cases; data lives in `../Rubban-Data` (see `desktop/main.cjs` line 17). macOS: the bundle is `path.resolve(process.execPath, '../../..')`; data is `~/Library/Application Support/Rubban`.
- Disabled when `!app.isPackaged` (source runs) and when `RUBBAN_DISABLE_UPDATES=1`.

### 6.2 Design

New `desktop/updater.cjs` exporting `createUpdater({ app, dataDir, log, repo: 'HosHaggag/Rubban', onState })`:

- `state`: `{ status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'error' | 'up-to-date', current, latest, notes, progress: 0–1, error }`.
- `check()`: `fetch('https://github.com/HosHaggag/Rubban/releases/latest/download/latest.json', { headers: { 'User-Agent': 'Rubban/<v>' } })` (this URL redirects to the latest release's asset and needs no API token or rate limit). Compare with `app.getVersion()` using a small semver compare (`major.minor.patch[-pre]`; no library). Store `lastCheck` and the result in `<dataDir>/update-state.json`. Run on startup after 20 s, then every 6 h (`setInterval`, unref'd), and on demand.
- `download()`: pick `assets[`${process.platform}-${process.arch}`]`; stream `https://github.com/HosHaggag/Rubban/releases/download/v<latest>/<name>` to `<dataDir>/updates/<name>.part` with progress events; abort over 500 MB; on completion compute SHA-256 and compare with the manifest; rename to `<name>`; delete any other file in `updates/`. Only `https://github.com/` and `https://objects.githubusercontent.com/` (the redirect target) are allowed as hosts; reject anything else.
- `install()`: write the helper script into `<dataDir>/updates/` and spawn it detached (`stdio: 'ignore'`, `detached: true`, `windowsHide: true`, `child.unref()`), then `app.quit()`.
  - Windows `apply-update.ps1` (shipped under `desktop/update/apply-update.ps1`, copied at install time; run as `powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File … -Zip … -Install … -Pid … -Exe …`): wait until the pid is gone (poll 250 ms, up to 60 s), `Expand-Archive` the zip into `updates/extract`, find the folder containing `Rubban.exe`, run the extracted `Install-Rubban.ps1 -Source <that folder> -Destination <Install> -NoStart` (it already replaces the folder, keeps `resources\app\tools` when the new build has none, and refreshes the shortcuts), delete `extract` and the zip, write `updates/result.json` `{ ok, version, error }`, then `Start-Process <Exe>`. On any error, write `result.json` with the message and start the old exe so the user is never left without the app.
  - macOS `apply-update.sh`: wait for pid; `ditto -x -k zip extract`; `xattr -dr com.apple.quarantine extract/*/Rubban.app`; if `codesign --verify` fails, `codesign --force --deep --sign - …`; `rm -rf "<bundle>"`; `mv extract/*/Rubban.app "<bundle>"` (if the directory is not writable, fall back to `~/Applications/Rubban.app` and record it in `result.json`); clean up; `open "<bundle>"`.
  - Protect against the running-with-a-different-bundle case: `install()` refuses when `process.execPath` is inside `/Volumes/` (running from a mounted zip/dmg) or a temp directory, and tells the user to install first.
- On the next start, `createUpdater` reads `updates/result.json`, logs it, shows a toast ("Updated to 0.11.0" or the error) through `onState`, and deletes it.
- IPC (`desktop/preload.cjs` → `window.rubbanDesktop.updates`): `getState()`, `check()`, `download()`, `install()`, `onState(listener)` (via `ipcRenderer.on('rubban:update-state')`). Validate the sender exactly like `rubban:open-external`.
- Preferences: `updates: { auto: true }` (auto-check and auto-download on metered-free networks is overkill; keep: auto **check** on, download on click). Settings › Updates panel: current version, last check time, "Check now", "Download", "Install and restart", the release notes (render with `ui/markdown.js`), and the "Check automatically" toggle. Also Help menu › "Check for updates…".

**UI**: a `button#update-button` in the sidebar `tool-row` (`ui/index.html` line 27) with a download-arrow icon and a dot badge; hidden while `up-to-date`/`idle`, visible with the dot when `available`, a progress ring (SVG stroke-dasharray, no animation) while `downloading`, and a filled dot when `ready`. Clicking: `available` → start download; `ready` → `install()`; `error` → open Settings › Updates. Also mirror the state in the status bar next to `#app-version` ("0.11.0 available").

In web mode (`npm run web`, no `window.rubbanDesktop`) the button is hidden.

### 6.3 Tests

- `desktop/updater.test.cjs`: semver compare (`0.10.7 < 0.11.0`, `1.0.0-rc.1 < 1.0.0`); `check()` with an injected `fetch` returning a manifest → `available`; same version → `up-to-date`; asset download with an injected fetch that streams bytes → checksum mismatch → `error` and the `.part` file is removed; host allow-list rejects `http://` and other hosts; `install()` refuses when not packaged (inject `isPackaged: false`).
- Script tests: run `apply-update.ps1` in CI on Windows against a fake install folder with a zip made by `scripts/zip-writer.cjs` and a fake `Rubban.exe` (any file); assert the folder is replaced and `result.json` is `ok`. Same for `apply-update.sh` on macOS with a fake `Rubban.app`.

Acceptance: with 0.11.0 installed and 0.11.1 released, the dot appears within a minute of launch; Download shows progress; Install closes the app, replaces it silently (no window, no SmartScreen because the file is written by Rubban, not downloaded by a browser), relaunches the new version, and shows "Updated to 0.11.1"; a corrupted zip (edit `latest.json` locally in a test) is refused with a readable error and the old version keeps running; the Windows portable layout and the installed layout both work; macOS `/Applications` and `~/Applications` both work.

---

## Legal note for the owner (not legal advice; get a lawyer's opinion before going public)

Question: *if the source is public, can the maker of Lens sue?*

Facts in the repository today:

1. `FEATURE-PARITY.md` states that the installed Lens application's ASAR was unpacked, fingerprinted and inventoried and that its source maps were read "to understand architecture". Commercial Lens is proprietary software with an EULA that, like most, prohibits reverse engineering and decompiling. Publishing a document that says you did this is the single biggest risk in the repo, independent of whether any code was copied. Delete the document (workstream 0) and do not describe that process anywhere.
2. `THIRD-PARTY-NOTICES.md` says the Windows build's `helm.exe` was taken from the Lens install folder. Helm is Apache-2.0, so redistributing Helm is allowed, but take it from the official source (workstream 5 does this) and remove the sentence.
3. The name "Lens" appears in `README.md`, `CHANGELOG.md`, `ui/style.css` line 1, `ui/kit.js` comments and the colour choices are documented as "exactly like Lens". **Trademark**: do not use another product's name in your product's description, tagline, screenshots or marketing ("Lens-style", "like Lens"). A factual comparison page is nominative fair use in most jurisdictions, but the safest course is to remove every mention. **Copyright**: colour values, layout concepts, a sidebar/table/drawer arrangement and feature lists are not protected expression; using similar colours is not infringement. **Trade dress** claims on software UIs exist but are weak and require proving consumer confusion; the different name, logo and the absence of their assets make that unlikely. Make sure no icon, font, image, CSS file or source line was copied from their distribution (the fonts here are Inter/JetBrains Mono/Noto under OFL; the icons are hand-drawn SVG paths in `ui/app.js`; keep it that way).
4. `LICENSE` is MIT with the wrong copyright holder (workstream 1 fixes it). Decide the holder name (your name or a company) before publishing.

With 1–3 done, the project is an independently written Kubernetes client that uses only public Kubernetes/Helm/Argo/RabbitMQ interfaces, and the realistic legal exposure is low. The same scrub applies to any remaining mention of other products in `CHANGELOG.md` history.

---

## Running on Windows (for the implementing model)

- WSL has no Node; the owner's Windows has Node 24.12 at `C:\Program Files\nodejs`. A clone of this repository exists at `C:\Users\Hossam Haggag\Rubban-src` with `node_modules` installed. Keep it in sync with `git pull` from the WSL repository (`/home/hossam/Rubban`), or work there directly.
- PowerShell's execution policy blocks `npm.ps1`; call `npm.cmd` instead. From WSL: `powershell.exe -NoProfile -Command "Set-Location 'C:\Users\Hossam Haggag\Rubban-src'; npm.cmd test"`.
- When launched from a VS Code/Claude Code terminal, `ELECTRON_RUN_AS_NODE=1` is set and Electron runs as plain Node (crash at `desktop/main.cjs:12`). Clear it: `Remove-Item Env:ELECTRON_RUN_AS_NODE; Start-Process node_modules\electron\dist\electron.exe -ArgumentList '.' -WorkingDirectory .`.
- `npm run package:mac` must run on macOS or Linux/WSL, never on Windows.
- The owner's Windows kubeconfig has four GKE contexts; three are production. Do not run mutating actions against them while testing. Use `npm run web` with the fake-API tests, or a `kind`/`docker-desktop` cluster.
