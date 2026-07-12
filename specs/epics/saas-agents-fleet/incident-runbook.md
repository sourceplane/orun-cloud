# saas-agents-fleet — Incident runbook (AF9)

Status: Normative for the fleet-plane on-call. Companion to
`saas-agents/design.md` §9 (the base security posture) and this epic's
`design.md` §9 (the fleet deltas). Every procedure below is exercised by a
test in `tests/agents-worker` — the runbook is the human-readable index of
containment that is already mechanical.

## The stance

Containment is **arithmetic, not vigilance**. Before reaching for a manual
lever, confirm the automatic one did not already fire — a runaway tree, a
hostile orchestrator, a spend spike, and a wedged loop each have a
structural bound that operates without an operator. The runbook exists for
the residue: verifying the bound held, and the rare case where a bound is
mis-tuned rather than breached.

## 1. A tree is spawning out of control

**First check it isn't already bounded.** A tree cannot exceed
`TREE_LIMITS` (depth 2 · 5 live children/parent · 10 live nodes/tree) or its
`tree` budget envelope — both refuse at the spawn door
(`agent_tree_width_exceeded` / `budget_exhausted`). If live-node count is at
10 and flat, the storm already hit the wall (`hardening.test.ts` proves the
greedy case).

**Lever:** `POST /agents/sessions/{root}/cancel` — tree-transitive kill,
leaf-up. It cancels every node even if no sandbox can be destroyed
(over-destroy posture); the `*/5` sweep collects the straggler boxes. Killing
the root is the fleet home's one-click **Kill tree**. Sealed evidence on any
node survives the kill and the failed destroys (`acceptance`/`hardening`
drills).

## 2. A session (or its harness) looks hijacked

The blast radius is a service principal's, narrowed further by the tree:
- **It cannot widen a child** — the applied ceiling is `parent ∩ child`,
  composed down; no chain of spawns regains a dropped tool.
- **It cannot author standing config** — routine and budget writes refuse an
  agent-session bearer structurally (`agent_session_config_write`), before
  policy. A hijacked session cannot schedule its own future or raise its own
  ceiling.
- **It cannot move a leash** — the autonomy PATCH refuses any agent identity
  (`agent_autonomy_self_service`), before policy.

**Lever:** kill the session (§1); if the whole profile is suspect, a human
demotes it (PATCH to `manual`) and disables its routines. The credential
dies within one lease TTL (~15 min) regardless (AG6).

## 3. Spend is spiking

**First check the envelopes.** `GET /agents/attention` surfaces every
budget at ≥80% as a `budget` item with its arithmetic. A session that
crossed 100% has already been sent a graceful `budget_exhausted` interrupt
(it finishes its tool call and seals — no data loss). If a run ignores the
interrupt, the lease-refusal backstop kills its credential within one TTL
(risk F6).

**Lever:** tighten the workspace ceiling (`PUT /agents/budgets` grain
`workspace`) to refuse new spawns at the door immediately; the running
fleet drains as sessions cross their own envelopes. Never needed as a *kill* —
budgets interrupt gracefully by design.

## 4. A routine is misbehaving

Two consecutive failed firings **park** it automatically (one attention
item, and the bound profile demotes one rung). A parked routine never fires
until a human resumes it (which resets the latch). A worker outage does not
produce a backlog — a routine fires at most once on recovery
(misfire-once).

**Lever:** disable (`PATCH {enabled:false}`) to stop it without losing the
row; delete to remove it. Resume (`PATCH {parked:false}`) after fixing the
underlying cause.

## 5. The drill (run before trusting the plane in a new environment)

1. Spawn a depth-2 tree with sealed evidence on a leaf.
2. Make the provider account unreachable (rotate/revoke the Daytona key).
3. `Kill tree` on the root → every node `canceled`, destroys all error.
4. Wait two sweep periods → stragglers reclaimed, error count logged,
   **sealed evidence intact**.
5. Confirm `GET /agents/attention` is empty (no stuck/orphan residue).

This is `hardening.test.ts` "the runaway-tree kill drill" executed against a
live environment; sign-off is the green drill plus a clean attention fold.
