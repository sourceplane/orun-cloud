# Epic: teams-collaboration (TC)

**Make a Team something you can *reach* — "who do we reach?" — as a notification target, an
`@mention` handle, an event-routing destination, and the owner of on-call/escalation
defaults.** Today notifications target only `user`/`organization`, there is no `@mention`
concept anywhere, and on-call lives as an *entity*-scoped catalog annotation. TC turns the
Team into the platform's routing primitive. Part of the
[`teams-platform`](../teams-platform/) program. **Plane: Collaboration / Ops.**

## Status

| Field | Value |
|-------|-------|
| Status | **Draft** — depends on `teams-foundation` **TF** (entity + handle + members), `teams-ownership` **TO** (owner→team, so events route to the *owning* team), and `saas-baseline` **B2** notifications (the delivery spine). |
| Cluster | **TC** (teams-collaboration — reach + on-call) |
| Owner(s) | `apps/notifications-worker` + `packages/notifications-client` + `packages/contracts` (targets/prefs) · `apps/membership-worker` (team→members expansion) · `apps/state-worker` (team-scoped on-call annotations) · `apps/web-console-next` |
| Builds on | `saas-baseline` **B2** (`NotificationRecipient`/`NotificationPreference` in `packages/contracts/src/notifications.ts` — today `subjectKind: user\|organization`); `saas-service-catalog` **SC6** (`catalog_entity_annotations`: `team`/`slack_channel`/`escalation`, *entity*-scoped, console-authored, "we surface escalation, we do not page"); `teams-ownership` **TO** (route by owner) |
| Decisions locked | (1) A team is a **notification target** by *expanding to members at enqueue* — not a new delivery channel; (2) **preferences cascade**: team-default → member-override (a member can opt out of a team's category); (3) on-call/escalation is promoted from *entity*-only to a **team-level default with entity override** — still authored in the console/CLI (SC6 overlay), still **not paging** (we surface targets; delivery integrations are separate); (4) event→team **routing** uses TO ownership (a deploy failure on an owned service reaches its owning team). |
| Gate | Confirm TC-A (member-override vs org-suppression precedence), TC-B (mention surfaces — which surfaces get `@team` first), TC-C (on-call scope — team-default only vs schedules). See `risks-and-open-questions.md`. |

## Thesis

Ownership (TO) tells you *what's ours*; collaboration tells you *how ours reaches us*.
Datadog's Teams are the target of monitor notifications (`@team-handle`), the owner of
on-call schedules, and the routing key for incidents. This repo has the delivery spine
(B2) and an entity-scoped operational overlay (SC6) but **nothing that routes to a group**.
TC adds the group-routing layer: a team resolves to its members at send time, carries its
own notification preferences, owns on-call defaults its services inherit, and becomes the
destination events route to **by ownership**. Crucially this is done **without a new
channel** and **without paging** — it is targeting + routing over the existing spine, in
line with SC6's "we surface escalation targets; we do not page."

## Milestones at a glance

| ID | Milestone | Status |
|----|-----------|--------|
| TC1 | **Team as notification target**: `subjectKind='team'`; expand to active members at enqueue; team-default + member-override preferences | Draft |
| TC2 | **`@team` handles/mentions**: resolve `@handle` → team → members in notification/activity surfaces (start where routing already flows) | Draft |
| TC3 | **Team-scoped on-call/escalation defaults**: promote SC6 annotations to team-level (`team`/`slack_channel`/`escalation`) with **entity override**; owned services inherit | Draft |
| TC4 | **Event → owning-team routing**: route service-scoped events (deploy/run failure on an owned entity) to the owning team (via TO); rules + defaults | Draft |

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| Team notification target + expansion + preference cascade, `@team` resolution in existing surfaces, team-level on-call/escalation defaults with entity override, event→owning-team routing | **Paging / incident delivery** (SC6 defers it; a notifications/integrations concern if ever wanted); new delivery **channels** (Slack/PagerDuty adapters) beyond surfacing the target; on-call **schedules/rotations** (TC-C — a later enhancement over defaults); comment threads (no such surface exists) |

## Read order

1. `README.md` — the reach thesis + the no-new-channel / no-paging boundary.
2. `design.md` — target expansion, preference cascade, team-level on-call, routing.
3. `implementation-plan.md` — TC1–TC4 with "done when".
4. `risks-and-open-questions.md` — override precedence, mention surfaces, on-call scope.
