# Epic: saas-product-experience

**Close the gap between what the platform can do and what a buyer can see.** The
backends are ahead of the surfaces: config/flags/secrets, notification
preferences, and rename lifecycles are live (or one facade away) on the API but
invisible, stubbed, or read-only in the console. This epic productizes the
control plane — every shipped capability reachable, polished, and discoverable
at the Vercel / Linear / Polar bar.

## Status

| Field | Value |
|-------|-------|
| Status | **In progress** |
| Cluster | **PX** (PX1–PX6) |
| Owner(s) | `apps/web-console-next`, `apps/api-edge`, `apps/notifications-worker`, `apps/membership-worker`, `apps/projects-worker`, `packages/{contracts,sdk,cli}` |
| Target branch | `main` |
| Builds on | U1–U11 (console foundation), B2 (notifications), B4 (SDK/CLI), config-worker facade (live) |
| Decisions locked | No new bounded contexts; console consumes only api-edge via `@saas/sdk`; API/CLI/UI parity for every new mutation; all milestones human-independent (no new credentials) |

## Thesis

A 2026-06-11 verified-live audit (authenticated Playwright walkthrough of the
stage console plus an edge-API surface probe) found the platform in an unusual
position: **the contract surface is more complete than the product surface.**
Concretely:

- `GET /v1/organizations/:id/config/{settings,feature-flags,secrets}` is live
  on api-edge and returns well-formed envelopes — but the console **Config page
  is a stub** ("settings will appear here…"). A buyer reads that as vaporware;
  the truth is the opposite.
- `@saas/sdk` ships `notifications.getPreferences/updatePreferences`, the
  worker handlers exist — only the api-edge facade is missing, which keeps the
  whole preferences surface dark (parked in `ai/deferred.md` as a U11 slice).
- Org/project/environment names are **immutable in the UI** because no PATCH
  routes exist — a typo means delete-and-recreate, which reads as a toy.
- Unknown console routes render the **unbranded Next.js 404**; destructive
  actions use native `confirm()`; new users land on a bare empty-state page
  with no guided path to their first API call.

None of these need credentials, new bounded contexts, or product decisions.
They are the highest-leverage human-independent work in the repo: each
milestone turns an already-paid-for backend capability into buyer-visible
product. The epic is the experience leg of the "control plane as a product"
bet — `saas-bootstrap-factory` makes the platform instantiable; **this epic
makes the instance worth wanting.**

## Read order

1. `README.md` (this file).
2. `implementation-plan.md` — PX1–PX6 with acceptance criteria.
3. `IMPLEMENTATION-STATUS.md` — as-built record (includes the audit evidence).

## Milestones at a glance

| ID | Milestone | Status |
|----|-----------|--------|
| PX1 | Console truth & papercuts pass (designed 404/error, designed confirms, loading states, wayfinding) | ✅ Shipped |
| PX2 | Config surface: settings, feature flags, secrets UI over the live facade | ✅ Shipped |
| PX3 | Notification preferences end to end (edge facade + console page) | ✅ Shipped |
| PX4 | Rename/update lifecycle (PATCH org/project/environment + inline edit) | Ready |
| PX5 | First-run onboarding: guided path to the first API call | Ready |
| PX6 | Resource search in Cmd-K | Ready |

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| Surfaces over live or one-facade-away backends; additive PATCH routes with full API/SDK/CLI/UI parity; console polish with a named bar (Vercel/Linear/Polar); designed error/empty/confirm states; onboarding | New bounded contexts; resources/runtime (P2); anything credential-gated (B1 OAuth/email, B6 Stripe, B10 SSO/SCIM); instantiability (BF); in-app notification inbox with read state (P4); marketing site |

## Relationship to other epics

- **`saas-console-ux` (U)** — U owns the console foundation and stays the home
  for incremental polish; PX milestones are *feature-complete surfaces*, each
  crossing at least one seam (contracts/edge/SDK) that U's charter excludes.
- **`saas-bootstrap-factory` (BF)** — orthogonal; BF makes a second instance
  deployable, PX makes every instance credible. No file-level overlap expected.
- **`saas-performance` (PERF)** — orthogonal; PX adds no hot-path work. If a PX
  surface exposes a latency problem, it is recorded and routed to PERF.
- **`saas-product-areas` (P4)** — PX3 ships *preferences* only; the inbox with
  delivery/read state remains P4.

## Verification bar

Every PX milestone is verified **live on stage** (authenticated walkthrough,
screenshots in the PR or implementer report) and smoke-checked on prod after
promotion. "Implemented locally" is not a completion state — this epic exists
because shipped-but-invisible is the failure mode being corrected.
