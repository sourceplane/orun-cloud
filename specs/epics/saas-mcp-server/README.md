# Epic: saas-mcp-server

**Make Orun Cloud a first-class platform for AI agents.** Ship an MCP (Model
Context Protocol) server that exposes the platform's highest-leverage surfaces —
the git-derived service catalog, runs and delivery state, audit and access
governance, usage/billing, config and webhooks — as a curated, task-shaped tool
plane that any MCP client (Claude Code, Cursor, VS Code, custom agents) can
connect to. One tool registry, two transports: a **local stdio server** shipped
inside the existing `orun-cloud` CLI, and a **remote Streamable-HTTP server** as
a new bounded-context Cloudflare Worker. The MCP server is a *client of the
public API, never a fourth plane*: every tool call traverses api-edge with the
caller's own credential, so RBAC, rate limits, idempotency, audit, and metering
apply unchanged.

## Status

| Field | Value |
|-------|-------|
| Status | **Ready** — MCP0–MCP2 are human-independent, ride entirely on shipped surfaces (SDK, state plane, OP1 auth, ES events, CD catalog docs), and are now a named dependency of `saas-agents` (AG — the in-sandbox runtime calls this MCP); MCP3 (OAuth) and MCP6 (entitlement) carry decisions in `risks-and-open-questions.md` |
| Cluster | **MCP** (agent client surface — promotes the agent-surface half of `saas-product-areas` **P7**; the **platform MCP**, distinct from orun's **work MCP** — see vocabulary note below) |
| Owner(s) | `packages/mcp` (new, primary) + `packages/cli` (stdio transport) + `apps/mcp-worker` (new, remote transport) + `apps/identity-worker` (OAuth 2.1 authorization, MCP3) + `packages/contracts`/`sdk` (schema seam) + `apps/web-console-next` (Connect page, MCP7) + `apps/billing-worker`/`metering-worker` (entitlement + metering, MCP6) |
| Target branch | `claude/orun-cloud-mcp-server-h95b57` (PRs merged incrementally) |
| Builds on | `packages/sdk` (contract-driven client — the only way tools touch the platform), `epics/saas-orun-platform/` OP1 (CLI session auth: short-lived JWT + rotating refresh — the substrate MCP3's OAuth rides), OV6 (org catalog projection) + OV7 (Runs), `epics/saas-event-streaming/` (ES — **shipped**: the typed event explorer + SDK iterators an `events_search` tool wraps), `epics/saas-catalog-docs/` (CD — **shipped**: `listCatalogDocs`/`readCatalogDoc`, the backing for `catalog_read_doc`), `components/18-state.md` (catalog invariant), B3 (edge idempotency/rate-limit families), B11 (entitlements) |
| Consumed by | `epics/saas-agents/` (AG — **the anchor client**): AG names MCP0–MCP2 a hard dependency, scopes "the MCP tool plane" out to this epic, reserves the MCP hostname in the sandbox egress allow-list (`SandboxSpec.egressAllow`: "the platform API + MCP, …"), and its AG6 session tokens are a credential MCP2 accepts by construction (bearer forwarded to api-edge). `orun/specs/orun-agents/` wires the runtime's MCP client to this server. |
| Decisions locked | (1) **The MCP server is a client, not a service**: it holds no service bindings, no DB access, and no policy logic — it consumes the public API through `@saas/sdk` with the caller's credential, so deny-by-default RBAC, edge rate limits, and audit apply identically to agent and human traffic. (2) **One tool plane, two transports**: the tool registry, schemas, and handlers live once in `packages/mcp`; `orun-cloud mcp` (stdio) and `apps/mcp-worker` (Streamable HTTP) are thin transports over it. (3) **Task-shaped curation, not endpoint mirroring**: v1 ships ≤ 25 tools grouped by job-to-be-done; a tool that needs data the public API can't provide triggers a contracts+api-edge extension first, never a private seam. (4) **Read-only by default**: write tools ship later (MCP5), carry MCP tool annotations (`readOnlyHint`/`destructiveHint`), require `Idempotency-Key`, and are individually policy-gated; both transports support a read-only mode. (5) **Secrets stay write-only**: tools may list secret *metadata*, never values (the `07-config` invariant is transport-independent). (6) **Runtime schemas live in `packages/mcp`** (zod, `satisfies`-checked against `@saas/contracts` types); `packages/contracts` stays dependency-free. (7) **The remote worker is its own bounded context on its own hostname** (`mcp.<domain>`), not an api-edge facade — MCP sessions are streaming and stateful-ish, but no policy bypass is possible because every tool call physically re-enters api-edge as an authenticated HTTP request. (8) **This is the platform MCP; the work MCP is orun's** — `orun mcp serve` (orun-work WP5, shipped) owns work-plane reads and the four write mutators; this server never grows work-plane tools (no lifecycle/status/pin surface here either), so the ecosystem's two MCP servers stay non-overlapping by construction. |

## Thesis

Every serious SaaS platform is about to have two client populations: humans in
the console and agents in editors/terminals. This platform is unusually well
positioned for the second one — it already has what agents need and most
platforms lack: a **provenance-correct, git-derived service catalog** (what
exists, who owns it, what depends on what), a **runs/state plane** (what
deployed, where, why it failed, with logs), a **complete audit log**, and a
**deny-by-default policy engine** in front of everything. What it lacks is the
protocol adapter that makes those surfaces legible to an agent without a human
copy-pasting JSON.

Since this epic was first authored the platform has committed to the bet at
program scale: **`saas-agents` (AG) + `orun/specs/orun-agents/` build the agent
runtime and its cloud control plane, and both name this epic as the platform
MCP the in-sandbox runtime calls** — for runs, logs, audit, usage — with the
tool plane explicitly scoped out of AG and into here. The work plane shipped
its own MCP (`orun mcp serve`, orun-work WP5) for work-item reads/mutations,
fixing the ecosystem vocabulary: **the work MCP is orun's; the platform MCP is
this epic.** The MCP server is the **distribution channel for the moat** — the
catalog and runs plane become the context source an engineer's agent (and the
platform's own hosted agents) reaches for: "who owns billing-worker?", "why
did the last prod run fail?", "what changed in this org yesterday?" — precisely
the traffic that makes a platform sticky. It serves two client populations
with one surface: **external agents** (Claude Code, Cursor on a laptop) and
**hosted agent sessions** (AG6 sandboxes, whose session credential is just
another bearer token to this server).

The bet mirrors the catalog epic's honesty guarantee: because the MCP server is
*just another API client*, its blast radius is exactly an API key's blast
radius. No new trust path, no shadow API, no policy fork — the whole epic is
additive surface over shipped rails.

## How it maps to the reference platforms

| GitHub MCP / Stripe MCP / Cloudflare MCP | Here |
|---|---|
| Remote MCP endpoint with OAuth | `apps/mcp-worker` (Streamable HTTP) + identity-worker OAuth 2.1 (MCP2–MCP3) |
| Local server via existing CLI credentials | `orun-cloud mcp` stdio command riding the CLI token store (MCP1) |
| Curated toolsets (not raw REST mirror) | ≤ 25 task-shaped tools over catalog/runs/audit/usage/config (MCP0, design §4) |
| Read-only mode / tool annotations | `--read-only`, `readOnlyHint`/`destructiveHint`, per-key write gating (MCP4–MCP5) |
| "Connect an agent" console page + install snippets | Console Connect surface with per-client snippets + key minting (MCP7) |
| Usage-metered, plan-gated agent access | `mcp.tool_call` metering + `feature.mcp_server` entitlement seam (MCP6) |

## Read order

1. `README.md` (this file) — status + thesis + milestones-at-a-glance + scope.
2. `design.md` — the client-not-service invariant, the two-transport
   architecture, the credential model, the v1 tool catalog, schema discipline,
   resources/prompts, the write path, and safety rails.
3. `implementation-plan.md` — MCP0–MCP8, each with "done when".
4. `risks-and-open-questions.md` — locked-vs-open decisions (OAuth scope, tool
   budget, entitlement placement, spec-revision pinning, session state).

## Milestones at a glance

| ID | Milestone | Status |
|----|-----------|--------|
| MCP0 | Tool-plane foundation: `packages/mcp` registry + zod schema discipline + scope resolution + error mapping + the read-only core toolset over `@saas/sdk` | ✅ Shipped (19 tools, 65 tests) |
| MCP1 | Local stdio server: `orun-cloud mcp` CLI command riding the existing token store; per-client config snippets | ✅ Shipped (`mcp serve` + `mcp tools`) |
| MCP2 | Remote server: `apps/mcp-worker` (Streamable HTTP, stateless-first) with `sk_` API-key bearer auth; own hostname; component intent | ✅ Shipped (stateless JSON transport; `mcp.<domain>` hostname is an infra follow-up) |
| MCP3 | OAuth 2.1 for remote clients: protected-resource metadata + authorization server endpoints on identity-worker (rides OP1), PKCE + dynamic client registration | 🗓️ Planned (decision: DCR posture) |
| MCP4 | Resources & prompts: catalog entity overviews and run logs as MCP resources; packaged prompts (investigate-failed-run, access-review, usage-review) | 🗓️ Planned |
| MCP5 | Write tools (gated): task-shaped mutations with `Idempotency-Key`, tool annotations, `via: mcp` audit provenance, read-only mode enforcement | 🗓️ Planned |
| MCP6 | Metering + entitlement: `mcp.tool_call` usage events, `feature.mcp_server` seam + U7 upgrade UX, quota checks | 🗓️ Planned (decision: free-vs-paid line) |
| MCP7 | Console "Connect an agent" surface: install snippets, key minting with per-key tool scope, connection status; docs | 🗓️ Planned |
| MCP8 | Conformance + agent-eval harness: `tests/mcp` contract suite, MCP Inspector smoke in CI, scripted agent-task evals, tool-budget guard | 🗓️ Planned |

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| The MCP tool plane (`packages/mcp`): registry, schemas, handlers, scope resolution; the stdio transport in the CLI; the remote worker transport; OAuth 2.1 authorization for remote clients; curated read tools over catalog/runs/audit/security-events/usage/billing/config/membership/webhooks; catalog + run-log resources; packaged prompts; gated write tools over existing public mutations; metering/entitlement/rate-limit integration; the console Connect page; conformance and agent-eval tests | A new business API or any private data seam (tools consume the public surface; gaps extend contracts+api-edge first); policy evaluation inside the MCP server (deny-by-default stays in the owning workers); secret **values** over any tool (metadata only); an agent runtime/orchestrator (we serve agents, we don't run them); NL→SQL or direct DB access; the NL *analytics* affordances of P7 (anomaly detection, NL entitlement queries — they stay parked on P3/B9 data); writing catalog content (forbidden by `18-state.md` — catalog tools are read-only plus SC6 operational annotations at most) |

## Relationship to existing work

- **OP / `saas-orun-platform`**: OP1's CLI session machinery (short-lived access
  JWT + rotating refresh, device flow) is exactly the token model MCP3's OAuth
  authorization needs — the epic reuses it rather than minting a second token
  plane. OV6/OV7 (catalog projection, Runs) are the highest-value read surfaces
  the tools wrap.
- **`components/18-state.md`**: binding. The catalog read-model is git-derived,
  never authored — MCP catalog tools are read-only; the only adjacent write is
  SC6's clearly-separated operational-annotation overlay, if/when SC6 ships.
- **SC / `saas-service-catalog`**: SC0's `state.getOrgCatalogEntity` is the
  natural backing for `catalog_get_entity`; until it lands the tool emulates via
  the OV6 list endpoint's filters. The epics don't compete — SC builds the human
  portal, MCP the agent portal, over the same projection.
- **AG / `saas-agents` + `orun/specs/orun-agents/`**: the anchor client. AG
  hosts `orun agent serve` in sandboxes whose egress allow-list already
  reserves the MCP hostname; the runtime calls this server with its AG6
  session-scoped token (a bearer for an `sp_` principal — accepted by MCP2's
  bearer-forwarding with zero special-casing). AG scopes the tool plane out to
  this epic; this epic scopes the runtime/sandbox/relay out to AG. **MCP0–MCP2
  are on AG's critical path** — sequence them ahead of AG6's remaining slices.
- **WP / PM (orun-work, orun-work-v3 — cross-repo)**: the **work MCP**
  (`orun mcp serve`, WP5, shipped) owns work-plane reads-with-evidence and the
  four write mutators; it may grow timeline/doc tools (PM v3). This server
  never wraps work-plane surfaces (locked decision 8) — an agent that needs
  both connects to both servers.
- **ES / `saas-event-streaming` (shipped)**: the typed event pipeline
  (`event_log` explorer, groups, keyset iterators in `EventsClient`) is the
  backend for the v1 `events_search` tool — richer than the audit read alone.
- **CD / `saas-catalog-docs` (shipped)**: `state.listCatalogDocs` /
  `readCatalogDoc` back `catalog_read_doc` — doc-set browse + body-by-digest,
  superseding the raw `readObjectText` plan.
- **SM / `saas-secret-manager`**: the future "agent needs a secret" path is
  SM3's lease-bound run-scoped resolve (`how: agent-session`) — never an MCP
  read tool. This epic's secrets surface stays metadata-only forever (risk R3).
- **B3 / B11 / U7**: edge idempotency + rate limiting apply automatically
  (every tool call re-enters api-edge); entitlement gating and upgrade UX reuse
  the shipped B11 seam and U7 patterns, mirroring how SC gates scorecards.
- **PX6 (Cmd-K resource search)**: a future `search` tool should wrap whatever
  cross-resource search endpoint PX6 lands — not build a second one.
- **P7 / `saas-product-areas`**: this epic **promotes the agent-surface half of
  P7** (the protocol/connectivity leg). P7's NL-analytics legs (anomaly
  detection, NL→entitlement query) remain parked on P3/B9.
