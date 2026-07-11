# orun-work v4 — risks and open questions

Status: Living register. Decisions locked in the README's status table are
restated here only when they carry a live trade-off worth re-checking.

## Decision ledger (locked, with the trade-off named)

| # | Decision | Trade-off accepted |
|---|---|---|
| V4-A | Two ladders: intent authored, delivery derived | Two state chips per epic is more UI than one status field; we accept the pixel cost because collapsing them is exactly the lie v2 exists to prevent |
| V4-B | Design is a noun (doc + sealed context + structured proposal) | Proposal JSON is a schema to maintain; the alternative (epics appear from chat scrollback) loses the compare/adopt/provenance loop that makes AI proposals governable |
| V4-C | Epic = surface rename of `spec`; wire kind unchanged | Permanent alias to document; a data migration would be cleaner in five years and break every client today — additive wins |
| V4-D | Milestones are epic-scoped sub-items (`<epic>#WH2`), not workspace items | No cross-epic milestones; keys don't ride work.sequences. Matches the repo convention exactly; a workspace-level "release train" grouping, if ever needed, is a saved view or a later noun |
| V4-E | Approval human-only, content-addressed, one policy knob (minApprovals) | No reviewer matrices/stage routing; enterprises wanting SOX-grade flows build on the log later |
| V4-F | Task churn never drifts approval; doc/milestone edits do | An agent can materially reshape implementation via tasks without re-approval — accepted because contracts still flag through triage review, and the doc+ladder is the scope contract |

## Open questions

- **Q-1 (minApprovals scope).** Per-workspace knob or per-initiative? Start
  workspace-wide; revisit if dogfood shows mixed-formality initiatives.
- **Q-2 (agent verdict weight).** `review_submitted` by an agent is advice
  today (counts toward nothing). Should a workspace be able to *require* an
  agent review (e.g. security-lens design review) before approve? Deferred:
  the events already exist; a policy predicate can land without schema work.
- **Q-3 (epic without initiative).** Allowed (v2/v3 corpus imports parent-
  less). Does the portfolio need an "unfiled" shelf, or is the epics list
  enough? Decide in WH2 with real data.
- **Q-4 (design → multiple initiatives).** A design currently belongs to
  exactly one initiative. Cross-initiative designs ("platform re-org")
  would break the drill-down's simplicity; deferred until a real case
  appears in dogfood.
- **Q-5 (milestone target dates vs cycles).** Milestones carry targetDate;
  tasks carry cycles (v3). Do epic pages need cycle overlays too, or does
  the ladder + burn-up suffice? Decide in WH2 by feel.
- **Q-6 (regeneration blast radius).** `task_regenerate` cancels open tasks
  under a milestone. Should tasks with observed delivery activity (branch
  seen, PR open) be protected from agent cancellation? Leaning yes: 422
  verdict, human confirms. Fix in WH5 against the acceptance run.
- **Q-7 (health formula).** on-track/at-risk/off-track needs thresholds
  (target-date trajectory, blocked-age, drift count). Lock the v1 formula in
  WH6 against the dogfood corpus and record it in design §1.5; the formula
  is code with named evidence, never a per-workspace config surface (yet).

## Deferred register

- Initiative-level OKR/metric linkage (successCriteria stays prose).
- Cross-workspace portfolio (WP-7 stands; `related` edges may point across).
- Design merge tooling (compare ships; merge is a human writing revision 3).
- Approval delegation/expiry policies.
- A public read-only roadmap surface (pairs P6 changelog/status, later).
- CRDT editing (unchanged from v3's deferral; measured trigger).
