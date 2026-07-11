# orun-work v5 — implementation status

> **As-built ≠ intent.** This file records what actually shipped, kept
> distinct from the design/plan docs.

## Milestones

| ID | Milestone | Status |
|----|-----------|--------|
| WV0 | The design language | ✅ Shipped — orun-cloud #427: `--work-*` tokens (light + dark), the `northwind-work.tsx` primitive set (RungIcon/TaskRungMark/PinBadge, MilestoneDiamond/Rail, WorkMeter, AgentAvatar, SessionChip, LensBar, GroupBand, TruthCaption), the pure glyph model with 16 conformance tests, demo-gallery Work tab, northwind-design.md inventory |
| WV1 | The Work home | ✅ Shipped — orun-cloud #428: one surface, three lenses (?lens= in the URL, last choice remembered), Initiatives lens at mock fidelity, early Epics lens, embedded-workbench Tasks bridge, /work/initiatives redirect, portfolio workbench deleted |
| WV2 | Epics & Tasks lenses | ✅ Shipped — orun-cloud #429: cycle bar from derived scope/done, rung groups in active-first order (pin-position grouping, badge beside truth), Filter/Display pills (board demoted to a Display layout), saved views unchanged |
| WV3 | The task peek | ✅ Shipped — orun-cloud #430: non-modal right-docked peek, RUNG · FOLD WITH PIN ladder over the v2 pin mutator, truth-source tag, evidence timeline, live session banner, pure pinIntent/truthSourceTag with tests |
| WV4 | Initiative & epic pages | ✅ Shipped — orun-cloud #431: drift banner with content-addressed Re-approve, milestone diamond ladder (complete folds shut), dense rows opening the peek, sticky Properties/Intent/Working-on-it rails, initiative evidence callout + Designs cards + DERIVED · NOT ENTERED rail |
| WV5 | Keyboard, motion, command | ✅ Shipped — orun-cloud #432: 1/2/3 lens keys, j/k roving focus, lens-aware c, f/d menus, p-to-pin in the peek, ⌘K lens verbs + the no-"Mark as…" wording gate, peek-in motion, data-change-only meter animation |
| WV6 | The sweep and the proof | ✅ Shipped — orun-cloud #433: last hexes tokenized, ProgressBar deleted, legacy workbench/view-bar retired (−1,011 lines), WV-5 style gate + projection budget CI-enforced (~5 ms at 10× dogfood), contrast recorded. Remaining tail: web-docs screenshot refresh + deployed-console profiling ride the live dogfood pass |

## Design rules held throughout

Per the cross-cutting acceptance in
[`implementation-plan.md`](./implementation-plan.md), verified on every
milestone PR (#427–#433): **WV-1** — zero schema/mutator/fold/API/SDK/CLI/
MCP diff across the whole epic (every write on the new surfaces is a
pre-existing mutator); **WV-2** — meters ship with their arithmetic,
health with its evidence, approval never renders without `@revision`
(asserted in the WV0 rendering suite); **WV-3** — pins render beside
observed truth in list, board, ladder, and peek (asserted); **WV-4** —
every pointer action has a keyboard path and a ⌘K verb, and the registry
test forbids `Mark as…` wording forever; **WV-5** — `work-style-gate`
keeps raw hex and per-surface dark forks out of `components/work/` in CI.

## The tail

The live dogfood pass (the same one carrying v4's import) owns:
regenerating the web-docs work-plane screenshots from the deployed v5
console, and profiling the two end-to-end interaction budgets (lens
switch, peek open) on the production corpus.
