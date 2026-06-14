# Epic: saas-orun-platform

**The SaaS becomes the Orun Platform** — the multi-tenant control plane that
Orun CLIs authenticate against and store remote state in, and that renders the
platform surfaces (Runs, Stacks, Catalog, Secrets) over that state. This is the
epic where the starter stops being a generic SaaS and becomes *the product*:
**Orun Cloud**.

Paired epic on the CLI side: `orun/specs/orun-cloud/` (cluster **OC**). The two
epics share one wire contract — [`state-api-contract.md`](./state-api-contract.md)
— and a cross-repo dependency map (below). Neither repo may break the contract
unilaterally.

## Status

| Field | Value |
|-------|-------|
| Status | **Draft → Ready for review** |
| Cluster | **OP** (OP0–OP9) |
| Owner(s) | new `state-worker`, identity-worker, config-worker, api-edge, db, contracts/sdk, web-console-next, infra/terraform |
| Target branch | `main` (PRs merged incrementally, milestone-sized) |
| Builds on | `core/constitution.md`, `core/domain-model.md`, `saas-baseline` (B1/B4/B5), `saas-integrations` (IG0 schema seam), `saas-console-ux` (URL-driven scope) |
| Pairs with | `orun/specs/orun-cloud/` — the CLI-side epic (cluster **OC**) |
| Decisions locked | one tenancy spine (org → project → environment, no parallel "namespace" noun); the state API is a frozen versioned contract shaped to Orun's existing `statebackend.Backend`; one contract, two implementations (Orun Cloud + OSS self-host) — no lock-in; two state planes (immutable CAS objects, mutable run coordination); path-scoped tenancy on every route; catalog is derived truth the platform never edits; secrets are write-only with envelope encryption and audited runtime grants; deny-by-default policy on every new action |

## Thesis

Orun already ships a complete remote-state client: a `Backend` interface
(`internal/statebackend/backend.go`), an HTTP client with retries and three
token sources (`internal/remotestate/`), CLI auth flows (`internal/cliauth/` —
browser loopback + device flow), and `orun cloud link`. What it points at today
is a single-tenant reference backend. Meanwhile this repo already owns
everything a multi-tenant control plane needs: org/project/environment tenancy,
deny-by-default RBAC, API keys and sessions, audit, events, webhooks, metering,
billing, and a console.

This epic connects the two. We give the existing Orun client contract a
first-class multi-tenant home: a new `state-worker` bounded context that stores
**plans, runs, jobs, logs, and catalog snapshots** per org/project/environment;
identity-worker grows the **CLI session and OIDC-federation** endpoints Orun's
token sources already expect; config-worker's dormant `secret_metadata` grows
into a real **secret manager** with runtime grants; and the console renders
**Runs, Stacks, Catalog, and Secrets** as the product's core surfaces. Because
the wire contract mirrors what Orun already implements, the integration is
seamless by construction — and because the same contract stays implementable by
the OSS single-tenant backend (`orun backend deploy`), adopting Orun Cloud is a
URL change, not a migration.

## Read order

1. `README.md` (this file) — status, thesis, milestone-at-a-glance, dependency map.
2. `design.md` — tenancy mapping, auth model, the two state planes, catalog,
   secrets, stacks, console surfaces, billing/metering.
3. `state-api-contract.md` — the normative wire contract (owned here, consumed
   by `orun/specs/orun-cloud/`).
4. `implementation-plan.md` — OP0–OP9, each with goal, owner, dependencies,
   "done when".
5. `risks-and-open-questions.md` — human decisions, deferred choices, risks.

## Milestones at a glance

| ID | Milestone | Status |
|----|-----------|--------|
| OP0 | Foundation (dormant): contracts, `190_state_foundation`, state-worker skeleton, R2 | 🗓️ Planned |
| OP1 | CLI session auth (loopback + device flow + refresh + revoke) | 🗓️ Planned |
| OP2 | Run coordination plane (runs, claims, leases, heartbeats, transitions) | 🗓️ Planned |
| OP3 | Object & log plane (CAS over R2, digest negotiation, log chunks + tail) | 🗓️ Planned |
| OP4 | Tenancy resolution & repo links (`orun cloud link` server side) | 🗓️ Planned |
| OP5 | OIDC federation for CI (GitHub Actions → Orun Cloud tokens) | 🗓️ Planned |
| OP6 | Console: Runs & Stacks surfaces | 🗓️ Planned |
| OP7 | Console: Catalog browser (derived-truth entity graph) | 🗓️ Planned |
| OP8 | Secret manager (storage, grants, console, audit) | 🗓️ Planned |
| OP9 | Metering, entitlements, retention/GC, hardening | 🗓️ Planned |

## Cross-repo dependency map

Each OC milestone (CLI side) verifies against the OP milestone that serves it.
Stage is the integration environment; "done when" gates on both sides passing
against stage.

| Orun Cloud (this repo) | Orun CLI (`orun/specs/orun-cloud/`) | Seam |
|------------------------|--------------------------------------|------|
| OP1 CLI session auth | OC1 auth completion | `/v1/auth/cli/*` endpoints ↔ `internal/cliauth` |
| OP4 tenancy & repo links | OC2 cloud link & scope resolution | link API ↔ `RepoLink` cache |
| OP2 run coordination | OC3 remote state v1 | `state-api-contract.md` §runs ↔ `internal/remotestate/client.go` |
| OP3 objects & logs | OC3 + OC4 object/catalog push | contract §objects/§logs ↔ object store sync |
| OP7 catalog browser | OC4 catalog push | catalog snapshot envelope (from `orun-service-catalog`) |
| OP8 secret manager | OC5 secrets integration | contract §secrets ↔ runner secret provider |
| OP5 OIDC federation | OC6 CI golden path | token exchange ↔ `OIDCTokenSource` |

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| state-worker (runs/jobs/objects/logs/catalog heads), CLI session + OIDC auth endpoints, repo-link tenancy resolution, secret manager promotion in config-worker, console Runs/Stacks/Catalog/Secrets surfaces, state entitlements + metering, retention/GC | CLI-side changes (→ `orun/specs/orun-cloud/`), executing jobs on platform-hosted runners (future epic; Orun runners stay customer-side), the catalog *model* itself (→ `orun/specs/orun-service-catalog`), generic resources runtime (→ `saas-resources-runtime`), SSO/SCIM (→ B10) |
