# saas-agents — Design

Status: Draft (normative once AG0 lands)

The agent runtime: remote sandboxed sessions attached to the platform.
Written against repo reality as of 2026-07-04: the work v2 substrate is live
(`packages/db/src/work/` — model, fold, memory+Postgres repositories;
migration `560_work_foundation_v2`; no API/console consumer yet), state-worker
carries run coordination + leases (`run-coordinator.ts`,
`coordination-native.ts`), identity resolves three actor types
(`resolve-bearer.ts`: `user | service_principal | workflow`) with `sk_` API
keys backed by service principals (`api-key-admin.ts`), the sidebar nav model
is `apps/web-console-next/src/components/shell/nav-items.ts`
(`buildNavSections`), and both MCP servers are specs, not code
(`saas-mcp-server` MCP0+; `orun/specs/orun-work/agents-and-mcp.md` WP5).
There is no sandbox/VM execution layer anywhere in the codebase today.

---

## 1. The shape of the plane (AG0)

### 1.1 One new bounded context

`apps/agents-worker` owns the **agent-session control plane**: sandbox
provisioning, session lifecycle, credential minting choreography, event
relay, and trigger evaluation. It is a control plane in the strict sense —
**no agent code executes on Cloudflare**. The data plane is the sandbox
(provider-hosted VM/container) plus the platform's existing public surfaces,
which the sandbox calls like any other client.

What the runtime is **not** (these define the seams):

- **Not a fourth policy plane.** Every platform-touching action a session
  takes re-enters api-edge or mcp-worker bearing the session credential.
  The runtime never proxies privileged calls on a session's behalf.
- **Not a tracker.** Work truth lives in the work plane's two logs. The
  runtime stores *infrastructure* facts about sessions (§4.1) and nothing
  about task lifecycle.
- **Not the tool plane.** Tool schemas, handlers, and curation live in
  `packages/mcp` (platform) and the orun MCP (work/catalog). The runtime
  wires credentials and relays approvals; it defines no tools.

### 1.2 Package layout

| Piece | Where | Role |
|---|---|---|
| Control plane | `apps/agents-worker` (new) | HTTP handlers (via api-edge facade), per-session Durable Object, trigger lane consumer, provider adapters (`src/providers/daytona.ts`) |
| Schema + repos | `packages/db/src/agents` + migration `agents` schema | `agent_profiles`, `agent_sessions`, `session_events`, `autonomy_policies` |
| Supervisor | `packages/agent-runner` (new) | The process inside the sandbox: token refresh, harness launch, event streaming, approval relay (§2.3) |
| Types | `packages/contracts/src/agents.ts` | Session/profile/event shapes, provider + harness interfaces (types only; contracts stays dependency-free) |
| SDK/CLI | `packages/sdk`, `packages/cli` | `agents.sessions.*`, `agents.profiles.*`; `orun-cloud agents ...` |
| Console | `apps/web-console-next` | Agents tab + Work-tab spawn points (§5, §7) |

Component spec: **`specs/components/19-agent-sessions.md`** is authored at
AG0 with the durable contract (this design is the source).

### 1.3 Two run kinds, one machinery

| | **Design run** | **Implementation run** |
|---|---|---|
| Spawned from | a Spec (Work tab or autonomy trigger) | a Ready task's `assign` (dispatch) |
| Brief | Spec doc + workspace spec conventions + `catalog_affected` | frozen `spec_get`/`orun spec pull <spec>@<hash>` + the task contract |
| Writes | epic files PR + `contract_propose` + `task_create`/`task_comment` | code PR (branch carries task key) + `task_comment` |
| Ends when | PR opened + contracts proposed | PR opened |
| Advances work by | humans ack contracts + merge → tasks derive **Ready** | observation log: PR → In Review; merge + gates → Done; overlay → Released |

Interactive ad-hoc sessions (spawn from the Agents tab with a free prompt)
use the same machinery with no work binding — they are the "remote
environment" primitive by itself.

---

## 2. The sandbox provider seam (AG1)

### 2.1 `SandboxProvider`

Sandboxes are external compute behind a narrow interface (the Polar-first /
GitHub-first posture applied to compute). Daytona is the first adapter; the
interface is only what the control plane provably needs:

```ts
interface SandboxProvider {
  create(spec: SandboxSpec): Promise<SandboxRef>;      // from base snapshot
  exec(ref, cmd, opts): Promise<ExecHandle>;           // start supervisor
  snapshot(ref): Promise<SnapshotId>;                  // suspend support
  resume(snapshot: SnapshotId): Promise<SandboxRef>;
  destroy(ref): Promise<void>;
  health(ref): Promise<SandboxHealth>;
}
```

`SandboxSpec` = base snapshot id + resources + TTL + **egress policy** +
env (non-secret). Provider credentials (the Daytona org API key) are
platform-level operator secrets escrowed via `saas-secrets-sync` — never
tenant-visible. Rules for adapters:

- **Over-destroy on ambiguity.** A sandbox whose session is unknown/expired
  is destroyed; state loss is bounded because durable state never lives in
  the sandbox (§4.4).
- **No inbound network path to sandboxes.** The supervisor dials out
  (long-poll/SSE to the session DO); the control plane never needs to reach
  in. This keeps adapters portable across providers and NAT-safe.
- **Egress allowlist by default:** platform API + MCP hostnames, the git
  host (github.com), the model provider API, package registries. Extensions
  are per-profile config, audited.

### 2.2 The base snapshot

A versioned image (`agents-base@<version>`) built in CI containing: the
`agent-runner` supervisor, the orun CLI, git, language toolchains, and the
harness binaries (Claude Code first). **No credentials, ever** — the
snapshot is workspace-agnostic and cacheable across tenants. Session
specifics (repo, branch, brief, tokens) arrive at runtime through the
supervisor bootstrap (§2.3). Repo-specific setup (dependency install) runs
per-session; a later optimization can layer per-repo warm snapshots without
changing the contract.

### 2.3 The `agent-runner` supervisor

PID 1 of a session. Bootstrap: the control plane injects exactly one
credential at `create` — a single-use, short-TTL **bootstrap token**. The
supervisor exchanges it for the session token (§3.2), fetches the session
manifest (repo, branch, brief, harness config, tool policy), obtains a repo
token via the platform (IG4), clones, and launches the harness.

Runtime loop: stream harness events to the session DO (batched, ordered,
at-least-once with sequence numbers); heartbeat the session lease; receive
steer messages and approval verdicts on the return channel; refresh the
session token before expiry; on idle timeout, request suspend (snapshot);
on terminal states, flush the transcript tail and exit.

### 2.4 `AgentHarness`

The harness seam keeps "or any preferred agent" a profile field:

```ts
interface AgentHarness {
  launch(brief: Brief, io: HarnessIO): HarnessProc;   // headless, stream-JSON
  steer(proc, message): void;
  approve(proc, requestId, verdict): void;
  stop(proc, reason): Promise<void>;
}
```

Claude Code first (headless mode, stream-JSON events, MCP config file,
permission-prompt callbacks → approval relay). The harness contract is
events-in/events-out; a second adapter (any CLI agent with a machine
interface) must not require control-plane changes — that is the AG9
conformance test.

---

## 3. Identity: the credential chain (AG2)

### 3.1 Agents are service principals with a responsible owner

An **agent profile** = harness + model + base snapshot + tool policy +
autonomy defaults, bound 1:1 to a membership **service principal (`sp_`)**
with a **mandatory responsible owner** (`usr_`) — the work plane's rule,
adopted platform-wide. The principal carries the role grants; the owner
carries accountability (audit renders both: "agent *impl-default* (owned by
@rahul)"). Workspaces get seeded `design-default` and `impl-default`
profiles; profiles are managed in the Agents tab (AG4).

No new identity table beyond the profile: authorization, membership, and
audit all see a plain service principal. **A session's blast radius is
exactly that principal's blast radius.**

### 3.2 The session token (no new token plane)

A session never holds an `sk_` key (long-lived, revocation-heavy) — it holds
a **session token**: a short-TTL bearer for the profile's service principal,
minted by identity-worker with two extra claims: `sessionId` and the scoping
tuple `(orgId, projectId?)`. This is the OP1 short-lived-JWT + rotating-
refresh pattern plus the workflow-token binding pattern — composed, not
invented. `resolve-bearer` resolves it to `actorType: 'service_principal'`
with `sessionId` surfaced for audit; policy evaluation is unchanged.

Refresh rides the **session lease**: the supervisor's heartbeat (§4.2) is
also the refresh channel; a session whose lease lapses cannot refresh, so a
runaway sandbox's credential dies within one TTL (target: 15 min, matching
workflow tokens). Stop/kill revokes the refresh chain immediately.

### 3.3 Secrets and repo access

- **Model credential** (Anthropic key or OAuth token): a workspace secret
  under a reserved key (`secret://<ws>/agents/<profile>/MODEL_KEY`),
  resolved at session start through the SM3 **lease-bound resolve** with
  execution-platform fact **`how: agent-session`** (a `SecretPolicy` axis
  value, joining `ci-oidc | local-cli | service`). Injected as env, TTL'd,
  redacted at capture (SD-8) — never in transcripts, snapshots, or the
  session manifest.
- **Task-declared secrets**: same path, authorized by Layer-1 RBAC
  (`secret.value.use` granted to the profile's principal) ∧ Layer-2
  `SecretPolicy` (which can pin by principal, component, env, and `how`).
- **Repo credential**: an IG4 token-broker installation token scoped to the
  linked repo, short-lived, fetched by the supervisor with the session
  token. PRs are authored by the GitHub App with the responsible owner
  co-attributed; the branch name carries the task key (`agent/ORN-142-...`)
  so WP2's claim join links the PR without any new protocol.

---

## 4. Session lifecycle & the event plane (AG3)

### 4.1 Control-plane states are infrastructure facts

```
requested → provisioning → running ⇄ awaiting_approval
                              ⇅
                          suspended
running → completing → completed | failed | canceled | expired
```

These are stored, mutable-by-the-runtime facts about *infrastructure* —
"is there a sandbox and is it healthy" — and must never be confused with
work rungs, which remain derived from the two work logs. A session can be
`completed` while its task sits in In Review for a week; the Work tab reads
the fold, the Agents tab reads session state, and the session detail page
renders both side by side.

### 4.2 Leases and sweeps

Each running session holds a lease (heartbeat from the supervisor through
the session DO; the state-worker lease idiom reapplied). A cron sweep in
agents-worker: lapsed lease → mark `failed(reason: lease_lost)` + provider
`destroy` (over-destroy rule); `suspended` beyond retention → `expired` +
snapshot GC; orphaned provider sandboxes (provider list minus live sessions)
→ destroyed. The sweep is the safety net that makes "sessions are cattle"
true under partial failure.

### 4.3 The session event log

`agents.session_events` is **append-only**: `(sessionId, seq, kind, payload,
ts)` with kinds in a closed vocabulary — `state_changed · harness_event ·
message_user · message_agent · tool_call · tool_result · approval_requested
· approval_resolved · artifact_produced · cost_sample · error`. Bulk
transcript content (harness stream, tool output) goes to **R2 as
content-addressed chunks**; `session_events` rows carry refs + small
payloads, keeping Postgres rows bounded. The event log is the replay source
for the console and the evidence trail for audit; nothing edits it.

### 4.4 The per-session Durable Object

One DO per session (the BM per-run-DO answer reapplied) is the **live
relay and the partition unit**: it accepts the supervisor's ordered event
batches (dedupe by `seq`), fans out to attached console clients over SSE,
holds the steer/approval return queue, and flushes durably (events →
Postgres, chunks → R2) so the DO itself is reconstructible — killable
without data loss. Hot path never touches the shared DB; N concurrent
sessions scale as N independent DOs.

### 4.5 Attach, steer, suspend

Console attach = snapshot bootstrap (persisted events) + cursor replay +
live SSE from the DO — deliberately the same read shape as the work
console's snapshot+cursor design (WP1), not a bespoke protocol. Steering
(a user message mid-session) and approval verdicts enqueue on the DO;
the supervisor picks them up on its channel. Idle sessions (no harness
activity, no attached clients, configurable window) suspend: provider
snapshot, sandbox destroyed, state `suspended`; resume re-creates from
snapshot and re-runs the credential bootstrap (tokens never survive a
suspend).

---

## 5. The console surface (AG4)

A new primary-rail entry in `nav-items.ts`, after Activities (day-to-day
product surface, not a Settings leaf):

```ts
{ href: `${orgBase}/agents`, label: "Agents", icon: "Bot" }
```

Routes under `orgs/[orgSlug]/agents/`:

- **Sessions list** (`/agents`) — live/suspended/recent sessions: state,
  profile, spawned-by, work binding (spec/task key → Work tab), runtime,
  cost-to-date. Filters by state/profile/repo.
- **Session detail** (`/agents/[sessionId]`) — the product's cockpit:
  streaming transcript (snapshot + SSE), steer input, **approvals inbox**
  (pending `approval_requested` rendered as actionable cards), artifacts
  (PR links, files), the work-binding panel (contract + derived rung *with
  evidence*, read straight from the work fold), cost, and the kill switch.
- **Profiles** (`/agents/profiles`) — CRUD over agent profiles: harness,
  model, snapshot version, tool policy, autonomy defaults, responsible
  owner, the principal's role grants (deep-link to Settings › Access).
- **Spawn dialog** — from the Agents tab (repo + branch + prompt) or
  pre-filled from Work-tab context (§7). Shows exactly what the session
  will get: profile, principal, repo scope, secrets it can resolve, tool
  policy — the "informed consent" screen.

Empty/skeleton states, URL-driven scope, and command-palette entries follow
the U-track conventions.

---

## 6. MCP as hands (AG5)

A session's platform reach is **exactly two MCP endpoints**, both consumed
with the session token:

- **orun MCP** (WP5) — work + catalog: `work_query`, `work_get`, `spec_get`,
  `catalog_get_component`, `catalog_affected`, `catalog_graph`, and the four
  writes (`task_create`, `task_comment`, `task_assign`, `contract_propose`).
  Deliberately no status write exists — the runtime inherits the "agent
  can't lie" property from the tool plane, not from its own vigilance.
- **platform MCP** (`saas-mcp-server`, MCP2 remote worker) — runs/logs,
  catalog read model, audit, usage. Read-only core; gated writes arrive
  MCP5 and apply to sessions unchanged.

The supervisor writes the harness's MCP config at launch (remote
Streamable-HTTP endpoints + the session token). The runtime adds two
controls, both enforced supervisor-side and audited control-plane-side:

- **Per-profile tool policy**: allow/deny/ask per tool (deny-by-default for
  writes). "Ask" surfaces as `approval_requested` in the console; the
  verdict flows back over the DO. Approvals are events in the session log —
  attributable, replayable.
- **Egress ∩ tool policy**: the sandbox allowlist (§2.1) means even a
  hijacked harness cannot reach surfaces the profile was never wired to.

Local git operations (clone, commit, push) are not MCP tools — they use the
IG4 repo token directly; the PR is the auditable artifact.

---

## 7. Design runs: Spec → epic files (AG6)

The user story: *a top-level epic item is created in the Work tab; one click
hands it to an agent that turns it into epic files and a designed, contracted
task set; when the humans ack, the work is agent-ready.*

In the two-log model that becomes, precisely:

1. **Spawn point.** A Spec whose tasks lack complete contracts (fold output:
   `contractComplete = false` across tasks, or zero tasks) renders **"Design
   with agent"** on the spec (Work tab). The spawn dialog pre-fills the
   design profile + the workspace's linked repo.
2. **Brief assembly** (control plane, before launch): the Spec envelope +
   doc body; the workspace's spec conventions (the repo's `specs/README.md`
   if present); and the **blast radius** — `catalog_affected` over the spec's
   named components/paths plus `catalog_graph` neighbors. The brief states
   the deliverables contract: epic files under `specs/<slug>/` matching repo
   conventions + proposed task contracts.
3. **The run.** The agent reads the catalog (MCP), drafts
   `specs/<slug>/{README,design,implementation-plan,...}.md` on a branch,
   creates/updates tasks (`task_create`) and proposes contracts
   (`contract_propose`: goal, `affects[]` from the blast-radius analysis,
   `doneWhen[]`, `gates[]`, `deps[]`), comments its reasoning
   (`task_comment`), and opens the PR.
4. **The human gate — where "next stage" happens.** `contract_propose`
   applies-but-flags (the work plane's rule); humans ack contracts and merge
   the spec PR. The moment a task's contract is complete and its deps close,
   the fold derives **Ready**. Nobody moved a card; the design run made
   Ready *true*, and the fold noticed.

Degradation is honest by construction: unresolved `affects` keys render
unresolved (never dropped); an over-broad blast radius is visible in the
contract diff the human acks; a bad design run is just a rejected PR.

---

## 8. Dispatch: autonomous implementation (AG7)

### 8.1 Dispatch is assignment (verbatim from the rails)

Promoting a task to implementation **is** the existing `assign` mutator with
an agent principal as subject, gated on Ready — `agents-and-mcp.md` §5
implemented literally. agents-worker reacts to the assignment: spawn an
implementation run — `orun spec pull <spec>@<hash>` frozen brief + the task
contract as the brief, worktree on a task-keyed branch, MCP as hands. The
run ends at an open PR; from there the observation log owns the story
(PR → In Review, merge + gates green → Done, overlay live → Released),
indistinguishable from a human's PR. Spec-level "promote to implementation"
is a fan-out convenience: assign every Ready task of the spec to the
implementation profile, subject to caps.

### 8.2 Trigger evaluation (how the runtime notices)

agents-worker consumes a **cursor lane** over the work logs (the ES1 lane
contract; until ES1 lands, a short-interval poll of the fold query API
behind the same consumer interface). On any event touching a spec/task with
an autonomy policy, it re-evaluates predicates *against the fold* — the lane
is a doorbell, never a truth source. Dispatch is naturally idempotent:
assignment is itself visible in the fold, so the predicate
(`ready ∧ unassigned ∧ under-cap`) cannot double-fire; session creation is
additionally deduped on `(taskKey, contractHash)`.

### 8.3 The autonomy ladder

Per-spec (fallback per-workspace) policy, stored in
`agents.autonomy_policies` — agent-plane configuration, **not** work truth
(the closed work vocabularies stay closed):

| Level | Design runs | Implementation runs |
|---|---|---|
| `manual` (default) | click only | click only |
| `assist` | suggested on spec creation (one-click card) | suggested when a task derives Ready |
| `auto-dispatch` | suggested | **auto-assigned** on Ready, up to caps |
| `full` | **auto-spawned** on spec creation | auto-assigned on Ready; **fix runs** auto-spawned on red gates |

Caps are hard and layered: per-workspace concurrent sessions (entitlement,
AG8), per-spec parallel implementation runs, per-task retry budget (a task
whose fix run fails twice parks with a `task_comment` and stops consuming
budget). `full` additionally requires the contract-ack step — autonomy
skips *clicks*, never the human gate on contracts (A3 in risks decides
whether a workspace may waive even that).

### 8.4 Fix runs

A Done-blocked task (merged but a contract gate red — the fold's
In-Review-parked case) with autonomy `full` spawns a fix run: brief = the
failing gate's run evidence (platform MCP: run + logs) + the contract.
Same machinery, same caps, same PR ending.

---

## 9. Metering & entitlement (AG8)

Usage events through the existing metering pipe: `agents.session_minutes`
(from lease heartbeats), `agents.tokens` (from harness `cost_sample`
events), `agents.sessions_started`. Entitlement `feature.agents` gates
spawn; the per-workspace concurrent-session cap is plan-tiered (the B11 +
U7 upgrade-UX pattern). Cost renders live on the session detail and rolls
up on Usage & quota. Model-provider spend rides the tenant's own credential
(§3.3) — the platform meters *its* compute and coordination, not the
tenant's model bill (A4 decides whether a platform-provided model pool
exists later).

---

## 10. Security posture & failure modes (AG9)

**Threat: prompt injection / hijacked harness.** Contained by construction,
layer by layer: the sandbox egress allowlist bounds *where* it can talk;
the session token bounds *what it can be* (one service principal, deny-by-
default RBAC, 15-min life tied to the lease); the tool policy bounds *what
it can do* (writes ask); the work plane bounds *what it can claim* (no
status surface exists); and the PR gate bounds *what it can ship* (review +
gates). The design assumption is that the harness **will** eventually be
adversarial for one session; every layer is sized for that.

**Threat: credential exfiltration.** Nothing long-lived exists to steal:
bootstrap token is single-use; session token dies with the lease; repo
token is short-lived and repo-scoped; secrets are TTL'd env values redacted
at capture upstream of every sink (transcripts, logs, R2) and never present
in snapshots (suspend re-bootstraps credentials, §4.5).

**Threat: runaway cost.** Leases + sweeps kill zombies; caps bound
concurrency; per-task retry budgets bound loops; the kill switch is one
click and revokes the refresh chain.

**Audit.** `agent.*` events through `appendEventWithAudit`:
`agent.session.started/completed/failed/killed`, `agent.approval.resolved`
(who approved what), `agent.profile.changed`, `agent.dispatch.auto` (which
policy fired). Every session is replayable end-to-end from its event log +
transcript chunks.

**Evals (the AG9 exit bar).** Scripted end-to-end evals in `tests/agents`:
a fixture spec → design run → contracts proposed match golden; a Ready
fixture task → implementation run → PR opened with task-keyed branch;
injection fixtures (hostile repo content instructing status assertion /
secret exfil) → observed containment. Plus the harness-seam conformance
test: a stub second harness passes the full lifecycle suite untouched.

---

## 11. Sequencing & dependency notes

- **AG0–AG4 need no work-plane or MCP progress** — an interactive remote
  session (spawn from Agents tab, repo + prompt, transcript, PR out) is
  shippable on IG4 + identity alone. This is the epic's first demoable
  slice and de-risks the provider seam early.
- **AG5 waits on MCP2 (platform) and WP5 (orun MCP write path)**; AG6 also
  wants WP1 (query API for fold reads) and WP2 (claim join so the PR moves
  the rung); AG7 wants WP4 (seal/pull) for frozen briefs — until then the
  brief pins the spec doc by content hash through `spec_get`.
- **The credential gates (Daytona org, model keys) block only live paths**:
  AG1 lands with a `local-docker` dev adapter + recorded provider fixtures
  so everything above the seam merges human-independently — the IG/Polar
  park-and-continue posture.
