# Epic: teams-governance (TG)

**The enterprise long-tail that makes Teams trustworthy at scale: sync membership from the
IdP, be able to *restrict* (not just grant) access by team, allow custom roles, and govern
the team lifecycle (archival, ownership transfer, access reviews).** These are the features
a security-conscious buyer checks for — and the ones most gated on decisions/upstreams. Part
of the [`teams-platform`](../teams-platform/) program. **Plane: Enterprise governance.**

## Status

| Field | Value |
|-------|-------|
| Status | **Draft (mostly ⛔-gated)** — TG1 (SCIM) is blocked on `saas-baseline` **B10** (SSO/SCIM, ⛔); TG2 (restriction) requires a deliberate **policy-engine evolution** (the allow-only union cannot restrict). TG4/TG5 (lifecycle, reviews) are buildable on **TF** now. |
| Cluster | **TG** (teams-governance — sync · restriction · lifecycle) |
| Owner(s) | `apps/identity-worker` (SCIM/SSO) · `packages/policy-engine` + `apps/membership-worker` (restriction/ABAC) · `packages/contracts` · `apps/web-console-next` |
| Builds on | `teams-foundation` **TF** (entity + members + provenance + audit); `saas-baseline` **B10** (SSO/SAML + SCIM — currently ⛔); `packages/policy-engine` (today **allow-only** union — `tenancy-and-rbac.md`: "V1 may implement policy as code-backed RBAC plus a small attribute layer"); `teams-hub` **TH** (the surface reviews render on) |
| Decisions locked | (1) TG is **not additive** to the engine the way TF–TC are — **restriction/deny is the one place this program may change `packages/policy-engine`**, behind an explicit decision (TG-B); (2) SCIM group→team is the **enterprise membership source of truth** when enabled, and console roster edits become read-only for synced teams (Datadog/Okta convention); (3) governance is **auditable end-to-end** — every sync, restriction, and lifecycle action emits `team.*`/`governance.*` events (TF5). |
| Gate | **Human-dependent + upstream-gated.** TG1 waits on B10 + IdP credentials. TG-B (restriction model) is a foundational RBAC decision — do not build TG2 until it is made. See `risks-and-open-questions.md`. |

## Thesis

TF–TH–TC make Teams *useful*; TG makes them *safe to hand an enterprise*. Three capabilities
define that bar, and each carries a real gate:

1. **Directory sync (TG1)** — auto-provision team membership from Okta/AzureAD groups.
   Hard-gated on B10 (no SSO/SCIM exists yet). Until then, teams are manually managed (TF).
2. **Restriction / least-privilege (TG2)** — "this team sees *only* its own resources." The
   current engine is **allow-only**: it can grant but never confine. Datadog-grade least
   privilege needs a deny/visibility layer — a genuine engine evolution, not a team feature
   bolted on. This epic *owns the decision*, and gates the build on it.
3. **Lifecycle & reviews (TG4/TG5)** — archival, ownership transfer, orphan cleanup, and
   periodic **access reviews / attestation** ("confirm these 12 people still belong").
   Buildable on TF today; the compliance surface enterprises expect.

## Milestones at a glance

| ID | Milestone | Status |
|----|-----------|--------|
| TG1 | **SCIM/SAML group → team** membership sync; synced teams become IdP-authoritative (console roster read-only) | ⛔ Blocked on B10 |
| TG2 | **Team-scoped restriction / visibility** — confine a team to its resources; **requires** the deny/ABAC engine decision (TG-B) | ⛔ Gated on TG-B |
| TG3 | **Custom roles + team-scoped grants** — beyond the fixed built-in roles, for team-tailored permission sets | Draft |
| TG4 | **Lifecycle governance** — archive/restore, ownership transfer, orphan-membership cleanup, deletion safety | Draft |
| TG5 | **Access reviews / attestation** — periodic membership + grant review with sign-off + audit export | Draft |

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| SCIM/SAML group→team sync, team-scoped restriction (behind the engine decision), custom roles, lifecycle governance, access reviews/attestation + audit export | The SSO/SCIM primitive itself (→ `saas-baseline` **B10**); a user-facing policy DSL (`tenancy-and-rbac.md` defers it); nested teams / teams-as-level (stays WID Stage 2); paging/incident governance (integrations concern) |

## Read order

1. `README.md` — the enterprise-bar thesis + the three gates.
2. `design.md` — SCIM mapping, the restriction/ABAC decision, lifecycle + reviews.
3. `implementation-plan.md` — TG1–TG5 with "done when" + gate conditions.
4. `risks-and-open-questions.md` — B10 dependency, the deny-model decision, sync authority.
