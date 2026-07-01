# teams-collaboration (TC) — Risks & Open Questions

Risks center on preference precedence and staying within the "surface, don't page"
boundary — not data safety.

## ⛔ Still open — confirm before building

| # | Question | Default lean |
|---|----------|--------------|
| **TC-A** | **Preference precedence** — can a team default re-enable a category a member (or org policy) turned off? | Member-override wins over team-default; **org suppression is an absolute ceiling** (security/compliance categories can never be re-enabled by a team). |
| **TC-B** | **Mention surfaces** — which surfaces get `@team` first? | Notification targets + routing rules first (routing-key form). Rich mentions wait for a comment/activity surface to exist. |
| **TC-C** | **On-call scope** — team-level *default* only, or full schedules/rotations? | **Default only at v1** (a single escalation target inherited by owned services). Schedules/rotations are a later enhancement, likely an integrations concern. |
| **TC-D** | **Delivery identity for members** — email only (today) or reserve for future channels? | Email only now; keep the target→recipient resolver channel-agnostic so a future Slack/PagerDuty adapter (out of scope) can plug into the same expansion. |

## ✅ Decisions made

| # | Decision | Resolution |
|---|----------|------------|
| TC-1 | **Target, not channel** | A team is a notification *target* expanded to members at enqueue; delivery stays on the one (email-first) spine. |
| TC-2 | **Live expansion** | Members are resolved at send time; roster changes need no backfill. |
| TC-3 | **Surface, don't page** | On-call/escalation is surfaced (SC6 boundary); the platform does not page — delivery integrations are out of scope. |
| TC-4 | **Route by ownership** | Event→team routing uses TO ownership; unowned falls back to the org default. |

## Risks

| Risk | Mitigation |
|------|------------|
| **Notification storms** — a team target × a noisy event class floods every member | Sensible default rules (failures, not every run); per-member category opt-out (TC2); rate-limit/batch on the notification spine (B2/B3). |
| **Suppression bypass** — a team default re-enables a compliance-suppressed category | TC-A: org suppression is an absolute ceiling in the cascade; covered by tests. |
| **On-call mistaken for paging** — users expect the platform to page | Clear "surfaced, not paged" copy (SC6 boundary); paging is explicitly out of scope. |
| **Stale routing on unowned services** — events with no owning team vanish | Fall back to org default + surface the entity in TO5's unmapped-owner backlog so coverage gaps are visible, not silent. |
