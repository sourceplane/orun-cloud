---
title: MCP server (connect an agent)
description: Connect AI agents — Claude Code, Cursor, VS Code, or your own — to the Orun Cloud MCP server, locally over stdio or remotely over Streamable HTTP.
---

Orun Cloud ships an **MCP (Model Context Protocol) server** so any MCP client
can query the platform's highest-leverage surfaces — the git-derived service
catalog, runs and logs, audit, usage and billing, config, and webhooks — as a
curated, task-shaped tool plane. The server is a *client of the public API,
never a fourth plane*: every tool call carries the agent's own credential
through the API edge, so [RBAC](/platform/access-control/rbac), rate limits,
idempotency, the [audit log](/platform/audit/audit-log), and
[metering](/platform/metering/usage-and-quotas) apply exactly as they do for
any other client.

There are two transports over one tool registry:

- **Local (recommended)** — `orun mcp serve`, a stdio server inside the
  **orun binary**, riding your `orun auth login`. One server, 34 tools: the
  25 platform tools this page describes plus orun's 9 work tools.
- **Remote** — a Streamable-HTTP endpoint for hosted agents, CI, and clients
  that can't run a local binary. Read-only today.

The console's workspace **Settings → MCP server** page carries the same
snippets with copy buttons, plus your live grant and usage status.

## Local server (recommended)

The orun binary serves the full tool plane natively — the platform tools
(catalog, runs, audit, usage, config, webhooks) and orun's work tools in one
MCP server, so an agent needs a single connection. See the
[orun docs](https://orun-docs.pages.dev) and the
[orun release notes](https://github.com/sourceplane/orun/releases) for the
unified server.

Install the binary and sign in once:

```sh
curl -fsSL https://raw.githubusercontent.com/sourceplane/orun/main/install.sh | sh
orun auth login
```

Then register the server with your client:

**Claude Code**

```sh
claude mcp add orun -- orun mcp serve
```

**Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "orun": {
      "command": "orun",
      "args": ["mcp", "serve"]
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "orun": {
      "type": "stdio",
      "command": "orun",
      "args": ["mcp", "serve"]
    }
  }
}
```

**Any other stdio client** — launch `orun mcp serve` and speak MCP over the
process's stdin/stdout.

Useful flags:

- `--read-only` hard-excludes the write tools from `tools/list` (not just
  execution).
- `--workspace <ref>` (a `ws_…` id, slug, or `org_…` id) pins the ambient
  `workspace` default for scoped tools; without it the workspace linked to
  your current repo is used. Per-call arguments always override.

### Reference implementation (node CLI)

The [`orun-cloud` CLI](/developers/cli) still ships the platform-only MCP
server — the same tool plane (`packages/mcp`) the remote server runs — and
remains fully supported as the **reference implementation**. Sign in once
with `orun-cloud login`, then register `orun-cloud mcp serve` the same way:

```sh
claude mcp add orun-cloud -- orun-cloud mcp serve
```

For Cursor/VS Code, use the JSON snippets above with `"command": "orun-cloud"`
and server name `orun-cloud`; any other stdio client launches
`orun-cloud mcp serve` and speaks MCP (spec revision 2025-06-18) over the
process's stdin/stdout.

Node-CLI flags: `--read-only` leaves the 19 read tools of the 25-tool roster;
`--workspace=REF` pins the ambient `workspace` default (your active org
otherwise). `orun-cloud mcp tools` prints the tool roster for humans.

## Remote server

The remote server speaks MCP over Streamable HTTP at the per-environment
worker URL (the `mcp.<domain>` hostname is a follow-up):

```
https://mcp-worker-prod.oruncloud.workers.dev/mcp
```

Two ways to authenticate:

- **API key (headless agents, CI)** — send a workspace
  [API key](/platform/identity/api-keys) (`sk_…`) as the `Authorization:
  Bearer` token. Mint it with the least-privileged role the agent needs:
  **viewer** for read-only agents, **builder** for agents that write.
- **OAuth 2.1 (interactive clients)** — OAuth-capable clients (Claude,
  Claude Code, Cursor, Visual Studio Code) connect to the remote URL directly
  and are sent through the console consent screen; no pasted key. The grant
  appears on your personal **Sessions & devices** page, where you can revoke
  it at any time.

The remote server is **read-only today**; write tools run through the local
server.

## Access and governance

- **Role-based scoping** — an agent can do exactly what its credential can
  do; the key's role bounds which tools succeed. Read tools need **viewer**;
  writes (create a project, set a flag, replay a webhook delivery, invite a
  member) need **builder** or above. There is no per-key tool subset yet —
  least privilege is the key's role.
- **Everything is governed** — every tool call is policy-checked
  (deny-by-default, in the owning service) and rate-limited at the API edge,
  lands in the audit log tagged `x-client-surface: mcp`, and is metered as
  `mcp.tool_call` in your workspace's usage.
- **Secrets stay write-only** — tools can list secret *metadata*, never
  values. No flag enables value reads.
- **Writes are replay-safe** — every write tool carries an idempotency key
  per logical attempt, so agent retries never double-create.
