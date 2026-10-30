# Rubban 1.0 plan — remaining work

Status on 2026-10-30 (git history rewritten the same day: `main` now starts at the cleaned 0.11.0 tree, no earlier names anywhere): all six workstreams of the original plan (cleanup, old-name removal, light theme, cluster switcher with kubeconfig import, onboarding tour, CI + GitHub Releases, in-app updater) are implemented in the tree and verified: `npm ci`, `npm run lint` (0 errors) and `npm test` (92 passed, 0 failed, 2 platform skips) on Windows from a fresh install; each section's design and acceptance list was checked against the code line by line. The completed sections have been removed from this file. What follows is the residue: small gaps found during that verification, decisions the owner must make, and the Windows notes for whoever works on the repository next.

Project rules still apply: no animations or transitions; no confirmation dialogs except the production guard; secret values never in list/watch payloads; kubectl and helm run without a shell with validated arguments; the renderer cannot reach the internet (anything that talks to GitHub lives in `desktop/` or `server/`); tests are plain `node --test` in the existing style.

---

## A. Gaps to close (ordered by weight)

### Release pipeline / updater

- **A1–A2.** Done 2026-10-30: `--smoke-test` exits with `app.exit(1)` on renderer errors; `release.yml` smoke-tests the Windows zip (via `Expand-Archive`, exit code + `desktop-smoke.json`) and the macOS arm64 zip (asserts on the printed JSON), uploads the smoke output as artifacts, and the publish job downloads only the `release-*` artifacts.
- **A3.** `desktop/updater.cjs` `check()` reports `ready` when `<dataDir>/updates/<asset>` already exists without re-hashing it; re-verify the SHA-256 before `install()` (cheap, the file is in a user-writable folder).
- **A4.** `install()` refusal for `/Volumes` or temp locations compares against `os.tmpdir()` literally (macOS `/var` vs `/private/var`); use `fs.realpathSync` on both sides and add a test for the branch.
- **A5.** `desktop/update/apply-update.sh` `write_result` escapes `message` but not `installedTo`; escape both.
- **A6.** `dismissResult` in the updater is not exposed over IPC (cosmetic; the UI guards with `reportedResult`).
- **A7.** README: the "Updates" and "Releasing (maintainers)" headings inside §5 are un-numbered; number them (5.4/5.5) and renumber what follows.

### Theme

- **A8.** **`ui/charts.js` is not themed.** Series colours and legend swatches are the hard-coded dark `PALETTE`; read them from CSS tokens at draw time (`getComputedStyle(document.documentElement).getPropertyValue('--…')`) with light values added to `ui/style.css`, and call `refreshView()` from an `onThemeChange` listener in `ui/app.js` so open charts redraw.
- **A9.** Two hex colours remain outside the token blocks in `ui/style.css`: line ~429 `::highlight(rubban-log-current)` (`#ff9800` / `#181a1c`, low contrast on white) → tokens; line ~651 `.rabbitmq-frame` `#fff` is intentional (the console is always light) — leave it with a comment.
- **A10.** `desktop/main.cjs` sets `nativeTheme.themeSource` only on the IPC call; read `theme` from `preferences.json` at startup (before creating the window) so an explicit Light/Dark choice opposite to the OS does not flash the wrong window colour on launch.

### Cluster switcher

- **A11.** The switcher popover rows have only Pin/Unpin; add the row ⋯ menu (Rename…, Change icon…, Set environment…, Remove import) reusing the Clusters-page functions in `ui/clusterui.js`.
- **A12.** Three places still show the raw context name instead of the label (`ui/app.js`: overview subtitle ~517, Helm modal ~1181, Metrics panel ~1215). Use `hooks.labelFor(state.context)` with the name in `title=`.
- **A13.** Bulk delete's production guard asks the user to type `"3 resources"`; ask for the word `delete` (or the first resource's name) instead — typing a count is not the "type the resource name" intent.
- **A14.** `readIndex` in `server/kubeconfigs.cjs` validates `id` but not that `contexts` is an array; a hand-edited `index.json` makes `/api/contexts` return 500. Validate and skip bad entries.
- **A15.** README: document the production guard and the Clusters page / kubeconfig import (CHANGELOG has them; README §4 and §6 do not).

### Tour

- **A16.** **Bug:** the Updates step's `when` checks that `#update-button` exists, but it always exists (hidden); check `!node.classList.contains('hidden')` so the step only appears when an update is pending.
- **A17.** README §4 "First run": mention the tour and the Appearance setting.
- **A18.** Add the persistence test (injected `savePreference` is called with `tourCompletedVersion` on Finish and on Skip) — `ui/tour.test.mjs` covers `visibleSteps` and `placeCard` only.
- **A19.** The tour backdrop blocks clicks on the highlighted target (plan wanted it clickable). Low impact; fix only if a step is added that needs a click.

### Findings from the code review of the uncommitted tree (2026-10-30)

- **A20. Wrong-cluster risk on import.** `server/kubeconfigs.cjs` ~56: clash detection compares context names only. kubectl's `KUBECONFIG` merge is first-file-wins for `clusters` and `users` too, so an imported context whose cluster/user entries share a name with the user's own file (`kubernetes`, `admin` are common) silently resolves to the user's server and credentials — destructive actions would hit the wrong cluster. Reject imports whose cluster or user names clash with any existing file, or rewrite the imported entries with an `<id>-` prefix on import.
- **A21. Hotbar click on a missing context.** `ui/clusterui.js` ~48: contexts no longer in the kubeconfig get a `missing` class but stay clickable; the old code disabled them. Set `node.disabled = !available` again.
- **A22. Updater loses `ready`.** `desktop/updater.cjs` ~184: a failed periodic check after a successful download overwrites `status: 'ready'` with `'error'`, so Install is hidden although the verified zip is on disk. Keep `ready` when the downloaded asset still matches the last manifest; report the check failure separately.
- **A23. Import needs kubectl.** `server/core.cjs` ~741: `POST /api/kubeconfigs` calls `kubectl config view` for existing names, so pasting a kubeconfig fails with 503 exactly when kubectl is missing — the case the welcome page advertises. Compute names from `kubeconfigs.list()` plus a non-fatal kubectl call.
- **A24. Listener leak.** `ui/updates.js` ~84: the listener array is filtered on `__live !== false` but `__live` is always true, so every Settings visit adds a listener holding a detached subtree. Prune listeners whose `body.isConnected` is false.
- **A25. Download progress flood.** `desktop/updater.cjs` ~210: `emit()` per body chunk → thousands of IPC messages and DOM rebuilds for a 150 MB zip. Emit only when `Math.round(progress * 100)` changes.
- **A26. Index re-read on every spawn.** `server/kubeconfigs.cjs` ~47: `kubeconfigVariable()`/`sourceOf()` re-read and parse `index.json` and stat every file on each call, and `kubeEnv()` runs on every kubectl spawn. Cache the parsed index; invalidate in `writeIndex`.
- **A27. Check-from-menu wording.** `desktop/main.cjs` ~57: `checkFromMenu` assumes an update is available when `check()` returns early (busy/downloading) → "Version  is available". Branch on the returned status.
- **A28.** Same as A16 (tour Updates step `when` tests existence, not visibility).
- **A29.** `desktop/main.cjs` ~44: `rubban:set-theme` re-implements the sender check inline instead of calling `fromRubban` like the other handlers. Move `fromRubban` above it and reuse.

None of A1–A19 had been addressed when this review ran.

---

## B. Decisions for the owner

- **B1. Production guard: tag-only or guessed?** Today `envFor` falls back to a name guess (`/prod|prd/`), so any context with "prod" in its name gets the type-to-confirm guard without being tagged, and "Not set" does not suppress the guess (choose "other" to opt out). The plan said "opt-in by tagging". Keep the guess (safer default for your three production clusters) or make it strictly tag-based?
- **B2. Code signing.** Windows SmartScreen and macOS Gatekeeper warnings only disappear with an OV/EV certificate (Azure Trusted Signing ≈ 10 USD/month) and an Apple Developer ID (99 USD/year) plus notarization. When bought: add `signtool` / `codesign --options runtime` + `notarytool` steps in `release.yml`, stop ad hoc re-signing in `Install-Rubban.command`, and make the updater verify the signature of the downloaded app in addition to the checksum.
- **B4. First release.** `v0.11.0` was tagged and pushed on 2026-10-30 to trigger the Release workflow. Watch it in the Actions tab; once the release is published, do the end-to-end updater check (install 0.11.0, publish 0.11.1, see the dot, download, install, relaunch) on Windows and macOS. Those acceptance items cannot be verified without two published releases.

---

## C. Legal note (unchanged; not legal advice)

The repository no longer names or describes any other product, does not bundle binaries taken from another product's install, and has the correct licence holder. Before making it public: have a lawyer glance at it, decide the copyright holder name in `LICENSE`, and keep it that way — no other product's name in the README, tagline, screenshots or marketing; no copied icons, fonts, CSS or source.

---

## D. Running on Windows (for the next model)

- WSL has no Node. Windows has Node 24.12 at `C:\Program Files\nodejs`. Two clones exist: `C:\Users\Hossam Haggag\Rubban-src` (the owner runs the app from here; its `node_modules` is currently half-deleted and repairs with `npm install` once the Rubban window is closed) and `C:\Users\Hossam Haggag\Rubban-verify` (clean, used for `npm ci` + lint + test). Sync from the WSL repository with `rsync -a --delete --exclude node_modules --exclude .git --exclude data --exclude build --exclude release ./ "/mnt/c/Users/Hossam Haggag/Rubban-verify/"`.
- PowerShell's execution policy blocks `npm.ps1`; call `npm.cmd`: `powershell.exe -NoProfile -Command "Set-Location 'C:\Users\Hossam Haggag\Rubban-verify'; npm.cmd test"`.
- A VS Code/Claude Code terminal exports `ELECTRON_RUN_AS_NODE=1`, which makes Electron run as plain Node and crash at `desktop/main.cjs` (`app` undefined). Clear it before launching: `Remove-Item Env:ELECTRON_RUN_AS_NODE; Start-Process node_modules\electron\dist\electron.exe -ArgumentList '.' -WorkingDirectory .`.
- `npm ci` / `npm install` cannot touch `node_modules\electron` while a Rubban built from that folder is running (EPERM/EBUSY). Close the app or use the other clone.
- `npm run package:mac` runs on macOS or Linux/WSL, never on Windows.
- The owner's Windows kubeconfig has four GKE contexts; three are production. Never run mutating actions against them while testing. Use `npm run web` with the fake-API tests, or a `kind`/`docker-desktop` cluster.
