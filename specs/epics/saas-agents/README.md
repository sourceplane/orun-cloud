# Epic: saas-agents

**Host the runtime, don't build it.** The agent runtime lives in the **orun
binary** (`orun/specs/orun-agents/`): a local-first delegation loop that turns
a frozen brief into a PR, with agent types as content-addressed objects and
Claude Code (or any binary) behind a driver seam. This epic is the **cloud
control plane** around that runtime: spin up a Daytona sandbox, run
`orun agent serve` inside it under a session-scoped service principal, relay
its event stream to a new **Agents** sidebar tab, and drive it from the
**Work tab** — "Design with agent" on a Spec (epic files + `contract_propose`
via the `catalog affected` blast radius) and dispatch-is-assignment autonomous
implementation runs. The runtime is a client of the platform's public surfaces;
this epic never re-implements it. Pairs `orun/specs/orun-agents/` (cluster
**AG**, shared).

## Status

| Field | Value |
|-------|-------|
| Status | **Draft** — authored, not yet ready to build; open decisions in `risks-and-open-questions.md` |
| Cluster | **AG** (agent framework — cross-repo, shared with `orun`; **orun owns the runtime + object kinds (AG0–AG4)**, this repo owns the **sandbox control plane + console (AG5–AG12)**) |
| Owner(s) | `apps/agents-worker` (new, primary — the control plane) · `packages/db/src/agents` (schema + repositories) · `apps/identity-worker` (session-token mint, AG6) · `apps/web-console-next` (Agents tab + Work-tab spawn points, AG7/AG8) · `apps/metering-worker`/`billing-worker` (AG10) · `packages/contracts`/`sdk` (session/profile types) |
| Target branch | `claude/agents-epic-design-vnvyyq` (design PR), then `main` (PRs merged incrementally) |
| Builds on | **`orun/specs/orun-agents/` (AG0–AG4 — the runtime; hard dependency)** · `orun-work` v2 (WP0 shipped; dispatch-is-assignment, the four agent tools) · `saas-mcp-server` (MCP0–MCP2 — the platform MCP the in-sandbox runtime calls) · `saas-secret-manager` (SM3 lease-bound resolve, `how: agent-session`) · `saas-integrations` IG4 (token broker — repo clone + PR) · `saas-orun-platform` OP1 (short-lived JWT + rotating refresh — the session-token pattern) · state-worker leases (`run-coordinator.ts` — the session-lease idiom) |
| Decisions locked | (1) **The runtime is the orun binary, not this worker** — `apps/agents-worker` provisions sandboxes, mints credentials, relays events, and dispatches; it does **not** supervise the agent. The agent loop, driver, brief, MCP wiring, tool policy, and session sealing all live in orun (`internal/agent`). This is the decisive change from the v1 design. (2) **Cloud is the same binary in a box** — a cloud session is `orun agent serve` inside Daytona; anything a cloud agent can do, a laptop `orun agent` can do, minus governance/persistence. (3) **Sandboxes are a provider seam** — `SandboxProvider`, **Daytona first** (+ a `local-docker` dev adapter + fixtures so CI is vendor-free); compute never on Cloudflare. (4) **No new identity plane** — an agent is an existing membership **service principal with a mandatory responsible owner**; a session holds a short-TTL, lease-coupled **session token** for that principal, never an `sk_` key. (5) **The runtime is a client** — everything it does to the platform re-enters api-edge / mcp-worker with the session credential, so RBAC/rate-limits/audit/metering apply unchanged; this epic adds no policy logic. (6) **The work plane stays the only task truth** — design output is a PR + `contract_propose`; promotion is the existing `assign` mutator; **session control-plane states are infrastructure facts** (provisioning/running/suspended), categorically distinct from derived work rungs. (7) **Sessions are cattle** — durable state is the sealed session objects (in orun's graph) + R2 relay mirror + provider snapshots; a per-session **Durable Object** is the live relay and partition unit. |
| Gate | **Human-dependent.** Needs: a Daytona org + API credential per environment (escrowed via `saas-secrets-sync`); a model-provider credential path (Anthropic key/OAuth) as workspace secrets; product sign-off on autonomy defaults and the free-vs-paid line (`risks-and-open-questions.md` A1–A4). AG5 (provider plane, dev adapter) is human-independent above the seam. The runtime half (AG0–AG4) is entirely human-independent — see the paired epic. |

## Thesis

The platform's whole differentiation is a **truth plane** agents need and
others fake: a git-derived catalog, an execution/state plane, and a work plane
where lifecycle is *derived, never authored*. `saas-mcp-server` makes that
truth legible to other people's agents. `orun-agents` makes the **orun binary
run agents against it**, local-first. This epic is the last mile: **run that
binary in the cloud** — the way Claude Code's remote environments do — attached
to the workspace, governed by its RBAC, driven from the product.

The decisive design choice (v2) is where the runtime lives. v1 put a supervisor
in a cloud worker (`packages/agent-runner`); v2 deletes it. The runtime belongs
in orun, because orun already *is* the truth engine — putting the agent there
means a laptop session and a cloud session are the **same code path**, a run is
**reproducible by content hash** across both, and "any preferred agent" is a
driver in the binary, not a cloud integration. What's left for the cloud is
exactly what the cloud is good at: **a box, an identity, a relay, and a
dispatch trigger.** That thinness is the point — `apps/agents-worker`'s blast
radius is a service principal's blast radius, and every session is a client of
the same public surfaces a human uses.

## How it maps to the references

| Claude Code remote env / Copilot agent / Devin | Here |
|---|---|
| Ephemeral cloud sandbox, snapshot/resume | `SandboxProvider` (Daytona first) + provider snapshots (AG5) |
| Session attached to the product; live transcript | per-session DO relaying **orun's** event stream + SSE (AG6/AG7) |
| Scoped repo credential injected at runtime | IG4 installation tokens, short-lived (AG6) |
| Agent identity distinct from the human, attributed | `sp_` service principal + mandatory responsible owner (AG6) |
| "Assign the bot an issue" → PR | dispatch **is** the work plane's `assign` mutator (AG9) |
| The agent's actual brain/loop | **the orun binary** (`orun/specs/orun-agents/`), not this worker |

## Read order

1. This README.
2. **`orun/specs/orun-agents/`** — the runtime (read first; this epic depends
   on it): README → design → data-model (the agent object kinds).
3. [`design.md`](./design.md) — the control plane: provider seam, session
   identity, the DO relay, work-tab flows, autonomy, security posture.
4. [`implementation-plan.md`](./implementation-plan.md) — AG5–AG12.
5. [`risks-and-open-questions.md`](./risks-and-open-questions.md).

## Milestones at a glance (cloud-owned; AG0–AG4 in `orun/specs/orun-agents/`)

| ID | Milestone | Stage | Status |
|----|-----------|-------|--------|
| AG5 | Sandbox provider plane: `SandboxProvider` + Daytona adapter + `local-docker` dev adapter; base snapshot (orun + drivers, zero creds); `apps/agents-worker` control plane; egress policy | 0 | 🏗️ Foundation shipped (`agents` schema `650_agents_foundation`, `@saas/db/agents` model+repo+memory, `@saas/contracts/agents` incl. `SandboxProvider` seam, dormant `apps/agents-worker` `/health`); Daytona/dev adapters + base snapshot ⛔ credential-gated |
| AG6 | Session identity & attach: agent profiles as `sp_` principals w/ responsible owner; session-bound token mint/refresh; `agent.session.*` policy; the **`orun agent serve` ↔ per-session DO relay** (event ingest → R2 mirror + SSE); leases + sweep; IG4 repo tokens; SM3 `how: agent-session` | 1 | 🏗️ Control-plane routes shipped (profiles + sessions + event relay read over the `agents` schema, actor-gated + policy-authorized); session-token mint, the DO relay, and sandbox provisioning are the remaining slices |
| AG7 | Console **Agents** tab: sessions list, live session detail (transcript from the DO relay, steer, approvals, artifacts, cost), profiles, informed-consent spawn dialog | 1 | 🗓️ Planned |
| AG8 | Design runs from the Work tab: "Design with agent" on a Spec → the runtime's brief (`catalog affected`) → epic files PR + `contract_propose` → tasks derive Ready | 2 | 🗓️ Planned (needs WP1/WP2) |
| AG9 | Dispatch & autonomy: assignment-triggered implementation runs (spawn `orun agent serve`); the autonomy ladder (`manual → assist → auto-dispatch → full`); concurrency caps; fix runs on red gates | 2 | 🗓️ Planned |
| AG10 | Metering, quotas, entitlement: `agents.session_minutes`/`agents.tokens` meters; `feature.agents` + U7 upgrade UX; per-org concurrent-session quota | 3 | 🗓️ Planned (decision: free-vs-paid line) |
| AG11 | Hardening: `agent.*` audit, transcript redaction, orphan/eviction sweeps, injection posture tests, scripted agent evals, incident runbook | 3 | 🗓️ Planned |
| AG12 | **Provider connections (BYO Daytona + Anthropic)**: workspace-connected provider accounts — `agents.provider_connections` + key custody in the secret manager (reserved `agents/providers/*` namespace, config-worker stays the only decrypt path) + verification pings + Integrations-hub cards / "Add your AI provider keys". Un-gates AG5-live + AG9: the sandbox and model credentials become tenant-connected instead of operator-escrowed | 0→1 | 🗓️ Planned (design landed; keys offered for verification) |

## Scope boundary

| In scope (cloud) | Out of scope |
|----------|--------------|
| The sandbox control plane (`apps/agents-worker`): `SandboxProvider` + Daytona adapter, session lifecycle, the per-session DO relay + R2 mirror, session identity (profiles as service principals, session-bound tokens); the console Agents tab + Work-tab spawn points; design runs + dispatch + the autonomy ladder + caps; metering/entitlement; audit + hardening | **The agent runtime itself** — loop, driver, brief, MCP wiring, tool policy, session sealing, the agent object kinds — all `orun/specs/orun-agents/` (**AG0–AG4**); a new identity/token plane (sessions ride existing `sp_` principals); policy evaluation inside the control plane (RBAC stays in the owning workers); any work-plane status write or new work mutator; the MCP tool plane (`saas-mcp-server`); tenant-resource convergence (component `08`); running untrusted tenant code as a product |

## Relationship to existing work

- **`orun/specs/orun-agents` (AG0–AG4)** — the runtime; a hard dependency. The
  seam is `orun agent serve` (there) ↔ the session token + DO relay (here). The
  agent's inputs and actions are sealed objects in orun's graph; this epic
  mirrors segments/transcripts into R2 for the console relay but the system of
  record is the sealed session.
- **`orun-work` (WP)** — the task source. This epic adds zero work-plane
  surface: design runs use the four agent tools, dispatch *is* `assign`,
  progress is observed. WP1/WP2/WP5 are dependencies of AG8/AG9.
- **`orun-work-v3` (PM)** — the *project surface* AG renders into. PM5 owns
  the board/timeline/triage view of agent work — agents as assignable seats,
  the infra-fact session chip beside a rung, the contract-review Triage lane,
  timeline attribution — while AG owns the runtime and the dispatch trigger.
  The seam is the same `assign` mutator and `contract_propose` flag; neither
  epic re-implements the other's half.
- **`saas-mcp-server` (MCP)** — the platform MCP the in-sandbox runtime calls
  (with the session credential) for runs/logs/audit/usage. MCP scoped out the
  runtime; this epic scopes out the tool plane.
- **`saas-secret-manager` / `saas-integrations` / `saas-orun-platform`** — the
  credential, repo-token, and session-token rails (SM3, IG4, OP1).
- **`agents/` + `ai/` (repo root)** — the dogfood loop; AG8/AG9 productize it.
