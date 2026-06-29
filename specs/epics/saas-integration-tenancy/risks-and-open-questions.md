# saas-integration-tenancy — Risks & Open Questions

Live register of the architecture/product decisions for the epic. IT1 (the
dormant resolution seam) is safe to build now; the live multi-org paths (IT2+) are
gated on `saas-integrations` IG1/IG2/IG4 landing and on the one product decision
below. Defaults are chosen to be least-surprising and reversible; **do not
silently flip a default without recording it here**.

## ⛔ Still open — product decision (do NOT auto-pick the non-default)

| # | Decision | Default | Notes |
|---|----------|---------|-------|
| D1 | **Sibling isolation: soft vs hard** | **Soft** (recommended) | Soft: workspaces under one account share the connection; what each sees is scoped by repo-link ownership + project/policy, mirroring how children already share a billing customer and pooled usage. Hard: a workspace's repos/events must be invisible to sibling workspaces even within the account — re-introduces per-workspace claim walls and stricter fan-out, and partially negates the easing this epic buys. Build hard **only** on explicit customer demand. |

## ⛔ Still open — lifecycle behavior (pick before IT6)

| # | Decision | Options | Leaning |
|---|----------|---------|---------|
| D2 | **Detach** (`clear parent_org_id`) effect on the workspace's repo links against the account connection | (a) **revoke** the workspace's active links on detach; (b) **block** detach while active links exist (force unlink first) | (b) block-then-unlink — least destructive, symmetric with billing's reversible detach; surface the blocker in the console. |

## ✅ Decisions made

| # | Decision | Resolution |
|---|----------|------------|
| A1 | Integration tenant boundary | **The parent (account) org**, via `effectiveIntegrationOrg(org) = parentOrgId ?? org.id` — twin of `effectiveBillingOrg`. |
| A2 | Credential direction | **Resolve up, never fan out.** One connection per installation, owned by the account; entitlements still fan down (MO3, unchanged). |
| A3 | Keystone | **Preserved.** `installation_id` stays globally `UNIQUE`; no constraint relaxed. |
| A4 | Authorization model | **Resolution, not hierarchical RBAC.** Exact-match policy (`scope.orgId === orgId`) is untouched; only integration *resource addressing* resolves to the account, gated by the workspace's own repo-link ownership. |

## Security / correctness risks

| Risk | Mitigation |
|------|------------|
| **Cross-workspace token leak** if the broker ever returns a full-installation token | "Never mint unscoped" becomes a hard invariant with tests (IT4); scope-down (`repository_ids` + permissions subset) is already enforced by GitHub. The blast radius of a regression rises from intra-org to intra-account — hence the dedicated suite. |
| **Repo double-claim** under a shared connection (two workspaces both receive a repo's events/tokens) | Single-claim partial unique `uq_integrations_repo_claim (connection_id, repo_external_id)` (IT2); attribution resolves ≤1 active link (IT3). |
| **Split-brain tenancy** — some handlers address the connection at the account, others at the raw workspace org | The IT6 invariant suite asserts every read/write resolves through `effectiveIntegrationOrg`; mirror billing's discipline of routing *all* reads through one seam. |
| **Uninstall blast radius** — a parent-side uninstall removes GitHub for every workspace | Disclosed in the console danger-zone + connection detail; reconciled through the existing lifecycle path with per-org audit. |
| **Unsolicited / orphaned installs** unchanged | Still recorded as orphaned and surfaced to admin-worker; never auto-bound (fail closed, `saas-integrations` §4). |

## Dependencies

| Dependency | State | Notes |
|------------|-------|-------|
| `saas-multi-org-billing` MO1 (`parent_org_id`, `effectiveBillingOrgId`) | ✅ Shipped | The substrate this epic mirrors. |
| `saas-integrations` IG1 (connect), IG2 (inbound), IG4 (token broker) | 🗓️ Planned | The live mechanics this epic re-points; IT2+ cannot land before them. |
| GitHub App registered per env | Human-gated | Same gate as `saas-integrations` D1/D2. |

## Non-blocking notes

- **No live-data migration risk:** every existing org is standalone
  (`parent_org_id NULL`) and resolves to itself; the seam is dormant until a
  customer owns an account with workspaces.
- **Isolation invariant holds:** the exact-match policy boundary is unchanged;
  this epic changes *which org owns the connection*, not how membership is checked.
- **Orthogonal to `saas-workspaces`:** the mechanism here is independent of what
  the units are *named*; WS can land before or after.
