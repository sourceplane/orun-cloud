---
title: CLI (orun-cloud)
description: The orun-cloud command-line client — auth, workspace context, output modes, exit codes, and the full command reference.
---

**`orun-cloud`** is the command-line client for the Orun Cloud control plane. It
is a thin wrapper over the [TypeScript SDK](/developers/sdk) — the SDK is the
only transport it uses — so every command maps to the same public API the
console and your own integrations call.

:::note
`orun-cloud` is **not** the `orun` CLI. `orun` is the intent compiler that
plans and converges platforms ([orun docs](https://orun.sourceplane.ai));
`orun-cloud` talks to this control plane's API — workspaces, projects, keys,
webhooks, billing, audit. The `orun` CLI's cloud surface (`orun cloud link` and
friends) is documented at
[orun.sourceplane.ai/cli/orun-cloud](https://orun.sourceplane.ai/cli/orun-cloud).
:::

## Install and run

The CLI ships in the [`sourceplane/orun-cloud`](https://github.com/sourceplane/orun-cloud)
repository as the private workspace package `@saas/cli` (bin: `orun-cloud`); it
is not yet published to the public npm registry. From a checkout:

```bash
pnpm --filter @saas/cli build
node packages/cli/dist/cli.js --help
```

Every command accepts `--output=human|json` (default `human`) and `--help` /
`--version` work as top-level flags.

## Authenticate

```bash
orun-cloud login    [--api-url=URL] [--token=BEARER]
orun-cloud whoami
orun-cloud logout
```

`login` uses a token-paste flow: pass `--token` or paste a Bearer token when
prompted (input is not echoed). Any credential the API accepts works — a
workspace [API key](/platform/identity/api-keys) or a session token. The CLI
validates the token by listing your workspaces, then stores it. `--api-url`
defaults to `https://api.orun.dev`.

**Token storage** — the OS keychain when available (service `orun-cloud-cli`,
via the optional `keytar` dependency), otherwise a file fallback at
`~/.config/orun-cloud/credentials.json` with `0600` permissions. Non-secret CLI
state (the active workspace) lives beside it in `config.json` (`0644`).
`XDG_CONFIG_HOME` is honored, and `ORUN_CLOUD_CONFIG_DIR` overrides the
directory entirely. `logout` clears both credential and context.

## Set the active workspace

Most commands operate on an **active workspace**, persisted locally:

```bash
orun-cloud workspace list                # `*` marks the active workspace
orun-cloud workspace use ws_9f2ab31c     # accepts ws_…, a slug, or org_…
```

`workspace` is the leading spelling; `org` is the retained legacy alias
(`orun-cloud org list`, `--org=ID`) — same handlers, same ids. See
[Vocabulary](/getting-started/vocabulary). Commands that need a workspace and
find none exit with code `5` and tell you to run `workspace use`.

## Output modes

- `--output=human` (default) — tables for lists, `key: value` blocks for writes.
- `--output=json` — the SDK response shape, verbatim; errors become one JSON
  object on stderr with `code`, `message`, and `requestId`.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Generic / unexpected failure |
| `2` | Usage error (missing argument, unknown subcommand) |
| `3` | Not authenticated — run `orun-cloud login` |
| `4` | Token rejected (401 from the API) — re-run `orun-cloud login` |
| `5` | No active workspace — run `orun-cloud workspace use <id>` |
| `6` | API error surfaced through the SDK (403, 404, 409, 422, 429, 5xx, …) |

Human-mode API errors include the request id for support correlation.

:::tip
On writes, `--idempotency-key=KEY` is forwarded verbatim to the API. The CLI
**never auto-generates a key** — supply your own to make retries safe. See
[Idempotency](/api/idempotency).
:::

## Command reference

### Workspaces and members

```bash
orun-cloud workspace list
orun-cloud workspace use <workspace-id>
orun-cloud workspace members
orun-cloud workspace invite dev@example.com --role=builder \
  --idempotency-key=$(uuidgen) [--workspace=ID]
```

`invite` defaults to the `viewer` role; the server owns the role catalogue, so
a typo returns the canonical 422. See [RBAC](/platform/access-control/rbac).

### Projects and environments

```bash
orun-cloud project list
orun-cloud project create "Web app" --idempotency-key=$(uuidgen)
orun-cloud env create prj_42 staging --idempotency-key=$(uuidgen)
```

### API keys

```bash
orun-cloud api-key create ci-deployer [--scope=SCOPE] --idempotency-key=$(uuidgen)
```

:::warning
The key secret is shown once in the create response and never again — store it
immediately.
:::

### Webhooks

```bash
# Endpoint lifecycle
orun-cloud webhook create https://example.com/hooks --event=project.created,project.archived
orun-cloud webhook disable whe_1 --reason="rotating infra"
orun-cloud webhook enable whe_1

# Secrets — rotation reveals the new secret once
orun-cloud webhook secrets rotate whe_1 --idempotency-key=$(uuidgen)

# Deliveries
orun-cloud webhook deliveries whe_1 --limit=20 [--cursor=CURSOR] [--all]
orun-cloud webhook deliveries replay whd_9   # re-sends the same event

# Local crypto helpers — no network call
orun-cloud webhook verify --secret=S --signature=H --timestamp=T \
  [--body=PATH] [--tolerance-seconds=N]
orun-cloud webhook sign --secret=S --timestamp=T [--body=PATH]
```

`verify` and `sign` operate entirely locally over the `{timestamp}.{body}`
HMAC-SHA256 scheme — useful for testing receivers. See
[Verifying deliveries](/platform/webhooks/verifying-deliveries) and
[Retries and replay](/platform/webhooks/retries-and-replay).

### Usage, billing, audit

```bash
orun-cloud usage summary [--metric=METRIC] [--from=ISO] [--to=ISO]
orun-cloud billing summary
orun-cloud audit list --limit=50 [--cursor=CURSOR] [--category=CAT] [--all]
# filters: --actor=ID --actor-type=TYPE --subject-kind=KIND --subject-id=ID
#          --event-type=TYPE --from=ISO --to=ISO
orun-cloud audit list --all --format=ndjson > audit-export.ndjson
```

`audit list --all` walks every page through the SDK's audit iterator;
`--format=ndjson` streams one JSON entry per line. See
[Audit log](/platform/audit/audit-log).

### Security events

```bash
orun-cloud security events [--limit=N] [--cursor=CURSOR] [--all]
```

Actor-scoped — your own account's security history; no `--org` needed.

### Notification preferences

```bash
orun-cloud notifications preferences [--org=ORG_ID]
orun-cloud notifications preferences set --category=billing --enabled=false [--org=ORG_ID]
```

You manage only your own email preferences, per workspace. See
[Email notifications](/platform/notifications/email).

### GitHub integration

```bash
orun-cloud integrations github token \
  --repos=ID[,ID…] --permissions=contents:read,pull_requests:write [--org=ORG_ID]
```

Mints a short-lived, repo-scoped GitHub installation token through the
workspace's GitHub connection. See [GitHub integration](/platform/integrations/github).

### Teams

```bash
orun-cloud team list
orun-cloud team create platform-eng [--slug=SLUG]
orun-cloud team get <teamId>
orun-cloud team update <teamId> [--name=NAME] [--slug=SLUG]
orun-cloud team delete <teamId>                       # revokes its grants
orun-cloud team members <teamId>
orun-cloud team member-add <teamId> <subjectId> [--type=user|service_principal]
orun-cloud team member-remove <teamId> <subjectId>
orun-cloud team grant <teamId> --role=ROLE --scope=account|organization|project [--scope-ref=PROJECT_ID]
orun-cloud team revoke <teamId> --role=ROLE --scope=account|organization|project [--scope-ref=PROJECT_ID]
orun-cloud team access [subjectId] [--project=ID]     # effective access + provenance
```

`team access` shows the permitted actions for you (or a subject) with `via`
provenance — which membership, team, or cascade produced each permission. All
team commands accept `--org=ORG_ID` to override the active workspace. See
[Teams](/platform/workspaces/teams).

## Related

- [TypeScript SDK](/developers/sdk)
- [CLI and CI authentication](/platform/identity/cli-and-ci-auth)
- [API keys](/platform/identity/api-keys)
- [Audit log](/platform/audit/audit-log)
