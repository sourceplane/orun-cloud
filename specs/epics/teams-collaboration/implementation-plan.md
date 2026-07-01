# teams-collaboration (TC) — Implementation Plan (TC1–TC4)

**Prerequisites:** `teams-foundation` **TF** (entity + handle + members), `teams-ownership`
**TO** (owner→team for routing), `saas-baseline` **B2** (notification spine). Boundary: no
new delivery channel, no paging.

## TC1 — Team as notification target

- `packages/contracts` + `packages/notifications-client`: add `"team"` to the notification
  subject kind.
- `apps/notifications-worker`: at enqueue, expand a team target to active members (TF) and
  resolve each to a delivery identity; apply the preference cascade (TC2) + existing
  suppression before enqueuing.
- **Done when:** a notification addressed to a team reaches its current members; a roster
  change is reflected on the next send with no backfill; org suppression still wins.

## TC2 — Preference cascade + `@team` resolution

- `packages/contracts` + `apps/notifications-worker`: `NotificationPreference` gains a
  team-default level; resolution is member-override → team-default → org-default, with
  org-suppression as an absolute ceiling.
- `apps/membership-worker`/`apps/api-edge`: resolve `@handle` → `team_` → members where
  routing flows (notification targets; activity feed as it lands).
- **Done when:** a member can opt out of a team category without leaving the team; org
  suppression cannot be overridden by a team default; `@handle` resolves to a team target.

## TC3 — Team-scoped on-call/escalation defaults

- `apps/state-worker` (SC6 overlay): a team-level on-call annotation (same
  `catalog_entity_annotations` contract, keyed by `team_id`), console/CLI-authored;
  entity-level annotations override; owned services inherit the team default via TO.
- `apps/web-console-next`: render on-call on the team page + entity drawer, marked
  "surfaced, not paged".
- **Done when:** a team sets escalation once and its owned services inherit it; per-service
  override works; nothing pages (targets are surfaced only).

## TC4 — Event → owning-team routing

- `apps/notifications-worker` + the event path: route service-scoped failure events
  (deploy/run) to the owning team via TO resolution; a small legible default rule set;
  unowned entities fall back to the org default.
- **Done when:** a failed run/deploy on an owned service notifies its owning team; unowned
  services fall back cleanly and surface in TO5's coverage backlog.

## Sequencing note

TC1 → TC2 (targeting + prefs) first; TC3 (on-call) and TC4 (routing) build on TO ownership.
TC3's on-call data is rendered read-only by the **TH** team page. Paging and on-call
schedules are explicitly out of scope (future integrations work).
