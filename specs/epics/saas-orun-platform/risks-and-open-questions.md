# saas-orun-platform — Risks & Open Questions

Status: Draft. D-items need a human decision; R-items are engineering risks
with a chosen mitigation.

## Decisions needed (human)

### D1 — Product naming
"Orun Cloud" is used throughout this epic as the working name for the SaaS
offering (company: Sourceplane). Decide the public name before OP6 (console
surfaces) — it leaks into URLs, the approval page ("Orun CLI wants access"),
OIDC audience (`orun-cloud`), and docs. Renaming later is mostly find/replace
but the OIDC audience and JWT issuer should not churn after OP5.

### D2 — Free-tier shape
Design §7 proposes: remote state free for one project, 7-day retention, no
secret manager. This is a pricing decision. Needed before OP9 (entitlement
defaults), not before.

### D3 — Hosting customer secret values at all
OP8 makes us a secret store. Alternative: metadata-only (we store references to
the customer's vault — AWS SM, Doppler) and never hold values. The epic chooses
**hold values with envelope encryption** because runtime injection into runs is
the product moat and reference-fetching from runners reintroduces the
credential-distribution problem we're solving. Confirm comfort with the
liability, and whether SOC2 timing changes the order.

### D4 — BYO-KMS / per-org KEK custody
Follow-up to D3: enterprises will ask to hold the KEK (BYO-KMS). Not in this
epic; confirm it's roadmap (post-OP8) so OP8's crypto layout keeps the seam
(KEK provider interface, not a hardcoded master key path).

### D5 — `orun backend init` (OSS self-host) parity commitment
The contract promises one API, two implementations. Decide how strongly we
commit publicly: (a) OSS backend is a reference implementation, best-effort;
(b) OSS backend is contract-certified per release (conformance suite in the
orun repo runs against both). Recommendation: (b) — the conformance suite also
hardens Orun Cloud. Affects OC-side scope. **Reality check:** the existing OSS
backend (`orun backend init`, not `deploy`) is an embedded Cloudflare Worker +
D1 on a single-tenant *namespace* model; honoring the contract means migrating
it to the org/project `_local/_local` scope in lockstep with OC0. Decide the
retrofit timing **before OC0**, since the namespace→org/project change spans
both the client and this server bundle.

### D6 — Catalog annotations
The platform never edits catalog content (provenance property). Buyers may ask
for console-side overrides (ownership, descriptions). If ever allowed, they
must live as a separate annotation layer, never merged into the snapshot.
Park: decide only if a real buyer asks.

## Engineering risks (chosen mitigations)

### R1 — Heartbeat/log write rates vs Workers + Hyperdrive
A 50-runner org emits ~2.5 writes/s of heartbeats plus log chunks. Mitigation:
heartbeat is a single-row UPDATE by PK; log chunks go to R2 with one index
INSERT; lease length/heartbeat interval are server-tunable (contract returns
them). Per-run Durable Object is the documented escalation seam (design §4.4).
Load test gate in OP9.

### R2 — Large objects through Workers
Request body limits make single-shot upload of big plans/snapshots fragile.
Mitigation: 25 MiB single-request budget + R2 multipart sub-protocol (contract
§3). Presigned direct-to-R2 upload is a later optimization — not v1, to keep
every byte behind policy + metering.

### R3 — Live log tail without SSE
Workers SSE/long-poll adds complexity. Mitigation: `fromSeq` cursor polling
(console 2 s interval) meets the < 5 s lag bar in OP6. SSE is an additive
endpoint later; contract shape already cursor-based so nothing breaks.

### R4 — Contract drift between repos
Two repos, one wire contract. Mitigation: `Orun-Contract-Version` header fails
loud on skew; the contract doc freezes at OP2; the orun repo vendors a copy and
CI diffs it against this one (OC0); additive-only changes after freeze.

### R5 — Lease semantics vs Orun's current client
Orun's existing `remotestate.Client` was written against the reference backend;
claim/lease responses here add `reason`/`lease_lost`. Mitigation: responses are
supersets where possible; where not (path scoping), OC0/OC3 update the client
behind the same `statebackend.Backend` interface so the rest of the CLI is
untouched.

### R6 — Secret exposure via logs
Values injected into step envs will get echoed by user commands. Mitigation:
CLI-side redaction of known values in log chunks before upload (OC5);
server-side never sees plaintext in logs by design but adds a best-effort
scrubber for resolved keys' values as defense in depth. Documented residual
risk: transformed values (base64 of a secret) are not catchable.

### R7 — GC correctness
Deleting CAS objects that something references would corrupt history.
Mitigation: GC only collects objects unreferenced by any catalog head
(including history pins) or any retained run's `planDigest`; deletion is
two-phase (tombstone, then purge after a grace window); rebuild-from-blobs
test in OP7 doubles as a referential integrity check.

### R8 — Tenant isolation in a high-write context
Same invariant as everywhere: every query carries `org_id + project_id`.
state-worker repo layer takes scoped IDs as branded types (OP0), and the
contention tests in OP2 include a cross-tenant probe (runner from org A
claiming org B's job must 404, not 403, per house resource-hiding rules).

### R9 — Cloudflare cron-trigger slot budget
The account has a bounded number of cron triggers (the 5-trigger limit bit IG0
once, resolved via a Workers Paid upgrade). OP2 (lease sweep) and OP9
(retention/GC) each add a cron. Mitigation: budget the slots up front and, if
the limit binds, coalesce the state crons into one scheduled handler that fans
out by phase (sweep vs GC) rather than registering separate triggers.

### R11 — Rotating-refresh-token robustness
Single-use refresh-token rotation with reuse-detection (design §3.1) is the
correct security posture but is fragile in real CLI use: concurrent invocations
(two terminals, a script, one `run` firing parallel requests) or a process
killed between the server rotating and the client persisting all cause a benign
replay of a spent token, which trips reuse-detection and revokes the whole
family — surfacing to users as a session that "expires" seconds after login.
Mitigations, in order of shipped→planned:
- **Client single-redemption (shipped, `orun` PR #366):** singleflight +
  cross-process advisory file lock + double-checked reload removes the dominant
  concurrency cause; only one refresh redeems the token, the rest reuse it.
- **Sliding idle window (shipped):** refresh extends the lifetime from "now", so
  active sessions never hit a surprise hard-expiry.
- **Absolute lifetime cap (shipped):** the slid window is clamped at
  `familyStart + ~90d` (family origin = `MIN(created_at)` over the family, no
  migration); past the cap the family is retired (`absolute_expiry`) and the
  user re-authenticates — a hard ceiling on an indefinitely-active or
  silently-compromised session.
- **Reuse grace interval (planned, needs review):** within a short leeway of a
  token's rotation, re-serve idempotently instead of revoking — closes the
  kill-between-rotate-and-persist window. This deliberately narrows the
  reuse-detection guarantee inside the leeway (the Auth0/Okta "reuse interval"
  tradeoff), so it ships only after a security review; until then the client
  lock covers the common case and a genuine theft is still caught outside the
  (not-yet-enabled) window.

### R10 — Error-envelope type vs wire shape
api-edge already emits the nested envelope `{ error: { code, message, details?,
requestId } }` (`apps/api-edge/src/http.ts`), but `packages/contracts/src/errors.ts`
is still the older flat shape (`{ error, message, requestId }`). Mitigation: OP0
reconciles the contracts type to the nested shape so the SDK, the OC0 client
parser, and the runtime all agree on one envelope.

## Deferred

- Platform-hosted runners (compute on Orun Cloud) — separate epic; security
  model (sandboxing, egress policy) is its own program.
- Scorecards/health live plane in the catalog read-model — columns reserved
  (OP7), fed by a later orun-service-catalog leg.
- SSE log streaming; presigned R2 uploads; per-run Durable Object — seams
  documented above, build on evidence.
- GitLab/Bitbucket OIDC issuers for OP5 — adapter seam mirrors
  saas-integrations' provider registry.
