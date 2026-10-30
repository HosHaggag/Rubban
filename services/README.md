# Optional self-hosted services

These services are independent Rubban implementations. The local MCP bridge lets an AI tool read clusters through a running Rubban.

Use Node.js 24.11 or newer and install the root project dependencies first. The bridge does not install Kubernetes tools or create cluster credentials.

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

Run `node --test services/*.test.cjs` from the root project. Tests use fake kubectl output and a mock MCP API. They do not contact live Kubernetes clusters or read real kubeconfigs.
