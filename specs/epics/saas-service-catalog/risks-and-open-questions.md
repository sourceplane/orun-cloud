# saas-service-catalog — Risks & Open Questions

Status: Draft. The locked decisions are in `README.md` (Decisions locked). This
file tracks what is still open and the risks the design has to hold.

## Decisions locked (recap)

- **D-LOCK-1** Hybrid drill-down: quick-peek drawer (`?entity=`) + deep-linkable
  `/catalog/[entityKey]` route. The route owns rich content; the drawer owns
  fast browse.
- **D-LOCK-2** The contextual entity sidebar is a *generalization* of the
  existing Settings rail-swap, not a new navigation primitive.
- **D-LOCK-3** v1 tabs: Overview · Dependency graph · Deployments · Activity.
- **D-LOCK-4** Differentiators committed: scorecards, insights, ownership/
  on-call, scaffolder.
- **D-LOCK-5** The read-model invariant is preserved — no console-authored
  catalog content, ever. Enrichment is computed-overlay, git-authored snapshot,
  separated operational-annotation, or git-writing scaffolder.

## Open questions (need a human/product call before the named milestone)

### Q1 — Ownership source of truth (gates SC6)
Intrinsic ownership is a *catalog fact* and should come from git
(`catalog-info.yaml`-style, via `orun catalog push`). But the snapshot's current
`owner` is a free string. **Decision:** do we (a) enrich the git snapshot/CLI to
carry a structured team ref (true to the invariant, requires CLI + snapshot
schema work and customer adoption), or (b) start with an org-authored team
mapping in the annotations overlay and migrate to git-authored later? Lean (a)
for correctness, (b) as a bridge. The operational contact (Slack/escalation)
is overlay either way.

### Q2 — Scorecard rule format (gates SC5)
Built-in vs. authorable. **Decision:** ship 2–3 *hardcoded* scorecards
(Production-readiness, Ownership, API-quality) to land the surface, or design a
declarative rule spec (YAML/JSON, git-authored à la Cortex) from the start?
Hardcoded ships SC5 faster and defers the authoring UX; declarative is the
eventual product but is a larger contract. Recommend hardcoded v1, declarative
as an SC5 follow-on. Either way the *result* is a computed overlay — the format
question is only about the rule inputs.

### Q3 — Graph library (gates SC1)
React Flow (rich interaction, ~heavier bundle) vs. a lighter static SVG/d3
layout for the entity mini-map. **Decision:** React Flow for the interactive org
graph (code-split so the table path is untouched); a static SVG is acceptable
for the one-hop entity mini-map if the chunk cost is material. Confirm the
bundle budget against the U-track perf bar.

### Q4 — Scaffolder placement & dependency on IG4 (gates SC7)
The scaffolder writes repos/PRs, which is integrations territory (IG4 token
broker). **Decision:** does SC7 live in a new surface owned by this epic
(templates + catalog story) calling integrations, or partly in
`integrations-worker`? And do we hard-gate SC7 on IG4 shipping, or build behind
a dormant provider seam so the template UX can land first? Recommend: this epic
owns templates + the scaffold action and the catalog narrative;
`integrations-worker` owns acting on GitHub; hard-gate the *live* path on IG4,
allow the template-registry + form UI to land dormant. SC7 is a sub-epic
candidate (`saas-service-catalog/sub-epics/golden-paths/`).

### Q5 — Tab routing shape (gates SC0 detail)
`/catalog/[entityKey]/[tab]` (segment per tab, cleanest deep links, more route
files) vs. `?tab=` (one route, query-driven). Recommend the segment form for
SEO/back-button parity with the rest of the App Router console; confirm against
the existing route conventions.

## Risks

### R1 — Invariant erosion (highest)
The constant pull toward "just let the console edit the entity" (the Backstage-
UI default) would break the drift-free-provenance guarantee in
`components/18-state.md`. Mitigation: the four-shapes rule in `design.md` §1 is a
hard gate in review; the annotations overlay is *labeled and stored* separately
so the git-derived boundary stays legible and no reviewer mistakes it for
catalog authoring.

### R2 — Overlay/projection key drift
Overlays key on `entity_ref` (and the identity triple), but the projection is
rebuilt on head advance. If an overlay keyed on a projection row id, it would
orphan on re-projection. Mitigation: overlays key on the *stable* identity
(`entity_ref` / `(project, env, ref)`), never on a derived row id; scorecards
are idempotent on `head_digest` and simply recompute.

### R3 — Scorecard signal availability
Scorecard checks that depend on runtime/deploy signals are only as good as the
run-coordination data for that entity's project/env. Mitigation: degrade a check
to "unknown" (not "fail") when its signal is absent, so a young org is not
punished with false reds; weight the score over *available* checks.

### R4 — Graph performance at scale
A large merged org graph can be expensive to lay out client-side. Mitigation:
the org graph respects the existing filter toolbar (it is never unbounded),
code-split the graph chunk, and cap rendered nodes with a "narrow your filter"
affordance past a threshold.

### R5 — Premium gating coherence
Scorecards/scaffolder behind entitlements must fail closed and route to the U7
upgrade UX, consistently with the rest of the console. Mitigation: reuse the
materialized per-org entitlement seam and the shipped upgrade CTA; no bespoke
gating.

### R6 — Scope creep into incident/runtime management
"On-call" and "deployments" tempt expansion into paging and CI execution.
Mitigation: the scope boundary in `README.md` is explicit — we *surface*
escalation targets and deploy provenance; we do not page and we do not execute
builds (P2/runtime, notifications/integrations own those).
