# Epics

Status: Normative index

Orun-style work programs for the SaaS starter. Each epic is a folder named
`saas-<slug>` (mirroring `../../orun/specs/orun-<slug>`) carrying a canonical doc
set. The durable per-bounded-context contracts live one level up in
`specs/components/`; epics are the cross-cutting programs that *evolve* them.

## The epics

| Epic | Cluster | Status | Owner(s) | What it is |
|------|---------|--------|----------|------------|
| [`saas-baseline/`](./saas-baseline/) | **B** | In progress | all workers | Table-stakes a credible SaaS starter must own: real auth, notifications, idempotency/rate-limits, SDK/CLI, webhooks, billing UX, audit UX, admin, observability, SSO. |
| [`saas-console-ux/`](./saas-console-ux/) | **U** | In progress | web-console-next, packages/ui | The buyer-credible console: App Router on Workers, design system, URL-driven scope, Cmd-K, empty/skeleton states, upgrade UX, SDK client. |
| [`saas-performance/`](./saas-performance/) | **PERF** | In progress | api-edge, packages/* | Make authenticated reads feel instant — measurement record, root-cause analysis, and the PERF task ladder. |
| [`saas-resources-runtime/`](./saas-resources-runtime/) | **P2** | Draft (not started) | resources-worker, runtime-worker | The differentiator/moat: manifest-driven project resources + runtime orchestration. Consumes components `06` + `08`. |
| [`saas-multi-org-billing/`](./saas-multi-org-billing/) | **B** (billing platform) | In progress | membership-worker, billing-worker, db, console | Datadog-style multi-org: default single org, more orgs are a purchased capability, billing rolls up to the default/parent org. Carries the `billing-provider-abstraction` sub-epic (Polar first, Stripe/others by config). Extends B6 + B11. |
| [`saas-bootstrap-factory/`](./saas-bootstrap-factory/) | **BF** | Draft (not started) | stack-tectonic, infra/terraform/*, all wrangler surfaces, tooling/factory | Make the repo instantiable: kill hardcoded identity/resource IDs (config indirection + deploy-time wiring), complete the infra story (foundation, preflight, domain v5), then Blueprint/Instance contracts + instantiator + upgrade path. Acceptance test: a second live SaaS ("acme") from `instance.yaml` only. |
| [`saas-product-experience/`](./saas-product-experience/) | **PX** | In progress | web-console-next, api-edge, notifications-worker, membership/projects workers, packages/{contracts,sdk,cli} | Close the backend-ahead-of-surface gap: console truth/papercuts, config/flags/secrets UI, notification preferences e2e, rename lifecycle, first-run onboarding, Cmd-K resource search. Opened from the 2026-06-11 verified-live audit. |
| [`saas-integrations/`](./saas-integrations/) | **IG** (promotes P5) | Draft | new integrations-worker, api-edge ingress, db, contracts/sdk/cli, console | Pluggable integrations platform, GitHub App first: org-level install (connection bound to org), project repo links with branch→environment mapping, HMAC-verified inbound ingress normalized to `scm.*` events on event_log, and a token broker so tenant products act on GitHub without holding credentials. Provider seam from day one (GitLab/Bitbucket = adapter + config). |
| [`saas-orun-platform/`](./saas-orun-platform/) | **OP** | Draft | new state-worker, identity-worker, config-worker, api-edge, db, contracts/sdk, console, infra | The SaaS becomes the Orun Platform (Orun Cloud): CLI session + OIDC auth, the remote state store (runs/objects/logs/catalog heads), secret manager with runtime grants, and the console's Runs/Stacks/Catalog/Secrets surfaces. One frozen wire contract shared with `orun/specs/orun-cloud/` (cluster **OC**). |
| [`saas-product-areas/`](./saas-product-areas/) | **P1, P3–P7** | Holding register | various | Promote-flow, observability, notification inbox, marketplace (P5 ⬆ promoted → [`saas-integrations/`](./saas-integrations/)), changelog/status, AI-native affordances. Each promoted to its own folder when work starts. |

The cross-epic sequencing and the one-line index live in
[`../roadmap.md`](../roadmap.md) — the program register.

## Lifecycle & conventions

- **Status legend:** see [`../README.md`](../README.md) § Status legend
  (`Draft → Ready → In progress → ✅ Shipped → ⛔ Blocked → Closed`).
- **As-built ≠ intent.** What actually shipped lives in each epic's
  `IMPLEMENTATION-STATUS.md`, kept distinct from the design/plan docs.
- **Milestone ✅, not archive.** A completed milestone inside an active epic is
  marked ✅ in `implementation-plan.md` and recorded in `IMPLEMENTATION-STATUS.md`
  — it is **not** deleted or archived. Only a **fully-closed program** (no open
  milestones, no follow-ups) moves to `../_archive/`.
- **Holding → promote.** A parked epic (`saas-product-areas` register) lives as a
  single README; when a leg is picked up it is promoted to a full doc set
  (`README.md` + `design.md` + `implementation-plan.md` + …), mirroring Orun's
  `orun-env-scoping` / `orun-affected-worker` pattern.
- **Sub-epics.** A tightly-coupled child program lives under its parent in
  `saas-<slug>/sub-epics/<child-slug>/` with the same doc set, and is surfaced
  from the parent README's milestone table (it is not a top-level register row).
  Today: `saas-multi-org-billing/sub-epics/billing-provider-abstraction/`.
- **Doc set per epic:** `README.md` (status table + thesis + read order +
  milestone-at-a-glance), `implementation-plan.md` (milestones with "done when"),
  `IMPLEMENTATION-STATUS.md` (as-built), plus `design.md` /
  `risks-and-open-questions.md` / `test-plan.md` where they carry weight.
