# Epic: saas-agents

**Run the agents.** Give Orun Cloud a first-party agent runtime — remote,
sandboxed agent sessions (Daytona first, provider seam from day one) that
attach to the platform through a session-scoped service-principal credential,
use the orun + platform MCP servers as hands, and consume the **work plane**
as their task source. A new **Agents** tab in the primary sidebar owns the
surface; the Work tab grows contextual spawn points: a top-level Spec can be
handed to a **design run** that turns it into epic files + task contracts
(using `catalog_affected` to identify the blast radius), and a Ready task
promotes to implementation by **assignment** — which auto-spawns an
**implementation run** that ends in a PR the observation log tracks like any
human's. This is the epic `orun/specs/orun-work/agents-and-mcp.md` §5
reserves by name ("the later Agents epic"), and the runtime `saas-mcp-server`
deliberately scoped out ("we serve agents, we don't run them" — this epic
runs them).

## Status

| Field | Value |
|-------|-------|
| Status | **Draft** — authored, not yet ready to build; open decisions in `risks-and-open-questions.md` |
| Cluster | **AG** (agent runtime — the execution half of the platform's agent bet; pairs `saas-mcp-server` **MCP** (the client surface) and `orun-work` **WP** (the task source)) |
| Owner(s) | `apps/agents-worker` (new, primary — the control plane) · `packages/db/src/agents` (schema + repositories) · `packages/agent-runner` (new — the in-sandbox supervisor) · `packages/contracts`/`sdk`/`cli` (session/profile types + client) · `apps/identity-worker` (session-token mint, AG2) · `apps/web-console-next` (Agents tab + Work-tab spawn points, AG4/AG6) · `apps/metering-worker`/`billing-worker` (AG8) |
| Target branch | `claude/agents-epic-design-vnvyyq` (design PR), then `main` (PRs merged incrementally) |
| Builds on | `orun-work` v2 (WP0 substrate shipped: `560_work_foundation_v2`, `@saas/db/work` fold + mutators; dispatch-is-assignment rails in `orun/specs/orun-work/agents-and-mcp.md` §5) · `saas-mcp-server` (MCP0–MCP2 tool plane + remote worker — the hands) · `saas-secret-manager` (SM3 lease-bound resolve — how model keys + secrets reach a sandbox) · `saas-integrations` IG4 (token broker — repo clone + PR write-back) · `saas-orun-platform` OP1 (short-lived JWT + rotating refresh — the session-token pattern) · state-worker run coordination + leases (`run-coordinator.ts`, `coordination-native.ts` — the lease idiom AG3 reuses) · `internal/affected` / `catalog_affected` (blast-radius input to design runs) |
| Decisions locked | (1) **Sandboxes are an external provider behind a seam** — compute never runs on Cloudflare Workers; `SandboxProvider` interface with **Daytona first** (same posture as Polar-first billing and GitHub-first integrations: one live adapter, a seam not a promise). (2) **No new identity plane**: an agent is an existing membership **service principal (`sp_`) with a mandatory responsible owner** (the work-plane rule); a session holds only a **short-TTL, session-bound token** for that principal, refreshed over the session lease — never an `sk_` key, never a long-lived secret baked into an image. (3) **The runtime is a client, never a fourth plane**: everything a session does to the platform re-enters api-edge / mcp-worker with the session credential, so deny-by-default RBAC, rate limits, idempotency, audit, and metering apply unchanged (mirrors `saas-mcp-server` decision 1). (4) **The work plane stays the only task truth**: sessions never write status (unrepresentable — the MCP has no such tool); design output is a PR + `contract_propose`; promotion to implementation *is* the existing `assign` mutator; session **control-plane states are infrastructure facts** (provisioning/running/suspended), a different category from work rungs, which stay derived. (5) **Harness-pluggable, Claude Code first**: the sandbox runs an `AgentHarness` behind a seam (headless stream-JSON), so "or any preferred agent" is a profile field, not a rewrite. (6) **Sessions are cattle**: all durable state lives in the append-only session event log + R2 transcript chunks + provider snapshots; a per-session **Durable Object** is the live relay and the partition unit (the `saas-orun-backend-merge` per-run-DO answer, reapplied). |
| Gate | **Human-dependent.** Needs: a Daytona organization + API credential (per-environment, escrowed via `saas-secrets-sync`); a model-provider credential path (Anthropic API key or OAuth) as workspace secrets; product sign-off on autonomy defaults and the free-vs-paid line (`risks-and-open-questions.md` A1–A4). AG0 (contracts + schema + seams, dormant) is human-independent. |

## Thesis

The platform has spent its differentiation budget building the **truth plane**
agents need and other platforms fake: a git-derived catalog with ownership and
dependencies, an execution/state plane with runs and gates, and a work plane
where **lifecycle is a derived query** — an agent physically cannot lie about
progress because no status-write surface exists. `saas-mcp-server` makes that
truth legible to *other people's* agents (Cursor, Claude Code on a laptop).
What's missing is the last mile: **the platform running agents itself**, the
way Claude Code's remote environments do — a sandbox spun up from the product,
attached to the workspace, doing the work, and disappearing.

That last mile is worth more here than on a generic tracker, because of what
the loop closes into. Elsewhere "AI agent" means a chatbot that drags cards.
Here the full development loop the founders already use — *spec → design →
contracts → Ready → implementation → PR → gates → Released* — is machine-
legible end to end: a design run derives its blast radius from
`catalog_affected` instead of guessing; an implementation run receives a
frozen brief (`spec_get`, the sealed contract) instead of a prompt; and its
output is judged by the **observation log** — branch, PR, gate results, live
revision — exactly like a human's. The work plane laid the rails
(`agents-and-mcp.md` §5: "dispatch is assignment... The Agents section is UI
over rails this spec lays"); this epic is that section, plus the runtime
underneath it.

The runtime itself stays deliberately thin. It owns **sandboxes, sessions,
credentials, and streaming** — nothing else. It holds no policy logic (the
session credential re-enters the public surface), no task state (the work
plane owns it), no tool semantics (the MCP servers own them). Its blast
radius is a service principal's blast radius. That thinness is what makes it
scale-safe: sessions are cattle keyed to an append-only event log, the
per-session Durable Object is the partition unit, and the sandbox provider is
a seam — Daytona today, anything with create/exec/snapshot/destroy tomorrow.

## How it maps to the references

| Claude Code remote environments / Copilot coding agent / Devin | Here |
|---|---|
| Ephemeral cloud sandbox per session, snapshot/resume | `SandboxProvider` (Daytona first) + provider snapshots (AG1) |
| Session attached to the product; live transcript, steer, stop | per-session Durable Object + SSE attach; Agents tab (AG3/AG4) |
| Scoped repo credential injected at runtime | IG4 token broker installation tokens, short-lived (AG2) |
| Agent identity distinct from the human, but attributed | `sp_` service principal + mandatory responsible owner (AG2) |
| "Assign the bot an issue" → PR | dispatch **is** the work plane's `assign` mutator, gated on Ready (AG7) |
| MCP servers as the agent's hands | orun MCP (WP5) + platform MCP (`saas-mcp-server`) wired in-session (AG5) |
| Metered minutes / premium requests | `agents.*` meters + `feature.agents` entitlement (AG8) |

## Read order

1. This README — thesis, decisions, milestones.
2. [`design.md`](./design.md) — the architecture: bounded context, provider
   seam, identity chain, session event plane, work-tab flows, autonomy ladder,
   security posture.
3. [`implementation-plan.md`](./implementation-plan.md) — AG0–AG9 with "done
   when" clauses and sequencing.
4. [`risks-and-open-questions.md`](./risks-and-open-questions.md) — the gate
   items and default leans.
5. Cross-repo pair: [`orun/specs/orun-agents/`](../../../../orun/specs/orun-agents/)
   (holding) — the CLI/engine half (`orun spec pull` in-sandbox, MCP stdio,
   conformance fixtures).

## Milestones at a glance

| ID | Milestone | Stage | Status |
|----|-----------|-------|--------|
| AG0 | Foundation: vocabulary + component spec `19-agent-sessions.md`, `agents` schema (profiles, sessions, session_events), contracts/SDK types, `SandboxProvider` + `AgentHarness` seams, dormant `apps/agents-worker` | 0 | 🗓️ Planned (human-independent) |
| AG1 | Sandbox provider plane: Daytona adapter, base snapshot (orun CLI + harness + `agent-runner` supervisor), lifecycle create/suspend/resume/destroy, egress policy | 0 | 🗓️ Planned (⛔ Daytona credential to go live) |
| AG2 | Session identity & access: agent profiles as `sp_` principals w/ responsible owner, session-bound token mint/refresh, `agent.session.*` policy actions, secret resolve with `how: agent-session`, IG4 repo tokens | 0 | 🗓️ Planned |
| AG3 | Session lifecycle & event plane: create/attach/steer/stop, per-session DO relay, append-only `session_events`, R2 transcript chunks, SSE, idle suspend + lease sweep | 1 | 🗓️ Planned |
| AG4 | Console: **Agents** sidebar tab — sessions list, live session detail (transcript, steer, approvals, artifacts, cost), profiles management, spawn dialog | 1 | 🗓️ Planned |
| AG5 | MCP as hands: orun MCP (WP5) + platform MCP wired in-session with the session credential; per-profile tool policy; approval relay to the console | 2 | 🗓️ Planned (needs WP5 + MCP2) |
| AG6 | Design runs from the Work tab: "Design with agent" on a Spec → frozen brief + `catalog_affected` → epic files PR + `contract_propose` → tasks derive Ready | 2 | 🗓️ Planned (needs WP1/WP2) |
| AG7 | Dispatch & autonomy: assignment-triggered implementation runs, the autonomy ladder (`manual → assist → auto-dispatch → full`), concurrency caps, fix runs on red gates | 2 | 🗓️ Planned |
| AG8 | Metering, quotas, entitlement: `agents.session_minutes` / `agents.tokens` meters, `feature.agents` + U7 upgrade UX, per-org concurrent-session quota | 3 | 🗓️ Planned (decision: free-vs-paid line) |
| AG9 | Hardening: `agent.*` audit events, transcript redaction, orphan/eviction sweeps, injection posture tests, scripted agent evals, incident runbook | 3 | 🗓️ Planned |

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| The agent-session control plane (`apps/agents-worker`): sandbox provider seam + Daytona adapter, session lifecycle, per-session DO event relay, append-only session event log + R2 transcripts; agent identity (profiles as service principals, session-bound tokens); the in-sandbox `agent-runner` supervisor + base snapshot; MCP wiring with the session credential; the console Agents tab + Work-tab spawn points; design runs (spec → epic files + contracts) and implementation runs (assignment-triggered, PR-terminated); the autonomy ladder + concurrency caps; metering/entitlement; audit + hardening | A new identity/token plane (sessions ride existing `sp_` principals — decision 2); policy evaluation inside the runtime (deny-by-default stays in the owning workers — decision 3); any work-plane status write or new work mutator (the closed vocabularies stay closed — decision 4); building or hosting the MCP tool plane (that is `saas-mcp-server`); tenant-resource deployment/reconciliation (that is `saas-resources-runtime` / component `08` — different plane: it converges *infrastructure*, this runs *development agents*); writing catalog content (forbidden by `18-state.md`); running untrusted tenant-authored code as a product (sandboxes run known harnesses over tenant repos); self-hosted/BYO-compute providers (a later adapter, not v1) |

## Relationship to existing work

- **`orun-work` (WP)** — the task source and the integrity backbone. This epic
  adds *zero* work-plane surface: design runs write through the four existing
  agent tools (`task_create`, `task_comment`, `task_assign`,
  `contract_propose`); dispatch *is* `assign`; progress is observed, never
  asserted. WP1 (query API), WP2 (GitHub ingester), WP4 (seal/pull), WP5 (MCP
  write path) are hard dependencies of AG5–AG7 and are tracked there, not here.
- **`saas-mcp-server` (MCP)** — the hands. MCP scoped out the runtime; this
  epic scopes out the tool plane. AG5 consumes MCP0/MCP2 (registry + remote
  worker) and adds only wiring: the session credential presented to
  `mcp.<domain>`, plus the per-profile tool policy and approval relay.
- **`saas-secret-manager` (SM)** — how any secret (model API key, resolved
  `secret://` refs a task's gates need) reaches a sandbox: the SM3 lease-bound
  resolve with execution-platform fact `how: agent-session`. Values are
  TTL'd, injected as env, redacted at capture (SD-8) — never in transcripts,
  never in snapshots.
- **`saas-integrations` (IG)** — repo access. Sessions clone and push via IG4
  token-broker installation tokens scoped to the linked repo; the branch name
  carries the task key so WP2's claim join links the PR with no new protocol.
- **`saas-orun-platform` (OP) / `saas-orun-backend-merge` (BM)** — the
  patterns: OP1's short-lived JWT + rotating refresh is the session-token
  shape; BM's per-run Durable Object is the per-session DO shape; state-worker
  leases are the session-lease shape.
- **`saas-resources-runtime` (P2) / component `08`** — adjacent, not
  overlapping: 08 orchestrates *declared tenant resources* toward desired
  state; this epic runs *interactive/autonomous development sessions*. Neither
  consumes the other in v1; a Released bridge (P2's `revision_live`) is how an
  agent's merged work eventually reaches the Released rung.
- **`agents/` + `ai/` (repo root)** — the dogfood: the orchestrator/
  implementer/verifier loop that builds this repo is the manual prototype of
  exactly this epic. AG6/AG7 productize that loop for every workspace.
