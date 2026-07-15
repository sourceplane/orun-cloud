# Sub-epic: brokered-orphan-safety

**Status:** Draft (design + decision cores landed; surface wiring staged)
**Parent:** `saas-integration-hub` (IH7 brokered credentials)
**Owner(s):** config-worker (secrets), integrations-worker (connections), console, `orun` CLI (plan/run + `orun secrets`)

## Problem

A **brokered** secret stores no value — it's a typed pointer at an integration
connection, and the value is minted at resolve time (IH7). That makes the
secret only as good as its connection. Today, when a connection is
`revoked`/`suspended`/deleted, two silent failure modes appear:

1. **Orphaned secrets are invisible.** The secret row keeps `status: active`
   even though its connection is dead, so the console list, `orun secrets list`,
   and a plan all show it as healthy. The failure only surfaces at run time as a
   generic mint error (`reason: "disabled"`), long after the mistake.
2. **Nothing stops the orphaning.** A connection can be revoked/deleted while
   live brokered secrets still point at it — quietly breaking every consumer.

Observed live: connection `int_61acdf67…` (Supabase, account `ogpic`) was
revoked while `SUPABASE_ACCESS_TOKEN` (project) and `SUPABASE_ACCESS_TOKEN-PROD`
(env prod) still pointed at it — both still read `active`.

## Design principle

**A brokered secret's health is a projection of its connection, and that
projection is computed once and rendered identically everywhere** — console,
CLI, plan, and run. We do not duplicate a "health" column onto the secret row
(it would drift, exactly like `status: active` did). Instead `orphaned` is
**derived** from the live connection status at read time, and the two mutating
edges (revoke a connection / resolve a secret) enforce the same rule.

---

## Feature 1 — Surface orphaned brokered secrets everywhere

### Orphan definition (single source of truth)
A brokered secret is **orphaned** when its bound connection is anything other
than `active` (`revoked` / `suspended` / `pending` / missing). This is the same
predicate the mint guard already enforces (`connection.status !== "active"` →
fail). Implemented once in `deriveOrphan()` (`config-worker/src/orphan.ts`) and
reused by every surface.

### API contract (additive, back-compat)
`PublicSecretMetadata` gains two optional, derived fields — omitted for static
and healthy secrets so pre-existing consumers see the old shape:
- `bindingStatus?: "active" | "pending" | "suspended" | "revoked" | "unknown"`
- `orphaned?: boolean`

The list/get/chain handlers batch-resolve connection statuses for the brokered
rows in the page via the existing `config-worker → INTEGRATIONS_WORKER` binding
(a new internal batch endpoint `POST /internal/integrations/connections/status`,
ids → status), then stamp each row through `deriveOrphan()`. Fail-soft: an
unreachable integrations-worker yields `bindingStatus: "unknown"` (shown as
"health unknown", **not** silently healthy).

### Surfaces
- **Console** — an amber **`Orphaned`** pill next to the `brokered` chip in the
  secrets list, and a per-row banner on the secret detail drawer:
  *"This secret's Supabase connection (`ogpic`) was revoked 6d ago — it can no
  longer mint a value. Reconnect the integration or repoint this secret."*
  with **Reconnect** / **Repoint** / **Delete** actions.
- **`orun secrets list`** — an `ORPHANED` state in the status column
  (alongside `active`/`revoked`), and a footer hint naming the dead connection.
- **`orun plan`** — a **compile-time warning** (not an error) for every brokered
  ref whose connection is not active: *"secret X is orphaned (connection
  revoked) — the run will fail closed."* Surfaced from the plan's secret-ref
  validation, which already round-trips the backend for scope resolution.
- **`orun run`** — the resolve path already fails closed; we upgrade the reason
  from the generic `disabled` to a precise `binding_orphaned` with the dead
  connection named, so the run log says *why* rather than just failing.

### Why derived, not stored
A stored `health` column requires a fan-out writer on every connection state
change (revoke, suspend, provider-side uninstall, grant revoke) and still races.
Deriving at read time is always correct and cheap (one batched status read per
list page), and it makes reconnection self-healing with zero writes.

---

## Feature 2 — A connection with live brokered secrets can't be revoked/deleted

### Rule
`DELETE …/integrations/{connectionId}` (revoke) is **blocked** while any
`active` brokered secret binds to it. The guard turns a silent orphaning into a
deliberate, informed choice.

### Recommended UX: block-by-default, with three explicit exits
Blocking alone is a dead end — a modern flow offers the way *out*, not just the
wall. On a blocked revoke the API returns `409 connection_in_use` with the full
blocker list (`{ id, secretKey, scope }[]`), and the console renders:

> **Can't disconnect Supabase (`ogpic`) yet** — 2 secrets still broker from it:
> `SUPABASE_ACCESS_TOKEN` (project), `SUPABASE_ACCESS_TOKEN-PROD` (prod).
> Choose how to proceed:
> - **Repoint** these secrets to another Supabase connection *(recommended)*
> - **Delete** these secrets, then disconnect
> - **Force-disconnect** and orphan them *(they stop working immediately)*

1. **Repoint** *(best; new capability)* — rebind the secrets to a different
   active connection of the same provider/template in one action
   (`PATCH …/config/secrets/{id}` `{ binding.connectionId }`). This is the
   answer to the reconnect-mints-a-new-id problem: reconnect, then repoint.
2. **Delete secrets, then revoke** — the explicit teardown path.
3. **Force** (`DELETE …?force=true`, elevated `integration.manage` +
   confirmation) — revoke anyway and orphan the secrets. The response echoes
   the now-orphaned secrets; an audit event records the forced orphaning.

### Enforcement
`classifyRevoke(references, { force })` (`integrations-worker/src/revoke-guard.ts`)
is the pure decision; `handleRevokeIntegration` calls the new config internal
endpoint `GET /internal/config/secrets/by-connection/{connectionId}` (active
brokered refs) and applies it before flipping status. Fail-closed: if the
reference check can't be reached, a non-forced revoke is refused (don't orphan
blind). Adds an `integrations-worker → CONFIG_WORKER` binding (the reverse of
the existing mint edge; no request cycle).

---

## Edge cases (decided)
- **Reconnect mints a new connection id** — old connection → `revoked`, secrets
  orphaned until **repointed** to the new id. Repoint is the first-class fix.
- **Suspended (provider-side uninstall)** — treated as orphaned (can't mint);
  self-heals to healthy if the connection returns to `active`.
- **Shared / granted account connections** — the guard counts brokered secrets
  across every workspace admitted to the connection, not just the owner's.
- **Force revoke** — always allowed for recovery, but audited and it echoes the
  casualties; never the default.
- **Static secrets** — untouched; `orphaned`/`bindingStatus` omitted.

## Telemetry
- `secret.orphaned.observed` (first time a resolve/list sees a secret flip to
  orphaned) and `connection.revoke.blocked` / `connection.revoke.forced`
  (count + blocker count) — so orphaning is measurable, not anecdotal.

## Rollout (phased, each independently shippable)
1. **Contract + `deriveOrphan` + `classifyRevoke`** (this change) — API shape and
   the two decision cores, unit-tested.
2. **Feature 2 guard** — reference endpoint + binding + revoke guard + `force`.
3. **Feature 1 read path** — batch status endpoint + list/get/chain stamping.
4. **Surfaces** — console pill/banner + `orun secrets`/`plan`/`run` copy.
5. **Repoint** — `PATCH` binding + console flow.
