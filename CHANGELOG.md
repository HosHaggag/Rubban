# Changelog

## 0.11.0: Light theme, cluster switcher, cleanup

- **Light theme.** Settings › Appearance offers System (the default), Light and Dark. System follows the Windows or macOS setting live; the terminal and window background follow too.
- **Cluster switcher.** The cluster selector is now a searchable popover (Ctrl+Shift+K) with pinned clusters, icons, colours and environment tags. The new **Clusters** page lets you rename a cluster, pick an icon and colour, tag it production, staging or development, and pin it. Pinned clusters in the hotbar can be reordered by dragging.
- **Import a kubeconfig.** Paste a kubeconfig or import a file from the Clusters page or the welcome page. Rubban keeps a private copy in its data folder and merges it through `KUBECONFIG` for the processes it starts; your own kubeconfig is never changed. Remove an import at any time.
- **Onboarding tour.** First launch walks through the main parts of the window in about ten steps. Skip it any time; restart it from Settings › Help or the command palette (“Take the tour”).
- **In-app updates.** Rubban checks GitHub Releases at start and every six hours. An update icon appears in the sidebar when a new version exists; **Download** fetches and verifies it (SHA-256), **Install and restart** swaps the app in place and relaunches it. If anything goes wrong the previous version is put back. Turn automatic checks off in Settings › Updates, or set `RUBBAN_DISABLE_UPDATES=1`. **Help › Check for updates…** checks on demand.
- **Releases from CI.** Pushing a `v<version>` tag builds the Windows and macOS zips on GitHub Actions with the official kubectl and helm bundled and checksum-verified, and publishes them with `SHA256SUMS.txt` and `latest.json`. CI runs lint and tests on Linux, Windows and macOS for every pull request.
- **Production guard.** On a cluster tagged production, destructive actions (delete, bulk delete, evict, drain, scale to zero, Helm uninstall, Argo CD delete) ask you to type the resource name once. Nothing else asks for confirmation.
- Removed the unused Team hub, cluster agent, Extensions, Cloud import, OpenCost, GitOps overview and Flux endpoints and the services behind them. The AI assistant, Prometheus queries and the MCP bridge stay.
- Removed the compatibility code for earlier product names (environment variables, data folders, the old token header and installer clean-up).
- Errors are written to `logs/rubban.log` in the data folder (rotated at 5 MB, three old files kept). **Help › Open log folder** opens it.
- Unexpected errors in the desktop app are logged and shown in one dialog instead of being lost.
- `--smoke-test` exits with a failure when the page logs renderer errors.
- Dependabot keeps npm dependencies current; ESLint runs with `npm run lint`.

## 0.10.7: AI assistant fix and simpler tools

- Fixed AI assistant prompts from non-Git desktop installs.
- Removed the Security toolbar button, command entry and dedicated page content.
- Added regression coverage for the AI CLI invocation contract.

## 0.10.6: Simpler workspace

- Removed Team Workspace, Extensions and Cloud clusters pages, toolbar buttons and commands, plus cloud onboarding shortcuts.
- Removed the Flux navigation section and Flux content from the GitOps overview; Argo CD remains.

## 0.10.5: RabbitMQ login and readability

- RabbitMQ signs in automatically from its Kubernetes Secret when opened; errors are shown honestly.
- Original dark backgrounds retained with softer foreground colors.
- Accessible resource tab selection/keyboard navigation, dialog naming/focus and sort announcements.
- Regression and performance evidence recorded; 73 automated passes and one platform skip.

## 0.10.4: Click outside to close resource details

- Clicking the dashboard outside the resource details drawer closes it and clears its selection/back history.
- Clicking another resource opens that resource's details immediately. Interactions inside the drawer, its menus and input dialogs keep working.
- The close button and Escape use the same close behavior. Resizable columns and confirmation-free actions remain.

## 0.10.3: Resizable columns

- Remove the Controlled by column from Pods, including the column chooser. Ownership remains available in resource details and other workload views.
- Resize table columns by dragging the divider at the right edge of a header. Widths are saved per table and survive navigation, sorting, filtering and reloads.
- Double-click a divider or press Home while it is focused to restore automatic width. Left/right arrow keys adjust width by 10px, or 50px with Shift.
- Keep confirmation-free actions from 0.10.2.

## 0.10.2: Execute actions without confirmations

- Remove all typed-name confirmation prompts across resource edits/deletes, bulk deletes, scaling, restarts, node actions, GitOps, Helm and access-control edits. Forms still collect required values; submitting them executes immediately.
- Argo CD Delete executes immediately using the existing foreground cascade default. Background and non-cascading deletes are direct menu actions, also available through Delete options in details and bulk selections.
- Choosing a create template replaces the editor contents immediately.
- Validated HTTP(S) links open in the system browser without an extra Electron confirmation.

## 0.10.1: Safer default-class changes and Windows validation

- Set the selected StorageClass or IngressClass as default before clearing other defaults. A rejected write to the new default now leaves the old default intact.
- Use Unix path rules in the macOS/Linux shell-environment helper, so its injected platform behaves consistently when tested on Windows.
- Add authenticated HTTP regression coverage for eviction, disruption-budget errors, default-class ordering, legacy default annotations, missing targets and IngressClass defaults.
- Re-check the eviction and default-storage-class UI flows in a browser with isolated fixtures, including a 2,000-pod list. These checks do not replace acceptance testing against a real Kubernetes API server.

## 0.10.0: Faster navigation, no animations, new colours

- **Pages open much faster.** Measured with 2,000 pods in one namespace:
  - Pods list: from about 1.5 s to under 0.1 s.
  - Cluster overview: from about 0.4 s to about 0.1 s.
  - Workloads overview: from about 0.5 s to under 0.1 s.
- **Why it is faster:**
  - Long lists draw only the rows on screen, at a fixed row height, instead of the first 1,500. Live updates, the 15-second usage refresh and the age ticker now redraw only those rows.
  - Each list stays in memory for five minutes after you leave its page, with its watch still running, so going back to a page is instant and shows current data. The server also keeps idle watches for two minutes instead of 20 seconds.
  - The pulsing "Live" dot used to repaint the whole page several times a second. That made everything sluggish on big lists; it is gone.
- **No animations or transitions anywhere.** This covers the live dot, row highlights, spinners, chevrons, button fades and the terminal cursor blink.
- **New colour palette:**
  - Dark grey chrome (`#181a1c`) around a `#1f2123` content area, `#2d2f31` separators and `#37383e` row hover.
  - White column headers, grey cell text and blue (`#3d90ce`) links and accent.
  - Status shown as coloured text (green Running, orange Pending, red failures).
  - The terminal, charts and app icon use the same palette.
- **Tables:**
  - Full-height lists with a sticky header.
  - Columns are sized to fit the panel, and long names end with `…`. Hover a cell to see the full value.
  - Namespace, owner and node are links that open that object.
- **Large lists in kubectl fallback mode.** When the live connection is off and Rubban lists through kubectl, a list can now be up to 64 MB instead of 12 MB. Before, very large namespaces failed with "Command output exceeded the configured limit".

## 0.9.0: New name and logo

- **New name and logo.** The app is now **Rubban · رُبّان**, the ship's captain, the Arabic for what "Kubernetes" (helmsman) means. The new compass mark replaces the radar on the app icon (Windows `.ico`, macOS `.icns`), in the sidebar and in the window.
- Everything uses the new name:
  - the executable (`Rubban.exe`, `Rubban.app`) and bundle ID (`dev.rubban.desktop`);
  - the installers (`Install-Rubban.ps1`, `Install-Rubban.command`);
  - the data folders (`%USERPROFILE%\Rubban\Rubban-Data`, `~/Library/Application Support/Rubban`);
  - the environment variables (`RUBBAN_*`) and the release zips (`Rubban-<version>-…`).
- **Release builds no longer need a `zip` command.** `npm run package:*` writes the zips itself, keeping Unix permissions and the symlinks inside macOS app bundles. This fixes `spawnSync zip EACCES` on WSL when `zip` is not installed.

## 0.8.0: macOS support, release builds and install guide

- **macOS.** Rubban runs on macOS 13 Ventura or later, on Apple silicon (arm64) and Intel (x64). `npm run package:mac` builds `Rubban.app` for both, signed ad hoc, from a Mac or from Linux/WSL, with `Install-Rubban.command` to install it into Applications.
  - Apps opened from Finder or the Dock do not get the PATH from your shell. Rubban now reads `PATH`, `KUBECONFIG`, proxy settings and cloud CLI variables from your login shell when it starts, and adds the usual Homebrew and Google Cloud SDK folders. Without this, kubectl, helm and `gke-gcloud-auth-plugin` would not be found.
  - Settings are kept in `~/Library/Application Support/Rubban`.
  - The menus follow macOS conventions, shortcut labels show ⌘, and the local terminal opens your login shell (zsh).
- **Release builds for both systems from one place.** `npm run package:win`, `package:mac` and `package:all` build zips into `release/`. They work on Windows, macOS or Linux/WSL, include only runtime dependencies plus the terminal's native module for the target, and can bundle kubectl and helm (`RUBBAN_BUNDLE_KUBECTL`, `RUBBAN_BUNDLE_HELM`).
- **Windows installer.** `Install-Rubban.ps1` installs or updates Rubban in `%USERPROFILE%\Rubban\Rubban-Windows`. It keeps the kubectl and helm bundled by an earlier install and keeps your settings, and adds a Start menu shortcut (and a desktop shortcut with `-DesktopShortcut`).
- **Local terminals.** A terminal opened without a cluster uses your normal login shell, with your profile. A terminal opened for a cluster still skips startup files, so a profile that sets `KUBECONFIG` cannot point it at another cluster. Both start in your home folder.
- **Docs.** The README is now a complete install, build and troubleshooting guide; release notes moved to this file.

## 0.7.0: RabbitMQ console and nodes metrics-server misses

- **RabbitMQ tab.** Rubban finds every RabbitMQ in the selected namespace (or all namespaces) by its management Service (port 15672, or a port named `management` / `http-stats`) and shows the management console inside Rubban, signed in with the deployment's initial login:
  - RabbitMQ Cluster Operator: the `<cluster>-default-user` Secret;
  - Bitnami chart and the official image: `RABBITMQ_USERNAME` / `RABBITMQ_PASSWORD` or `RABBITMQ_DEFAULT_USER` / `RABBITMQ_DEFAULT_PASS`, as literal values, Secret references, `envFrom` Secrets or `*_FILE` mounts;
  - otherwise RabbitMQ's `guest` / `guest`, which works because the port forward arrives on the pod's loopback interface.
  The bar above the console shows the username, the password (hidden until you reveal it), copy buttons, where the login came from, *Open in browser* and *Reconnect*. The console is reached through a port forward (listed under Port Forwarding) and a loopback proxy on its own port, so the console page cannot read Rubban's token or window; the login is handed to it with a message addressed to that origin only and is never put in a URL.
- **Nodes that metrics-server leaves out.** metrics-server omits a node (and its pods) when it fails to scrape that node's kubelet, which is why such a node showed `—` while Prometheus-based tools showed bars. Rubban now notices nodes missing from `metrics.k8s.io` and reads their CPU and memory from the kubelet summary API through the API server (`nodes/proxy`), marked "read from the kubelet". If that also fails, the node shows *no data* with the reason, and the Nodes and Overview totals compare usage only with the nodes that reported (for example "on 5 of 6 nodes") instead of understating utilisation.

## 0.6.0: Argo CD › Manage

- **A Manage tab under Argo CD** lists every Application with sync, health, last operation, revision, auto-sync, destination and a *Problems* column carrying the first error message. Cards count synced, out-of-sync, healthy, degraded, progressing and failing applications and filter the list when clicked; sync, health, project and "with problems only" filters are remembered.
- **Actions** from the ⋮ / right-click menu, the details panel or a multi-selection: *Refresh* and *Hard refresh*; *Sync…* with revision, prune, dry run, apply only, force, sync options (server-side apply, replace, create namespace, prune last, apply out-of-sync only, skip schema validation, respect ignore differences), prune propagation, retry and a choice of resources (all, none or only out-of-sync); *Terminate* a running operation; *Auto-sync…* (automated, prune, self heal, allow empty); *Roll back* to a history entry (refused while auto-sync is on, as Argo CD does); *Delete…* as foreground cascade, background cascade or non-cascading. Every change asks you to type the application name first, except dry runs and refreshes.
- **Why it fails.** *Errors and warnings* collects every application's conditions (`SyncError`, `ComparisonError`, `…Warning`), failed operations, resources that failed to sync and degraded or missing resources, with the message and when it happened. The details panel shows the same problems per application, the last operation with per-resource results, resources (click to open the live object), history and conditions.
- **No Argo CD login.** Rubban acts through the Kubernetes API with your kubeconfig, writing the same fields the Argo CD API server writes (`operation`, the refresh annotation, `spec.syncPolicy`, the resources finalizer), so your cluster RBAC on `applications.argoproj.io` decides what you can do. A second sync while an operation is pending is refused.
- Views opened without live updates now refresh the open details panel after an action.

## 0.5.0: every view, with live consumption

- **Consumption everywhere, in human units.** CPU shows as millicores or cores (`250m`, `1.5 cores`) and memory in binary units (`512 MiB`, `3.9 GiB`), with a small bar against limits (or requests) and a tooltip with usage, requests, limits and percentages. Pods, Deployments, StatefulSets, DaemonSets, ReplicaSets, Replication Controllers, Jobs, Namespaces, Nodes and Applications all have CPU and Memory columns; each list shows the total for what is on screen.
- **Workloads › Overview** adds *Consumption by workload*: every pod rolled up to its Deployment, StatefulSet, DaemonSet, CronJob or Job, sortable by CPU or memory used, requested and limited.
- **Cluster overview** now shows CPU, memory and pod capacity (usage, requests, limits, allocatable, capacity) for all nodes, control plane or workers; usage history charts; top pods by CPU and memory; consumption by namespace; and a cluster issues list (nodes not ready, failing pods, warning events).
- **Metrics tabs** for pods (per container), workloads, nodes, namespaces, PVCs and ingresses. Rubban finds Prometheus, Thanos or VictoriaMetrics inside the cluster and queries it through the API server's service proxy with your credentials; nothing is exposed locally. Without Prometheus it charts the samples it took from metrics-server since the cluster was opened. Settings › Metrics picks a specific service or turns history off per cluster.
- **Per-kind tables.** Each kind has its own columns (for example pods: containers, CPU, memory, ready, restarts, controlled by, node, QoS, age, status), sorting on every column, a column chooser, multi-select with bulk delete, and a ⋮ / right-click menu with that kind's actions. Custom resources use their CRD printer columns.
- **Per-kind details.** Pods: containers with state, last state, image, ports (forward each), environment (reveal secret and config map values on request), mounts, probes, command, resources and per-container usage; volumes, conditions, tolerations, affinity. Workloads: replicas, strategy, selector, images, owned pods with usage, revisions with rollback. Nodes: addresses, OS, kernel, runtime, kubelet, capacity and allocatable, taints, conditions, images and pods with usage. Plus services (ports, endpoints), ingresses (rules, TLS, links), network policies (ingress and egress rules), config maps (edit values), secrets (reveal, edit, TLS certificate validity, registry list), quotas (usage meters), limit ranges, HPA, VPA, PDB, webhooks, admission policies, PVCs, PVs, storage classes, RBAC rules and bindings (add or remove subjects), service accounts (permissions, kubeconfig), CRDs, events, Flux and Gateway API objects. Related objects are links, and ← returns to the previous object.
- **Actions.** Node shell, cordon, uncordon and drain; pod logs, shell, attach, evict and port forward; scale, restart, pause/resume and roll back workloads; trigger, suspend and resume CronJobs; set default IngressClass or StorageClass; create a time-limited kubeconfig for a service account.
- **Dock with tabs.** Logs and terminals open side by side in a resizable dock. Logs have container (or all containers), time range, line count, timestamps, previous container, wrap, follow, search with highlighting and download. Workload logs stream every matching pod. A local shell opened while a cluster is selected gets a kubeconfig scoped to that cluster and namespace.
- **Helm.** Chart details with README, versions and default values; install pre-filled with those values. Release details with values (user-supplied or all), notes, managed resources (open the live object) and history with rollback; upgrade pre-fills the repository chart and current values.
- **Create** offers templates for 33 kinds, pre-filled with the current namespace. **Port forwarding** can pick a free local port and open the browser. Sidebar sections appear for Gateway API, admission policies and Flux when the cluster serves them.

## 0.4.0: Graphite Console design

- **New name.** Window title, sidebar brand, About box, service scripts, the MCP server name and environment variables took a new name; the product has been called **Rubban** since 0.9.0.
- **Graphite Console design.** Near-black, compact layout with monospaced resource names, status dots, a green signal accent and a radar logo. Inter, JetBrains Mono and Noto Kufi Arabic are bundled under `ui/fonts` so the app looks the same on every machine.
- **Simpler chrome.** The separate icon rail is gone: workspace tools (metrics, security, team, cloud, extensions, AI, settings) sit at the bottom of the sidebar, pinned clusters sit under the cluster selector, and the namespace selector, refresh, shell and create actions live in the top bar.
- **Pods table** now shows Status (including container problems such as `CrashLoopBackOff`), Ready, Restarts, Node, IP and Age.
- The MCP bridge's bearer-token requests are now accepted by the desktop API (previously only the `X-…-Token` header was).

## 0.3.0: sectioned sidebar

- The sidebar is organised into collapsible sections: Overview, Applications, Argo CD, Nodes, Workloads, Config, Network, Storage, Namespaces, Events, Helm, Access Control and Custom Resources. Open sections are remembered, the current view is highlighted and revealed, and the filter box searches section and item names.
- Clicking a sidebar item navigates in the current tab; Ctrl+click or middle-click opens it in a new tab. The Overview tab stays pinned.
- **Applications** groups Deployments, StatefulSets and DaemonSets into applications using `app.kubernetes.io/instance`, Argo CD tracking, Helm release, `app.kubernetes.io/name` or `app` labels, with combined readiness, status, owner and version.
- **Argo CD** lists Applications (sync, health, source, revision), ApplicationSets and AppProjects. The Application drawer shows source, destination, auto-sync policy, last operation and managed resources, with **Sync** and **Hard refresh** actions. Clusters without Argo CD show a clear "not installed" state.
- **Workloads › Overview** shows live counts and health bars for every workload type plus recent warning events.
- **Helm** is split into **Charts** (browse and install from your repositories, manage repositories) and **Releases**.
- **Custom Resources** lists Definitions and every CRD group, updated live as CRDs are installed or removed.
- Metrics, Security and Team workspace moved to the left rail. Cost insights, Flux GitOps and the raw API resource browser remain available from the command palette (Ctrl+K).

## 0.2.0: live cluster data

- **One persistent connection per cluster.** Rubban starts a `kubectl proxy` for each context you use, bound to `127.0.0.1` on an OS-chosen port under a random 128-bit path prefix, with kubectl's Host filter limited to `127.0.0.1`. Kubeconfig exec plugins (for example `gke-gcloud-auth-plugin`, `kubelogin`, `aws eks get-token`) run once per token lifetime instead of once per click. Idle connections close after 10 minutes and restart on demand.
- **Live tables.** Resource views, custom resources, events, the overview and the namespace list use shared LIST+WATCH streams: paginated initial list, watch bookmarks, automatic relist on `410 Gone`, idle-stream recovery and exponential backoff. Rows that change are re-rendered and briefly highlighted; a status chip shows *Live*, *Reconnecting*, *Polling* (watch not permitted by RBAC, relists every 15 s) or *Snapshot*.
- **Open details stay current.** The detail drawer refreshes its overview when the object changes, warns in the YAML editor instead of overwriting your edits, and says when the object has been deleted.
- **Faster reads.** Namespaces, lists, object JSON/YAML, discovery (aggregated discovery in one request where the server supports it) and metrics go through the connection. Writes (apply, diff, delete, scale, restart, Helm) still use kubectl. If the connection process cannot start, reads fall back to one-shot kubectl.
- Secret payloads remain excluded from list and watch data. `managedFields` are dropped from streamed objects and YAML, as `kubectl get -o yaml` does by default.
