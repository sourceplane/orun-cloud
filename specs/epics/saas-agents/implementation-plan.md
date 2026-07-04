# saas-agents — Implementation Plan (AG0–AG9)

Milestones for the agent runtime. Stages: **0** foundation (no live compute),
**1** interactive sessions, **2** work-driven autonomy, **3** scale +
hardening. Design references are to [`design.md`](./design.md) sections.

## AG0 — Foundation: contracts, schema, seams — 🗓️ Planned

The dormant substrate (the OP0 posture): everything typed and migrated,
nothing serving.

- `specs/components/19-agent-sessions.md`: the durable bounded-context
  contract (from design §1, §4); `core/vocabulary.md` gains *Agent profile*,
  *Agent session*, *Design run*, *Implementation run*, *Dispatch*.
- `packages/contracts/src/agents.ts`: profile/session/event shapes, the
  closed `session_events` kind vocabulary, `SandboxProvider` +
  `AgentHarness` interface types (design §2.1, §2.4).
- `packages/db/src/agents` + migration (`agents` schema): `agent_profiles`,
  `agent_sessions`, `session_events` (append-only, CHECK-enforced kinds),
  `autonomy_policies`; repositories with memory + Postgres impls (the
  `@saas/db/work` pattern).
- `apps/agents-worker` skeleton: component intent, `/health` only, wrangler
  template, DO class registered but unreachable.
- Owner: `packages/contracts` + `packages/db` + `apps/agents-worker`.
- **Done when:** schema migrates cleanly; repositories round-trip with
  append-only enforcement tested; contracts compile into SDK types; the
  worker deploys dormant; component spec 19 merged.

## AG1 — Sandbox provider plane — 🗓️ Planned (⛔ live paths need the Daytona credential)

- `SandboxProvider` runtime seam in agents-worker; **Daytona adapter**
  (create/exec/snapshot/resume/destroy/health) against their API; a
  `local-docker` dev adapter + recorded fixtures so CI and local dev never
  need the vendor (design §11).
- Base snapshot build in CI: `agents-base@<version>` with `agent-runner`,
  orun CLI, git, toolchains, Claude Code binary — zero credentials baked
  (design §2.2).
- Egress allowlist enforcement in the sandbox spec; provider credential
  escrowed via `saas-secrets-sync` (operator-level, never tenant-visible).
- Owner: `apps/agents-worker` + `packages/agent-runner` (build) + CI lane.
- **Done when:** adapter conformance suite (same fixtures, both adapters)
  passes create→exec→snapshot→resume→destroy; a sandbox from the base
  snapshot runs the supervisor to "manifest fetched" against a stub control
  plane; over-destroy sweep behavior covered by tests.

## AG2 — Session identity & access — 🗓️ Planned

- Agent profiles bind 1:1 to service principals with a **mandatory
  responsible owner**; seeded `design-default` / `impl-default` per
  workspace (design §3.1).
- identity-worker: session-token mint (short-TTL bearer for the principal +
  `sessionId` claim + org/project binding) and lease-coupled refresh;
  `resolve-bearer` surfaces `sessionId` for audit (design §3.2).
- Policy: `agent.session.create/read/steer/kill`, `agent.profile.*` actions
  in the policy engine; deny-by-default wiring in api-edge facade routes.
- Secrets: `how: agent-session` execution-platform fact accepted by the
  SM3 resolve path; reserved model-key convention documented (design §3.3).
- Repo access: supervisor fetches IG4 installation tokens with the session
  token; task-keyed branch convention (`agent/<TASK-KEY>-<slug>`).
- Owner: `apps/identity-worker` + `packages/policy-engine` +
  `apps/agents-worker` + config-worker (SM3 seam).
- **Done when:** a session token authorizes exactly the principal's grants
  (policy tests); refresh dies when the lease lapses (integration test);
  a live sandbox obtains a repo token and clones without any long-lived
  credential appearing in the sandbox (asserted by inspection test).

## AG3 — Session lifecycle & event plane — 🗓️ Planned

- Control-plane state machine (design §4.1) + session leases + the sweep
  cron (lapsed → destroy; suspended → retention GC; orphan reconciliation)
  (design §4.2).
- Per-session Durable Object: ordered ingest (seq dedupe), SSE fan-out,
  steer/approval queue, durable flush (Postgres events + R2 chunks),
  DO-reconstructible-from-storage invariant (design §4.4).
- `agent-runner` full loop: bootstrap-token exchange, manifest, harness
  launch (Claude Code headless stream-JSON), event batching, heartbeat,
  steer/approve pickup, idle-suspend request, terminal flush (design §2.3).
- Attach = snapshot + cursor replay + SSE (the WP1 read shape).
- Owner: `apps/agents-worker` + `packages/agent-runner`.
- **Done when:** an end-to-end session (spawn → prompt → transcript streams
  → steer mid-run → complete) works against the dev adapter in CI; kill
  revokes within one token TTL; suspend/resume round-trips with credentials
  re-bootstrapped; replay of a finished session reproduces the transcript
  byte-identically from Postgres+R2 alone.

## AG4 — Console: the Agents tab — 🗓️ Planned

- `nav-items.ts`: `Agents` entry after Activities; routes under
  `orgs/[orgSlug]/agents/` — sessions list, session detail (live transcript,
  steer, approvals inbox, artifacts, work-binding panel with fold evidence,
  cost, kill), profiles CRUD, spawn dialog with the informed-consent summary
  (design §5).
- SDK (`agents.sessions.*`, `agents.profiles.*`) + CLI
  (`orun-cloud agents spawn/list/attach/kill`).
- U-track conventions: empty/skeleton states, URL scope, Cmd-K entries.
- Owner: `apps/web-console-next` + `packages/sdk` + `packages/cli`.
- **Done when:** the interactive slice is buyer-demoable end to end: spawn
  from the console on a linked repo, watch the live transcript, steer,
  approve a gated action, get a PR link, kill a session — all through
  public surfaces with the session principal in the audit trail.

## AG5 — MCP as hands — 🗓️ Planned (needs MCP2 + WP5)

- Supervisor writes harness MCP config: orun MCP + platform MCP remote
  endpoints, session token as credential (design §6).
- Per-profile tool policy (allow/deny/ask), enforced in the supervisor,
  mirrored in profile config; "ask" → `approval_requested` → console card →
  verdict round-trip.
- Tool-call + approval events land in the session log with tool name +
  argument digest (full payloads to R2).
- Owner: `packages/agent-runner` + `apps/agents-worker` +
  `apps/web-console-next` (approvals).
- **Done when:** a session answers "what does this workspace own and what
  did the last run fail on?" through MCP tools only (no scraping); a
  denied tool is refused sandbox-side *and* would be refused
  platform-side (defense-in-depth test); an "ask" tool blocks until a
  console verdict and both outcomes are in the event log.

## AG6 — Design runs from the Work tab — 🗓️ Planned (needs WP1 + WP2)

- Work-tab contextual action: "Design with agent" on Specs whose fold shows
  incomplete contracts; spawn dialog pre-filled (design §7).
- Brief assembly in the control plane: spec envelope + doc, repo spec
  conventions, `catalog_affected` + graph neighborhood blast radius.
- The run's deliverable contract: epic files under `specs/<slug>/` on a
  branch + `task_create`/`contract_propose`/`task_comment` through the four
  agent tools + PR.
- Console: proposed-contract review affordance links the ack step next to
  the spec PR.
- Owner: `apps/agents-worker` + `apps/web-console-next` (Work tab) — the
  work mutators/tools are WP-owned and unchanged.
- **Done when:** the fixture flow passes in CI: create a Spec → design run →
  PR contains conventional epic files, proposed contracts carry non-empty
  `affects[]` resolved against the catalog, and after simulated human ack +
  merge the fold derives Ready for the contracted tasks — with zero writes
  outside the four agent tools + git.

## AG7 — Dispatch & the autonomy ladder — 🗓️ Planned (wants WP4)

- Assignment-triggered implementation runs: lane consumer (ES1 contract;
  poll fallback) → fold re-check (`ready ∧ unassigned ∧ under-cap`) → spawn
  with frozen brief (`spec_get`@hash until WP4's pull lands) (design §8.1–8.2).
- `autonomy_policies` (`manual → assist → auto-dispatch → full`) per
  spec/workspace + the caps: workspace concurrency, per-spec parallelism,
  per-task retry budget with park-and-comment (design §8.3).
- Spec-level "Dispatch all Ready" fan-out action; fix runs on red gates at
  `full` (design §8.4).
- Owner: `apps/agents-worker` + `apps/web-console-next` (Work tab actions,
  policy editor).
- **Done when:** assigning a Ready fixture task to the impl profile spawns
  exactly one session that ends in a task-keyed PR; double-delivery of the
  triggering event cannot double-spawn (dedupe test); caps and retry
  budgets enforce under a storm fixture; `full` autonomy on a fixture spec
  drives create→design→ack→dispatch→PR with only the ack click.

## AG8 — Metering, quotas, entitlement — 🗓️ Planned (decision: free-vs-paid line, A2)

- `agents.session_minutes` / `agents.tokens` / `agents.sessions_started`
  usage events; `feature.agents` entitlement gating spawn; plan-tiered
  concurrent-session quota; U7 upgrade CTA on the cap; cost on session
  detail + Usage & quota rollup (design §9).
- Owner: `apps/metering-worker` + `apps/billing-worker` +
  `apps/agents-worker` + console.
- **Done when:** metering events reconcile with lease/heartbeat truth in a
  replay test; an over-quota spawn is refused with the upgrade path; usage
  renders on the existing Usage surface.

## AG9 — Hardening & evals — 🗓️ Planned

- `agent.*` audit family via `appendEventWithAudit`; transcript redaction
  verified against the SD-8 capture point; sweep/orphan chaos tests;
  incident runbook (kill-all switch, provider outage degradation).
- `tests/agents` eval suite: golden design-run + implementation-run
  fixtures; injection fixtures (hostile repo content → containment
  asserted); harness-seam conformance (stub second harness passes the
  lifecycle suite unchanged) (design §10).
- Owner: `apps/agents-worker` + `tests/agents` + docs.
- **Done when:** the eval suite is a CI gate; injection fixtures show no
  status assertion, no secret egress, no off-allowlist call; the runbook
  is exercised once against stage.

## Sequencing note

Build order **AG0 → AG1 → AG2 → AG3 → AG4**, then **AG5 → AG6 → AG7**, with
**AG8/AG9** overlapping the tail. The first demoable slice is AG4 (an
interactive remote session ending in a PR) and needs *no* work-plane or MCP
progress — it de-risks the provider seam while WP1/WP2/WP5 and MCP0–MCP2
land in their own epics. The two credential gates (Daytona, model keys)
block only live paths: the dev adapter + fixtures keep every milestone
mergeable human-independently (the park-and-continue posture). Nothing in
AG0–AG4 competes with WP or MCP for files; AG5–AG7 touch the Work-tab
console surface and should coordinate with WP1's board work at review time.
