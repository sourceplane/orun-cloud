# saas-orun-platform — Architecture Overview & Decisions

Status: Draft. The at-a-glance companion to `design.md` — the diagram, the
load-bearing decisions, and *why* each was taken. Read this first; read
`design.md` for the model and `state-api-contract.md` for the wire.

## The shape

```
┌─ orun CLI (Go, customer-side) ───────────┐      ┌─ Orun Cloud (this repo) ──────────────────────────┐
│ runner / compiler / cockpit              │      │ api-edge (one public Worker, path-scoped routes)  │
│   └── statebackend.Backend  ──────────── HTTPS ──→  state-worker   (NEW: runs, jobs, objects, logs) │
│   └── bridge.Source (status/logs/TUI)    │      │   identity-worker (+ CLI sessions, OIDC exchange) │
│ cliauth: session.json (access+refresh)   │      │   config-worker   (+ secret manager)              │
│ local object store (sha256 digests) ──── same digests ──→ R2 (CAS blobs) + Postgres (state schema)  │
└──────────────────────────────────────────┘      │   policy / events / metering / billing (reused)   │
                                                  │   Next.js console: Runs · Stacks · Catalog · Secrets│
                                                  └────────────────────────────────────────────────────┘
```

Execution stays customer-side. The platform **remembers** (state), **authorizes**
(policy/audit), and **renders** (console). It never runs the customer's jobs.

## The five load-bearing decisions

### 1. The wire contract conforms to the CLI, not the reverse
The contract is shaped 1:1 to orun's existing `statebackend.Backend` interface
(InitRun / Claim / Heartbeat / Update / Logs / Runnable). **Why:** orun already
ships this client with retries and token sources; making the server conform
collapses integration risk to "stand up the server." It's frozen and versioned
(`Orun-Contract-Version` header) with two implementations — Orun Cloud and the
OSS self-host backend — so adoption is a URL change, not a migration. That
no-lock-in posture is the trust wedge for an infra tool.

### 2. One tenancy spine — org → project → environment — no new nouns
Orun's "namespace" retires; `orun cloud link` maps a git remote to an existing
project. **Why:** RBAC, audit, webhooks, metering, and billing then apply to all
state *for free* — no parallel permission or billing model. "Stacks" are not an
entity either: just environments rendered with latest-run + drift, so there is
no second write path to keep consistent.

### 3. Two state planes, mirroring orun's own object model
Immutable CAS plane (plans, catalog snapshots in R2, keyed by the **same sha256
digests** as the local object store) + mutable coordination plane (Postgres rows
with atomic claims, leases, heartbeats). **Why:** identical digests mean no
translation layer and near-free repeat pushes (sync = "push what's missing, move
a head"); leases + idempotent transitions are what let a run survive a killed
laptop and let CI and humans share a run without double-claiming.

### 4. Three auth doors into one existing ActorContext
Platform CLI sessions (loopback + device flow, short access JWT + rotating
refresh), GitHub OIDC exchange for secretless CI, and existing `sk_` API keys.
**Why:** these map exactly onto orun's three `TokenSource` implementations, so
the CLI changes endpoints, not shape — and OIDC kills the "paste a long-lived
token into CI" anti-pattern.

### 5. Secrets are write-only with run-lease-gated reads
Values are envelope-encrypted and never readable via the management API; the
only read path is a runner holding a live job lease resolving declared keys,
every access audited, values redacted from logs before upload. **Why:** it is
the most defensible posture for the riskiest feature. Whether to hold values at
all (vs. metadata-only references) is the one liability call flagged for a human
(`risks-and-open-questions.md` D3).

## Consciously deferred (with the seam left open)

| Deferred | Why now / seam |
|---|---|
| Platform-hosted runners | Execution stays on customer compute; hosting is a separate security epic |
| Durable Objects for claim contention | Postgres is fine at launch volume; per-run DO documented as the escalation seam |
| SSE log streaming | Cursor (`fromSeq`) polling meets the < 5 s latency bar; SSE is additive later |
| BYO-KMS / per-org KEK custody | OP8 keeps a KEK-provider seam so this is non-breaking later (D4) |

## What to review first

The riskiest open call is **D3 (secret custody)** — everything else degrades
gracefully if wrong; that one is a liability commitment. After that, **D1
(naming)** and **D5 (OSS-backend conformance commitment)** shape public posture.
