# orun-work v5 — implementation status

> **As-built ≠ intent.** This file records what actually shipped, kept
> distinct from the design/plan docs. The epic is Draft; nothing has
> shipped yet.

## Milestones

| ID | Milestone | Status |
|----|-----------|--------|
| WV0 | The design language | ✅ Shipped — orun-cloud #427: `--work-*` tokens (light + dark), the `northwind-work.tsx` primitive set (RungIcon/TaskRungMark/PinBadge, MilestoneDiamond/Rail, WorkMeter, AgentAvatar, SessionChip, LensBar, GroupBand, TruthCaption), the pure glyph model with 16 conformance tests, demo-gallery Work tab, northwind-design.md inventory |
| WV1 | The Work home | In progress |
| WV2 | Epics & Tasks lenses | Not started |
| WV3 | The task peek | Not started |
| WV4 | Initiative & epic pages | Not started |
| WV5 | Keyboard, motion, command | Not started |
| WV6 | The sweep and the proof | Not started |

## Design rules to hold throughout

To be confirmed as shipped work lands, per the cross-cutting acceptance in
[`implementation-plan.md`](./implementation-plan.md): WV-1 (no backend
diff), WV-2 (every derived pixel names its source), WV-3 (pin beside
truth, asserted), WV-4 (keyboard-first, mouse-complete), WV-5 (Northwind
primitives only, grep-gated).
