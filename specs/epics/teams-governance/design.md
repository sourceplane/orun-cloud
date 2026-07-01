# teams-governance (TG) — Design

Status: Draft. Written against repo reality as of 2026-07-01: **no SSO/SAML/SCIM exists** —
it is `saas-baseline` **B10**, ⛔ Blocked (after B1+B8 stable, needs IdP credentials); the
policy engine is **allow-only** (`packages/policy-engine/src/index.ts` — first-allow-wins
scan, no deny), and `tenancy-and-rbac.md` states "V1 may implement policy as code-backed
RBAC plus a small attribute layer. It does not need a user-facing policy language yet";
roles are **fixed built-ins** (no custom roles); TF supplies the team entity, members,
provenance, and `team.*` audit.

## 1. Directory sync — SCIM/SAML group → team (TG1)

**Gated on B10.** When SSO/SCIM lands, an IdP group maps to a team:

```
membership.team_idp_bindings (account_org_id, team_id, idp_group_ref, provider, …)
```

- On a SCIM push (or SAML assertion group claim), reconcile `team_members` for the mapped
  team to the IdP group's membership: add joiners, remove leavers, all as audited `team.*`
  events.
- A **synced team is IdP-authoritative**: console/CLI roster edits become read-only
  (surface "managed by Okta"), matching Datadog/Okta convention — the source of truth is the
  directory, and drift is a sync bug, not a manual fix.
- Mixed teams (some IdP-synced members, some manual) are allowed only if the provider
  binding marks specific members as directory-owned; default is fully-synced-or-manual to
  avoid ambiguous ownership.

Until B10, TG1 is documented-but-unbuilt; teams are manually managed via TF.

## 2. Restriction / least-privilege (TG2) — the engine decision

This is the one place the program may change the engine, and it is **not additive**.

**The problem:** the engine unions *allow* facts and can never say "team X may see **only**
its own resources." A user in a broadly-granted team plus a narrow team gets the **union** —
there is no way to confine. Datadog-grade least privilege (restriction queries / team
scopes) requires expressing *negative* or *scoping* constraints.

**The decision (TG-B) — pick one, deliberately:**

- **(a) Visibility scoping (recommended first step)** — keep the engine allow-only for
  *actions*, but add a **resource-visibility filter** resolved from team ownership: list/read
  surfaces show only resources owned by (or granted to) the viewer's teams, unless the viewer
  holds a broad role. This is a *read-filter*, not a deny rule — it composes with the allow-
  only engine and delivers 80% of "teams see their own stuff" without inverting evaluation.
- **(b) True deny/ABAC** — add deny facts or attribute predicates to the engine. Powerful and
  fully general, but it forces conflict-resolution semantics (deny-overrides-allow) and a much
  larger test surface — the thing `saas-teams` deliberately avoided. A real fork in the road.

Default lean: ship **(a) visibility scoping** as TG2; treat **(b)** as a separate, explicitly-
scoped RBAC epic if a customer needs hard confinement. Either way, **do not build TG2 until
this is decided** — it determines the engine's evaluation model.

## 3. Custom roles + team-scoped grants (TG3)

Today roles are fixed built-ins with enumerated permission sets. Enterprise buyers expect
custom roles (a curated permission subset) grantable to a team. Design:

- A `custom_roles` catalog (account-scoped): name + an allowed-permission subset drawn from
  the existing permission vocabulary (no new permissions — just curated bundles).
- Grant a custom role to a team exactly like a built-in (`role_assignments`,
  `subject_type='team'`), with the policy engine resolving the custom role's permission set.
- Guardrails: a custom role can never exceed the grantor's own permissions; changes are
  audited; deletion is safe (revoke-cascade like TF/TM team-delete).

TG3 is additive to the engine (a role is still just a permission set); it does **not** need
the TG2 restriction decision.

## 4. Lifecycle governance (TG4)

- **Archive/restore** — a team can be archived (hidden, grants suspended) and restored,
  distinct from delete (which cascade-revokes, per TM/TF).
- **Ownership transfer** — reassign a team's `team_admin`(s); reassign the entities a team
  owns (via TO's owner map) when a team is dissolved, with an explicit "reassign to team Y /
  mark Unowned" step (never silently orphan).
- **Orphan cleanup** — a member removed from the account is stripped from its teams (wired
  into `remove-member`, per `saas-teams` risks); a deleted team's grants and owner-map rows
  are revoked/cleared.
- All lifecycle actions emit `team.*`/`governance.*` audit events.

## 5. Access reviews / attestation (TG5)

The compliance surface enterprises audit against:

- **Periodic review** — surface each team's membership + grants for a reviewer to confirm or
  revoke ("do these 12 still belong? does this team still need `admin` on `ws_prod`?").
- **Sign-off + audit export** — record who attested what, when; export the audit trail
  (SOC2/ISO evidence). Renders on the **TH** account/team surfaces using **TF4** provenance
  (every grant already traceable to its source).

## 6. Alternatives considered

- **Invert the engine to deny-by-default with team scopes now** — rejected as the default:
  too large a change for the current stage; visibility scoping (§2a) delivers most of the
  value additively. Keep (b) as a deliberate, separately-scoped decision.
- **Build SCIM before B10** — impossible: no SSO/identity-federation primitive exists; TG1
  must wait on B10 rather than fork a parallel identity path.
- **Custom permissions (not just custom roles)** — rejected: custom roles curate the
  *existing* permission vocabulary; inventing new permissions per customer is unbounded and
  breaks the fixed catalog the engine validates against.
