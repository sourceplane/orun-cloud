# saas-mcp-server — Design

Status: Draft (decisions marked **locked** are settled; the rest are open in
`risks-and-open-questions.md`).

## 1. Positioning and jobs-to-be-done

The MCP server exists to answer, inside an engineer's agent session, the
questions this platform is uniquely able to answer:

- **Orientation** — "which workspaces and projects can I touch, as whom?"
- **Catalog** — "what services exist, who owns `billing-worker`, what depends
  on it, where is its overview doc?" (the moat: git-derived, provenance-correct)
- **Delivery** — "why did the last prod run fail? show me the failing job's
  logs." (OV7 runs + plan DAG + log tail)
- **Governance** — "what changed in this org yesterday? who has access to
  project X and via what grant?" (audit log + effective-access)
- **Operations** — "are we near quota? what plan are we on? which webhook
  deliveries failed this week?"
- **Action (later, gated)** — "create a staging environment", "replay that
  delivery", "flip this flag", "invite this teammate".
- **Hosted agents (AG)** — the same questions, asked by the platform's own
  sandboxed `orun agent serve` sessions with an AG6 session credential. The
  in-sandbox runtime is the anchor client: its egress allow-list reserves this
  server's hostname, and its "for runs/logs/audit/usage" calls land here.

Non-goals are as load-bearing as goals: this is **not** an agent runtime (AG),
not the work MCP (`orun mcp serve` — work-plane reads and the four mutators
live there), not a second API, not a policy surface, and not a path to secret
values.

## 2. Architecture: one tool plane, two transports

```
                      ┌──────────────────────────────┐
                      │        packages/mcp          │
                      │  tool registry · zod schemas │
                      │  handlers over @saas/sdk     │
                      │  scope resolver · errors     │
                      └───────┬──────────────┬───────┘
                    stdio     │              │   Streamable HTTP
                              ▼              ▼
                  packages/cli          apps/mcp-worker
                 `orun-cloud mcp`      (new bounded context,
                 (local, rides the      mcp.<domain>, stateless-first)
                  CLI token store)             │
                              │                │  bearer sk_ / OAuth access token
                              ▼                ▼
                        ┌──────────────────────────┐
                        │        api-edge          │   ← rate limits, idempotency,
                        │   (unchanged, public)    │     actor resolution: UNCHANGED
                        └──────────────────────────┘
                                     │
                         bounded-context workers
                        (deny-by-default RBAC here)
```

**Locked: the MCP server is a client, not a service.** Neither transport holds
service bindings, Hyperdrive access, or policy logic. Every tool call becomes
one or more `@saas/sdk` calls carrying the *caller's* credential through
api-edge. Consequences, all intentional:

- RBAC is enforced where it always is — in the owning worker, deny-by-default.
  An agent can do exactly what its key/session can do, nothing more.
- Edge rate limiting and idempotency apply per tool call with zero new code
  (the `identity` bucket keys on the same bearer token).
- Audit and metering see agent traffic as first-class API traffic.
- The MCP server can be rebuilt, moved, or shipped to customers without any
  trust review of the platform core.

**Locked: one registry (`packages/mcp`), thin transports.** The registry is the
single source of truth for tool names, schemas, annotations, and handlers. The
CLI command and the worker do only transport concerns (framing, auth
acquisition, session lifecycle). This mirrors how `packages/policy-engine` and
`packages/contracts` are shared rather than duplicated.

**Locked: the remote worker is its own bounded context** (`apps/mcp-worker`,
`component.yaml` type `cloudflare-worker-turbo`, own hostname `mcp.<domain>`)
rather than an api-edge facade. Rationale: MCP Streamable HTTP is a long-lived,
optionally-SSE protocol that doesn't fit api-edge's request/response
middleware; and routing it through api-edge would buy nothing, because the
protection api-edge provides is *already* applied to every downstream call the
tools make. Stateless-first: no Durable Object session state until a feature
(server-initiated messages, subscriptions) demands it.

## 3. Credential model

Three credentials, all pre-existing; the epic adds acquisition plumbing only:

| Client situation | Credential | Acquired via | Milestone |
|---|---|---|---|
| Local agent on a dev machine | CLI token (session bearer or pasted API key) | existing `orun-cloud login` + token store (`packages/cli/src/token-store/`) | MCP1 |
| Headless / CI / server-side agent | org-scoped API key (`sk_…`, service principal `sp_…`) | existing `api-key create`; sent as `Authorization: Bearer` | MCP2 |
| Interactive remote client (Claude.ai, hosted IDEs) | OAuth 2.1 access token (short-lived JWT + rotating refresh) | new authorization endpoints on identity-worker, riding the shipped OP1 CLI-session machinery | MCP3 |
| Hosted agent session (AG sandbox) | AG6 session-scoped token for the profile's `sp_` principal (short-TTL, lease-coupled) | minted by `apps/agents-worker` at session start (owned by AG — nothing to build here) | works from MCP2 (it's a bearer) |

MCP3 specifics (spec revision 2025-06-18): `apps/mcp-worker` serves **protected
resource metadata** (`/.well-known/oauth-protected-resource`) pointing at
identity-worker as the authorization server; identity-worker adds authorization
server metadata, an authorization endpoint (console-rendered consent), token +
refresh endpoints (OP1's issuance/rotation reused), and PKCE (S256, mandatory).
Dynamic client registration posture is an open question (risks D1) — the
fallback is a small allow-list of known public clients. Access tokens carry the
same claims as CLI session JWTs; **no new token kind is minted**.

**Tenancy scoping.** Workspace/project is *explicit tool input*, never ambient
guess (the `api-guidelines` rule). Every scoped tool takes `workspace`
(accepting `ws_…` | slug | `org_…`, resolved by the same edge resolver) and,
where relevant, `project`. `whoami` returns the caller's workspaces so agents
can self-orient; the stdio server may default `workspace` from the CLI's active
context (`packages/cli/src/context/store.ts`) while still accepting overrides.

## 4. Tool catalog (v1)

**Locked: task-shaped curation, ≤ 25 tools.** Endpoint-mirroring is an
anti-goal: 200 auto-generated tools blow the client's context budget and make
the agent worse, not better. Grouping and the wrapped SDK surface:

### Read tools (MCP0)

| Tool | Wraps (SDK) | Notes |
|---|---|---|
| `whoami` | `auth` profile + `organizations.list` | actor kind, email, workspaces + roles, active scope |
| `workspaces_list` | `workspaces.list` | slugs, `ws_` refs, kind (account/workspace) |
| `projects_list` | `repos.list` + `environments.list` | per-workspace, with environments inlined |
| `catalog_search` | `state.listOrgCatalogEntities` | facets: `kind`, `owner`, `project`, `environment`, free-text `q`; cursor pagination passed through |
| `catalog_get_entity` | OV6 list filtered by ref (→ SC0 `getOrgCatalogEntity` when it ships) | identity + relations + provenance |
| `catalog_read_doc` | `state.listCatalogDocs` + `readCatalogDoc` (CD, shipped) | doc-set browse per entity + markdown body by digest |
| `runs_list` | `state.listRuns` / `listOrgRuns` | org- or project-scoped, status filter |
| `runs_get` | `state.getRun` + `listRunJobs` | run detail + plan-DAG job statuses |
| `runs_read_logs` | `state.readRunJobLogs` | tail with `fromSeq`; size-capped output |
| `audit_search` | `events.iterAuditEntries` | time range, actor, action filters |
| `events_search` | `events.listEventsPage` / `getEvent` (ES, shipped) | typed `event_log` explorer: type-glob, source, project/env, time filters; event groups |
| `security_events_list` | `securityEvents` | |
| `access_explain` | `memberships` + `teams` + effective-access | "who can do what, via which grant" (direct / team / account-cascade provenance) |
| `usage_summary` | `metering` usage summary | |
| `quota_check` | `metering` quotas | |
| `billing_summary` | `billing` summary + entitlements | plan, entitlements, invoice list |
| `config_read` | `config` settings + feature flags | discriminated scope (org/project/env), mirroring `ConfigScope` |
| `secrets_list` | `config` secrets | **metadata only** — names/versions; values are unreadable by design |
| `webhook_deliveries_list` | `webhooks` deliveries | delivery-failure debugging |

### Write tools (MCP5, gated — see §7)

| Tool | Wraps | Annotations |
|---|---|---|
| `project_create` | `repos.create` | `readOnlyHint:false` |
| `environment_create` | `environments.create` | |
| `flag_set` | `config` feature-flag write | |
| `webhook_create` / `webhook_delivery_replay` | `webhooks` | replay is the agent-shaped op |
| `member_invite` | `memberships.invite` | `destructiveHint:false`, still policy-gated |

Deliberately excluded from v1 writes: API-key creation/revocation, billing
mutations, team/role grants, anything under `admin` — high blast radius, low
agent value; revisit with per-key tool scoping (MCP7) in place. **Work-plane
surfaces are excluded categorically** (locked decision 8): reads-with-evidence
and the four work mutators belong to the work MCP (`orun mcp serve`, WP5).
**Agent-session read tools** (`agent_sessions_list`, `agent_session_events`
over the AG6 edge routes) are natural additions once the SDK grows an agents
client — tracked as a post-MCP2 candidate, not v1 (the tool budget holds).

**Naming.** `<domain>_<verb>`, no vendor prefix (the server name namespaces in
multi-server clients). Tool descriptions are written for model consumption:
one-line purpose, argument semantics, and when *not* to use the tool.

**Output shape.** Tools return structured JSON content mirroring the public DTO
(so agents can chain calls) plus a short human-readable text summary. List
tools pass cursors through verbatim and state their page limits. Oversized
payloads (logs, docs) are truncated with an explicit continuation hint.

**Error mapping.** The SDK's typed errors map 1:1 to MCP tool errors carrying
the platform `code` (`forbidden`, `rate_limited` with retry-after,
`validation_failed` with field details, …) — agents see the same semantic error
set as every other client (`contracts/src/errors.ts`).

## 5. Schema discipline

`packages/contracts` is intentionally dependency-free TypeScript — there is no
runtime validator or OpenAPI document to generate from. **Locked:** runtime
schemas (zod) live in `packages/mcp`, one per tool input/output, each
`satisfies`-checked against the corresponding `@saas/contracts` type so drift
is a compile error in this package and contracts stay clean. If a later epic
introduces runtime schemas in contracts proper, `packages/mcp` migrates to them
mechanically. Tool schemas are versioned with the package; removing or
narrowing a tool's schema follows the same deprecation discipline as the
public API (additive by default).

## 6. Resources and prompts (MCP4)

- **Resources** (read-optional context, weaker client support — kept minimal):
  - `catalog://{workspace}/{entityKey}` — entity overview (rendered from the
    git-authored `docs.overview` blob + identity/relations), the agent-facing
    twin of SC0's entity page.
  - `runs://{workspace}/{project}/{runId}` — run summary with job list.
- **Prompts** (packaged workflows, the "golden paths" of agent usage):
  - `investigate_failed_run` — orient → `runs_get` → failing jobs →
    `runs_read_logs` → summarize root cause with links.
  - `access_review` — enumerate members/teams/grants for a scope via
    `access_explain` + `audit_search`, produce a review table.
  - `usage_review` — usage vs quota vs plan entitlements, flag anomalies.
  - `service_snapshot` — catalog entity + owner + dependencies + latest runs,
    the "brief me on this service" one-shot.

## 7. Write path and safety rails (MCP5)

- **One write path.** Write tools call the same public mutations as the console
  and CLI — never a bespoke seam. Work-item mutations are not this server's to
  make at all: the work MCP (WP5, shipped) owns them, with its forbidden-tool
  assertions (`packages/db/src/work/model.ts`) as the enforced boundary.
- **Idempotency.** Every write tool auto-generates an `Idempotency-Key` per
  logical attempt (and accepts a caller-supplied one), so agent retries are
  replay-safe at the edge (B3).
- **Annotations.** Every tool declares MCP annotations (`readOnlyHint`,
  `destructiveHint`, `idempotentHint`) so clients can gate confirmation UX.
- **Read-only mode.** `orun-cloud mcp --read-only` and a per-connection
  read-only flag on the remote server hard-exclude write tools from
  `tools/list` — not just from execution.
- **Provenance.** Requests carry a client-surface marker (`user-agent` +
  a `x-client-surface: mcp` header) so audit queries can segment agent traffic;
  authorization semantics are unchanged by it.
- **No secret values, ever.** `secrets_list` returns metadata; there is no tool
  that returns a secret value, and no flag that enables one.

## 8. Metering, entitlement, rate limits (MCP6)

- **Metering:** each tool call emits a `mcp.tool_call` usage event (org-scoped,
  dimensioned by tool name and transport) through the existing metering
  ingestion — the platform meters itself the way it meters customers.
- **Entitlement:** `feature.mcp_server` seam via B11, mirroring
  `feature.catalog_scorecards`: the gate is evaluated at connection/`tools/list`
  time and returns an upgrade-shaped error consistent with U7. Where the
  free/paid line sits is an open product decision (risks D3) — the seam ships
  either way.
- **Rate limits:** inherited from the edge per call. The remote worker adds
  only a cheap connection-level cap (concurrent sessions per principal) to
  protect itself, mirroring the edge's fail-open posture.

## 9. Component layout

```
packages/mcp                 tool registry, schemas, handlers, scope resolver
                             (turbo-package; depends on @saas/sdk, @saas/contracts, zod)
packages/cli                 + `mcp` command group (stdio transport; --read-only)
apps/mcp-worker              remote transport worker (cloudflare-worker-turbo,
                             own hostname; stateless-first)
apps/identity-worker         + OAuth 2.1 authorization endpoints (MCP3)
apps/web-console-next        + Connect-an-agent page (MCP7)
tests/mcp                    conformance + contract + agent-eval suites (MCP8)
```

Each new unit declares its own `component.yaml`; Orun discovers and binds it —
no CI edits (`specs/core/orun-golden-path.md`).
