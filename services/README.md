# Optional self-hosted services

These services are independent Rubban implementations. They provide a small read-only team catalog, outbound cluster agents and a local MCP bridge. They do not implement Lens cloud, subscriptions, shared account infrastructure or full product parity.

Use Node.js 24.11 or newer and install the root project dependencies first. The team hub uses `ws`; the agent additionally needs `kubectl` on PATH and an existing working Kubernetes context. These programs do not install Kubernetes tools or create cluster credentials.

## Team hub

Set a strong `RUBBAN_ADMIN_PASSWORD` in the service environment, then run `node services/team-hub.cjs`. First run creates an `admin` account; optional `RUBBAN_ADMIN_USER` chooses another username. The password must contain 12–256 characters. Later runs load the saved account database and do not change its password from the environment. Remove the bootstrap password from the service environment after initialization.

The default listener is `127.0.0.1:4520`. `RUBBAN_HUB_PORT` changes the port; `RUBBAN_HUB_BIND` changes the bind address. `RUBBAN_DATA_DIR` selects the persistent state directory; the default is `services/data/` beside the hub script. Preserve this directory between restarts. `state.json` stores scrypt password hashes and agent-token hashes. `audit.ndjson` records user/cluster IDs and query metadata, without passwords, bearer tokens or query results. Session tokens remain in memory, expire after eight hours and are invalidated by a hub restart. Protect and back up the state directory using the deployment account's filesystem permissions; POSIX file modes are requested as 0700/0600. Windows deployments should use a dedicated account and restrict the folder ACL.

Public `GET /health` reports availability. The remaining interface is:

| Request | Result / authorization |
|---|---|
| `POST /api/login` with `{ "username": "admin", "password": "..." }` | Eight-hour bearer token; at most ten attempts/minute per source address |
| `GET /api/clusters` | Clusters permitted to the bearer user, including agent connection status |
| `POST /api/clusters` with `{ "name": "Development" }` | Admin only; unique cluster name, generated cluster ID and one-time-displayed agent token |
| `POST /api/users` with `{ "username": "alice", "password": "...", "role": "viewer", "clusterIds": ["..."] }` | Admin only; creates an account and explicit cluster assignments |
| `POST /api/clusters/<id>/query` with `{ "resource": "pods", "namespace": "default" }` | Authenticated read through that cluster's connected agent |

Use `Authorization: Bearer <token>` for authenticated HTTP requests. Administrators can query all catalog clusters. Viewers can query only assigned IDs. User updates/deletion, password recovery, agent-token rotation, SSO, tenant isolation and high availability are not implemented. Provision a new cluster ID to replace a leaked agent token and remove the old entry only while the service is stopped and with an administrative state backup.

Cluster names are unique without case sensitivity. Request bodies are capped at 16 KiB. Agent responses are capped at 4 MiB; per-cluster pending requests, global pending requests and execution times are bounded. Losing an agent rejects its pending requests. A newly connected agent with the same cluster identity replaces the previous connection.

For access from other machines, provide real TLS and restrict network access. Direct non-loopback binding requires `RUBBAN_TLS_CERT` and `RUBBAN_TLS_KEY` pointing to certificate/key files; otherwise the hub refuses to start. A TLS reverse proxy can instead forward to the default loopback listener. Protect that proxy, its certificates and the hub port; the hub does not trust forwarded client IP headers, so login throttling behind a proxy applies to the proxy address. Agents require `wss://` for non-loopback hosts and use normal certificate validation. Do not disable TLS verification. HTTP bearer authentication alone does not encrypt traffic. No CORS browser interface is supplied.

## Outbound agent

An administrator provisions a catalog cluster, then securely supplies its returned ID and agent token to the machine that has the intended cluster context. Run with these environment variables:

```text
RUBBAN_HUB_URL=wss://your-hub.example/agent
RUBBAN_CLUSTER_ID=<provisioned UUID>
RUBBAN_AGENT_TOKEN=<one-time displayed token>
RUBBAN_KUBE_CONTEXT=<exact existing context>
```

Then run `node services/agent.cjs`. Local testing may use `ws://127.0.0.1:4520/agent`. `RUBBAN_KUBECTL` optionally chooses the kubectl executable. Agent credentials travel in the WebSocket Authorization header, never URL query parameters or process command arguments. The agent makes an outbound connection and reconnects with backoff; it does not open an inbound cluster listener.

Give the agent a Kubernetes identity with only the required RBAC read permissions. This is enforced by the cluster independently of Rubban. The agent accepts structured `resource`, optional `namespace` and optional `name` fields. Resource kinds are explicitly allowlisted in `kube-read.cjs`; `secrets`, arbitrary resource kinds, shell commands, custom URLs, `--raw`, writes and interactive exec are unavailable. Supported special resources are `api-resources` (discovery), `metrics:nodes`, `metrics:pods`, and `logs` (pod name and namespace required, snapshot of at most 200 lines/64 KiB). It never follows a log stream. Standard resources use kubectl JSON get/list requests. Metrics requires the cluster's metrics API. `kubectl` is spawned with `shell: false`; CLI tokens and flags cannot be supplied by a query.

## Local read-only MCP bridge

Start Rubban first. The bridge requires its current local API URL and bearer token. Set `RUBBAN_API_URL=http://127.0.0.1:<port>/` and `RUBBAN_API_TOKEN=<local API token>`, then launch `node services/mcp.cjs` from your MCP client's stdio registration. Alternatively pass `node services/mcp.cjs --connection-file <Rubban-generated connection.json>` or set `RUBBAN_CONNECTION_FILE`. A connection file contains `{ "url": "http://127.0.0.1:<port>", "token": "..." }`; retain it in the application's private data directory and restrict access. The bridge rejects non-owner-readable POSIX files. Windows folder access is governed by its ACL. Environment values override file values. A stale file/token after Rubban exits cannot authenticate to a new session.

Only the literal `127.0.0.1` host and an HTTP(S) origin are accepted. Arbitrary endpoints, redirects, URL credentials and remote hosts are rejected. No client registration is edited automatically. The bridge implements newline-delimited JSON-RPC MCP stdio initialization and these four tools:

- `list_contexts`: `GET /api/contexts`.
- `list_resources`: `GET /api/resources?context=...&resource=...&namespace=...`.
- `resource_details`: `GET /api/resource?context=...&resource=...&namespace=...&name=...`.
- `metrics`: `GET /api/metrics?context=...&namespace=...`; returns node/pod snapshots and warnings.

All tools are read-only. Kubernetes objects may contain application configuration or other sensitive information; use an appropriately scoped local Kubernetes identity. Returned content is untrusted data for the MCP client to interpret. Diagnostics go to stderr; stdout contains only protocol messages. This is a minimal stdio bridge, without remote MCP transport, subscriptions, prompts, resources, sampling or OAuth.

The implementation follows the [MCP 2025-06-18 stdio transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports), [lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle), and [tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) specifications, and negotiates the basic tool subset with 2024-11-05 and 2025-03-26 clients as well.

## Verification

Run `node --test services/*.test.cjs` from the root project. Tests use temporary hub state, loopback HTTP/WebSocket connections, fake kubectl output and a mock MCP API. They do not contact live Kubernetes clusters or read real kubeconfigs. The tests cover role assignments, token-authenticated agents, allowlisted queries, request correlation, disconnect failure, size bounds, password/token persistence exclusions, MCP initialization and fixed authenticated GET endpoints. No claim of tested production deployment or live-cluster compatibility is made.
