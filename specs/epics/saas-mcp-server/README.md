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
| Status | **Draft** — MCP0–MCP2 are human-independent and ride entirely on shipped surfaces (SDK, state plane, OP1 auth); MCP3 (OAuth) and MCP6 (entitlement) carry decisions in `risks-and-open-questions.md` |
| Cluster | **MCP** (agent client surface — promotes the agent-surface half of `saas-product-areas` **P7**) |
| Owner(s) | `packages/mcp` (new, primary) + `packages/cli` (stdio transport) + `apps/mcp-worker` (new, remote transport) + `apps/identity-worker` (OAuth 2.1 authorization, MCP3) + `packages/contracts`/`sdk` (schema seam) + `apps/web-console-next` (Connect page, MCP7) + `apps/billing-worker`/`metering-worker` (entitlement + metering, MCP6) |
| Target branch | `claude/orun-cloud-mcp-server-h95b57` (PRs merged incrementally) |
| Builds on | `packages/sdk` (contract-driven client — the only way tools touch the platform), `epics/saas-orun-platform/` OP1 (CLI session auth: short-lived JWT + rotating refresh — the substrate MCP3's OAuth rides), OV6 (org catalog projection) + OV7 (Runs), `components/18-state.md` (catalog invariant), B3 (edge idempotency/rate-limit families), B11 (entitlements), `packages/db/src/work/sync.ts` (the one-write-path verdict contract that already names "the future MCP" as a client — W5) |
| Decisions locked | (1) **The MCP server is a client, not a service**: it holds no service bindings, no DB access, and no policy logic — it consumes the public API through `@saas/sdk` with the caller's credential, so deny-by-default RBAC, edge rate limits, and audit apply identically to agent and human traffic. (2) **One tool plane, two transports**: the tool registry, schemas, and handlers live once in `packages/mcp`; `orun-cloud mcp` (stdio) and `apps/mcp-worker` (Streamable HTTP) are thin transports over it. (3) **Task-shaped curation, not endpoint mirroring**: v1 ships ≤ 25 tools grouped by job-to-be-done; a tool that needs data the public API can't provide triggers a contracts+api-edge extension first, never a private seam. (4) **Read-only by default**: write tools ship later (MCP5), carry MCP tool annotations (`readOnlyHint`/`destructiveHint`), require `Idempotency-Key`, and are individually policy-gated; both transports support a read-only mode. (5) **Secrets stay write-only**: tools may list secret *metadata*, never values (the `07-config` invariant is transport-independent). (6) **Runtime schemas live in `packages/mcp`** (zod, `satisfies`-checked against `@saas/contracts` types); `packages/contracts` stays dependency-free. (7) **The remote worker is its own bounded context on its own hostname** (`mcp.<domain>`), not an api-edge facade — MCP sessions are streaming and stateful-ish, but no policy bypass is possible because every tool call physically re-enters api-edge as an authenticated HTTP request. |

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

The codebase has already placed this bet twice: the work-plane sync contract
(`packages/db/src/work/sync.ts`) is explicitly designed so "an agent mutator
gets the identical accept/reject verdict the UI's optimistic client does" and
names *the future MCP* as its client (W5); and roadmap leg **P7** ("AI-native
affordances") registers NL-driven queries as a planned differentiator. This
epic is the promotion of that seam into a product: the MCP server is the
**distribution channel for the moat** — the catalog and runs plane become the
context source an engineer's agent reaches for ("who owns billing-worker?",
"why did the last prod run fail?", "what changed in this org yesterday?"),
which is precisely the traffic that makes a platform sticky.

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
| MCP0 | Tool-plane foundation: `packages/mcp` registry + zod schema discipline + scope resolution + error mapping + the read-only core toolset over `@saas/sdk` | 🗓️ Planned (human-independent) |
| MCP1 | Local stdio server: `orun-cloud mcp` CLI command riding the existing token store; per-client config snippets | 🗓️ Planned (human-independent) |
| MCP2 | Remote server: `apps/mcp-worker` (Streamable HTTP, stateless-first) with `sk_` API-key bearer auth; own hostname; component intent | 🗓️ Planned (human-independent) |
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
- **W / orun-work (cross-repo)**: `packages/db/src/work/sync.ts` names MCP as a
  first-class client of the one-write-path mutator verdict contract (W5). When
  the work plane reaches this repo's surface, its MCP tools ride that contract
  as-is; MCP5's write tools follow the same one-write-path discipline meanwhile.
- **B3 / B11 / U7**: edge idempotency + rate limiting apply automatically
  (every tool call re-enters api-edge); entitlement gating and upgrade UX reuse
  the shipped B11 seam and U7 patterns, mirroring how SC gates scorecards.
- **PX6 (Cmd-K resource search)**: a future `search` tool should wrap whatever
  cross-resource search endpoint PX6 lands — not build a second one.
- **P7 / `saas-product-areas`**: this epic **promotes the agent-surface half of
  P7** (the protocol/connectivity leg). P7's NL-analytics legs (anomaly
  detection, NL→entitlement query) remain parked on P3/B9.
