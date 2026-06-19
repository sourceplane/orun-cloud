# Architect Roadmap — Program Register

Status: Normative direction. Sequencing is the Orchestrator's call.

## Purpose

This is the **cross-epic index** for the Orun Cloud SaaS starter. It groups the
forward direction into clusters — **Baseline SaaS (B)**, **UI / Design (U)**,
**Product Areas (P)**, and **Performance (PERF)** — and points at the epic folders
that own the per-milestone detail. Read this to understand which leg a candidate
task belongs to and where its durable plan lives.

The per-milestone bodies, status, and as-built records now live under
[`epics/`](./epics/) (one folder per cluster). This file keeps only the one-line
index + cross-epic sequencing. The per-component contracts under
[`components/`](./components/) remain the contract; the architectural rules live in
[`core/`](./core/).

The architect-style ground rules:

- Trust code reality over stale docs.
- Prefer the largest coherent reviewable unit with one primary outcome.
- Bounded contexts are non-negotiable; deployment count is.
- Every product surface must look credible to an external buyer before being
  declared done.
- Every internal seam must be extraction-safe before being declared done.

## Epic index

| Cluster | Epic | Status | What it owns |
|---------|------|--------|--------------|
| **B** | [`epics/saas-baseline/`](./epics/saas-baseline/) | In progress | B1 auth · B2 notifications · B3 idempotency/rate-limit · B4 SDK/CLI · B5 webhooks · B6 billing UX · B7 audit UX · B8 admin · B9 entitlement observability · B10 SSO/SCIM |
| **U** | [`epics/saas-console-ux/`](./epics/saas-console-ux/) | In progress | U1 App Router · U2 design system · U3 URL scope · U4 empty states · U5 Cmd-K · U6 forms · U7 upgrade UX · U8 skeleton/optimistic · U9 white-label · U10 SDK client · U11 Vercel-standard completion |
| **PERF** | [`epics/saas-performance/`](./epics/saas-performance/) | In progress | PERF1–PERF14 latency ladder (PERF1–5 + PERF6 core shipped + verified; PERF6b/PERF7–9 planned; PERF10–14 added by the 2026-06-08 second full-surface audit). Measurement record + RCA + cost notes in the epic's `design.md`. |
| **P2** | [`epics/saas-resources-runtime/`](./epics/saas-resources-runtime/) | Draft (not started) | The moat: manifest-driven resources + runtime orchestration (components 06 + 08). |
| **B** (billing platform) | [`epics/saas-multi-org-billing/`](./epics/saas-multi-org-billing/) | In progress | Datadog-style multi-org ownership (default single org; more orgs purchased; billing from the default/parent org) + the `billing-provider-abstraction` sub-epic (Polar first, Stripe/others by config). Extends B6 + B11. |
| **BF** | [`epics/saas-bootstrap-factory/`](./epics/saas-bootstrap-factory/) | Draft (not started) | Make the starter instantiable: BF0–BF2 truth + typed params · BF3–BF6 config indirection + deploy-time wiring (no committed resource IDs) · BF7–BF9 domain/foundation/preflight · BF10–BF12 OCI stack + Blueprint/Instance contracts + instantiator · BF13–BF14 acme rehearsal + upgrade path. |
| **PX** | [`epics/saas-product-experience/`](./epics/saas-product-experience/) | In progress | Close the backend-ahead-of-surface gap: PX1 console truth/papercuts · PX2 config/flags/secrets UI · PX3 notification preferences e2e · PX4 rename lifecycle · PX5 first-run onboarding · PX6 Cmd-K resource search. All human-independent. |
| **IG** | [`epics/saas-integrations/`](./epics/saas-integrations/) | Draft | Pluggable integrations platform (promotes P5), GitHub App first: IG0 foundation · IG1 connect flow · IG2 inbound `scm.*` events · IG3 repo links · IG4 token broker · IG5 console · IG6 lifecycle hardening · IG7 pluggability/instance proof · IG8 inbound projection fields · IG9 write-back proxy (the Orun Cloud v2 state bridge — `epics/saas-integrations/bridge-to-state.md`). |
| **SS** | [`epics/saas-secrets-sync/`](./epics/saas-secrets-sync/) | Draft (SS0/SS1 in progress) | One write path for every secret: SS0 escrow convention + manifest · SS1 drift checker enforced in verify lanes · SS2 deploy-lane sync · SS3 escrow seeding (human-gated) · SS4 Secrets Store for shared keys · SS5 rotation runbook + BF9 preflight. |
| **BM** | [`epics/saas-orun-backend-merge/`](./epics/saas-orun-backend-merge/) | Ready | Replace `orun-backend`'s relational coordination plane with **native event-sourced coordination** (DO-sharded per run, Postgres projection, content-addressed `job-result` memoization), cross-repo with `orun` (**NC**): BM0 contract v2 + vendor · BM1 object kinds + memoization · BM2 per-run Durable-Object event log (conditional append) · BM3 projections · BM4 CLI adoption · BM5 auth/quota · BM6 cutover · BM7 decommission. Greenfield (no permanent backcompat); `orun-backend` is the parity reference. Extends OP/OV. |
| **SC** | [`epics/saas-service-catalog/`](./epics/saas-service-catalog/) | Draft | Org catalog → internal developer portal: SC0 drill-down foundation (entity route + contextual sidebar + drawer) · SC1 dependency graph · SC2 deployments · SC3 activity · SC4 insights · SC5 scorecards · SC6 ownership/on-call · SC7 golden-path scaffolder · SC8 index polish. Every enrichment is a computed overlay, git-authored snapshot, separated operational annotation, or git-writing scaffolder — never console-authored catalog content (`components/18-state.md`). |
| **P1, P3–P7** | [`epics/saas-product-areas/`](./epics/saas-product-areas/) | Holding register | P1 promote-flow · P3 observability · P4 notification inbox · P5 marketplace (⬆ promoted → `saas-integrations`) · P6 changelog/status · P7 AI-native. |

For the status legend (`Draft → In progress → ✅ Shipped → ⛔ Blocked → Closed`),
see [`README.md`](./README.md).

## Cross-epic sequencing notes for the Orchestrator

- **B1 + B2 are the highest-leverage baseline pair** — together they kill the
  "demo-only auth" problem and unblock invitations + billing receipts + alerts.
  Order is **B2 → B1** because B1 needs real email. (Both currently have
  human-blocked tails — see the `saas-baseline` risks.)
- **U-track** is structurally complete (U1–U11) and continues as incremental
  polish under `saas-console-ux`; after U10, the SDK client is in place.
- **P2 is the differentiator and the largest single program.** Do not start it
  before **B4 (SDK)** — the resources contract should ship as a typed client
  surface from day one.
- **B6 (Stripe)** waited on **U7** (shipped) so upgrade CTAs have somewhere to go;
  it is now blocked only on Stripe creds. Its provider work is being generalized
  into the **`saas-multi-org-billing` / `billing-provider-abstraction`** sub-epic:
  a swappable provider adapter shipping **Polar first**, switchable to Stripe (or
  others) by config rather than rewrite.
- **`saas-multi-org-billing`** is a new billing-platform epic (not part of the
  B1–B10 ladder). Its **MO1** dormant seam is human-independent and safe to land
  early; paid multi-org (MO2+) is gated on the product/credential decisions in
  the epic's `risks-and-open-questions.md`. Build the Polar adapter (sub-epic
  BP0/BP1) in parallel with MO1.
- **Prefer B / U over P** until baseline buyer-credibility is reached. The
  platform's defining bet is in P2, but a customer cannot reach P2 without B1–B4
  being credible.
- **PERF** is orthogonal and ongoing; PERF5 took warm org-scoped reads/writes to
  ~55–65ms p50 on prod and the PERF6 core made the edge gate measurable. Next is
  PERF7 (cold starts), with PERF6b (AE dashboards) as a cheap follow-on.
- **PX (product experience)** is the highest-leverage human-independent cluster
  while B1/B6/B10 stay credential-blocked: every PX milestone turns an
  already-live backend capability into buyer-visible product (config/flags UI,
  notification preferences, rename, onboarding). PX1 (truth/papercuts) goes
  first to set the visual bar; PX2/PX3 ride on live backends; nothing in PX
  competes with BF or PERF for files.
- **IG (integrations)** promotes P5 without waiting for P2: a repo link is a
  plain record now, re-projectable as a manifested resource when P2 lands. It
  rides shipped rails (B1 OAuth patterns, B5 event_log→webhooks fan-out, B11
  entitlements) and adds the platform's first unauthenticated edge ingress
  (design §5) — the only genuinely new trust path. IG0 (foundation) and IG2's
  worker-side fixtures are human-independent; live paths are gated on
  per-environment GitHub App registration (the epic's D1, same
  park-and-continue posture as the Polar/Stripe credential gates).
- **SC (service catalog)** evolves OP's shipped OV7 catalog into an internal
  developer portal without touching the read-model contract: SC0–SC4 (drill-down
  route + contextual sidebar + drawer, dependency graph, deployments/activity
  tabs, computed insights) are human-independent and ride on shipped data or
  computed-on-read overlays. SC5 (scorecards) and SC6 (ownership/on-call) carry
  product decisions (rule format; ownership source) but stay invariant-safe as
  sibling overlays. SC7 (golden-path scaffolder) is the detachable, highest-lift
  tail — it writes git via IG4, never the catalog, and is a sub-epic candidate.
  Highest-leverage first slice: **SC0 + SC1 + SC4**.
- **BM (orun-backend merge)** is a **greenfield, cross-repo** redesign, not a
  compat exercise: it replaces `orun-backend`'s relational `runs/jobs/claim`
  plane with coordination native to the content-addressed store — a run is an
  append-only **event stream** rooted at `planDigest → sourceHash`, claims are
  **conditional appends** sharded **per run on a Durable Object**, and Postgres
  becomes a **delayed projection**. This is also the scaling answer (the per-run
  DO is the partition unit; heartbeats/claims leave the shared primary) and the
  provenance answer (`sourceHash → plan → job → result` Merkle chain, with
  content-addressed `job-result` memoization). It **pairs with `orun`'s NC
  cluster** on one vendored contract (`coordination-api.md`); the CLI moves to an
  append/fold/read-the-log client, so there is **no permanent backward-compat
  surface** — only a transient read-only drain bridge at BM6 cutover.
  `orun-backend` is the parity reference for the claim/lease invariants, never
  lifted in. BM0–BM3 (contract, object kinds, the DO event log, projections) are
  the human-independent server spine; BM4 co-develops with NC; only BM6 (cutover)
  and BM7 (decommission) need an operator call. Open product/security calls: D1
  memoization scope (per-project → org-shared → global) and D2 `jobInputHash`
  definition.
- **BF (bootstrap factory)** is orthogonal to B/U/P and mostly human-independent:
  BF0–BF2 (docs truth, infra `dependsOn` edges, parameterizing the Terraform +
  stack identity surface) are safe to schedule any time and improve this
  instance on their own. The keystone is BF5/BF6 (Terraform wiring manifest +
  deploy-time binding resolution — removes all committed resource IDs). Only
  BF8 (fresh-account foundation) and BF13 (acme rehearsal) are human-gated; park
  them per the deferred-decision protocol until the epic's human-help register
  is supplied.

## What this document is not

- Not a delivery-date list and not a Gantt chart.
- Not the per-milestone plan — that lives in each `epics/<epic>/implementation-plan.md`.
- Not a substitute for the per-component contracts under
  [`components/*.md`](./components/) — those remain the contract.
- Not the as-built record — that lives in each `epics/<epic>/IMPLEMENTATION-STATUS.md`.
- Not a frozen plan. The Orchestrator may propose reordering, splits, merges, or
  new epics via the spec-change-proposal flow in `agents/orchestrator.md`.
