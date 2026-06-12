# saas-console-ux — Implementation Plan (U1–U11)

Carved from the roadmap's "UI / Design (U)" cluster. U1–U10 were originally scoped
inside Task 0082 (App Router cutover). Status markers reflect code reality as of
2026-06-08. Normative design direction is in `design.md`.

## U1 — Next.js 15 (App Router) on Cloudflare Pages — ✅ Shipped
Migrate the console from the vanilla-TS prototype to Next.js 15 App Router via
`@opennextjs/cloudflare`. Stood up alongside the old console, then cutover; old
console is archive-only after parity. (Task 0082.)

## U2 — Design system in `packages/ui` — ✅ Shipped
shadcn/ui + Radix Primitives + Tailwind v4 baseline, full agent freedom on token
names/palette/type-scale/motion. Every console primitive comes from `packages/ui`;
no bespoke per-page styling; dark-mode-by-default with a working light mode.

## U3 — URL-driven scope selector — ✅ Shipped
`/orgs/:orgSlug/projects/:projectSlug/environments/:envSlug/...` is the source of
truth for the multi-tenant invariant. `sessionStorage` routing state forbidden.
Persistent scope switcher on every page.

## U4 — Empty states as a product feature — ✅ Shipped
Every list view ships a designed empty state with a primary CTA and a one-line
explanation. No `"No X yet"` + emoji placeholders.

## U5 — Cmd-K command palette — ✅ Shipped
Global Cmd-K: switch org/project, jump to each page, create invitation, create API
key, logout. Extensible registry so each product area registers its own actions.

## U6 — Contract-driven forms — ✅ Shipped
`react-hook-form` + Zod, schemas derived from / matched against
`packages/contracts`. Pattern + helper extracted to `packages/ui`.

## U7 — Designed precondition_failed / upgrade UX — ✅ Shipped
On `412 precondition_failed` from the entitlement seam, render a designed upgrade
prompt distinguishing the four reason codes (`disabled`, `not_configured`,
`malformed_limit`, `limit_reached`); show usage vs limit when available; CTA +
"talk to sales" fallback; requestId behind a Details disclosure. (Unblocks B6.)

## U8 — Skeleton + optimistic UI — ✅ Shipped (skeletons); optimistic ongoing
Designed skeleton state on every list/detail. Mutation flows optimistic where safe
(rename, archive, role change) with clean rollback. Skeletons shipped; optimistic
flows continue as follow-ups (also wired into the PERF1 cache mutations).

## U9 — White-label-ready theming — ✅ Shipped (foundation)
Token-driven theming so a fork rebrands by editing `packages/ui/tokens.css`. No
hard-coded color literals; logo/wordmark via a swappable component. Full
white-label kit can be a follow-up.

## U10 — Console-as-SDK-client — ✅ Shipped
After B4, the console consumes `@saas/sdk` (`src/lib/api.ts`) rather than a bespoke
`api.ts`. Single client surface; single retry/auth/idempotency story.

## U11 — Vercel-standard console completion — ✅ Shipped (notification-prefs deferred)
Closed the remaining buyer-visible gaps, scoped to surfaces the public API/SDK
already backs (Task 0127):
- **Usage & quota dashboard** over `metering.getUsageSummary` / `checkQuota` /
  `listQuotaViolations`. ✅
- **Account profile / general settings** over `auth.getProfile` / `updateProfile`
  / `logout`. ✅
- **Org & project settings** — read-only metadata + danger-zone archive
  (`projects.archive`, `environments.archive`). No rename/update (no API). ✅
- **Design-system completion** — `Select`, `Sheet`, `Tooltip`, `Popover`,
  `Checkbox` + a mobile nav drawer. ✅
- **Interaction polish** — Cmd-K as an extensible registry; optimistic mutations
  with rollback where safe. ✅
- **Notification preferences** — ⛔ **deferred (backend-blocked):** api-edge
  exposes no `/v1/notifications/*` facade; the dependency-free `Switch` primitive
  is in place for when it lands. (See `saas-baseline` risks + P4.)

## Post-U11 polish (this epic, ongoing)
Sidebar/profile/theme placement, mobile drawer parity, dialog centering + a11y,
inline copy feedback, button loading spinners, slug auto-derive, last-used-org
default, auth-guard hardening, prod error boundaries. Tracked as incremental PRs
until the epic is declared v1-complete.
