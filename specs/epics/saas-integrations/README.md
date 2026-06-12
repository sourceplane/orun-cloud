# Epic: saas-integrations

**The control plane owns the Git provider relationship so tenant products never
have to.** A pluggable integrations platform — GitHub App first — that gives every
product built on this control plane the full "medium SaaS" GitHub feature set as
a service: sign-in (already shipped), org-level install, project-level repo
links, normalized inbound events on the platform event bus, and brokered
short-lived tokens to act on GitHub. Products run on Cloudflare, AWS, or
anywhere else; the GitHub credentials, webhook verification, dedupe, retries,
and audit all live here.

## Status

| Field | Value |
|-------|-------|
| Status | **In progress** — IG0 shipped (#307); IG1+ live paths gated on D1 (see `IMPLEMENTATION-STATUS.md`) |
| Cluster | **IG** (integrations platform — promotes P5; consumes B1 OAuth login, B5 webhooks, B11 entitlements) |
| Owner(s) | new `apps/integrations-worker` + `apps/api-edge` (ingress) + `packages/db` + `packages/contracts`/`sdk`/`cli` + `apps/web-console-next` |
| Target branch | `main` (PRs merged incrementally) |
| Builds on | `core/domain-model.md`, `core/constitution.md`, `components/01-edge-api.md`, `components/02-identity.md` (OAuth adapters, shipped), `components/15-webhooks-integrations.md` (outbound-only; this epic owns inbound), `apps/identity-worker/src/oauth/*` (provider-registry pattern), `apps/webhooks-worker` (cron + inbox/outbox pattern), `110_billing_foundation` entitlement seam |
| Decisions locked | Structural: (1) integrations are a **new bounded context** (`integrations`), not an extension of `webhooks-worker` — spec 15 explicitly excludes inbound OAuth/webhooks; (2) **provider seam from day one** (registry + adapter, mirroring `identity-worker/src/oauth/providers.ts` and `billing-provider-abstraction`) — GitHub is the first adapter, not a special case; (3) **do not wait for P2** — a repo link is a plain org/project-scoped record now, forward-compatible with becoming a manifested resource when P2 lands; (4) inbound events ride the existing **event_log → outbound webhooks** pipeline — products consume `scm.*` events through the webhook surface they already have; (5) tenant products **never hold GitHub credentials** — all act-on-GitHub goes through the token broker or proxy. |
| Gate | IG0 (spec/schema/contracts, dormant) and most of IG2 are human-independent. IG1+ live paths need a **GitHub App registered per environment** (App ID, private key, webhook + client secrets) — see `risks-and-open-questions.md` D1/D2. |

## Thesis

Stripe made billing a product; Polar made merchant-of-record a product; this
control plane's bet is making the *entire SaaS substrate* a product. For most
products, the next integration after auth and billing is source control. Today
the platform already does GitHub *login* (B1, shipped: provider-adapter OAuth in
identity-worker) — but a product that wants to react to pushes, gate PRs, post
check runs, or read repo contents has to register its own GitHub App, run its
own webhook endpoint, verify signatures, dedupe deliveries, store private keys,
and refresh installation tokens. That is exactly the kind of undifferentiated
heavy lifting a control plane should absorb.

The mechanism: one **GitHub App per control-plane instance** (per environment),
installed by customers onto their GitHub orgs. The installation binds to a
Sourceplane organization; repos link to projects; every inbound delivery is
verified, deduped, persisted, and re-emitted as a normalized `scm.*` event on
the canonical event_log — which means outbound delivery to the tenant product's
own infrastructure, replay, audit, and failure budgets all come **free** from
the already-shipped webhooks pipeline. Acting on GitHub is brokered: a product
exchanges its control-plane API key for a short-lived, repo-scoped installation
token (audited, policy-gated, entitlement-gated). The provider seam keeps
GitLab/Bitbucket a config-plus-adapter away, the same way Stripe is one adapter
away from Polar.

## How it maps to Vercel (the reference)

| Vercel | Here |
|--------|------|
| "Connect Git provider" on the team | Install the instance's GitHub App; installation binds to the org (`connections`) |
| Project ← linked Git repository | `repo_links`: repo ↔ project, with branch → environment mapping |
| Push/PR events drive the product | Normalized `scm.*` events on event_log → tenant product via outbound webhooks/SDK |
| Vercel posts checks & deploy statuses back | Token broker mints scoped installation tokens; product (or a thin proxy) posts checks/statuses |
| Git settings page + repo picker UX | Console: Settings → Integrations (marketplace cards), connection detail, project Git tab |

## Read order

1. `README.md` (this file) — status + thesis + milestones-at-a-glance.
2. `design.md` — bounded context, data model, edge ingress trust path, token
   broker, event normalization, provider seam, console UX, instance config.
3. `implementation-plan.md` — IG0–IG7, each with "done when".
4. `risks-and-open-questions.md` — the human-gated registrations and product
   decisions (App permission set, token broker policy), plus security risks.

## Milestones at a glance

| ID | Milestone | Status |
|----|-----------|--------|
| IG0 | Foundation (dormant): `components/17-integrations.md`, contracts, `180_integrations_foundation` migration, repo layer, worker skeleton — no live behavior | ✅ Shipped (#307) |
| IG1 | Connect flow e2e: App install + signed-state callback ingress + installation ↔ org binding + connection lifecycle + minimal console connect surface | 🗓️ Planned (gated: App registration per env) |
| IG2 | Inbound events: HMAC-verified webhook ingress, durable inbox + dedupe, cron drain, normalized `scm.*` emission into event_log, delivery log + replay | 🗓️ Planned |
| IG3 | Repo links: repo browsing, project ↔ repo linking, branch → environment mapping, console repo picker | 🗓️ Planned |
| IG4 | Token broker: scoped short-lived installation tokens for tenant products, policy + entitlement gates, audit, SDK/CLI surface | 🗓️ Planned |
| IG5 | Console to Vercel standard: Integrations marketplace page, connection detail with activity, project Git tab polish, Cmd-K actions | 🗓️ Planned |
| IG6 | Lifecycle hardening: suspend/uninstall reconciliation, drift self-heal, failure-budget alerts (B2-wired), admin-worker visibility | 🗓️ Planned |
| IG7 | Pluggability proof + instance alignment: second-provider dormant adapter (GitLab) compiling against the seam; App credentials as BF instance parameters | 🗓️ Planned (optional tail) |

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| The `integrations` bounded context; GitHub App install/uninstall lifecycle; inbound webhook ingress + normalization onto event_log; repo ↔ project links with branch → environment mapping; the token broker; console Integrations + project Git surfaces; SDK/CLI; entitlement gating; audit | Sign-in with GitHub (shipped, B1 — reused untouched); outbound webhook delivery mechanics (shipped, B5 — consumed as-is); CI/CD or build execution on pushes (a *product* concern; P2/runtime later); marketplace billing/rev-share; arbitrary user-authored workflows; mirroring repo *contents* into the platform |

## Relationship to existing work

- **B1 (auth)**: shipped the OAuth provider registry this epic's connection flow
  imitates — but login identity (user-scoped, `auth_identities`) and integration
  connections (org-scoped, installation-backed) are different objects with
  different lifecycles. The epic shares the signed-state cookie pattern and the
  GitHub HTTP conventions, not the tables.
- **B5 / spec 15 (webhooks)**: stays outbound-only. This epic is the inbound
  twin: same inbox/cron/replay discipline, opposite direction. `scm.*` events
  enter event_log; spec-15 machinery fans them out to customer endpoints.
- **P2 (resources/runtime)**: not a dependency. A `repo_link` is forward-defined
  so it can be re-projected as a manifested resource when P2 lands (the moat
  consumes the link; it does not own it).
- **BF (bootstrap factory)**: the GitHub App's identity (App ID, slug, secrets)
  is per-instance config, never hardcoded — IG7 aligns the credential surface
  with BF's instance.yaml story.
- **saas-multi-org-billing**: integrations are entitlement-gated
  (`feature.integrations.github`), reusing the materialized per-org entitlement
  seam and the U7 upgrade UX unchanged.
