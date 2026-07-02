---
title: Architecture
description: How Orun Cloud is built — one edge API worker in front of bounded-context workers, a Next.js console on Workers, and a Supabase/R2/KV/Durable Objects data plane.
---

Orun Cloud is a set of **bounded-context Cloudflare Workers** behind a single
public **edge API worker**, with a Next.js console delivered from Workers +
Static Assets and Supabase Postgres as the primary relational store. Each
context owns its schema, its migrations, and its contracts; nothing but the
edge (and the console) is reachable from the public internet.

```text
                 https://app.orun.dev            https://api.orun.dev
                ┌───────────────────┐          ┌──────────────────────────┐
   Browser ───▶ │  web-console-next │          │        api-edge          │
                │  (Next.js/OpenNext│  fetch   │  auth resolution · CORS  │
   SDK/CLI ────▶│  Workers+Assets)  │ ───────▶ │  /v1/workspaces alias    │
                └───────────────────┘          │  idempotency (KV)        │
                                               │  rate limits (DO)        │
                                               │  facades per context     │
                                               └────────────┬─────────────┘
                                        service bindings +  │  provenance headers
              ┌───────────┬───────────┬───────────┬─────────┴──┬───────────┐
              ▼           ▼           ▼           ▼            ▼           ▼
         identity    membership   projects     events       config     metering
              ▼           ▼           ▼           ▼            ▼           ▼
          billing   notifications webhooks  integrations    state    (policy ◀─ called
              │           │           │           │            │        by workers)
              └───────────┴─────┬─────┴───────────┴────────────┘
                                ▼                       admin-worker (internal only,
              ┌─────────────────────────────────┐        never behind the edge)
              │  Supabase Postgres (Hyperdrive) │
              │  R2 (state objects) · KV · DOs  │
              └─────────────────────────────────┘
```

## The edge API worker

`api-edge` is the only public HTTP entry point for the API. Per request it:

- **Resolves the actor** — session token, API key, or workflow token — once,
  and forwards the identity downstream as provenance headers.
- **Rewrites vocabulary** — `/v1/workspaces/*` is rewritten to the canonical
  `/v1/organizations/*` before routing, and a `ws_…` ref or slug in the path is
  resolved to the canonical `org_<hex>` id, so downstream workers only ever see
  opaque ids.
- **Enforces idempotency** — a caller-owned `Idempotency-Key` on unsafe methods
  is checked against a KV-backed replay store; replays carry
  `x-saas-replay-source: edge-idempotency`, and a KV outage fails open to a
  direct forward, never a 5xx. See [Idempotency](/api/idempotency).
- **Enforces rate limits** — token buckets per (org, identity) scope, backed by
  a Durable Object per bucket key for atomic counters without a KV write on the
  hot path. See [Rate limits](/api/rate-limits).
- **Routes to a facade per bounded context** (`auth-facade`, `org-facade`,
  `project-facade`, `audit-facade`, `billing-facade`, …) which forwards over a
  service binding, and appends its own phases to the `Server-Timing` header.

## Bounded-context workers

Each context is a separate Worker because it is a separate ownership boundary:
its own contracts, storage namespace, migration history, and failure domain —
and the first extraction candidates when a context needs to leave the monorepo.

- **identity-worker** — users, sessions, API keys, OAuth, service principals.
  Separate because credentials and session state have a stricter security
  boundary than everything else.
- **membership-worker** — organizations (workspaces), members, invitations,
  role assignments. The tenancy source of truth.
- **projects-worker** — project and environment lifecycle inside a workspace.
- **policy-worker** — deny-by-default RBAC evaluation. Not bound to the edge;
  the domain workers call it over service bindings so authorization decisions
  are centralized and consistent. See [RBAC](/platform/access-control/rbac).
- **events-worker** — domain-event fanout and the immutable audit log; serves
  the org-scoped audit query surface.
- **config-worker** — settings, feature flags, and secret metadata primitives.
- **metering-worker** — usage ingestion, rollups, quota state, and summaries.
  Kept apart from billing so metering can be trusted independently of pricing.
- **billing-worker** — plans, subscriptions, invoices, entitlements, and the
  provider adapter (Polar today; a Stripe path exists but is
  credential-blocked).
- **notifications-worker** — email dispatch and per-user delivery preferences.
- **webhooks-worker** — outgoing webhook endpoints, HMAC signing, delivery
  attempts, retries, and replay.
- **integrations-worker** — the GitHub integration: connections, repo links,
  inbound delivery handling, and short-lived token brokering.
- **admin-worker** — audited admin/support workflows. **Internal-only**: it has
  no edge facade and is never publicly routable (see
  [Operations](/self-hosting/operations)).
- **state-worker** — the state plane: run coordination, a content-addressed
  object/log store on R2, catalog heads, and workspace links. See
  [State plane](/platform/state-plane/overview).

## The console

`web-console-next` is a Next.js 15 app delivered through
`@opennextjs/cloudflare` as a Worker entrypoint plus a static-assets directory
(Cloudflare **Workers + Static Assets**). It is an API client like any other —
it talks to `api-edge` and holds no privileged path into the workers.

## Data plane

| Store | Used for |
| --- | --- |
| **Supabase Postgres** | Primary relational store. Separate Supabase projects per environment (`orun-cloud-stage`, `orun-cloud-prod`); each bounded context owns its schema/table namespace and migration history. |
| **Cloudflare Hyperdrive** | Pooled Postgres access for Workers — workers reach the database through the `PLATFORM_DB` Hyperdrive binding, not raw connection strings. |
| **R2** | Content-addressed state objects and logs for the state plane. |
| **Workers KV** | The edge idempotency replay store. |
| **Durable Objects** | Per-bucket rate-limit counters at the edge. |

## Internal calls: service bindings + provenance

Worker-to-worker calls travel exclusively over **Cloudflare service bindings**
(`IDENTITY_WORKER`, `MEMBERSHIP_WORKER`, `PROJECTS_WORKER`, …) — they are
in-process dispatches, never public URLs, so an internal surface cannot be
reached from the internet even if its route shape is known.

Every forwarded request carries provenance headers set by the edge after actor
resolution: `x-request-id` plus the actor block (`x-actor-subject-id`,
`x-actor-subject-type`, `x-actor-email`, and — where relevant —
`x-actor-org-id` / `x-actor-project-id`). Downstream workers trust these
headers only because the binding topology guarantees the caller is the edge.
Project-scoped calls always carry `orgId + projectId` — never a bare
`projectId` — per the project-isolation invariant.

## Shared packages

| Package | Role |
| --- | --- |
| `packages/contracts` | API, tenancy, event, and error types + validators — the single wire contract for workers, SDK, and console. |
| `packages/policy-engine` | The RBAC evaluation logic consumed by policy-worker. |
| `packages/db` | Migration harness, manifest, and runner (plus the Hyperdrive adapter). |
| `packages/sdk` | The [TypeScript SDK](/developers/sdk), contract-driven. |
| `packages/cli` | The [`orun-cloud` CLI](/developers/cli), built on the SDK. |
| `packages/shared` | Generic helpers (IDs, errors) — no domain logic. |

Every one of these units — worker, package, Terraform stack, migration runner —
declares itself as **component intent** (`component.yaml`) and is deployed by
`orun`; see [Run your own](/self-hosting/deploy-your-own).

## Related

- [Run your own](/self-hosting/deploy-your-own)
- [Operations](/self-hosting/operations)
- [Security model](/security/security-model)
- [API overview](/api/overview)
