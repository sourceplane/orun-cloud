# teams-governance (TG) — Implementation Plan (TG1–TG5)

**Prerequisites:** `teams-foundation` **TF** (entity + members + provenance + audit).
**Gates:** TG1 waits on `saas-baseline` **B10** (SSO/SCIM, ⛔); TG2 waits on the restriction-
model decision (TG-B). TG3/TG4/TG5 are buildable on TF now.

## TG1 — SCIM/SAML group → team sync  ⛔ (gated on B10)

- `apps/identity-worker` + `apps/membership-worker`: `team_idp_bindings` (team ↔ IdP group);
  reconcile `team_members` on SCIM push / SAML group claim; synced teams' rosters become
  read-only in console/CLI ("managed by <IdP>"); every change audited.
- **Done when (post-B10):** an Okta/AzureAD group drives a team's membership; joiners/leavers
  reconcile automatically; manual edits to synced teams are blocked with a clear reason.

## TG2 — Team-scoped restriction / visibility  ⛔ (gated on TG-B decision)

- **Decision first (TG-B):** visibility scoping (read-filter, engine stays allow-only) vs
  true deny/ABAC (engine evolution). Do not start the build until chosen.
- Default path (visibility scoping): `apps/api-edge`/read surfaces filter list/read results
  to the viewer's teams' owned/granted resources unless a broad role applies; the engine's
  allow evaluation is unchanged.
- **Done when:** a scoped team member sees only their teams' resources on list/read surfaces;
  broad roles bypass the filter; the chosen model is recorded and tested.

## TG3 — Custom roles + team-scoped grants

- `packages/db` + `apps/membership-worker` + `packages/policy-engine`: an account-scoped
  `custom_roles` catalog (curated subsets of the **existing** permission vocabulary);
  grantable to a team via `role_assignments` (`subject_type='team'`); grantor-can't-exceed-
  own-permissions guardrail; audited; delete-safe.
- **Done when:** an account admin can define a custom role from existing permissions and grant
  it to a team; the engine resolves it; a custom role can never exceed its grantor.

## TG4 — Lifecycle governance

- `apps/membership-worker` + console: archive/restore; ownership transfer (reassign
  `team_admin` + reassign owned entities via TO's map, never silent orphan); orphan cleanup
  (member-leaves-account strip; deleted-team grant + owner-map revoke); all audited.
- **Done when:** teams can be archived/restored/transferred/deleted safely; no dangling grants,
  memberships, or owner-map rows; every action is audited.

## TG5 — Access reviews / attestation

- `apps/api-edge` + `apps/web-console-next`: periodic membership + grant review with sign-off;
  audit export; renders on the **TH** surfaces using **TF4** provenance.
- **Done when:** a reviewer can attest/revoke a team's members + grants; sign-offs are recorded
  and exportable as an audit trail.

## Sequencing note

TG3/TG4/TG5 are buildable on TF today and deliver the lifecycle + compliance surface. TG1 is
parked until B10 lands. TG2 is parked until TG-B (the engine-model decision) is made — it is
the one milestone that may change `packages/policy-engine`, so it carries the highest design
risk in the whole program.
