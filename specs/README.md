# Sourceplane SaaS — Spec Pack

Status: Normative index

This directory is the authoritative spec pack for the reusable multi-tenant SaaS
starter. It is organised into three tiers so durable contracts and lifecycle-
tracked work never get confused with each other.

> **Ground rule (from `core/constitution.md` and `roadmap.md`):** trust code
> reality over stale docs. When a spec and the running system disagree, the
> system is the source of truth and the spec is the bug — fix it (or file a
> proposal under `ai/proposals/`).

## The three tiers

| Tier | Directory | What it holds | Lifecycle |
|------|-----------|---------------|-----------|
| **Core** | [`core/`](./core/) | The durable architectural foundation: constitution, product overview, domain model, monorepo shape, access/infra, Orun golden path, operating model, and the frozen `contracts/`. | Normative; **never** archived for being "implemented". Changed only via the constitution's change-control. |
| **Components** | [`components/`](./components/) | One reference spec per bounded context (`00`–`16`). The durable contract each Worker/package must honor. | Stays valid after implementation. `Status:` header reflects code reality + names the owning epic. |
| **Epics** | [`epics/`](./epics/) | Orun-style work programs (`saas-baseline`, `saas-console-ux`, `saas-performance`, `saas-resources-runtime`, `saas-multi-org-billing`, `saas-product-areas`). Each carries a README status table, an `implementation-plan.md` of milestones, and an `IMPLEMENTATION-STATUS.md` as-built record. | Draft → Ready → In progress → Shipped → Closed. |

Plus:

- [`roadmap.md`](./roadmap.md) — the **cross-epic program index/register**. One
  line per cluster pointing into `epics/`; the per-milestone detail lives in the
  epic plans.
- [`_archive/`](./_archive/) — superseded or fully-closed material, **non-
  authoritative**, kept for provenance only.

## Status legend (used in every epic README + component header)

| Marker | Meaning |
|--------|---------|
| `Draft` | Being authored; not ready to build. |
| `Ready for implementation` | Design locked; safe to assign. |
| `In progress` | Some milestones shipped, others open. |
| ✅ `Shipped` | Milestone live on `main` and verified. |
| 🗓️ `Planned` | Scheduled, not started. |
| ⛔ `Blocked` | Needs human input (secrets/decision) or an upstream slice. |
| `Closed` / `Archived` | Program complete or superseded; in `_archive/`. |

## Read order

1. **`core/constitution.md`** — the rules everything obeys.
2. **`core/product-overview.md`** + **`core/domain-model.md`** — what we're building.
3. **`core/repo.md`** + **`core/access-and-infra.md`** + **`core/operating-model.md`** — how the monorepo and ops work.
4. **`core/contracts/`** — the frozen API/tenancy/event/manifest contracts.
5. **`components/`** — the bounded-context contract for the area you're touching.
6. **`epics/<epic>/`** — the active work program that area belongs to (start at its README).

## Conventions (mirrors `../orun/specs/`)

- **Epic = folder**, named `saas-<slug>` (mirrors Orun's `orun-<slug>`).
- Each epic README opens with a **status table** (Status, Cluster, Owner, Target
  branch, Builds on, Decisions locked), a one-paragraph thesis, a read order, and
  a milestone status-at-a-glance.
- **As-built ≠ intent:** shipped state lives in `IMPLEMENTATION-STATUS.md`, never
  silently edited into the design docs.
- A **completed milestone** inside an active epic is marked ✅ — it is *not*
  archived. Only a **fully-closed program** (no open milestones, no follow-ups) or
  a **superseded draft** moves to `_archive/`.
- A **holding epic** (parked / not-yet-scoped) lives as a single README and is
  **promoted** to a full doc set when work starts.
