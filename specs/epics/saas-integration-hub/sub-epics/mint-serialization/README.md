# Per-connection mint serialization (IH6 custody)

**Status:** Shipped — DO lease lock + mint-core wiring + revoke-sweep coverage,
race-regression tested.

## Problem

A brokered mint on a rotating-parent provider is a read-modify-write on
custody:

```
read parent (refresh token P0) → provider mint (CONSUMES P0, returns P1) → re-envelope P1
```

Two concurrent mints for the same connection race that window: both read P0;
the first refresh consumes P0 and stores P1; the second presents the
already-consumed P0. Provider refresh-reuse detection then refuses the mint or
revokes the token family — killing sibling access tokens mid-flight.

**Observed live** (ogpic CI, 2026-07-17): three parallel verify jobs each
resolved `TEST_SUPABASE_API` (supabase/management-access) from one connection;
all three mints "succeeded" but one minted token came back `401` from the
Supabase Management API — family invalidation from the rotation race.

## Design

### Primitive: `ConnectionMintLock` Durable Object

One instance per connection (`idFromName(connectionUuid)`) — globally unique
and single-threaded, the platform's canonical serializer (the RunCoordinator
rationale). It is a **FIFO lease lock, not the executor**: mint work stays in
the worker (Hyperdrive, provider fetch, custody crypto are wired there); the
DO only grants turns.

- `POST /acquire {leaseMs, waitMs}` — grants immediately when free, else the
  request parks in a FIFO waiter queue inside the DO (the in-flight request
  keeps the instance alive) up to the wait budget. A grant carries a
  **one-time token**.
- `POST /release {token}` — token-checked; a stale releaser can never free
  someone else's turn.
- **Lease TTL** (default 30s) is the crashed-holder backstop: a DO alarm
  clears an expired holder and grants the next waiter. An overrun only
  degrades to the pre-serialization behavior — never worse.
- **Wait budget** (default 20s) bounds queueing: an exhausted waiter fails
  TYPED (`mint_lock_timeout`, 503, retryable), which the resolve surface names
  in run logs via `brokerReason`.
- Holder state persists to DO storage (eviction-safe); waiters are in-memory.

The pure lease state machine (`MintLockCore`) is time- and token-injected and
unit-tested outside the Workers runtime; the DO (`mint-lock-do.ts`) is the
thin runtime shell (split so jest suites can import the core + runner).

### What holds the lock

Only the custody critical section in `executeMintCore`:

```
readParentCredential → broker.mintCredential → reEnvelopeParentCredential
```

Template validation, entitlements, the per-org rate limit, the ledger insert,
and events stay OUTSIDE — the hold is ~one provider HTTP call. Both mint
surfaces (public `…/credentials` and the internal `secret_resolve` mint) flow
through `executeMintCore`, so both are covered by construction.

The **connection-revoke custody sweep** (live-mint revoke → provider-side
revoke → custody zeroize) takes the same lock, closing the mint-vs-revoke
race where an in-flight mint could re-envelope a rotated parent AFTER the
zeroize, resurrecting custody for a revoked connection. Revoke is never
blockable by mint traffic: a lock timeout proceeds unlocked (the status flip
already stops new mints; only already-in-flight mints remain).

### Failure posture

Serialization is **hardening, not an authz gate**:

- Missing `MINT_LOCKS` binding (older deploys, harnesses) or a lock-service
  transport error → the section runs unlocked — the status-quo posture.
- A wait-budget timeout under genuine contention → typed `mint_lock_timeout`
  (503, retryable, named in `brokerReason`).

### Non-goals (future work)

- **Single-flight token sharing** (a cached short-lived credential served to
  concurrent resolves of the same template) would also collapse ledger
  attribution (one row per mint, per-run `requestedBy`/`runId`) — deliberately
  out of scope.
- Cross-connection fairness/limits — the per-org daily mint rate limit already
  governs volume.

## Verification

`tests/integrations-worker/src/mint-lock.test.ts`:
- lease-core semantics (grant / deny / token-checked release / expiry).
- **the race regression**: a rotating-parent fake provider with reuse
  detection; two concurrent mints — unserialized reproduces the live failure
  (`201` + `412 parent_grant_insufficient`), serialized both succeed with two
  distinct rotations.
- `mint_lock_timeout` mapping on both mint surfaces.
- runner degrades open without a namespace.
