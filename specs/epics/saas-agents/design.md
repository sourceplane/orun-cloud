# saas-agents — Design (the cloud control plane)

Status: Draft (normative once AG5 lands)

The cloud half: **host and govern** the orun agent runtime, don't rebuild it.
Written against repo reality as of 2026-07-08: the work v2 substrate is live
(`packages/db/src/work/`); state-worker carries run coordination + leases
(`run-coordinator.ts`); identity resolves `user | service_principal | workflow`
(`resolve-bearer.ts`) with `sk_` keys backed by service principals
(`api-key-admin.ts`); the sidebar nav model is
`apps/web-console-next/src/components/shell/nav-items.ts`; both MCP servers are
specs. **The runtime is specified in `orun/specs/orun-agents/`** — this document
covers only what wraps it. There is no sandbox layer in the codebase today.

---

## 0. The split (read this first)

```
┌──────────────────────── orun binary (orun/specs/orun-agents) ────────────────────────┐
│ internal/agent: the loop · AgentDriver (Claude Code) · brief · MCP wiring · tool      │
│ policy · session event log + sealing.   `orun agent serve --session <id>`             │
└───────────────────────────────────────────┬───────────────────────────────────────────┘
                                             │ dials out (event stream ↔ control channel)
┌────────────────────────────── apps/agents-worker (THIS EPIC) ──────────────────────────┐
│ SandboxProvider (Daytona) · session-token mint · per-session DO relay · dispatch/triggers │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

**The control plane never supervises the agent.** It provisions a box, injects
a bootstrap credential, starts `orun agent serve`, receives orun's event
stream, and dispatches. Everything with agent semantics is in orun. This
inverts the v1 design (which had a `packages/agent-runner` supervisor in the
cloud); v1's supervisor is deleted — orun is the supervisor.

Consequence: `apps/agents-worker` is small and holds no policy logic, no tool
semantics, no task state. Its blast radius is a service principal's.

---

## 1. Bounded context

`apps/agents-worker` owns: sandbox provisioning, session lifecycle (the
*infrastructure* state machine), credential-mint choreography, the per-session
Durable Object relay, and dispatch/trigger evaluation. No agent code executes
on Cloudflare.

| Piece | Where | Role |
|---|---|---|
| Control plane | `apps/agents-worker` (new) | provider adapters (`src/providers/daytona.ts`), per-session DO, trigger consumer, HTTP via api-edge facade |
| Schema + repos | `packages/db/src/agents` + `agents` migration | `agent_profiles`, `agent_sessions`, `session_relay` (R2 mirror index), `autonomy_policies` |
| Types | `packages/contracts/src/agents.ts` | profile/session shapes, `SandboxProvider` interface (types only) |
| SDK/CLI | `packages/sdk`, `packages/cli` | `agents.sessions.*`, `agents.profiles.*` |
| Console | `apps/web-console-next` | Agents tab + Work-tab spawn points |

The system of record for what an agent *did* is the sealed
`AgentSessionSnapshot` in orun's object graph
(`orun/specs/orun-agents/data-model.md` §3); `session_relay` is a projection
for the console's live/replay reads, not a second truth.

---

## 2. The sandbox provider seam (AG5)

Sandboxes are external compute behind a narrow interface (the Polar-first /
GitHub-first posture applied to compute). Daytona first; the interface is only
what the control plane provably needs:

```ts
interface SandboxProvider {
  create(spec: SandboxSpec): Promise<SandboxRef>;   // from base snapshot
  exec(ref, cmd, opts): Promise<ExecHandle>;        // start `orun agent serve`
  snapshot(ref): Promise<SnapshotId>;               // suspend
  resume(snapshot): Promise<SandboxRef>;
  destroy(ref): Promise<void>;
  health(ref): Promise<SandboxHealth>;
}
```

- **The base snapshot ships orun.** `agents-base@<version>` = the orun binary +
  its bundled drivers (Claude Code) + git + toolchains. No credentials baked.
  Workspace-agnostic, cacheable cross-tenant. (The runtime *is* the binary, so
  the image is "a machine with orun on it" — nothing bespoke.)
- **`local-docker` dev adapter + recorded fixtures** keep CI and local dev
  vendor-free (the park-and-continue posture).
- **No inbound path to sandboxes.** `orun agent serve` dials out to the session
  DO; the control plane never reaches in — NAT-safe, provider-portable.
- **Egress allowlist by default**: platform API + MCP hostnames, the git host,
  the model provider, package registries. Extensions are per-profile, audited.
- **Over-destroy on ambiguity**: an unknown/expired session's sandbox is
  destroyed — safe because durable state is the sealed session, not the box.

---

## 3. Session identity: the credential chain (AG6)

### 3.1 Profiles are service principals with a responsible owner

An **agent profile** (cloud) binds a workspace's use of an orun agent *type* to
a membership **service principal (`sp_`)** with a **mandatory responsible
owner** (the work-plane rule). The profile carries the workspace override of the
type's capability contract (narrowing-only — it can tighten `tools`/`mayAffect`
but never widen the sealed ceiling; `orun/specs/orun-agents/agent-type-format.md`
§3) plus autonomy defaults. Seeded `design-default`/`impl-default` per
workspace. **No new identity table beyond the profile** — authorization,
membership, and audit see a plain service principal.

### 3.2 The session token (no new token plane)

A session holds a **session token**: a short-TTL bearer for the profile's
service principal, minted by identity-worker with `sessionId` + `(orgId,
projectId?)` claims — the OP1 short-lived-JWT/rotating-refresh pattern plus the
workflow-token binding, composed. `resolve-bearer` resolves it to
`actorType: 'service_principal'` with `sessionId` surfaced for audit; policy is
unchanged. The control plane injects a **single-use bootstrap token** at
`create`; `orun agent serve` exchanges it for the session token and refreshes
over the **session lease** (the heartbeat channel). Lease lapses → refresh dies
→ a runaway sandbox's credential expires within one TTL (~15 min). Kill revokes
the refresh chain immediately.

### 3.3 Secrets & repo access

- **Model credential** and task-declared `secret://` refs resolve through the
  SM3 **lease-bound resolve** with execution-platform fact **`how:
  agent-session`** — TTL'd env, redacted at capture (SD-8), never in the sealed
  session, never in a snapshot.
- **Repo credential**: an IG4 installation token, short-lived, repo-scoped,
  fetched by the runtime with the session token. PRs are the GitHub App with
  the responsible owner co-attributed; the branch carries the task key so WP2's
  claim join links the PR with no new protocol.

---

## 4. The session event plane & the DO relay (AG6)

### 4.1 Control-plane states are infrastructure facts

```
requested → provisioning → running ⇄ awaiting_approval
                              ⇅
                          suspended
running → completing → completed | failed | canceled | expired
```

Stored, mutable-by-the-control-plane facts about *infrastructure* — never
confused with work rungs, which stay derived from the work logs. A session can
be `completed` while its task sits In Review for a week; the console renders
both, side by side.

### 4.2 The per-session Durable Object is a relay, not a supervisor

orun (in the sandbox) owns the session event log and seals it
(`AgentSessionSegment`, `orun/specs/orun-agents/data-model.md` §3.2). The DO's
job is **live fan-out**: receive orun's ordered event batches (dedupe by seq),
mirror them to R2 + the `session_relay` index for durable console reads, fan
out to attached clients over SSE, and carry the steer/approval **return queue**
back to orun. The DO holds no authority over the agent — it is the wire between
the sandbox and the console. It flushes durably and is reconstructible; N
sessions scale as N independent DOs (the BM per-run-DO pattern).

### 4.3 Leases, sweeps, suspend

A running session holds a lease (orun's heartbeat through the DO; the
state-worker lease idiom). A cron sweep in agents-worker: lapsed lease →
`failed(lease_lost)` + `destroy`; `suspended` past retention → `expired` +
snapshot GC; orphaned provider sandboxes → destroyed. Idle → suspend (provider
snapshot, box destroyed); resume re-runs `orun agent serve` and re-bootstraps
credentials (tokens never survive a snapshot). The sweep is what makes
"sessions are cattle" true under partial failure.

### 4.4 Attach & steer

Console attach = snapshot bootstrap (R2-mirrored events) + cursor replay + live
SSE from the DO — the same read shape as the work console (WP1). Steering and
approval verdicts enqueue on the DO; orun picks them up on its return channel
and hands them to the driver.

---

## 5. The console surface (AG7)

A new primary-rail entry in `nav-items.ts`, after Activities:

```ts
{ href: `${orgBase}/agents`, label: "Agents", icon: "Bot" }
```

Routes under `orgs/[orgSlug]/agents/`:

- **Sessions list** (`/agents`) — live/suspended/recent: state, profile,
  spawned-by, work binding (spec/task key → Work tab), runtime, cost.
- **Session detail** (`/agents/[sessionId]`) — the cockpit: streaming
  transcript (R2 snapshot + DO SSE), steer input, **approvals inbox** (pending
  `approval_requested` as actionable cards), artifacts (PR links), the
  work-binding panel (contract + derived rung *with evidence*, from the work
  fold), cost, kill switch. The same view `orun agent`'s TUI renders locally —
  console and TUI are two front-ends over one event vocabulary.
- **Profiles** (`/agents/profiles`) — the workspace binding of an orun agent
  type: principal, responsible owner, capability narrowing, autonomy defaults,
  role grants (deep-link to Settings › Access).
- **Spawn dialog** — the informed-consent screen: profile, principal, repo
  scope, resolvable secrets, tool policy — exactly what the session will get.

Follows U-track conventions (empty/skeleton, URL scope, Cmd-K).

---

## 6. Design runs from the Work tab (AG8)

*A top-level Spec is created; one click hands it to an agent that turns it into
epic files + a contracted task set; when humans ack, the work is agent-ready.*

In the two-log model:

1. **Spawn point.** A Spec whose fold shows incomplete contracts renders
   **"Design with agent"** (Work tab); the dialog pre-fills the design profile
   + linked repo.
2. **Brief.** The control plane spawns `orun agent serve` in design mode; orun
   assembles the sealed brief — Spec doc + repo spec conventions + the
   **blast radius** (`catalog affected` + graph neighbors), frozen as content
   (`orun/specs/orun-agents/design.md` §4).
3. **The run.** The agent drafts `specs/<slug>/…` on a branch, creates/updates
   tasks (`task_create`), proposes contracts (`contract_propose`: goal,
   `affects[]` from the blast radius, `doneWhen[]`, `gates[]`, `deps[]`),
   comments, opens the PR — all through the four agent tools + git.
4. **The human gate = "next stage".** `contract_propose` applies-but-flags;
   humans ack + merge. The moment a contract completes and deps close, the fold
   derives **Ready**. Nobody moved a card; the design run made Ready *true*.

Degradation is honest: unresolved `affects` render unresolved; an over-broad
blast radius is visible in the contract diff; a bad run is a rejected PR.

---

## 7. Dispatch & autonomy (AG9)

### 7.1 Dispatch is assignment

Promoting a task to implementation **is** the existing `assign` mutator with an
agent principal as subject, gated on Ready (`orun-work` agents-and-mcp §5).
agents-worker reacts: spawn `orun agent serve` in implementation mode with the
frozen brief (`orun spec pull <spec>@<hash>` + the task contract). The run ends
at an open PR; the observation log owns the rest (In Review → Done → Released),
indistinguishable from a human's PR.

### 7.2 Trigger evaluation

agents-worker consumes a **cursor lane** over the work logs (the ES1 lane
contract; poll the fold API until ES1). On any event touching a spec/task with
an autonomy policy, it re-checks predicates **against the fold** (the lane is a
doorbell, not truth). Dispatch is idempotent: assignment is visible in the fold,
so `ready ∧ unassigned ∧ under-cap` can't double-fire; session creation dedupes
on `(taskKey, contractHash)`.

### 7.3 The autonomy ladder

Per-spec (fallback per-workspace) policy in `agents.autonomy_policies` —
control-plane config, **not** work truth:

| Level | Design | Implementation |
|---|---|---|
| `manual` (default) | click | click |
| `assist` | suggested on spec creation | suggested on Ready |
| `auto-dispatch` | suggested | **auto-assigned** on Ready, up to caps |
| `full` | **auto-spawned** on spec creation | auto-assigned; **fix runs** on red gates |

Caps are hard and layered: per-workspace concurrency (entitlement, AG10),
per-spec parallelism, per-task retry budget (two failed fix runs → park with a
`task_comment`). `full` still requires the contract-ack step — autonomy skips
*clicks*, never the human gate on contracts (A3).

### 7.4 Fix runs

A Done-blocked task (merged, a gate red) under `full` spawns a fix run: brief =
the failing gate's run evidence (platform MCP) + the contract. Same machinery,
same caps, same PR ending.

---

## 8. Metering & entitlement (AG10)

`agents.session_minutes` (lease heartbeats), `agents.tokens` (orun `cost_sample`
events relayed up), `agents.sessions_started`. `feature.agents` gates spawn;
per-workspace concurrency is plan-tiered (B11 + U7). Cost renders on session
detail + Usage & quota. Model-provider spend rides the tenant's own credential
(§3.3); the platform meters its compute + coordination, not the tenant's model
bill (A4).

---

## 9. Security posture (AG11)

**Prompt injection / hijacked harness** — contained by construction, layer by
layer: sandbox egress allowlist bounds *where*; the session token bounds *what
it can be* (one principal, deny-by-default RBAC, ~15-min lease life); orun's
tool policy bounds *what it can do* (writes ask); the work plane bounds *what it
can claim* (no status surface); the PR gate bounds *what it can ship*. The
design assumes a harness *will* be adversarial for one session; every layer is
sized for that. Note the runtime enforces tool policy sandbox-side **and** every
MCP call re-enters api-edge, so RBAC re-enforces independently (defense in
depth).

**Credential exfiltration** — nothing long-lived to steal: bootstrap token is
single-use; session token dies with the lease; repo token is short-lived;
secrets are TTL'd, redacted at capture, absent from the sealed session and
snapshots.

**Runaway cost** — leases + sweeps kill zombies; caps bound concurrency;
retry budgets bound loops; one-click kill revokes the refresh chain.

**Audit** — `agent.*` via `appendEventWithAudit`:
`agent.session.started/completed/failed/killed`, `agent.approval.resolved`,
`agent.profile.changed`, `agent.dispatch.auto`. Every session is
replayable end-to-end — and additionally sealed in orun's graph
(`orun agent replay`), so the cloud audit row and the content-addressed session
agree.

**Evals (AG11 exit bar)** — `tests/agents`: fixture spec → design run →
contracts match golden; Ready fixture task → implementation run → task-keyed PR;
injection fixtures (hostile repo content) → observed containment. The
harness-seam conformance test lives in orun (AG4).

---

## 10. Sequencing

- **AG5–AG7 need the runtime (orun AG0–AG4) but no WP/MCP progress**: an
  interactive cloud session (spawn from the Agents tab, repo + prompt,
  transcript, PR out) is shippable on the runtime + IG4 + identity alone — the
  first demoable cloud slice, and it de-risks the provider seam.
- **AG8 waits on WP1/WP2** (fold reads + claim join) and the runtime's design
  mode; **AG9 wants WP4** (seal/pull for frozen briefs) and WP5 (the four write
  tools); until WP5 the runtime uses read-only MCP + direct git (the PR is still
  the artifact).
- **Credential gates (Daytona, model keys) block live paths only**: the
  `local-docker` dev adapter + fixtures keep AG5–AG7 mergeable
  human-independently.
