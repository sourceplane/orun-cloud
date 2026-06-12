# saas-console-ux — Design Direction (Normative)

This epic implements the console; the **durable contract** for what the console
must do is `specs/components/12-web-console.md` (§ Design Direction, § API
Consumption, § Acceptance Criteria). This doc captures the cross-cutting design
*direction* the U-cluster commits to, so individual U-milestones don't each
re-litigate it.

## Principles

- **The URL is the multi-tenant source of truth.**
  `/orgs/:orgSlug/projects/:projectSlug/environments/:envSlug/...` is canonical;
  `sessionStorage` for routing state is forbidden. A persistent scope switcher is
  visible on every page. (U3)
- **Everything comes from `packages/ui`.** shadcn/ui + Radix Primitives +
  Tailwind v4 baseline; no bespoke per-page styling. Dark-mode-by-default with a
  working light mode. (U2)
- **Token-driven theming → white-label is a tokens edit, not a refactor.** No
  hard-coded color literals in components; logo/wordmark via a swappable
  component; theming via CSS variables in `packages/ui/tokens.css`. (U9)
- **The console is just another SDK client.** After B4, the console consumes the
  generated `@saas/sdk`, not a bespoke `api.ts` — one client surface, one
  retry/auth/idempotency story. (U10)
- **Empty/skeleton/upgrade states are product features, not placeholders.** Every
  list ships a designed empty state with a CTA; every list/detail has a designed
  skeleton; every `412 precondition_failed` from the entitlement seam renders a
  designed upgrade prompt distinguishing the four reason codes (`disabled`,
  `not_configured`, `malformed_limit`, `limit_reached`). (U4, U7, U8)
- **Contract-driven forms.** `react-hook-form` + Zod with schemas derived from /
  matched against `packages/contracts`; the pattern + helper live in
  `packages/ui`. (U6)
- **Extensible command surface.** Global Cmd-K with an extensible registry so each
  product area registers its own actions. (U5)

## Constraint

The console may consume **only** `api-edge` (never internal Worker bindings). Any
U-milestone that would need a route api-edge doesn't expose is **out** until a
backend slice adds it (e.g. notification preferences need a `/v1/notifications/*`
facade — deferred; see `IMPLEMENTATION-STATUS.md` and `saas-baseline` risks).

## Relationship to other epics

- **B4 (saas-baseline)** gates U10 (SDK client).
- **P4 (saas-product-areas)** owns the in-app notification *inbox* with read-state;
  this epic only ships per-category *preferences* once the edge facade exists.
- Visual/interaction polish beyond U11 (sidebar, mobile drawer, dialog a11y,
  optimistic mutations) continues under this epic until it is declared v1-complete.
