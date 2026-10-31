<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.png">
    <img src="docs/images/logo-light.png" alt="Rubban · رُبّان" width="460">
  </picture>
</h1>

<p align="center">
  A free, open-source Kubernetes desktop for Windows and macOS.<br>
  It works with any cluster your kubeconfig can reach: GKE, EKS, AKS, on-premises or local.
</p>

<p align="center">
  <a href="https://github.com/HosHaggag/Rubban/releases/latest"><b>Download</b></a> ·
  <a href="#2-install-on-windows">Install on Windows</a> ·
  <a href="#3-install-on-macos">Install on macOS</a> ·
  <a href="CHANGELOG.md">What's new</a>
</p>

<p align="center">
  <img src="docs/images/screenshot-problems.png" alt="Rubban's Problems page listing what is wrong in a production and a staging cluster, grouped by cluster" width="100%">
</p>

Rubban (رُبّان) is Arabic for a ship's captain, a nod to Kubernetes, which is Greek for helmsman. It uses the kubeconfig and credentials you already have, needs no account, and keeps what you do every day in one window.

## Why Rubban

- **Careful with production.** Tag a cluster as production and destructive actions ask you to type the resource name first. Edited YAML is applied only after you have reviewed the diff and a server-side dry run, and a kubeconfig import whose cluster or user names clash with your own is refused, so a command cannot quietly reach the wrong cluster.
- **Made for many clusters at once.** Every tab keeps its own cluster and namespace, so production and staging sit side by side. Ctrl+K finds resources in every open cluster, the Problems page shows what is wrong in all of them, and any resource can be compared with its twin in another cluster.
- **The everyday tools are built in.** Argo CD, Helm, Prometheus metrics, terminals, logs of whole workloads, port forwards that survive, and RabbitMQ consoles that open already signed in. There are no plugins to find and install.
- **Signs you back in.** When a cluster's credentials expire, Rubban says which cluster it is and starts the right sign-in for GKE, EKS or AKS with one click.
- **Free and light.** MIT-licensed, with no account and no paid tier. It is one small Go program that uses the system's web view, and it never changes your kubeconfig.

## Features

### What is wrong, in every cluster

The **Problems** page, the warning button in the left rail, lists crash loops, image pull errors, out-of-memory kills, pods that cannot be scheduled or never become ready, workloads below their replica count, failed Jobs, pending volume claims, unhealthy nodes, and Argo CD applications that are degraded or out of sync, for every cluster that has a tab open. A row opens the resource in the right cluster, opens its logs, or snoozes it for an hour.

### Production and staging, side by side

<img src="docs/images/screenshot-compare.png" alt="The storefront Deployment compared between a production and a staging cluster, with the replica count, image tag and an added feature flag marked" width="100%">

**Compare…** in a resource's details shows its YAML from two clusters, or two namespaces, side by side. What always differs is left out (`managedFields`, `uid`, `resourceVersion`, timestamps and `status`), differences are marked line by line, and a one-line summary names the fields that changed.

### A whole workload's logs

<img src="docs/images/screenshot-logs.png" alt="Logs of the five pods of the storefront Deployment in one view, each pod in its own colour" width="100%">

Logs of a Deployment, StatefulSet, DaemonSet or Job follow every pod at once, one colour per pod, and keep up as pods come and go. Filter with **Include** and **Exclude** (plain text or `/regex/`), and **Pause** to read while lines keep arriving.

### Live usage everywhere

<img src="docs/images/screenshot-pods.png" alt="The Pods view of a production cluster with live CPU and memory for every pod" width="100%">

CPU and memory are shown for pods, workloads, namespaces and nodes against their requests, limits and capacity, and update live. History comes from Prometheus, Thanos or VictoriaMetrics when the cluster runs one.

### Everything else

- **Live views of every kind.** Each kind gets its own columns and details, kept up to date over a per-cluster watch connection.
- **Fast on big clusters.** Lists of thousands of pods open in well under a second: only the rows on screen are drawn, and each list stays in memory for a few minutes after you leave it, so going back to a view is instant. There are no animations.
- **Tabs like a browser.** Each tab keeps its cluster, namespace and view. **+** or Ctrl+T opens another cluster in a new tab, Ctrl+W closes one and Ctrl+Tab moves between them. Your tabs come back on the next launch.
- **Cluster switcher.** A searchable switcher (Ctrl+Shift+K) with pinned clusters, and a **Clusters** page to rename a cluster, give it an icon and a colour, and tag it production, staging or development.
- **Import a kubeconfig.** Paste one or pick a file. Rubban keeps a private copy and never changes your own kubeconfig.
- **Review before apply.** The Create dialog and the YAML tab show the coloured diff, the objects the change touches, kubectl's warnings and the server's dry-run result before **Apply** is enabled.
- **Actions.** Scale, restart, roll back, cordon, drain and evict, and trigger CronJobs.
- **Terminals.** Pod exec and attach, node shells and a local terminal scoped to the selected cluster open in a tabbed dock.
- **Port forwards that survive.** A forward restarts on the same local port when kubectl loses its connection, and comes back when Rubban starts again.
- **Helm.** Browse charts, and manage releases: values, history, upgrade, rollback and uninstall.
- **Argo CD › Manage.** Refresh, hard refresh, sync, terminate, set auto-sync, roll back and delete applications, with every app's error messages listed together.
- **RabbitMQ.** Open the management console of each RabbitMQ in the cluster inside Rubban, already signed in with its initial login.
- **Settings › Access.** See which of the permissions Rubban's features need your identity has in the current cluster and namespace, and copy the result for an administrator.
- **Light and dark.** Follows the system theme, or pick one. A short tour shows the way around on first launch.
- **Installer and updates.** A Windows installer that needs no administrator rights. Rubban checks GitHub Releases, verifies each download's SHA-256 and installs updates in place.
- **Also included.** Gateway API views, an AI CLI assistant and a read-only MCP bridge for AI tools.

Secret values never appear in resource lists. They are fetched when you press **Reveal**, or when you open RabbitMQ to sign in automatically using its deployment Secret.

*The screenshots show two demo clusters running a sample shop.*

---

## Contents

1. [Before you start](#1-before-you-start)
2. [Install on Windows](#2-install-on-windows)
3. [Install on macOS](#3-install-on-macos)
4. [First run](#4-first-run)
5. [Build from source (WSL, Linux, macOS or Windows)](#5-build-from-source-wsl-linux-macos-or-windows)
6. [Permissions each feature needs](#6-permissions-each-feature-needs)
7. [Where Rubban keeps its data](#7-where-rubban-keeps-its-data)
8. [Troubleshooting](#8-troubleshooting)
9. [MCP bridge](#9-mcp-bridge)
10. [Security model](#10-security-model)
11. [Project layout](#11-project-layout)

Release notes are in [CHANGELOG.md](CHANGELOG.md).

Drag a table header's right-hand divider to resize that column. Widths are remembered per view. Double-click the divider to restore automatic sizing; focused dividers also support arrow keys and Home. Pods no longer shows a Controlled by column.

---

## 1. Before you start

Rubban does not create clusters or credentials. It uses the same kubeconfig and tools as `kubectl`. On the machine where you install it you need:

| What | Why | Check with |
|---|---|---|
| A kubeconfig with your contexts (`~/.kube/config`, or `KUBECONFIG`) | Rubban lists its contexts | `kubectl config get-contexts` |
| **kubectl** | Every cluster read and action | `kubectl version --client` |
| The credential plugin your clusters use | Log-in to the cluster: `gke-gcloud-auth-plugin` for GKE, `aws` for EKS, `kubelogin` for AKS | `kubectl get ns` works in a terminal |
| **helm** (optional) | The Helm pages | `helm version` |
| **metrics-server** in the cluster (optional) | Problems page | `list` and `watch` on pods, deployments, statefulsets, daemonsets, jobs, persistentvolumeclaims and nodes (and Argo CD applications), in all namespaces, for every cluster with a tab open |
| Live CPU and memory | `kubectl top nodes` |
| **Prometheus**, Thanos or VictoriaMetrics in the cluster (optional) | Usage history and the Metrics tabs | Rubban finds it on its own |

**If `kubectl get ns` works in your terminal, Rubban will work too.** Do this check first.

Release builds can bundle kubectl and helm (see [5.4](#54-bundle-kubectl-and-helm-optional)). Credential plugins are never bundled; install them with your cloud CLI.

---

## 2. Install on Windows

Windows 10 or 11, 64-bit.

### 2.1 Install the command-line tools (once)

In PowerShell:

```powershell
winget install -e --id Kubernetes.kubectl
winget install -e --id Helm.Helm            # optional, for the Helm pages
```

Then install your cloud provider's CLI and credential plugin, and get your cluster's kubeconfig the way your provider documents it. Rubban works with any cluster kubectl can reach: GKE, EKS, AKS, on-premises or local.

Open a **new** PowerShell window and check that `kubectl get ns` works.

> **Using WSL?** Rubban for Windows reads the *Windows* kubeconfig (`%USERPROFILE%\.kube\config`). A kubeconfig made inside WSL points at Linux plugin binaries that Windows cannot run, so get the kubeconfig once in Windows as well, with your provider's Windows CLI.

### 2.2 Install Rubban

1. Download `Rubban-<version>-Setup.exe` from the release page and run it. It installs for your user only (no administrator prompt), adds **Rubban** to the Start menu and offers a desktop shortcut.
2. Rubban lives in `%LOCALAPPDATA%\Programs\Rubban`. Your settings, imported kubeconfigs and logs live in `%LOCALAPPDATA%\Rubban`, so they stay the same across updates.
3. If you ran Rubban from a zip before, the first start copies its settings (from the `Rubban-Data` folder next to the zip, or from `%USERPROFILE%\Rubban\Rubban-Data`) into the new folder. The old folder is left in place.

**SmartScreen.** Rubban is not code-signed, so Windows may show *Windows protected your PC* when you run the setup or the first launch. Choose **More info**, then **Run anyway**.

**Portable.** Download `Rubban-<version>-Windows-x64.zip` instead, right-click it, choose **Properties**, tick **Unblock**, then **Extract All…**, and run `Rubban.exe`. Settings then go to a `Rubban-Data` folder next to the extracted folder. You can also run `powershell -ExecutionPolicy Bypass -File .\Install-Rubban.ps1` from the extracted folder to copy Rubban to `%USERPROFILE%\Rubban\Rubban-Windows` (add `-DesktopShortcut` for a desktop icon).

You can build both yourself with `go run ./cmd/buildtool package --os windows`, then `go run ./cmd/buildtool installer` (needs [Inno Setup 6](https://jrsoftware.org/isinfo.php)); see [section 5](#5-build-from-source-wsl-linux-macos-or-windows).

### 2.3 Update or remove

- **Update:** use **Settings › Updates**, or run the new `Rubban-<version>-Setup.exe`. Your settings are kept. A portable copy updates the same way from Settings, or by running the new zip's `Install-Rubban.ps1`.
- **Remove:** **Settings › Apps › Installed apps › Rubban › Uninstall**. The uninstaller asks whether to delete your settings too (the default is to keep them). A portable copy is removed by deleting its folder and its `Rubban-Data`.

---

## 3. Install on macOS

Requires macOS 13 Ventura or later. Use the zip that matches your Mac:

| Your Mac | Zip | `uname -m` prints |
|---|---|---|
| Apple silicon (M1, M2, M3, M4 and later) | `Rubban-<version>-macOS-arm64.zip` | `arm64` |
| Intel | `Rubban-<version>-macOS-x64.zip` | `x86_64` |

### 3.1 Install the command-line tools (once)

With [Homebrew](https://brew.sh):

```bash
brew install kubectl
brew install helm                        # optional, for the Helm pages
```

Then install your cloud provider's CLI and credential plugin, and get your cluster's kubeconfig the way your provider documents it. Rubban works with any cluster kubectl can reach: GKE, EKS, AKS, on-premises or local.

Open a **new** Terminal window and check that `kubectl get ns` works.

### 3.2 Install Rubban

1. Double-click the zip to extract it. This gives a folder named like `Rubban-0.10.0-macOS-arm64`.
2. In Terminal, run the installer from that folder:

   ```bash
   bash ~/Downloads/Rubban-0.10.0-macOS-arm64/Install-Rubban.command
   ```

The installer:

- copies `Rubban.app` to `/Applications`, or to `~/Applications` if you cannot write to `/Applications`;
- removes the download quarantine;
- checks the app's signature with `codesign` and re-signs it for this Mac if needed;
- opens Rubban.

After that, start Rubban from Launchpad, Spotlight or the Applications folder.

**Why the installer is needed.** Rubban has no Apple Developer ID, so macOS blocks the downloaded copy. It reports the app as "damaged" or "can't be opened", or stops it with "killed". If you prefer to do the steps by hand:

```bash
cp -R Rubban.app /Applications/
xattr -dr com.apple.quarantine /Applications/Rubban.app
codesign --force --deep --sign - /Applications/Rubban.app   # only if macOS still refuses to open it
```

### 3.3 How Rubban finds your tools on macOS

Apps started from Finder, the Dock or Spotlight do not see the PATH set in `~/.zprofile` or `~/.zshrc`. At start-up, Rubban reads these settings from your login shell (zsh by default):

- `PATH` and `KUBECONFIG`;
- `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`;
- the `CLOUDSDK_*`, `AWS_*` and `AZURE_CONFIG_DIR` cloud settings.

It also adds the Homebrew folders (`/opt/homebrew/bin`, `/usr/local/bin`) and the default install folders of cloud CLIs that do not put themselves on `PATH`. If you change these settings in your shell, quit and reopen Rubban (⌘Q).

To turn the start-up check off, set `RUBBAN_SKIP_SHELL_ENV=1` (for example with `launchctl setenv`).

### 3.4 Update or remove

- **Update:** quit Rubban (⌘Q), then run the new version's `Install-Rubban.command`. Settings are kept.
- **Remove:** drag `/Applications/Rubban.app` to the Bin. To remove settings too: `rm -rf ~/Library/Application\ Support/Rubban`.

---

## 4. First run

1. **Choose a cluster** in the selector at the top left. Rubban lists the contexts from your kubeconfig and does not contact any cluster before you pick one.
2. **Choose a namespace** in the top bar, or keep *All namespaces*.
3. **Use the sidebar:**
   - Overview, Applications, Argo CD, RabbitMQ and Nodes;
   - Workloads, Config, Network and Storage;
   - Namespaces, Events, Helm and Access Control;
   - Flux, Gateway API and Custom Resources.
   Ctrl-click (⌘-click on macOS) opens a view in a new tab.
4. **Tabs work like a browser's.** Each tab remembers its cluster, namespace and view, so two clusters can be open side by side. **+** at the end of the tab bar (or Ctrl+T) opens another cluster in a new tab; the selector at the top left switches the *current* tab's cluster. Last session's tabs come back on the next launch.
5. **Problems.** The triangle button at the bottom of the left rail lists what is wrong in every cluster you have open, with a red or amber count on the button and a dot on each affected cluster's tab. Click a row to open the resource (switching the current tab to that cluster), or use **Logs** and **Snooze 1 h**. Closing the last tab of a cluster removes its problems.
6. **Compare.** **Compare…** in a resource's details shows the same resource on two sides, for example prod and staging, in a new tab: cleaned, sorted YAML with the differing lines marked (**Hide unchanged**, **Include status**, **Swap sides**, **Copy diff**). Secrets are never compared.
7. **Create and edit with a review.** In **Create** and in a resource's **YAML** tab, press **Review** to see exactly what would change (diff, objects, warnings, and the cluster's own validation or admission errors) before **Apply** unlocks. Editing the text after a review locks it again.
8. **Expired credentials show up where you look.** A cluster whose credentials expired gets an amber ring on its tab, in the selector and on the hotbar, and a banner with **Sign in again**. It opens the terminal dock running the one command that fixes it (`gcloud auth login`, `az login` or `aws sso login --profile …`, chosen from the cluster's kubeconfig); when the login finishes, the views reconnect.
9. **Click any row** for its details: overview, metrics, YAML and events. Use ⋮ or right-click for that row's actions.
10. **Settings** is the gear at the bottom of the sidebar. It holds:
   - what your identity may do in the current cluster (**Access**);
   - the Prometheus service used for each cluster (or none);
   - the node shell image;
   - the keyboard shortcuts.

| Shortcut | Windows | macOS |
|---|---|---|
| Command palette (views and resources in all open clusters) | Ctrl+K | ⌘K |
| Open a search result in a new tab | Ctrl+Enter | ⌘Enter |
| Cluster overview | Ctrl+1 | ⌘1 |
| Switch cluster (current tab) | Ctrl+Shift+K | ⌘⇧K |
| Open a cluster in a new tab | Ctrl+T | ⌘T |
| Close tab · next tab · previous tab | Ctrl+W · Ctrl+Tab · Ctrl+Shift+Tab | ⌘W · Ctrl+Tab · Ctrl+Shift+Tab |
| Show or hide the terminal dock | Ctrl+\` | Ctrl+\` |
| Filter the sidebar | / | / |
| Close the details panel | Esc | Esc |

Logs opened for a workload follow all of its pods: each pod has its own colour and a chip in the toolbar to hide it, **Include** and **Exclude** accept text or `/regex/`, and **Pause** holds the view while new lines are still collected (up to about 4 MB are kept).

---

## 5. Build from source (WSL, Linux, macOS or Windows)

Rubban is one Go program. The Windows zip can be built on Linux, WSL, macOS or Windows. The macOS zips must be built on a Mac, because the desktop shell links against Cocoa.

### 5.1 Prerequisites

- **Go 1.26 or newer** (`go version`).
- **macOS builds:** the Xcode command line tools (`xcode-select --install`).
- **Windows builds:** nothing else. The desktop shell uses the WebView2 runtime that Windows 11 and up-to-date Windows 10 already have.
- **Linux desktop builds** (only to run the window on Linux, which is not a supported target): `libwebkit2gtk-4.1-dev` and `libgtk-3-dev`. `rubban web` needs none of this.
- **Optional:** `rcodesign`, to sign macOS builds ad hoc when building on Linux/WSL: `cargo install apple-codesign`. Without it, the macOS zip is unsigned and `Install-Rubban.command` signs the app on the Mac.
- **Optional, for the UI unit tests and ESLint only:** Node.js 24 (`npm install`, then `npm run lint` and `npm run test:ui`). Nothing in the build or at run time uses Node.

### 5.2 Run and test

```bash
cd path/to/rubban
go test ./...                              # unit tests (add -tags desktop on Windows or macOS to include the shell)
go run ./cmd/rubban web                    # serve the UI on a loopback URL and open it in a browser
go run -tags desktop ./cmd/rubban          # run the desktop app (Windows or macOS; in WSL this needs WSLg)
```

When run from source, settings go to `./data`. Use `RUBBAN_DATA_DIR=/some/path` to choose another folder.

### 5.3 Build release zips

```bash
go run ./cmd/buildtool package --os windows                  # release/Rubban-<version>-Windows-x64.zip
go run ./cmd/buildtool package --os darwin --arch arm64      # release/Rubban-<version>-macOS-arm64.zip (on a Mac)
go run ./cmd/buildtool package --os darwin --arch x64        # release/Rubban-<version>-macOS-x64.zip (on a Mac)
```

`go run ./cmd/buildtool installer` (Windows, needs Inno Setup 6) wraps that folder into `release/Rubban-<version>-Setup.exe`. The Windows zip holds `Rubban.exe`, `rubban-cli.exe` (for `web` and `mcp`), `VERSION`, `Install-Rubban.ps1`, this README, the licence files and `tools/` when kubectl and helm are bundled. The macOS zip holds `Rubban.app`, `Install-Rubban.command` and this README. Builds made on a Mac are signed ad hoc with `codesign`; builds made on Linux/WSL use `rcodesign` when it is installed.

To copy the zips from WSL to your Windows Downloads folder:

```bash
cp release/*.zip /mnt/c/Users/$(cmd.exe /c 'echo %USERNAME%' 2>/dev/null | tr -d '\r')/Downloads/
```

### Updates

Packaged builds check `github.com/HosHaggag/Rubban/releases/latest/download/latest.json` shortly after start and every six hours (Settings › Updates, or **Help › Check for updates…**). The app downloads only from GitHub over HTTPS, verifies the SHA-256 from `latest.json`, and installs through a small helper (`apply-update.ps1` on Windows, `apply-update.sh` on macOS, both carried inside the Rubban binary) that runs after Rubban exits, so no installer window or browser download is involved. The helper restores the previous version if the install fails. Releases are not code-signed yet, so the checksum is the integrity check.

### Releasing (maintainers)

There is one GitHub Actions workflow, **Build and release**, and it runs only when started by hand (Actions › Build and release › Run workflow, on the branch to release). Nothing runs on pushes or pull requests. The workflow reads the version from the `VERSION` file, refuses to run without a `## <version>` section in `CHANGELOG.md` or when tag `v<version>` already exists at another commit, bundles the official kubectl and helm (versions in `cmd/buildtool/tool-versions.json`, checksums verified), builds the Windows and macOS zips, smoke-tests them and publishes them as release `v<version>` with `SHA256SUMS.txt`, `latest.json` and the changelog section as the release notes. Turn **publish** off to only build: the zips are then kept as workflow artifacts.

```bash
# 1. add "## 0.12.1: …" to CHANGELOG.md
# 2. put 0.12.1 in VERSION (or: go run ./cmd/buildtool release patch, which also commits and tags)
# 3. commit, push, then start "Build and release" from the Actions tab
```

### 5.4 Bundle kubectl and helm (optional)

Point the build at binaries for the *target* platform. They are copied into `tools/` next to `Rubban.exe`, or into `Rubban.app/Contents/Resources/tools`, with their SHA-256 checksums recorded in `tool-provenance.json`. `go run ./cmd/buildtool fetch-tools win32 x64 tools-dl` downloads checksum-verified copies from the official sources.

```bash
RUBBAN_BUNDLE_KUBECTL=~/dl/windows/kubectl.exe RUBBAN_BUNDLE_HELM=~/dl/windows/helm.exe go run ./cmd/buildtool package --os windows
RUBBAN_BUNDLE_KUBECTL=~/dl/darwin-arm64/kubectl RUBBAN_BUNDLE_HELM=~/dl/darwin-arm64/helm go run ./cmd/buildtool package --os darwin --arch arm64
```

Rubban uses bundled tools first and falls back to the ones on PATH.

### 5.5 Useful environment variables

| Variable | Effect |
|---|---|
| `RUBBAN_DATA_DIR` | Folder for settings and session files |
| `RUBBAN_PORT` | `rubban web` only: the loopback port to listen on (default: chosen by the system) |
| `RUBBAN_SKIP_SHELL_ENV=1` | macOS/Linux: do not read the login shell's environment at start-up |
| `RUBBAN_DISABLE_PTY=1` | Use the simple pipe terminal instead of a native pseudo-terminal |
| `RUBBAN_DISABLE_UPDATES=1` | Turn off the update check and installer |
| `RUBBAN_RELEASE_DIR` | Where `buildtool package` writes the release zips (default `release/`) |

---

### 5.6 Security scans

`scripts/sast.sh` runs the static scans used before a release and writes the reports to `sast-out/`: govulncheck (reachable Go vulnerabilities), gosec, staticcheck, Semgrep (Go, JavaScript, GitHub Actions and secrets rule packs), gitleaks (working tree and history), Trivy and `npm audit`. The tools are installed on first use (Go tools into `$GOPATH/bin`, Semgrep into a Python venv). Findings that are accepted by design are listed at the top of the script, with the reason; `.gitleaks.toml` and `.gitguardian.yaml` exclude test fixtures and the vendored terminal bundle from secret scanning. Keep the `go` line in `go.mod` on the latest patch release: govulncheck reports standard-library fixes against it, and the release workflow builds with exactly that version.

---

## 6. Permissions each feature needs

Rubban acts with *your* Kubernetes identity, so cluster RBAC decides what works. Every view degrades gracefully: you see a clear message instead of an error page.

| Feature | Kubernetes permissions |
|---|---|
| Browse any view | `list` and `watch` on that resource (`get` for details) |
| Search (Ctrl+K) | `list` on pods, deployments, statefulsets, daemonsets, jobs, cronjobs, services, ingresses, configmaps, secrets, persistentvolumeclaims, namespaces and nodes, in all namespaces; kinds you cannot list are skipped |
| Live CPU and memory | `metrics.k8s.io` `pods` and `nodes`: `list` |
| Usage for nodes metrics-server misses | `nodes/proxy`: `get` (kubelet summary through the API server) |
| Usage history and Metrics tabs | `services/proxy`: `get` on the Prometheus service |
| Logs / exec / attach | `pods/log`: `get`; `pods/exec` and `pods/attach`: `create` (logs of a whole workload also `list` pods by its label selector) |
| Node shell | create pods in `kube-system` (privileged debug pod) |
| Port forwarding and RabbitMQ console | `pods/portforward`: `create` (forwards you create are restarted and restored by Rubban with the same permission) |
| Reveal a Secret, RabbitMQ initial login | `secrets`: `get` in that namespace |
| Argo CD › Manage | `applications.argoproj.io`: `get`, `list`, `watch`, `patch`, `delete` in the Argo CD namespace |
| Edit, scale, restart, delete | `patch`, `update` or `delete` on the resource |
| Compare across clusters | `get` on the resource in each cluster (Secrets are refused) |
| Review before apply | `create`/`patch` with dry-run on the resource (the review asks the API server to validate the manifest without storing it) |

**Settings › Access** checks all of these for you: it asks the cluster what your identity may do in the namespace you choose, and **Copy as text** gives you something to send to an administrator.

Argo CD actions do not need an Argo CD login. Rubban updates the Application objects the same way the Argo CD API server does, so your cluster RBAC decides what you can do. If you cannot list Argo CD applications in all namespaces, Rubban falls back to the `argocd` namespace.

---

## 7. Where Rubban keeps its data

| Install | Settings and session files |
|---|---|
| Windows, installed with `Setup.exe` | `%LOCALAPPDATA%\Rubban` |
| Windows, installed with `Install-Rubban.ps1` | `%USERPROFILE%\Rubban\Rubban-Data` |
| Windows, extracted zip | `Rubban-Data` next to the extracted folder |
| macOS | `~/Library/Application Support/Rubban` |
| From source | `./data` in the repository |

This folder holds:

- `preferences.json`: settings, pinned clusters and Prometheus choices;
- `forwards.json`: the port forwards you created, restored (on the same local ports) the next time Rubban starts;
- `port`: the loopback port Rubban reuses on each launch, so settings the page keeps in the browser (column widths, dock height, log options) survive restarts;
- `update-state.json` and `updates/`: the last update check and downloaded updates;
- `connection.json`: the local API address and token, written while Rubban runs, for the MCP bridge;
- `kubeconfigs/`: private copies of kubeconfigs you imported (mode 0600), one file each plus `index.json`;
- `logs/rubban.log`: errors and start-up problems as JSON lines (rotated at 5 MB, three old files kept). Open it from **Help › Open log folder**.

Rubban never writes to your own kubeconfig; imported kubeconfigs are separate copies that Rubban merges into the `KUBECONFIG` of the kubectl and helm processes it starts. Deleting the folder resets Rubban.

---

## 8. Troubleshooting

| Symptom | What to do |
|---|---|
| No contexts in the cluster selector | Run `kubectl config get-contexts` in a terminal. On macOS, if Terminal shows contexts but Rubban does not, check where `KUBECONFIG` is set (see [3.3](#33-how-rubban-finds-your-tools-on-macos)) and restart Rubban. |
| A banner says "Credentials for … expired" | Choose **Sign in again** and finish the login in the browser window it opens. Rubban needs `gcloud`, `az` or `aws` on your PATH for that; without it, sign in from your own terminal and press **Retry**. |
| A port forward shows `error: local port … is in use` | Another program holds that port after Rubban restarted. Stop the forward and create it again on a free port, or close the other program and press **Restart**. |
| `executable … not found` for a credential plugin (`gke-gcloud-auth-plugin`, `kubelogin`, `aws`, …) | Your kubeconfig names a plugin that is not installed or not on `PATH`. Install it with your cloud provider's CLI, open a new terminal, and check that `kubectl get ns` works. Then restart Rubban. |
| `kubectl is not installed or not on PATH` | Install kubectl ([2.1](#21-install-the-command-line-tools-once) or [3.1](#31-install-the-command-line-tools-once)), or bundle it in the build ([5.4](#54-bundle-kubectl-and-helm-optional)). |
| CPU and memory show `—` everywhere | metrics-server is missing or not ready. `kubectl top nodes` shows the same problem. |
| One node shows **no data** | metrics-server could not scrape that node, and Rubban could not read the kubelet either. Hover the cell for the reason. Usually you lack `nodes/proxy` permission, or that node's kubelet is unhealthy. Totals then cover the nodes that reported. |
| Metrics tabs are empty | No Prometheus was found. Pick the service in **Settings › Metrics**, or check `services/proxy` permission. |
| RabbitMQ: "Could not open the management console" | Check that the management plugin is enabled (port 15672), that you have `pods/portforward` permission, and that a RabbitMQ pod is Ready. Press **Try again**. |
| RabbitMQ: the console asks for a login | The initial login could not be read (see the message under the login bar), or the user was changed after install. Sign in with the right credentials. |
| macOS: "Rubban is damaged" / "can't be opened" / "killed" | Run `Install-Rubban.command` again, or the three commands in [3.2](#32-install-rubban). |
| Windows: "Windows protected your PC" | Choose **More info**, then **Run anyway**. Rubban is not code-signed. |
| The terminal says "command-pipe fallback" | A pseudo-terminal could not be created. Full-screen programs (vim, top) will not work there. On Windows this needs Windows 10 version 1809 or later; otherwise you set `RUBBAN_DISABLE_PTY=1` deliberately. |
| A local terminal for a cluster ignores your aliases | This is intentional. A cluster-scoped terminal skips shell startup files so a profile cannot switch `KUBECONFIG`. A terminal opened with no cluster selected loads your normal profile. |
| Something went wrong and you want to report it | Open **Help › Open log folder** and attach `rubban.log`. It contains no secret values. |
| Long names are cut off with `…` | Columns are sized to fit the panel. Hover a cell to see its full value, widen the window, or hide columns you do not need with **Columns**. |
| A list still shows old data after a change made elsewhere | Lists update live. If the connection was interrupted, press **Refresh** on the page to list everything again. |
| Start fresh | Quit Rubban and delete its data folder ([section 7](#7-where-rubban-keeps-its-data)). |

---

## 9. MCP bridge

`rubban mcp` is a read-only **MCP bridge** (stdio transport) that lets an AI tool read clusters through a running Rubban. Start Rubban first: the bridge connects to the local API through the `connection.json` that Rubban writes to its data folder ([section 7](#7-where-rubban-keeps-its-data)). Register one of these commands with your MCP client:

```bash
# macOS
/Applications/Rubban.app/Contents/MacOS/Rubban mcp --connection-file "$HOME/Library/Application Support/Rubban/connection.json"
```

```powershell
# Windows
& "$env:LOCALAPPDATA\Programs\Rubban\rubban-cli.exe" mcp --connection-file "$env:LOCALAPPDATA\Rubban\connection.json"
```

```bash
# From the source folder, with `go run ./cmd/rubban web` or the desktop app running
go run ./cmd/rubban mcp --connection-file ./data/connection.json
```

`RUBBAN_CONNECTION_FILE` can replace the flag, and `RUBBAN_API_URL` (`http://127.0.0.1:<port>/`) with `RUBBAN_API_TOKEN` override the file. Only the literal `127.0.0.1` host is accepted; on macOS and Linux the connection file must not be readable by other users. A stale file from a previous Rubban session cannot authenticate to a new one.

The bridge offers four tools, all read-only: `list_contexts`, `list_resources` (`context`, `resource`, optional `namespace`), `resource_details` (plus `name`) and `metrics` (`context`, optional `namespace`). Secrets are not among the resources it can list. Returned objects may contain application configuration, so use a Kubernetes identity scoped to what the AI tool should see. It implements the MCP 2025-06-18 stdio transport and tools specification and also negotiates with 2024-11-05 and 2025-03-26 clients; there are no prompts, resources, subscriptions or remote transport. Diagnostics go to stderr; stdout carries only protocol messages.

---

## 10. Security model

- **Local only.** The backend listens only on `127.0.0.1`, behind a random 256-bit token, and checks `Host` and `Origin`. Each cluster gets its own `kubectl proxy`, also on `127.0.0.1`, under a random path.
- **Secrets.** Lists, watches and object reads never carry Secret values; you see key names only. Values are fetched one Secret at a time when you press **Reveal**.
- **Actions.** Actions execute directly when selected or when their form is submitted, without confirmation prompts. kubectl and helm run without a shell, and their arguments are validated.
- **Cluster terminals.** A cluster-scoped terminal gets a kubeconfig with only that context, deleted when the terminal closes.
- **RabbitMQ console.** It runs on its own loopback port, a different origin from Rubban, so it cannot read Rubban's token or window. The login is handed to it with a message addressed to that origin only, never in a URL.
- **No telemetry.** Rubban contacts only your clusters and the services you open.

---

## 11. Project layout

```
cmd/rubban/        The program: desktop app (no arguments), `web` server and `mcp` bridge
cmd/buildtool/     Packaging, tool download, manifest, check-version and release commands (go run ./cmd/buildtool)
internal/app/      Desktop shell: window, menus, dialogs, theme and the updates bridge (Wails, built with -tags desktop)
internal/server/   Local backend: Kubernetes reads and actions, metrics, Helm, Argo CD, RabbitMQ, logs and terminals
internal/live/     kubectl proxy pool, API discovery and shared live watches
internal/updater/  In-app updater and its helper scripts
internal/mcp/      MCP bridge
ui/                The interface (plain ES modules, no build step) and its styles, embedded into the binary
scripts/           Installers (Install-Rubban.ps1, Install-Rubban.command)
assets/            Icons (.ico for Windows, .icns for macOS, .svg/.png)
```

Licence: MIT (see [LICENSE](LICENSE) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)).
