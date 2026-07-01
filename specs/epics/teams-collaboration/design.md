# teams-collaboration (TC) — Design

Status: Draft. Written against repo reality as of 2026-07-01: notifications are email-only
with a provider seam; `NotificationRecipient`/`NotificationPreference`
(`packages/contracts/src/notifications.ts`) key on `subjectKind: "user" | "organization"`
only; there is **no** `@mention` concept anywhere; on-call/escalation is an *entity*-scoped
console-authored overlay `catalog_entity_annotations` (SC6), which explicitly **"surfaces
escalation targets; does not page."**

## 1. Team as a notification target (TC1) — expand, don't add a channel

A team is not a new delivery channel; it is a **target that expands to members** at
enqueue. Add `"team"` to the notification subject kind and resolve at send time:

```
enqueue(notification, target):
  if target.subjectKind == 'team':
     members = team_members(target.subjectId) where status=active          # TF
     recipients = ⋃ member → resolve to a delivery identity (email today)
     for r in recipients: apply preference cascade (§2); enqueue if not suppressed
  else: (today's user/org path, unchanged)
```

Expansion at enqueue (not a stored fan-out) means a roster change is reflected on the next
notification with no backfill — the same "resolve live, no cache to bust" property the
authz expansion has. Delivery stays email-first; the provider seam (B2) carries any future
channel.

## 2. Preference cascade (TC2 prefs) — team-default → member-override

Extend `NotificationPreference` so a team can carry category defaults and a member can
override for themselves:

```
effectivePref(member, team, category):
  member-override(member, category)                 # explicit opt-in/out wins
    ?? team-default(team, category)                 # the team's setting
    ?? org-default(category)                         # today's org-wide default
  ∧ not org-suppressed(member, category)             # security/compliance suppression still wins
```

- A member can **opt out** of a team's non-critical category without leaving the team.
- **Org-level suppression** (security/compliance) remains an absolute ceiling — a team
  default can never re-enable something org policy suppressed (TC-A precedence).

## 3. `@team` mentions/handles (TC2)

There is no mention system to extend, so TC introduces the **minimum**: `@handle`
resolution *where routing already flows* — notification targets and (as it lands) the
activity feed. `@payments` → team `team_…` (TF handle) → members (§1). This is deliberately
not a rich comment/mention UX (no such surface exists); it is the routing-key form of a
mention, so monitors/rules can address a team by handle.

## 4. Team-scoped on-call/escalation (TC3) — promote SC6, still don't page

SC6's `catalog_entity_annotations` holds `team`/`slack_channel`/`escalation` **per entity**,
authored in the console/CLI (not catalog content). TC generalizes the *level*:

```
onCallFor(entity):
  entity-level annotation (SC6)                       # explicit per-service override
    ?? team-level default (the owning team's on-call) # NEW: inherited via TO ownership
    ?? none ("no on-call declared")
```

- A **team on-call default** (a sibling annotation keyed by `team_id`, same overlay
  contract, still console/CLI-authored) means a team sets escalation once and all its owned
  services inherit — with per-service override still possible.
- Consistent with SC6's boundary: we **surface** the escalation target on the entity/team
  page; we **do not page**. Actual delivery to Slack/PagerDuty is an integrations concern,
  explicitly out of scope.

## 5. Event → owning-team routing (TC4)

The payoff of TO + TC together: a service-scoped event (a failed deploy/run on an owned
entity) routes to the **owning team**.

```
routeEvent(event with entityRef):
  team = resolveOwner(account, entity.owner)          # TO
  target = team ? notify(team) : fallback(org default) # §1 expansion
```

- Routing rules start with a small, legible default (owned-service run/deploy failure →
  owning team) rather than a rules engine; richer routing is a later enhancement.
- Unowned/unmapped entities fall back to the org default (and appear in TO5's coverage
  backlog — another reason to close ownership gaps).

## 6. Alternatives considered

- **Store a team's expanded recipient list** — rejected: drifts on roster change; enqueue-
  time expansion is live and backfill-free.
- **Add a "team" delivery channel** — rejected: a team is a *target*, not a transport;
  reusing the member→email path keeps one delivery spine.
- **Page from the platform** — rejected: SC6's explicit boundary ("we do not page");
  paging is an integrations/notifications-delivery concern with its own reliability bar.
- **A full mention/comment system** — rejected as premature: no comment surface exists;
  TC ships only the routing-key form of `@team`.
