# saas-multi-org-billing — Risks & Open Questions

Live register of the product/architecture decisions and human-gated items for the
epic. The packaging + behavior decisions (D1–D5) were **answered 2026-06-08** and
are recorded below; only credentials and two deferred follow-ups remain open. MO1
(the dormant seam) is safe to build now; the only blocker for **paid** multi-org
(MO2+) is provider credentials.

## ✅ Decisions made (2026-06-08)

| # | Decision | Resolution |
|---|----------|------------|
| D1 | Payment provider / Merchant-of-Record posture | **Polar first** — Polar is the Merchant of Record (legal seller, remits tax/VAT). Stripe/others come later via the same adapter (`billing-provider-abstraction` sub-epic). |
| D2 | How multi-org is sold | **Self-serve checkout** — the org-creation gate ends in a Polar checkout, not a sales lead form. (Enterprise tier remains "contact sales".) |
| D3 | Limit semantics across the account | **Per-org inherited limits** — each org gets the plan's per-org limits; only `limit.organizations` is account-level. Keeps the `check-entitlement` hot path and matches Datadog. |
| D4 | Downgrade below the org limit | **Grandfather + block-new** — existing children keep working; creating new children is blocked until the org count is back under `limit.organizations`. Least destructive, fully auditable. |
| D5 | Plan packaging | **Flat tiers** (Free / Pro / Business / Enterprise) with fixed per-tier limits and flat price. Full catalog in `design.md` §3. |

## ⛔ Still open — human-input gates (do NOT auto-pick)

| Item | Blocking decision | Unblock signal |
|------|-------------------|----------------|
| **Provider credentials** | Polar `POLAR_ACCESS_TOKEN` + `POLAR_WEBHOOK_SECRET` per env; Polar products created for Pro/Business → product ids for `POLAR_PRODUCT_MAP`; webhook endpoint configured in the Polar dashboard. | User supplies sandbox creds (unblocks BP1 end-to-end) then prod creds (at launch). |

## Deferred follow-ups (out of scope for MO1–MO6 unless promoted)

| Item | Default for now | Notes |
|------|-----------------|-------|
| **Parent role / ownership transfer** | The first/default org stays the billing parent; no reassignment. | Promote to a follow-up if customers need to move the payer to another org. |
| **Cross-org membership & RBAC** | **Membership stays per-org** (preserves the audit/isolation boundary in `core/domain-model.md`). | Account-level admin roles are a `components/04` follow-up, out of scope here. |
| **Pooled quotas** | Not built (D3 chose per-org inherited). | Build only on explicit customer demand; it would require a live cross-org aggregation read at gate time. |

## Notes / non-blocking

- **No live-data migration risk:** every existing org is standalone
  (`parent_org_id NULL`); the feature is dormant until purchased (`design.md` §8).
- **Isolation invariant holds:** child orgs keep their own `org_id` scope, audit,
  and project isolation — multi-org changes *who pays*, not the tenancy boundary.
- **Catalog reconciliation (MO1):** the decided catalog supersedes the current
  placeholder `free`/`pro` rows in `plan-catalog.ts`. MO1 must not silently reduce
  a bootstrapped org's limits — apply the D4 grandfather principle to any
  downward change on an in-use plan code.
