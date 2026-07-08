# saas-agents — Implementation Plan (AG5–AG11, the control plane)

The cloud-owned milestones. The runtime (AG0–AG4) lives in
`orun/specs/orun-agents/implementation-plan.md` and is a hard dependency.
Stages: **0** provider foundation, **1** hosted sessions, **2** work-driven
autonomy, **3** scale + hardening. Design refs are to [`design.md`](./design.md).

## AG5 — Sandbox provider plane — 🗓️ Planned (⛔ live paths need the Daytona credential)

- `SandboxProvider` seam in `apps/agents-worker`; **Daytona adapter**
  (create/exec/snapshot/resume/destroy/health); a `local-docker` dev adapter +
  recorded fixtures so CI never needs the vendor (design §2).
- Base snapshot in CI: `agents-base@<version>` = the **orun binary** + bundled
  drivers + git + toolchains, zero credentials baked.
- Egress allowlist; provider credential escrowed via `saas-secrets-sync`
  (operator-level, never tenant-visible); `apps/agents-worker` skeleton
  (`/health`, component intent, DO class registered).
- Owner: `apps/agents-worker` + CI lane.
- **Done when:** adapter conformance (same fixtures, both adapters) passes
  create→exec→snapshot→resume→destroy; a sandbox from the base snapshot runs
  `orun agent serve` to "attached, awaiting brief" against a stub relay;
  over-destroy sweep covered by tests.

## AG6 — Session identity & the DO relay — 🗓️ Planned

- Agent profiles bind to `sp_` principals with a **mandatory responsible
  owner**; capability narrowing over the orun agent type (never widening);
  seeded `design-default`/`impl-default` (design §3.1).
- identity-worker: session-token mint (short-TTL principal bearer + `sessionId`
  + org/project) + lease-coupled refresh; `resolve-bearer` surfaces `sessionId`;
  single-use bootstrap token (design §3.2).
- Policy: `agent.session.create/read/steer/kill`, `agent.profile.*`.
- The **`orun agent serve` ↔ per-session DO relay**: ordered ingest (seq
  dedupe), R2 mirror + `session_relay` index, SSE fan-out, steer/approval return
  queue; leases + sweep cron (design §4).
- Secrets: `how: agent-session` accepted by SM3; repo tokens via IG4;
  task-keyed branch convention.
- Owner: `apps/identity-worker` + `packages/policy-engine` + `apps/agents-worker`
  + config-worker (SM3 seam).
- **Done when:** a live sandbox running `orun agent serve` authenticates,
  streams events to the DO, and the DO mirrors + fans out over SSE; the session
  token authorizes exactly the principal's grants; refresh dies when the lease
  lapses; no long-lived credential ever appears in the sandbox (inspection
  test); kill revokes within one TTL; suspend/resume re-bootstraps credentials.

## AG7 — Console: the Agents tab — 🗓️ Planned

- `nav-items.ts`: `Agents` after Activities; routes under `orgs/[orgSlug]/agents/`
  — sessions list, session detail (transcript from R2+DO, steer, approvals
  inbox, artifacts, work-binding panel with fold evidence, cost, kill), profiles,
  informed-consent spawn dialog (design §5).
- SDK (`agents.sessions.*`, `agents.profiles.*`) + CLI passthrough
  (`orun-cloud agents spawn/list/attach/kill`).
- U-track conventions: empty/skeleton, URL scope, Cmd-K.
- Owner: `apps/web-console-next` + `packages/sdk` + `packages/cli`.
- **Done when:** the interactive cloud slice is buyer-demoable: spawn from the
  console on a linked repo, watch the live transcript, steer, approve a gated
  action, get a PR link, kill — all through public surfaces with the session
  principal in the audit trail, and the same session `orun agent replay`-able.

## AG8 — Design runs from the Work tab — 🗓️ Planned (needs WP1 + WP2)

- Work-tab action "Design with agent" on Specs with incomplete contracts;
  spawn dialog pre-filled (design §6).
- Spawn `orun agent serve` in design mode; the runtime assembles the sealed
  brief (spec doc + conventions + `catalog affected` blast radius). Deliverable:
  epic files PR + `contract_propose`/`task_create`/`task_comment` via the four
  agent tools.
- Console: proposed-contract review next to the spec PR.
- Owner: `apps/agents-worker` + `apps/web-console-next` (Work tab).
- **Done when:** the fixture flow passes: create a Spec → design run → PR has
  conventional epic files, proposed contracts carry non-empty `affects[]`
  resolved against the catalog, and after simulated ack + merge the fold derives
  Ready — zero writes outside the four agent tools + git.

## AG9 — Dispatch & the autonomy ladder — 🗓️ Planned (wants WP4 + WP5)

- Assignment-triggered implementation runs: lane consumer (ES1; poll fallback)
  → fold re-check (`ready ∧ unassigned ∧ under-cap`) → spawn `orun agent serve`
  with the frozen brief (`spec pull @hash`) (design §7.1–7.2).
- `autonomy_policies` (`manual → assist → auto-dispatch → full`) + caps
  (workspace concurrency, per-spec parallelism, per-task retry budget with
  park-and-comment); spec-level "Dispatch all Ready" fan-out; fix runs at `full`
  (design §7.3–7.4).
- Owner: `apps/agents-worker` + `apps/web-console-next`.
- **Done when:** assigning a Ready fixture task spawns exactly one session
  ending in a task-keyed PR; double-delivery can't double-spawn (dedupe test);
  caps + retry budgets hold under a storm fixture; `full` on a fixture spec
  drives create→design→ack→dispatch→PR with only the ack click.

## AG10 — Metering, quotas, entitlement — 🗓️ Planned (decision: free-vs-paid line, A2)

- `agents.session_minutes`/`agents.tokens`/`agents.sessions_started`;
  `feature.agents` gate; plan-tiered concurrency quota; U7 upgrade CTA; cost on
  session detail + Usage rollup (design §8).
- Owner: `apps/metering-worker` + `apps/billing-worker` + `apps/agents-worker` +
  console.
- **Done when:** metering reconciles with lease/heartbeat truth in a replay
  test; an over-quota spawn is refused with the upgrade path; usage renders on
  the existing Usage surface.

## AG11 — Hardening & evals — 🗓️ Planned

- `agent.*` audit via `appendEventWithAudit`; transcript redaction against SD-8;
  sweep/orphan chaos tests; incident runbook (kill-all, provider-outage
  degradation).
- `tests/agents`: golden design/implementation runs; injection fixtures →
  containment asserted. (The harness-seam conformance test lives in orun AG4.)
- Owner: `apps/agents-worker` + `tests/agents` + docs.
- **Done when:** the eval suite is a CI gate; injection fixtures show no status
  assertion, no secret egress, no off-allowlist call; the runbook is exercised
  once against stage.

## Sequencing note

Build order **AG5 → AG6 → AG7**, then **AG8 → AG9**, with **AG10/AG11**
overlapping the tail — but all of it sits on the runtime (orun **AG0–AG4**),
which must land first (and does so human-independently). The first demoable
cloud slice is AG7 (a hosted interactive session ending in a PR) and needs no
WP/MCP progress. The credential gates (Daytona, model keys) block live paths
only; the dev adapter + fixtures keep AG5–AG7 mergeable. AG8/AG9 touch the
Work-tab console surface — coordinate with WP1's board work at review time.
