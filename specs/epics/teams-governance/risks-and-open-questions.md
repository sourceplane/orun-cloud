# teams-governance (TG) — Risks & Open Questions

The enterprise plane. Its defining risks are **upstream gates** (B10) and one **foundational
RBAC decision** (the restriction model), not implementation detail.

## ⛔ Still open — confirm before building

| # | Question | Default lean |
|---|----------|--------------|
| **TG-A** | **SCIM authority for mixed teams** — can a team have both IdP-synced and manual members, or is a team fully-synced-or-manual? | **Fully-synced-or-manual at v1** (a `provider` binding flips the team to IdP-authoritative, roster read-only). Mixed ownership is ambiguous; add later if needed. |
| **TG-B** | **Restriction model** — visibility scoping (read-filter, engine stays allow-only) vs true deny/ABAC (engine evolution)? | **Visibility scoping first** — delivers "teams see their own" additively; reserve deny/ABAC for a separate, explicitly-scoped RBAC epic if hard confinement is required. **Blocks TG2.** |
| **TG-C** | **Custom-role ceiling** — can a custom role include any permission, or only a subset of the grantor's? | Only a subset of the grantor's own permissions (no privilege escalation); curated from the **existing** catalog (no new permissions). |
| **TG-D** | **Review cadence** — platform-scheduled attestation vs on-demand only? | On-demand + optional scheduled (quarterly) reminders once notifications (TC) can target reviewers. Start on-demand. |

## Dependencies & gates

| Gate | Nature | Handling |
|------|--------|----------|
| **B10 (SSO/SCIM)** | Hard upstream, ⛔ in `saas-baseline` (needs B1+B8 stable + IdP credentials) | TG1 is documented-but-unbuilt until B10; teams are manually managed via TF meanwhile. Do not fork a parallel identity path. |
| **TG-B (restriction model)** | Foundational RBAC decision | TG2 does not start until decided; it is the only milestone that may change `packages/policy-engine`. |

## ✅ Decisions made

| # | Decision | Resolution |
|---|----------|------------|
| TG-1 | **IdP is authoritative when synced** | A SCIM-bound team's roster is directory-owned; console edits are read-only (Datadog/Okta convention). |
| TG-2 | **Restriction is not additive** | Confinement requires an engine decision (TG-B); the rest of the program stays additive. |
| TG-3 | **Custom roles curate existing permissions** | No new permissions per customer; a custom role is a bundle of the fixed catalog, grantor-bounded. |
| TG-4 | **Never silently orphan** | Team dissolution reassigns or explicitly marks-Unowned its owned entities; member/​grant/​owner-map cleanup is audited. |

## Risks

| Risk | Mitigation |
|------|------------|
| **Engine complexity blowup** — adopting deny/ABAC inverts evaluation and explodes the test surface | Default to visibility scoping (TG-B option a); gate any deny model behind a dedicated RBAC epic with its own conflict-resolution spec + tests. |
| **SCIM drift / desync** — IdP and platform rosters diverge | Reconcile-on-push + periodic full reconcile; treat drift as a sync bug (alert), not a manual fix; synced rosters read-only. |
| **Attestation theater** — reviews signed without meaning | Render real provenance (TF4) + real recent activity (TH4) next to each grant so reviewers see *why* access exists and whether it is used. |
| **Custom-role sprawl** — many bespoke roles become unmanageable | Grantor-bounded + audited + delete-safe; surface usage (which teams hold each custom role) so unused roles are prunable. |
