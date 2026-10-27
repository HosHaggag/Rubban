# Handoff: Rubban 0.10.7

## 0.10.7: AI assistant and Security removal

Codex now uses exec --skip-git-repo-check --sandbox read-only - so packaged installs do not need a Git checkout. Prompts remain on stdin. Removed the Security toolbar button, command-palette entry, render route and report-specific UI. Generic custom resources and legacy integration APIs remain available for compatibility. Automated validation: 74 passes, one Windows platform skip; evidence is in the enclosing outputs/qa-0.10.7 folder.

## 0.10.6: Simpler workspace

Removed the Team, Extensions and Cloud UI pages, toolbar and command entries, cloud onboarding links, and the Flux section. The combined GitOps overview now contains Argo CD only. Existing backend legacy APIs and standalone service modules remain for compatibility; no current UI entry points call the removed features. The original Rubban header is restored.

## 0.10.5: QA and RabbitMQ login

Original background surfaces are retained; text/accent contrast is softer. Resource tabs now expose selection and keyboard navigation; dialogs expose names and focus; sorting exposes direction. RabbitMQ reads its Secret when opened and its embedded console retrieves the credentials through a token-protected same-origin endpoint, avoiding a failed cross-frame handoff. Login success is verified against the authenticated console. No credentials are placed in URLs or reports.

QA on the installed 0.10.4 files covered 73 views, 174 resource detail tab visits, 64 focused interaction checks and all 34 templates using a simulated Kubernetes cluster with 2,000 pods. Automated baseline: 71 passed, 1 Unix-only skip; updated suite: 73 passed, 1 skip. Updated Windows native smoke passed. Real staging RabbitMQ automatic login succeeded; a transient upstream socket hang-up banner was observed afterward. Offline lists can display an empty row while the Reconnecting badge is active: unresolved UX finding. Cloud accounts, Team Hub, real mutating cluster operations, native interactive ConPTY sessions and macOS remain outside this run. Detailed evidence is in outputs/regression-installed-0.10.4 at the enclosing task root.

## 0.10.4 follow-up: dismiss resource details from the dashboard

The screenshot/request refers to the right-hand resource drawer. A primary pointer press outside it now closes the drawer and clears selected resource/back history, before the background control's click handler runs. Another row can therefore open its own details in the same click. Clicks inside the drawer, popup menus and open input dialogs are excluded. The close button and Escape share closeDrawer(). No confirmations or animations were added.

Validation: syntax check and test suite passed (71 passes, 1 Unix-only skip). Browser fixture checks verified that clicking YAML inside keeps the panel open, a dashboard/search click closes it, another resource row opens that row's details in one click, and Escape still closes the panel. No production cluster was contacted. Windows native-startup and macOS packaging limitations remain as documented below.

## 0.10.3 follow-up: Pods columns

The user requested removal of the Pods Controlled by column and resizable columns. The Pods definition no longer includes controlledByColumn (other workloads keep it). Shared table headers now have pointer and keyboard resize handles. Widths are keyed by column ID in each table's existing localStorage record and restored by automatic fitting; double-click/Home resets an individual width. Selection and row-menu columns keep their automatic sizing. No-animation and no-confirmation behavior remains.

Syntax checks passed and the test suite remains at 71 passes with one Unix-only skip. Previous native Windows/macOS acceptance limitations remain below.

Browser fixture validation: Controlled by is absent from both Pods headers and the chooser; dragging Name changed 167px to 287px without sorting; a right-arrow changed it to 297px. That width survived filtering to 100 items, sorting and a full reload/reopening of Pods. Home restored automatic width (167px); Shift+Right adjusted by 50px. Preview shows the final 267px width on a 2,000-pod list. No production cluster was contacted.

## 0.10.2 follow-up: no confirmation windows

The user explicitly requested removal of every confirmation window. The shared `confirmAction` hook now resolves immediately without creating UI, covering every existing action handler and form. Required input forms and editors remain. Template replacement and external HTTP(S) links also execute directly. Argo CD deletion no longer opens a dialog: Delete uses foreground cascading; background/non-cascading alternatives remain in menus. Keep this no-confirmation behavior in future work.

The 0.10.1 test, packaging and environment notes below remain applicable. The 0.10.2 change was syntax-checked and the suite passed again (71 passed, 1 Unix-only skip). Native Windows startup and macOS release limitations remain as documented below.

## 0.10.1 continuation

Continued on 21 October 2026 from the supplied 0.10.0 archive. The 0.10.0 notes below are historical; this section takes precedence.

## Changes in this continuation

- Default-class changes enable the selected StorageClass/IngressClass before clearing old defaults. A failure enabling the new default leaves the existing default untouched. Clearing another default can still fail after the new default is set; the error is returned so the user can retry.
- Unix path handling in the shell-environment helper, including when macOS behavior is tested on Windows.
- Six authenticated HTTP regression tests cover eviction, disruption-budget errors, malformed names, default-class order, legacy storage annotations, missing targets, no-op defaults and both IngressClass endpoints.
- A ZIP contents test now runs on Windows as well as Unix. The original Unix permissions/symlink test remains Unix-only.
- Legacy environment compatibility is tested in an isolated VM context instead of launching a subprocess.
- Corrected the outdated "no virtualization" statement in FEATURE-PARITY.md.

## Validation in this continuation

- Pinned dependencies installed with `npm ci --ignore-scripts --no-audit --no-fund`. Normal npm lifecycle subprocesses were denied by this Windows sandbox.
- `node --test --test-isolation=none --test-reporter=tap server/*.test.cjs services/*.test.cjs scripts/*.test.cjs ui/*.test.mjs`: **71 passed, 0 failed, 1 skipped** (Unix permissions/symlinks). Normal process-isolated tests were denied with `spawn EPERM`; in-process execution ran the actual tests without filtering failures.
- In-app browser with an isolated HTTP Kubernetes fixture and Rubban's actual UI/backend: loaded 2,000 pods with windowed rendering; filtered to `debug-shell`; used Actions > Evict and typed confirmation; confirmed live removal and a count of 1,999; used Actions > Set as default on `fast`; confirmed `fast` became Default and `old` lost Default. Recorded writes enabled `fast` before disabling `old`.
- These browser checks use test doubles. They do not establish that the earlier real kube-apiserver actions-suite failures were caused by bad seed data. Reseeding and rerunning that original suite remains outstanding.
- The Windows x64 package was rebuilt from 0.10.1. Its executable FileVersion and ProductVersion are both 0.10.1. No new macOS zips are delivered in this continuation.
- Native Windows smoke launch with an empty kubeconfig stopped before the renderer: Electron reported that this Codex workspace's AppContainer ACL prevents sandboxed child processes from reading the install directory. No ACLs or sandbox settings were changed. Native startup therefore remains unverified; extract the ZIP into a normal user folder for that acceptance pass.

## Remaining acceptance/release work

1. Rerun the original actions suite against a freshly seeded non-production Kubernetes API server, particularly eviction and default StorageClass. The original seed/test harness is absent from this archive.
2. Build macOS arm64 and x64 zips on Linux/WSL or macOS with `npm ci && npm test && npm run package:mac`. WSL access here returns `E_ACCESSDENIED`; the Windows cross-target build failed launching npm with `spawnSync cmd.exe EPERM`. README specifies macOS/Linux for macOS builds; app-bundle symlinks and ad hoc signing also need a supported host.
3. Physical macOS launch, Windows installer/ConPTY acceptance and representative cloud-auth clusters remain unverified unless separately documented.

Keep the secret-redaction, argument-validation, isolated RabbitMQ origin and no-animation rules listed at the end of this file.

---

## Archived 0.10.0 handoff (historical)

The user asked for this: "the application is little slow in navigating between pages. I need it faster, without animations, and change the colour palette to be exactly like Lens."

The code for all three is written and tested. What is left is release work, plus re-checking two end-to-end steps (see "Still to do").

## What changed

| Area | Files | Change |
|---|---|---|
| Windowed tables | `ui/kit.js` (`table()`), `ui/virtual.js` (new) | Lists with more than 120 rows render only the rows on screen plus 14 rows either side. Spacer rows fill the rest, and rows have a fixed height (`--row: 32px`). One scroll/resize listener serves every table. Columns are measured once from the rows on screen plus a text sample, then fixed (`table-layout: fixed`). When the table is too wide, long columns shrink and end with an ellipsis; the name column keeps up to a third of the width. Long cell values get a tooltip. Row flash classes were removed. |
| Cached live feeds | `ui/app.js` (`openFeed`, `liveList`) | Each (context, namespace, resource) has one WebSocket feed, shared by all views that show it. A feed stays open for 5 minutes after its last view closes. A new subscriber gets the cached items in a microtask, before the page is painted. Refresh resyncs the feed in place. Fatal errors and snapshot feeds are not cached. The Overview, Workloads, Applications and resource pages render cached data at once instead of after their debounce. |
| Server | `server/live.cjs` | `WATCH_LINGER_MS` is now 2 minutes (was 20 s). |
| Server | `server/core.cjs` | List calls in the kubectl fallback mode allow 64 MB of output (`LIST_OUTPUT_LIMIT`). `/api/health` reads the version from `package.json`. |
| Other | `ui/app.js`, `ui/format.js` | Memoised sidebar tree (`customChildren`, `allNav`); `podResources()` cached per pod object (WeakMap, frozen). |
| No animations | `ui/style.css`, `ui/dock.js`, `ui/kit.js` | A global `animation:none; transition:none` rule. All keyframes removed (live pulse, blink, row flash, spinner). `loading()` shows text only. The xterm cursor no longer blinks. |
| Lens palette | `ui/style.css`, `ui/dock.js`, `ui/charts.js`, `assets/*`, `ui/rubban.svg`, `desktop/main.cjs` | `:root` tokens: chrome `#181a1c`, content `#1f2123`, separators `#2d2f31`, row hover `#37383e`, selected nav `#282a2d`, borders `#414348`, text `#a5a7a9` / `#aaacae`, headers `#f1f3f5`, accent and links `#3d90ce`, good `#4caf50`, warn `#ff9800`, bad `#ce3933`. Table headers are white and not uppercase. Status is coloured text, links are underlined, and checkboxes are drawn flat. The terminal theme, chart palette, app icon (png/ico/icns regenerated) and window background all use the same palette. |
| Links | `ui/kinds.js` | Namespace, owner and node cells link to that object (`refCell`). |
| Docs | `CHANGELOG.md`, `README.md`, `FEATURE-PARITY.md` | 0.10.0 entry, feature bullet, troubleshooting rows. The version in `package.json` and `package-lock.json` is 0.10.0. |

## Measured (2,000 extra pods, Chromium and Electron on Linux)

| View | 0.9.0 | 0.10.0 |
|---|---|---|
| Pods list | 1.4–1.7 s, one long task of about 1 s | 60–110 ms |
| Cluster overview | about 400 ms | 60–110 ms |
| Workloads overview | about 510 ms | 30–75 ms |
| Idle on a big list | a 150 ms frame several times a second, caused by the infinite "Live" pulse animation | no long tasks |

Electron E2E results:

- 0 running animations (`document.getAnimations()`).
- Palette tokens applied.
- Window background `#1F2123`.

## Tests

- `npm test`: 65/65 pass. This includes a new `windowRange`/`covers` test in `ui/views.test.mjs`.
- These browser suites pass:
  - all-views (every sidebar view and its drawers);
  - Argo CD manage and RBAC fallback;
  - RabbitMQ;
  - nodes / metrics-server gap;
  - live drawer updates;
  - Electron RabbitMQ;
  - Electron speed.
- The one all-views failure is the RabbitMQ entry on the test server without a RabbitMQ forward. It failed the same way on 0.9.0.

## Still to do

1. **Re-check two steps of the actions suite: `evict` (row `debug-shell`) and `defaultclass` (storage class).** They failed on the last run, right after the test data was re-seeded, and the seed script had itself just exited with an error. They are most likely missing test data, not a regression. Confirm this by re-seeding cleanly. If it is a regression, the likely cause is a row that is no longer in the DOM because of windowing; filter the table first.
2. Run `npm ci && npm test && npm run package:all` and check the three zips in `release/`.
3. Give the user the new source for WSL (`~/rased/repos/devops/rubban`) and the release zips.

## Rules to keep

- **Secrets.** Secret values never appear in list, watch or object-read responses; lists carry only `dataKeys`. Values come only from `/api/secret-data`, the YAML reveal, or `/api/rabbitmq/credentials`.
- **No `innerHTML`.** Markdown links open only http(s).
- **kubectl/helm arguments are validated.** Names cannot start with `-`.
- **RabbitMQ console.** It runs on a separate loopback origin. Credentials are passed only by `postMessage` to that exact origin, never in URLs.
- **The no-animation rule is global.** Do not add transitions back.
