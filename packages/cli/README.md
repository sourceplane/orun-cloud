# `@saas/cli`

`orun-cloud` — first-class TypeScript CLI for the Orun Cloud control
plane. Wraps `@saas/sdk` (the only transport allowed) and surfaces a
small set of read-only commands today; write commands land in Task 0101.

## Install (workspace)

This package is internal to the `orun-cloud` monorepo and is not
published. Build the binary with:

```sh
pnpm --filter @saas/cli build
node packages/cli/dist/cli.js --help
```

## Commands

Auth (Task 0100):

```
orun-cloud login    [--api-url=URL] [--token=BEARER]
orun-cloud logout
orun-cloud whoami
```

Reads (Task 0100):

```
orun-cloud workspace list
orun-cloud workspace use <workspace-id>
orun-cloud workspace members
orun-cloud project list
```

> **Workspace vocabulary (saas-workspaces WS3).** `workspace` is the leading
> spelling; `org` is retained as an alias (`orun-cloud org list`, `--org=ID`).
> A Workspace is any organization in your account; ids are unchanged (`org_*`).

Writes (Task 0101):

```
orun-cloud workspace invite <email> [--role=ROLE] [--idempotency-key=KEY] [--workspace=ID]
orun-cloud project create <name> [--idempotency-key=KEY]
orun-cloud env create <project-id> <name> [--idempotency-key=KEY]
orun-cloud api-key create <name> [--scope=SCOPE] [--idempotency-key=KEY]
orun-cloud webhook create <url> [--event=EVENT[,EVENT2,...]] [--idempotency-key=KEY]
```

Cross-resource reads (Task 0101):

```
orun-cloud usage summary    [--metric=METRIC] [--from=ISO] [--to=ISO]
orun-cloud billing summary
orun-cloud audit list       [--limit=N] [--cursor=CURSOR] [--category=CAT] [--all]
```

All commands accept `--output=human|json`. JSON mode emits one document
per invocation; on error, `{ "error": { "code", "message", "requestId? } }`.

### Exit codes (`src/errors.ts`)

| Code | Meaning |
|------|---------|
| 0    | Success |
| 1    | Generic / unexpected error |
| 2    | Usage error (missing/invalid args or flags) |
| 3    | Not authenticated (no stored credential) |
| 4    | API error (4xx/5xx surfaced from the SDK) |
| 5    | No active organization context |
| 6    | Idempotency replay rejected by api-edge |

### Idempotency

`--idempotency-key=KEY` is forwarded **verbatim** to the API on every
write — Stripe parity. The CLI never auto-generates a key. When you omit
the flag, no `Idempotency-Key` header is sent and the api-edge worker
falls through without replay protection (still safe for read-after-write
flows; required for retry-safe writes).

For `webhook create --event=A,B`, each child subscription gets a
deterministic suffixed key (`KEY:sub:0`, `KEY:sub:1`, …) so the whole
command remains retry-safe under partial failure.

### Active organization

Most write/cross-read commands resolve the org from the persisted
context (`orun-cloud org use <org-id>`). Only `org invite` accepts an
explicit `--org=ORG_ID` override; the others throw "no active
organization" (exit 5) when context is unset.

### Audit pagination

`audit list` without flags returns the first page; `--all` walks every
page until the server returns `cursor: null`. In `--all --output=json`
mode the CLI emits one JSON document per page (JSON Lines) so a
downstream pipeline can stream without buffering.

## MCP server (node reference implementation)

> **The canonical local MCP is the orun binary: `orun mcp serve`** — it
> serves this platform tool plane natively alongside orun's work tools
> in one server (D7 unification, `specs/epics/saas-mcp-server/` MCP10 +
> `orun/specs/orun-mcp/`). Point users at the console's
> Settings › Developer › MCP server page or the orun docs. The command
> below remains fully functional as the **node reference
> implementation** over `packages/mcp` (the contract source of truth,
> and the implementation behind the remote worker).

`orun-cloud mcp serve` runs the platform's MCP (Model Context Protocol)
server over **stdio**, so any local MCP client — Claude Code, Cursor,
VS Code, a custom agent — can query the service catalog, runs and logs,
audit, usage/billing, config, and webhooks with your CLI credential
(epic `specs/epics/saas-mcp-server/`, MCP1). The tool plane lives in
`packages/mcp`; this command is a thin transport: every tool call rides
your stored token through api-edge, so RBAC, rate limits, audit, and
metering apply exactly as they do for any other API client.

```
orun-cloud mcp serve [--read-only] [--workspace=REF] [--api-url=URL]
orun-cloud mcp tools [--read-only] [--output=human|json]
```

- Credential: the stored token from `orun-cloud login` (keychain/file).
  Without one, `mcp serve` exits non-zero with a pointer at `login`.
- `--read-only` hard-excludes the write tools (MCP5: `project_create`,
  `environment_create`, `flag_set`, `webhook_create`,
  `webhook_delivery_replay`, `member_invite`) from `tools/list`, not just
  execution — 19 read tools remain. Without the flag all 25 tools are
  served; every write is policy-gated by your role, audited, and
  idempotency-keyed.
- `--workspace=REF` (a `ws_…` id, slug, or `org_…` id) sets the ambient
  `workspace` default for scoped tools; without the flag the active org
  from `orun-cloud org use` is used. Per-call `workspace` arguments
  always override the default.
- Stdout carries the protocol; the startup banner and all diagnostics go
  to stderr.

Client setup snippets:

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

**Generic stdio client**: launch `orun-cloud mcp serve` and speak MCP
(spec revision 2025-06-18) over the process's stdin/stdout.

A remote Streamable-HTTP server with API-key/OAuth auth also exists
(`apps/mcp-worker`, MCP2/MCP3, read-only) — the console's
Settings › Developer › MCP server page and the web-docs
`developers/mcp` page carry the connect instructions for both
transports.

## Auth

The shipped V1 is **token-paste**: `orun-cloud login` prompts for a
Bearer token, validates it via `client.organizations.list()`, and stores
it. Switching to a device-flow grant once api-edge ships
`/v1/auth/device/{start,poll}` is a one-line dispatch in
`src/auth/login.ts`.

Token storage:
- `KeychainTokenStore` (preferred): macOS Keychain / Windows Credential
  Vault / Secret Service via `keytar` (lazy import; in
  `optionalDependencies`).
- `FileTokenStore` fallback: `~/.config/orun-cloud/credentials.json`,
  mode **0600**, parent directory mode **0700**.

Active organization context lives at
`~/.config/orun-cloud/config.json` (mode 0644, not a secret). Override
both via `ORUN_CLOUD_CONFIG_DIR` (used by tests).

## Output stability

JSON output is deterministic given a deterministic SDK response. The CLI
adds **no** timestamps to JSON envelopes. `formatOutput()` is the only
emission path and is fully covered by tests.

## Hazards / constraints

- Zero hazards under `packages/cli/**`. The hazard set is the same as
  the rest of the monorepo: disabled-eslint comments, ts-ignore,
  ts-expect-error, and force-cast escape hatches via `as` chains.
- The package index (`src/index.ts`) is loadable in non-Node hosts; the
  keychain adapter dynamic-imports `keytar` only when needed.
- Idempotency-Key is **caller-owned**. Task 0101 wires `--idempotency-key`
  through to the SDK; the CLI never auto-mints a key.

## Testing

```sh
pnpm --filter @saas/cli typecheck
pnpm --filter @saas/cli lint
pnpm --filter @saas/cli test
pnpm --filter @saas/cli build
```

## Related

- `specs/components/13-cli-and-sdk.md` — surface contract.
- `packages/sdk` — the only allowed transport.
- Task 0101 — write commands + remaining read-only fan-out.
