# saas-orun-backend-merge — Design

Status: Draft. The server-side design for **native, event-sourced job
coordination** over Orun Cloud's content-addressed state store, sharded per run
on a Durable Object with Postgres as a delayed projection. The normative wire
seam is [`coordination-api.md`](./coordination-api.md); this doc explains the
model behind it. `orun-backend` is the parity reference for the coordination
*invariants*, not its API.

## 1. Why the legacy plane is the wrong shape

`orun-backend` predates the object store. Its model is a mutable `run_jobs`
table mutated by `claim/heartbeat/update`, with events emitted only as
observability exhaust. The modern store is the opposite kind of thing: a
**Merkle object graph** (`PUT /objects/{digest}`, kinds `plan |
catalog-snapshot | composition-lock | artifact-manifest`) with **mutable refs**
that advance by **emitting events** (`PUT /catalog/head` → `catalog.head.advanced`).
Coordination is the last plane that hasn't been made native to it.

| | Legacy (`orun-backend`) | Native redesign |
|---|---|---|
| Authority for job state | mutable `run_jobs` row | **fold over a per-run append-only event log** |
| A claim | `UPDATE … SET status='claimed'` | **conditional append** `JobClaimed` |
| Completion | `status='succeeded'` | append `JobSucceeded{ result: sha256:… }` → content-addressed object |
| Run identity | opaque runId | rooted at `planDigest → sourceHash` (a Merkle chain) |
| Liveness | cron sweep mutates rows | per-run DO **alarm** appends `LeaseExpired` |
| Postgres tables | source of truth | **delayed projection** (read model) |
| Result reuse | impossible | **content-addressed memoization** across runs/tenants |

A run becomes symmetric with the catalog: a **catalog head** is a ref to the
latest *desired* state; a **run** is an event stream advancing the latest
*execution* state — both anchored to immutable digests.

## 2. Three planes

### 2.1 Immutable object plane (extend the existing CAS)

New object kinds alongside `plan`:

- `job-result` — `{ jobInputHash, outputs:[digest], exit, logsDigest }`,
  content-addressed by its inputs. **The memoization key.**
- `log` — an assembled job log sealed as one object, referenced by `job-result`.
- `run-record` *(optional)* — the sealed terminal fold of a run, immutable
  provenance/audit.

`plan` already embeds the `sourceHash`; because orun compiles deterministically,
`planDigest` is the reproducibility key. The whole graph is verifiable:
`sourceHash → plan → job → result`.

### 2.2 Per-run event log (the coordination spine)

One totally-ordered, append-only stream per run, monotonic `seq`. Authoritative
state is a reduction (the fold every reader and the server agree on):

```
reduce(events) → {
  run:  pending | running | succeeded | failed | canceled,
  jobs: { [jobId]: { phase, holder?, leaseEpoch?, result?, attempt } },
  frontier: [jobId…]   // every dep's latest event ∈ { Succeeded, Memoized }
}
```

Event vocabulary (extends the `state.*` namespace already in
`packages/contracts/src/state.ts`):
`RunCreated{planDigest,sourceHash}` · `JobReady` · `JobClaimed{runner,leaseEpoch}`
· `LeaseRenewed` · `LeaseExpired` · `JobSucceeded{result}` · `JobMemoized{result}`
· `JobFailed{reason}` · `LogChunk{seq}` · `RunCompleted` · `RunFailed` ·
`RunCanceled`. Every event is actor-attributed (signed provenance) and the log is
append-only and versioned — events are additive forever.

**Strong consistency = conditional append.** A claim appends `JobClaimed` iff the
job's latest event is `JobReady`/`LeaseExpired` **and** its deps' latest events
are terminal-success **and** no `job-result` already memoizes it. That predicate
is checked under the run's single writer (below), so of N racing claims exactly
one append wins — the event-sourced equivalent of the legacy conditional `UPDATE`,
with the same exactly-one-winner guarantee and no shared-row contention.

### 2.3 Projections (delayed truth)

Postgres + caches hold read models derived from the log: run list, status, the
frontier cache, metering, and the OV6 catalog. All eventually consistent — which
is correct **because Postgres is no longer authoritative for the claim**. This is
the "delayed Postgres truth" the design deliberately accepts; reads tolerate
1–5s staleness, the claim never does, and the claim is the only synchronous
append.

## 3. The Durable Object coordination shard

Each run's event stream has exactly one writer: a **Durable Object keyed by
runId**. It holds the live fold in memory, serializes appends single-threaded,
persists each append to DO storage (durable), and projects to Postgres
asynchronously.

```
runner ──► api-edge ──► state-worker ──► RunCoordinator DO (per run)
(OIDC/key)   authz +        routes        ├─ in-memory fold (authoritative live state)
             scope          to the DO      ├─ append-only event log in DO storage
                                           ├─ alarm → append LeaseExpired on timeout
                                           └─ async batched projection ▼
                                                               Postgres (read models) + R2 (objects)
```

- **Claim/heartbeat/complete** are in-memory transactions on the DO — no shared
  DB row, no Hyperdrive connection per op. Strong consistency becomes *cheap*.
- **Liveness** is the DO's own alarm appending `LeaseExpired` (then `JobReady`),
  so there is **no separate cron sweep racing the same rows** — the second-writer
  problem of the relational design disappears structurally.
- **Lease semantics preserved from the reference**: 60s lease / 20s heartbeat,
  takeover on lapse, bounded re-queue then `timed_out` (mirrors `orun-backend`'s
  `HEARTBEAT_TIMEOUT_MS` invariants, BM2's parity bar).

### 3.1 One contract, two implementations

The DO is a *hosted* optimization, never part of the wire contract. The OSS
self-host backend implements the same `coordination-api.md` with a **plain-Postgres
conditional-append** (a single `INSERT … WHERE NOT EXISTS(conflicting latest
event)` per claim) — single-tenant, no scale pressure, no Cloudflare primitive.
The CLI cannot tell which served it. This is what keeps "one contract, two
implementations" honest while the hosted plane scales by sharding.

## 4. Scalability — why this is also the scaling answer

The pressure at thousands of tenants is dominated by the highest-frequency,
lowest-value writes. Illustrative peak (5,000 concurrent runs × ~10 active jobs):

| Op | Rate | Needs strong consistency? | In this design |
|---|---|---|---|
| Heartbeats | ~2,500/s | No | in DO memory; **0 Postgres writes** |
| Claims | ~400/s | **Yes** | DO conditional append; **0 synchronous Postgres writes** |
| Terminal updates | ~400/s | Soft | append, projected in batches |
| Log append | 5–10k/s | No | bytes → R2; index batched |
| status / frontier reads | thousands/s | No | served from DO / projection cache |
| run-create + quota | ~tens/s | **Yes** | **stays strong in Postgres** |

The single-writer-per-run partition means coordination **scales horizontally by
run** (10,000 concurrent runs = 10,000 tiny DOs, spread globally), and Postgres
write volume drops from ∝(heartbeats × jobs) on hot shared rows to ∝(runs,
batched) on DO-owned rows — easily 50–1000× fewer hot writes. The escalation tail
(Tier 2) is to **shard the Postgres projection plane by `org_id`** if the *query*
plane (not coordination) ever saturates; the OV6 catalog already projects
org-global, so cross-shard reads stay bounded.

## 5. Memoization (a native superpower, opt-in)

Because `job-result` is keyed by `jobInputHash`, a claim that finds an existing
result appends `JobMemoized{result}` and the runner **skips execution** — a
content-addressed build cache shared across a tenant's runs and (within policy)
across tenants. This is impossible to express with mutable status rows.

**Correctness gate:** only **hermetic** jobs are safe to memoize. The plan
declares purity per job (`hermetic: true`); default **off**. `jobInputHash`
covers the job's resolved inputs (step definitions, input digests, declared env);
a non-hermetic job is always executed. Cache scope (per-project vs org-shared vs
global) and GC are open questions (R-set), but the *mechanism* is just object
existence + an event.

## 6. Recovery & durability

- DO storage is authoritative for the live stream and survives DO eviction /
  relocation (Cloudflare reconstructs the DO from its storage).
- Every ~N appends or on terminal transitions, the DO writes a **snapshot object**
  (the fold at `seq`) and a projected checkpoint to Postgres.
- On *permanent* DO loss (rare): rebuild the fold from the last snapshot object +
  replay subsequent events; if the tail is unrecoverable, the run is re-drivable
  from `planDigest` (deterministic) with already-`Succeeded` jobs short-circuited
  by their `job-result` objects — memoization doubles as crash recovery.

## 7. Migration & cutover (no permanent compat)

Because the CLI moves with us (cross-repo), we do **not** keep the legacy surface:

1. **BM0–BM5** build the new plane behind the new contract on stage; the new CLI
   targets it.
2. **Drain bridge (transient).** At cutover, put `orun-backend` read-only; let
   in-flight legacy runs finish on the old plane (bounded by the lease window). No
   translation shim — new runs start on the new plane only.
3. **Provenance migration.** Backfill terminal legacy runs as `run-record`
   objects + projection rows for history continuity; live legacy coordination
   state is *not* migrated (it drains).
4. **Cutover** `orun-api.sourceplane.ai` to Orun Cloud; update
   `intent.yaml` `execution.state.backendUrl` and the CLI default. Rollback =
   DNS flip back while the old plane is still read-only-intact, valid until BM7.
5. **Decommission** the standalone backend (BM7).

## 8. Boundary invariants (must hold)

- One writer per run (the DO) — the only place claim ordering is decided.
- Postgres is never authoritative for a claim; it is a projection and the home of
  run-create/quota only.
- The wire contract never names the DO; OSS self-host stays plain-Postgres.
- The object graph is git/content-derived: `job-result`/`log`/`run-record` are
  immutable and addressed by digest; the catalog stays projector-fed, never
  authored.
- Execution is at-least-once (lease takeover can re-run a slow job); steps must be
  idempotent and memoization is opt-in — same liveness contract as the reference,
  relocated into the event model.
