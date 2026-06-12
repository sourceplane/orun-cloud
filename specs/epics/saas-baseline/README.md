# Epic: saas-baseline

**The table-stakes a credible multi-tenant SaaS starter must own** — the
"Baseline SaaS (B)" cluster from the roadmap, carved into an Orun-style epic.

## Status

| Field | Value |
|-------|-------|
| Status | **In progress** (most legs shipped; three human-blocked) |
| Cluster | **B** (B1–B10) |
| Owner(s) | api-edge, identity, membership, billing, webhooks, notifications, admin, events workers + contracts/sdk/cli |
| Target branch | `main` (PRs merged incrementally) |
| Builds on | `core/constitution.md`, `core/contracts/`, the `components/` contracts |
| Decisions locked | deny-by-default authz; contract-first; org auto-created on first login; bearer paste is dev-only |

## Thesis

A buyer cannot reach the differentiator (`saas-resources-runtime`, P2) until the
baseline is credible. This epic closes the gap between "demo-only" and "a SaaS a
customer would pay for": real authentication, transactional email, edge
idempotency + rate limits, a typed SDK/CLI, webhook delivery you can operate,
billing you can self-serve, audit you can search, an admin back office, and the
SSO/SCIM enterprises require.

## Read order

1. `README.md` (this file) — status + milestone-at-a-glance.
2. `implementation-plan.md` — B1–B10, each with goal, owner, dependencies, and
   "done when".
3. `IMPLEMENTATION-STATUS.md` — what actually shipped (PR-level).
4. `risks-and-open-questions.md` — the human-blocked items and deferred decisions.

## Milestones at a glance

| ID | Milestone | Status |
|----|-----------|--------|
| B1 | Real authentication (magic link + OAuth) | ⛔ Blocked (creds) — GitHub OAuth scaffolding landed (0129) |
| B2 | Notifications worker (real email) | ✅ Shipped (worker live; provider swap deferred) |
| B3 | Edge idempotency and rate limiting | ✅ Shipped |
| B4 | SDK + CLI packages | ✅ Shipped |
| B5 | Webhooks polish | ✅ Shipped |
| B6 | Billing UX completion (Stripe) | ⛔ Blocked (creds; U7 precondition met) |
| B7 | Audit-log UX | ✅ Shipped |
| B8 | Admin / support worker | ✅ Shipped |
| B9 | Entitlement-decision observability | ✅ Shipped (console surface deferred) |
| B10 | SSO / SAML and SCIM | ⛔ Blocked (after B1+B8 stable) |

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| Auth, email, idempotency/rate-limit, SDK/CLI, webhook operability, billing self-serve, audit search, admin back office, entitlement observability, SSO/SCIM | The console surface (→ `saas-console-ux`), product differentiators (→ `saas-resources-runtime`), latency work (→ `saas-performance`) |
