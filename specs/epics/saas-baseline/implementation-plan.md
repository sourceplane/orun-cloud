# saas-baseline — Implementation Plan (B1–B10)

The baseline cluster. Each item is a candidate scope for one coherent PR-sized
task (or a small number of follow-ups if a clean split exists). Items inside the
cluster are not strictly ordered; sequencing is the Orchestrator's call. Carved
verbatim-in-substance from the roadmap's "Baseline SaaS (B)" section; status
markers reflect code reality as of 2026-06-08.

## B1 — Real authentication — ⛔ Blocked (creds); GitHub OAuth scaffolding landed (0129)

Replace email-code + bearer-token paste with a production-credible auth surface.
At minimum: passwordless email magic link via a real email provider behind a
contract (see B2), plus at least one OAuth provider (GitHub or Google). Bearer
token import remains as a dev-only affordance. Auto-create a personal organization
on first login so the user lands in a working scope, not a chooser screen.

Owner: identity-worker + membership-worker. Depends on: B2 for email delivery.
Out: SSO/SAML (B10), SCIM (B10).
**Done when:** magic-link + ≥1 OAuth provider work end-to-end; first login
auto-creates a personal org. **Blocked on:** human-supplied OAuth app creds +
verified email sender.

## B2 — Notifications worker (real email) — ✅ Shipped (provider swap deferred)

Stand up `apps/notifications-worker` per component `14`. Adapter pattern behind a
provider contract (Resend / Postmark / SES). Templates for: magic-link login,
invitation, billing receipt, security alert, webhook-down alert, generic
transactional. Preferences API per identity. Delivery state recorded in events.

Owner: notifications-worker. Unlocks B1, B3 invitation polish, B5 webhook alerts,
billing receipts. Out: in-app inbox UI (P4).
**Done when:** worker live with the template set + preferences API + delivery
events. **Residual:** the real transactional provider is gated on a human choice
(`notifications-provider-swap`, see risks) — the adapter seam is in place.

## B3 — Edge idempotency and rate limiting — ✅ Shipped

Generalize idempotency at `api-edge` for unsafe POSTs (closed: duplicate POST →
duplicate pending invitations). Per-org and per-identity rate limits at the edge,
deny-by-default, single shared response envelope. Standardize the
`Idempotency-Key` header in contracts.

Owner: api-edge + contracts. Out: per-resource quota (billing entitlements — done).

## B4 — SDK + CLI packages — ✅ Shipped

Generate a typed SDK from `packages/contracts` (one client shared by console, CLI,
and external customers). Ship `packages/cli` per component `13` on top of the SDK.
Token storage on keychain via `keytar` with a `~/.config/sourceplane/` fallback.

Owner: `packages/sdk` + `packages/cli`. Unlocks external automation, CI flows,
future integrations.

## B5 — Webhooks polish — ✅ Shipped

Component `15` is implemented; this added the buyer-credible surfaces:
signing-key rotation UX, per-endpoint delivery history with replay, failure-budget
alerts (wired through B2), and signing-secret reveal-once-then-rotate. Documented
the verification recipe and shipped `@sourceplane/webhook-verifier`. Manual
single-attempt delivery replay landed end-to-end (PR #181).

Owner: webhooks-worker + console + B2 wiring.

## B6 — Billing UX completion — ⛔ Blocked (creds; U7 precondition met)

Stripe provider adapter behind the billing contract (privileged read-sync +
webhook intake); customer portal link from console; upgrade/downgrade flow that
respects the entitlement seam; invoice list; failed-payment recovery copy.
Provider-specific fields stay behind the adapter, never in contracts.

Owner: billing-worker + console. Depends on: U7 (designed `precondition_failed`
copy — **shipped**), B2 (receipts — shipped).
**Blocked on:** human-supplied Stripe creds + the receipts decision.

## B7 — Audit-log UX — ✅ Shipped

Searchable audit history per org with filters by actor, resource, action, time
range. Export to NDJSON. Surfaces what events-worker already records.

Owner: console + events-worker (read API only; no model change).

## B8 — Admin / support worker — ✅ Shipped

Shipped `apps/admin-worker` with audited support actions, impersonation with an
explicit audit trail, plan overrides, and entitlement inspection. Internal-only
routing; never on api-edge.

Owner: admin-worker.

## B9 — Entitlement-decision observability — ✅ Shipped (console surface deferred)

Counts only (no provider payloads, no secrets) by caller × entitlement key emitted
from billing-worker, to an Analytics Engine / structured-log sink. Used by the
admin-worker dashboard and by on-call to see who's hitting the gate.

Owner: billing-worker + admin-worker.
**Deferred:** the customer-console surface — B9 reads live on internal-only
admin-worker, and no internal-operator console/auth model exists yet (needs a
product/architecture call; see risks).

## B10 — SSO / SAML and SCIM — ⛔ Blocked (after B1 + B8 stable)

SSO domains attached to organization; SCIM provisioning per Okta/AzureAD
conventions; org-level lockout policy.

Owner: identity-worker + membership-worker + admin-worker.
**Blocked on:** B1 stable + human-supplied IdP creds/decisions.

## Sequencing note

B1 + B2 are the highest-leverage pair (kill demo-only auth; unblock invitations +
receipts + alerts); order is **B2 → B1** because B1 needs real email. Anything in
B / U should be preferred over P until baseline buyer-credibility is reached.
