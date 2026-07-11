# orun-work v5 — implementation status

> **As-built ≠ intent.** This file records what actually shipped, kept
> distinct from the design/plan docs. The epic is Draft; nothing has
> shipped yet.

## Milestones

| ID | Milestone | Status |
|----|-----------|--------|
| WV0 | The design language | ✅ Shipped — orun-cloud #427: `--work-*` tokens (light + dark), the `northwind-work.tsx` primitive set (RungIcon/TaskRungMark/PinBadge, MilestoneDiamond/Rail, WorkMeter, AgentAvatar, SessionChip, LensBar, GroupBand, TruthCaption), the pure glyph model with 16 conformance tests, demo-gallery Work tab, northwind-design.md inventory |
| WV1 | The Work home | ✅ Shipped — orun-cloud #428: one surface, three lenses (?lens= in the URL, last choice remembered), Initiatives lens at mock fidelity, early Epics lens, embedded-workbench Tasks bridge, /work/initiatives redirect, portfolio workbench deleted |
| WV2 | Epics & Tasks lenses | ✅ Shipped — orun-cloud #429: cycle bar from derived scope/done, rung groups in active-first order (pin-position grouping, badge beside truth), Filter/Display pills (board demoted to a Display layout), saved views unchanged |
| WV3 | The task peek | ✅ Shipped — orun-cloud #430: non-modal right-docked peek, RUNG · FOLD WITH PIN ladder over the v2 pin mutator, truth-source tag, evidence timeline, live session banner, pure pinIntent/truthSourceTag with tests |
| WV4 | Initiative & epic pages | ✅ Shipped — orun-cloud #431: drift banner with content-addressed Re-approve, milestone diamond ladder (complete folds shut), dense rows opening the peek, sticky Properties/Intent/Working-on-it rails, initiative evidence callout + Designs cards + DERIVED · NOT ENTERED rail |
| WV5 | Keyboard, motion, command | In progress |
| WV6 | The sweep and the proof | Not started |

## Design rules to hold throughout

To be confirmed as shipped work lands, per the cross-cutting acceptance in
[`implementation-plan.md`](./implementation-plan.md): WV-1 (no backend
diff), WV-2 (every derived pixel names its source), WV-3 (pin beside
truth, asserted), WV-4 (keyboard-first, mouse-complete), WV-5 (Northwind
primitives only, grep-gated).
