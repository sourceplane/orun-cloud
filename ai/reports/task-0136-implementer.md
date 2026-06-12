# Task 0136 — PX2 config surface — Implementer Report

## Summary

- New shared `ConfigSurface` (Settings / Feature flags / Secrets tabs) over
  `client.config`, mounted at all three scopes: org `settings/config`,
  new project `projects/:slug/config` page (+ project nav link), environment
  detail section.
- Settings list/create/edit with JSON-or-string value input (pure
  `parseConfigValueInput`/`formatConfigValue`, round-trip tested).
- Flags: optimistic Switch toggle with cache rollback on error.
- Secrets: metadata-only list; write-only create/rotate (password inputs,
  `autoComplete="off"`); revoke via the PX1 `ConfirmDialog`.
- Scope-disambiguated cache keys (`configScopeKey`) added to `qk`.

## Files Changed

Console: `components/config/{config-surface.tsx,value.ts}`, org config page,
new project config page, env detail page, `nav-items.ts`, `query-keys.ts`.
Tests: `config-value.test.ts` (+ nav assertions unchanged — additive link).

## Checks Run

- tests/web-console-next: 203 passed (7 new).
- `pnpm typecheck`, `pnpm lint` green; OpenNext build exercised in CI.

## Assumptions

- No delete for settings/flags in the SDK → not offered in UI (recorded as
  Non-Goal; revisit if the facade grows DELETE).
- Flags created disabled by default — safer rollout ergonomics.

## Spec Proposals

None.

## Remaining Gaps

- Config change events appear in the audit log via config-worker; no
  config-specific history view (PX-later / P1 promote flow).

## PR Number

#300.
