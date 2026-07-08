# saas-settings-ia (SI) — Risks & Open Questions

Status: Draft.

## Risks

### R1 — Overlap with `teams-hub` (TH1) on the Account surface
TH1 also proposes an Account Hub. If both epics build account pages, they collide.
**Mitigation:** the D4 split is explicit — **TH owns the account-surface *pages***
(members roster, workspace list, cross-workspace fan-out reads); **SI owns the
*nav model + doorway routing*** that places them at a top-level Account home and
wires the switcher. SI2 lifts the *existing* `settings/account/*` pages up
unchanged as the interim host; TH's richer pages drop into the same doorway. The
two must be sequenced/reviewed together, not in isolation.

### R2 — Redirect sprawl / broken deep links
SI moves ~12 route families. A missed shim 404s a bookmarked or in-product link.
**Mitigation:** the design §5 table is the authoritative redirect list; SI ships a
table-driven redirect test asserting every legacy path resolves. The repo already
uses `redirect()` shims for the prior top-level→settings moves, so the pattern and
its tests exist.

### R3 — Inline role editing is a real authority change on a busy surface
Exposing `PATCH …/members/:id` inline (SI3) makes privilege escalation one click.
**Mitigation:** the mutation is already server-authorized (deny-by-default,
`validateRoleAssignment`, `membership.updated` audit); the console renders it
deny-safe (hide/disable when the actor lacks `member.role.update`), optimistic with
rollback on 403 (U8). No new authority — only surfacing the shipped one.

### R4 — Provenance column depends on facts the client can see
The `direct` / `via team` / `account-cascaded` label must be trustworthy.
**Mitigation:** derive it from the same membership facts `listEffectivePermissions`
assembles server-side (the account-scope remap and team-fact expansion happen in
membership-worker, not the client), surfaced through the existing effective-access
read — not re-derived in the browser.

### R5 — "Settings follow the switcher" is a learned model
Users habituated to a single `/settings` may not expect the Account chip to open
different settings than the Workspace chip.
**Mitigation:** the switcher already badges Account vs Workspace (WID5), so the
distinction is visible before the click; page titles name their scope (SI5); Cmd-K
gives a direct path to each. This is the Vercel/Clerk/WorkOS pattern, not a novel
one.

## Open questions

### Q1 — Personal route namespace: `/you` vs `/account` vs `/settings/you`?
D5 picks `/you` to kill the tenant/person "account" collision. Open: whether to
keep a `/account` **redirect** indefinitely (recommended, matches the WS/WID
"nothing is removed" back-compat stance) or deprecate on a date. **Leaning:**
indefinite redirect.

### Q2 — Does the Roles matrix need a real endpoint, or a contract mirror?
SI4 can read a static mirror of the role catalogs in `packages/contracts`
(zero backend) or a `GET …/roles` facade (single source of truth, small api-edge
add). **Leaning:** contract mirror first (ships console-only), promote to a facade
if/when custom roles (TG) make the catalog dynamic.

### Q3 — At Workspace scope, is "Teams" a tab on People & Access or a separate rail item?
The current first-class `/orgs/:slug/teams` product surface is good and heavily
linked. Open: whether the workspace People & Access "Teams" tab **replaces** it or
**links to** it. **Leaning:** keep the product-surface Teams page; the People &
Access "Teams" tab at workspace scope shows *granted* teams and links out — Teams
management stays account-scoped (its owning scope).

### Q4 — Billing visibility for non-billing-admins after the move to Account
Moving Billing to the Account doorway (SI1) is correct, but a workspace admin who
is not `billing_admin`/`account_billing_admin` should see a legible "billing is
managed at the account" affordance, not a dead end. **Leaning:** show the Account
doorway's Billing entry with an entitlement-style locked state (reuse the U7
`precondition_failed` upgrade-UX component) rather than hiding it silently.

### Q5 — Sequencing against PX3 (notification-preferences backend)
SI1 re-homes the personal Notifications page to `/you/notifications`, but its
*content* (email prefs GET/PUT) is blocked on PX3/B2. Open: ship the moved page
with the existing (partial) surface, or gate the You→Notifications entry until
PX3. **Leaning:** move the page now (IA is independent of the backend); the entry
renders whatever PX3 has shipped, consistent with the U11 deferral note.
