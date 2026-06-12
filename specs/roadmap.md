# Architect Roadmap — Program Register

Status: Normative direction. Sequencing is the Orchestrator's call.

## Purpose

This is the **cross-epic index** for the Sourceplane SaaS starter. It groups the
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
| **IG** | [`epics/saas-integrations/`](./epics/saas-integrations/) | Draft | Pluggable integrations platform (promotes P5), GitHub App first: IG0 foundation · IG1 connect flow · IG2 inbound `scm.*` events · IG3 repo links · IG4 token broker · IG5 console · IG6 lifecycle hardening · IG7 pluggability/instance proof. |
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
