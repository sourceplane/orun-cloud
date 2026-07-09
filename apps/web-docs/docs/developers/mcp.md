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

- **Local (recommended)** — `orun-cloud mcp serve`, a stdio server inside the
  [`orun-cloud` CLI](/developers/cli), riding your CLI login.
- **Remote** — a Streamable-HTTP endpoint for hosted agents, CI, and clients
  that can't run the CLI. Read-only today.

The console's workspace **Settings → MCP server** page carries the same
snippets with copy buttons, plus your live grant and usage status.

## Local server (recommended)

Sign in once with `orun-cloud login`, then register the server with your
client:

**Claude Code**

```sh
claude mcp add orun-cloud -- orun-cloud mcp serve
```

**Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "orun-cloud": {
      "command": "orun-cloud",
      "args": ["mcp", "serve"]
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "orun-cloud": {
      "type": "stdio",
      "command": "orun-cloud",
      "args": ["mcp", "serve"]
    }
  }
}
```

**Any other stdio client** — launch `orun-cloud mcp serve` and speak MCP
(spec revision 2025-06-18) over the process's stdin/stdout.

Useful flags:

- `--read-only` hard-excludes the write tools from `tools/list` (not just
  execution) — 19 read tools remain of the 25-tool roster.
- `--workspace=REF` (a `ws_…` id, slug, or `org_…` id) pins the ambient
  `workspace` default for scoped tools; per-call arguments always override.

`orun-cloud mcp tools` prints the tool roster for humans.

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
