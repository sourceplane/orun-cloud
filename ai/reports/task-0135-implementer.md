# Task 0135 — PX1 console truth & papercuts — Implementer Report

## Summary

- Designed 404 (`app/not-found.tsx`); unbranded Next default unreachable.
- `ConfirmDialog` primitive (consequence copy, resource echo, busy-locked
  destructive action, initial focus on Cancel) replaces both native
  `confirm()` calls (member remove, API key revoke) — zero native chrome left.
- Persistent breadcrumb `<nav>` via pure unit-tested `breadcrumbs.ts` model;
  replaces the slug-chip + name echo in `OrgScope`.
- `useUnsavedChangesGuard` (beforeunload) on the dirty account form.
- Config-page copy de-stubbed to the truth (API live via SDK/CLI; UI = PX2).

## Files Changed

Console: `not-found.tsx`, `ui/confirm-dialog.tsx`, `shell/breadcrumbs.ts`,
`shell/org-scope.tsx`, `lib/use-unsaved-guard.ts`, settings members/api-keys/
config pages, account page. Tests: `tests/web-console-next/src/breadcrumbs.test.ts`.

## Checks Run

- `pnpm test` (tests/web-console-next): 196 passed (8 new).
- `pnpm typecheck`, `pnpm lint`, `pnpm build` (OpenNext) in
  `apps/web-console-next`: green.
- `kiox` unavailable in this environment; Orun plan exercised via PR CI
  (changed-scope plan + run).

## Assumptions

- In-app route-change veto intentionally out of scope (no public App Router
  API); beforeunload + existing Save/Discard covers the silent-loss path.
- ZodForm submit buttons already render in-flight state; the org-create
  "stranding" observed in the audit was backend cold-path latency (PERF),
  not a missing UI state.

## Spec Proposals

None — all within PX1 latitude.

## Remaining Gaps

- Webhooks/billing flows already used designed dialogs; not re-audited
  beyond the confirm() grep (repo-wide count was exactly 2).
- Breadcrumb labels for dynamic segments show slugs/ids (names would need
  per-segment fetches); acceptable at the bar, revisit if it grates.

## Next Task Dependencies

PX2 (config surface) replaces the de-stubbed Config page with the real UI.

## PR Number

#299 (epic docs were #298, merged).
