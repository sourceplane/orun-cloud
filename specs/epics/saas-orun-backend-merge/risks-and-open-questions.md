# saas-orun-backend-merge — Risks & Open Questions

Status: Draft. The architecture bets are **locked** in the README (greenfield
event-sourced coordination, DO-per-run shard, Postgres projection, opt-in
memoization, no permanent backcompat). What remains here are the **decisions
still open behind those bets** (D-set) and the **engineering risks** the
milestones own (R-set).

## Open questions (behind the locked bet)

### D1 — Memoization scope & GC (owner BM1)

Opt-in hermetic memoization is locked; its *blast radius* is not. Is a
`job-result` cache **per-project**, **org-shared**, or **global** (a true
cross-tenant build cache)? Global is the biggest win and the biggest trust/PII
surface (one tenant's outputs visible to another by content hash). **Leaning:**
per-project by default, org-shared opt-in, global never without explicit
publish — and a TTL/refcount GC on `job-result`/`log` objects folded into the
existing OV9 object-GC. Needs a product/security call before org-shared ships.

### D2 — `jobInputHash` definition (owner BM1)

What exactly is hashed decides both cache hit-rate and correctness. Too broad →
no hits; too narrow → unsafe reuse. **Leaning:** resolved step definitions +
declared input object digests + declared environment keys (not values) + the
composition lock; explicitly excludes wall-clock/secrets. Must be specified and
golden-vectored; a wrong hash is a correctness bug, not a perf miss.

### D3 — DO global placement vs runner locality (owner BM2)

A run's DO lives in one Cloudflare location; runners (CI) may be elsewhere →
every append is a cross-region hop. **Leaning:** accept it (appends are small and
infrequent vs heartbeats which stay client-side between beats); revisit with
location hints only if claim latency breaches SLO. Open: whether to pin a run's
DO near its first runner.

### D4 — Drain window for in-flight legacy runs (owner BM6)

How long `orun-backend` stays read-only-serving in-flight runs at cutover.
**Leaning:** one max-run-duration window (legacy runs are bounded); new runs
never start on the old plane. No dual-write bridge (it reintroduces the
cross-writer race). Operator picks the calendar slot.

### D5 — OSS self-host implementation timing (owner BM7)

The contract is implementable on plain Postgres, but the OSS self-host is parked
(`orun/specs/orun-cloud` D5). Do we build the plain-Postgres conditional-append
server now (as the conformance reference) or only define the gate? **Leaning:**
define the conformance gate at BM7, build the server only when self-host is
unparked — but keep the contract DO-free so it stays buildable.

## Engineering risks

### R1 — Conditional-append correctness (severity: critical; owner BM2)

The whole safety model is "exactly one `:claim` append wins." If the DO's
in-memory guard or the OSS `INSERT … WHERE NOT EXISTS` is wrong, two runners
execute one job (double-deploy). Mitigation: the single writer per run is the
serialization point; BM2's parity suite + fuzzed concurrent-claim tests are the
gate; the predicate (latest-event ∈ ready ∧ deps terminal-success ∧ no memo) is
evaluated atomically under the writer, never read-then-write in app code.

### R2 — DO durability / recovery (severity: high; owner BM2)

DO storage is authoritative for the live stream; a permanent DO loss without a
recent snapshot could strand a run. Mitigation: snapshot objects every N appends +
projected checkpoints; rebuild = last snapshot + replay; unrecoverable tail =
re-drive from `planDigest` with `Succeeded` jobs short-circuited by their
`job-result` (memoization doubles as crash recovery). Rehearse a forced-loss
recovery on stage.

### R3 — Projection lag visible as "lost" work (severity: medium; owner BM3)

Because Postgres is delayed, a user may not see a just-claimed job for seconds.
Mitigation: `…/log` (SSE/long-poll) is the live truth for anyone who needs it;
the console reads the stream for active runs and the projection for lists;
document the consistency contract (§7) so staleness is expected, not a bug.

### R4 — Event-schema immutability (severity: medium; owner BM0)

The log is forever; a breaking event-shape change orphans old runs and CLIs.
Mitigation: every event versioned + additive-only from BM0; the shared fold
tolerates unknown future fields; contract major bump only via the platform's
change-control, vendored + checksum-guarded into `orun`.

### R5 — At-least-once surprises (severity: medium; owner BM2/BM4)

Lease takeover can run a job twice; non-idempotent steps corrupt. This is
unchanged from the reference but now explicit. Mitigation: document at-least-once
in the contract (§7); memoization is opt-in and never a correctness crutch; the
CLI surfaces takeover in the cockpit so a re-run is visible.

### R6 — Cross-repo contract skew (severity: medium; owner BM0/BM4)

Server and CLI evolving the contract independently breaks runs. Mitigation: one
owned copy here, vendored + checksum-guarded into `orun` (mirrors the existing
`orun-cloud/vendored` mechanism); the shared fold lives in `packages/contracts`
and is the single reduction both sides import-or-port; neither repo bumps the
major unilaterally.

## Explicitly out (per the locked bet)

- A permanent legacy `/v1/runs` surface — dropped; only the transient BM6 drain
  bridge exists.
- Lifting `orun-backend`'s Durable Object code or its V2 (Tasks 0021–0023)
  org/project layer — superseded; `orun-backend` is a parity reference only.
- Platform-hosted runners — job execution stays customer-side.
