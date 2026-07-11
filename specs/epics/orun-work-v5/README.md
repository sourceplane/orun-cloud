# orun-work v5 — the surface (Linear feel, honest pixels)

> Console-only epic; this repo owns all of it. There is **no orun leg** —
> the oracle, the folds, the CLI, and the MCP are untouched. Builds ON v2
> (`../orun-work/`, WP0–WP5), v3 (`../orun-work-v3/`, PM0–PM5), and v4
> (`../orun-work-v4/`, WH0–WH6) — nothing here changes what the work plane
> *knows*; everything here changes what it *feels like*. v5 rebuilds the
> Work surface to the bar of the best tracker ever shipped — Linear — while
> keeping the one thing Linear cannot render: every status pixel names its
> truth source.

| | |
|---|---|
| **Status** | **✅ Shipped — WV0–WV6** (orun-cloud #427 #428 #429 #430 #431 #432 #433); the docs-screenshot refresh and deployed-console profiling ride the live dogfood pass (see [`IMPLEMENTATION-STATUS.md`](./IMPLEMENTATION-STATUS.md)) |
| **Cluster** | **WV** (`WV0 → WV6`, plan in [`implementation-plan.md`](./implementation-plan.md)) |
| **Repos** | `sourceplane/orun-cloud` only (`apps/web-console-next`, `docs/northwind-design.md`). No schema, mutator, route, fold, oracle, CLI, or MCP change anywhere. |
| **Builds on** | orun-work v2 (WP, shipped): the derived delivery ladder and the pin seam · v3 (PM, shipped): authoring, board, cycles, views, conversation · v4 (WH, shipped): the five-noun hierarchy, designs, approval, drift, rollups — v5 renders what WH0–WH6 already serve; every screen in this epic is a re-presentation of existing reads |
| **Pairs with** | `saas-console-ux` (**U** — owns the Northwind design system, shell, Cmd-K; v5 grows the Northwind vocabulary and registers Work verbs into U5's palette), `saas-agents`/`saas-agents-live` (**AG/AL** — live session chips deep-link into the Agents surface), `saas-product-experience` (**PX** — skeleton/empty-state conventions) |
| **Pixel source** | `Northwind_Work.html` (the v5 pixel mock, 2026-07-11). Following the `northwind-design.md` precedent, the mock itself is not committed; the normative extraction — tokens, component grammar, per-screen specs, exact microcopy — is [`design.md`](./design.md) |
| **Inspiration** | Linear — and this time not the gestures but the *feel*: one home, lenses not destinations, peek not navigate, keyboard not toolbar, density without noise, motion that reports instead of decorates. The discipline is unchanged: every gesture we take from Linear gets re-grounded in a truth source before it ships |
| **Decisions locked** | (V5-A) **one Work home, three lenses** — Initiatives · Epics · Tasks are tabs of a single surface, not sibling destinations; drill-downs are pages, tasks are peeks; (V5-B) **the mock is normative** — the design.md extraction is the source of truth for the light theme; dark derives from the same tokens; screenshots never override tokens; (V5-C) **Linear's feel, honest chips** — no surface gains an editable status as part of the reskin; WP-3 and the pin-beside-truth seam are load-bearing in every component contract; (V5-D) **presentation-only** — v5 consumes the WH1 query surface as-is; if a screen seems to need a new endpoint, the screen is wrong (see risks Q-1); (V5-E) **status icons are folds** — the rung icon set (rings, checks, dashes) is a pure function of fold output; a pinned task renders the pin *beside* the observed icon, never instead of it; (V5-F) **agents are teammates, not textures** — agent actors get their own avatar grammar (square, star) and live-session chips wherever humans get initials, at equal visual rank |
| **Milestone prefix** | **WV** |

## The one-paragraph thesis

v2 built truth (a delivery lifecycle nobody can type). v3 built speed
(authoring, boards, cycles). v4 built shape (Initiative → Design → Epic →
Milestone → Task, with human-only, content-addressed approval). What none
of them built is **desire** — the surface that makes the honest tracker the
one people *prefer*, not just the one they trust. Today the hierarchy ships
as workbenches: correct, complete, and visually foreign to the Northwind
language the rest of the console speaks. v5 is the product-design epic:
one Work home with three lenses (Initiatives · Epics · Tasks), drill-down
pages for the things you own, a peek panel for the things you check,
a keyboard grammar for the things you do all day — rendered entirely in
Northwind (paper canvas, Newsreader display serif, quiet chrome) at
Linear's density and pace. The differentiating rule survives contact with
the aesthetics: **Linear renders opinions beautifully; we render evidence
beautifully.** Every health pill, progress ring, and approval chip on
these screens is a fold with its evidence one hover away, and the three
captions under the lenses say so in words.

## What the mock settles (the five arguments this epic ends)

| Question the workbenches left open | What the mock answers |
|---|---|
| Where does Work *start*? | One home. Lens bar: **Initiatives** (the why), **Epics** (the unit of approval), **Tasks** (the day). Sticky, keyboard-switchable (`1`/`2`/`3`), last lens remembered per user. |
| Is a task a page? | No. A task is a **peek** — a right-docked panel with the rung ladder (fold-with-pin), evidence timeline, live session banner, and two exits (`Open epic page`, `View document`). Tasks are regenerable implementation detail (V4-F); the page-worthy nouns are the durable ones. |
| How does status *look* when it cannot be typed? | Like Linear's icon set, derived: dashed ring (Draft), empty ring (Ready), half ring (In Progress), three-quarter ring (In Review), filled check (Done), green check (Released). The geometry is a pure function of the fold; a pin renders as a badge beside it. |
| Where do agents show up? | Everywhere humans do, at equal rank: square star avatars in assignee columns, `● coder-01 · s_4f21` live chips on rows, a session banner in the peek, `2 humans · 1 agent` in the epic rail. |
| Does honesty cost polish? | The mock's three lens captions are the answer: *"Health folds from member epics on every read…"*, *"…the tracker never lies for you"*, *"…folded from delivery truth — never typed in."* Truth is part of the visual language, set in 12px `#999`, not a compliance banner. |

## Invariants (carried forward, plus v5's)

Carried verbatim — these are the product: **WP-3** (no stored delivery
status anywhere), **WP-6** (one mutator surface), **WP-10** (agents cannot
pin), **V3-3** (derived numbers are not editable), **V4-1** (the delivery
fold is frozen), **V4-2** (approval human-only, content-addressed), **V4-3**
(drift is visible, never blocking).

New for v5:

- **WV-1 No new reads, no new writes.** The epic ships against the WH1
  query surface and the existing mutators/verdicts, byte-identical. The
  only writes any v5 screen performs are the ones the workbenches perform
  today (pins, comments, item edits, approvals, adoption) — restyled,
  never multiplied.
- **WV-2 Every derived pixel names its source.** Rollup components take
  their evidence as part of their props contract — a health pill without
  hover evidence, a progress meter without an n/m, or an approval chip
  without its `@revision` is a type error, not a review comment.
- **WV-3 The pin never impersonates the fold.** In every component that
  renders lifecycle (icon set, chips, board columns, peek ladder), the
  observed value renders unconditionally; a pin adds an attributed badge.
  Asserted in component tests, extended from the WH2 suite.
- **WV-4 Keyboard-first, mouse-complete.** Every action reachable by
  pointer is reachable by keyboard and listed in the ⌘K palette; no
  action is keyboard-only.
- **WV-5 One design language.** Work components compose Northwind
  primitives (`northwind.tsx`) exclusively; per-surface one-off styling
  (the shadcn-era workbench look) is retired, not wrapped.

## Read order

1. This README — the thesis and the scope boundary.
2. [`design.md`](./design.md) — the normative extraction of the mock:
   design stance, tokens, component grammar, the five screens with exact
   microcopy, interaction/keyboard/motion/state specs, IA and routes.
3. [`implementation-plan.md`](./implementation-plan.md) — the WV0–WV6
   ladder with done-whens.
4. [`risks-and-open-questions.md`](./risks-and-open-questions.md) —
   decision ledger and the open questions (default lens, board's future,
   density at scale, dark derivation).
5. [`IMPLEMENTATION-STATUS.md`](./IMPLEMENTATION-STATUS.md) — as-built
   record (empty at draft).

## Milestones at a glance

| ID | Milestone | One line |
|----|-----------|----------|
| WV0 | The design language | Work tokens + primitives land in Northwind (`northwind.tsx`, `northwind-design.md` §Work): rung icon set, two-segment meters, intent/health chips, milestone diamonds, agent avatars, live dots, truth captions — both themes |
| WV1 | The Work home | One route, header (serif title · fold stats · attention link), sticky lens bar, the **Initiatives** lens, lens captions, Filter/Display/New shells, route consolidation + redirects |
| WV2 | Epics & Tasks lenses | Intent-grouped Epics lens with `@revision` chips; rung-grouped Tasks lens with the cycle bar; Filter/Display live; board becomes a Display layout; saved views carried |
| WV3 | The task peek | Right-docked non-modal panel: rung ladder (fold with pin), evidence timeline, live session banner, properties, two exits; open/close/navigate from keyboard |
| WV4 | Initiative & epic pages | The two drill-downs at mock fidelity: health-evidence callout, Designs rail, milestone ladder with the diamond rail, drift banner with `Re-approve @rev`, sticky properties/intent/working-on-it rails |
| WV5 | Keyboard, motion, command | The full keyboard grammar, Work verbs in ⌘K (U5 registry), the New menu, the motion pass (live pulses, collapse, peek slide; reduced-motion), skeleton and empty states |
| WV6 | The sweep and the proof | Milestone/design/triage/cycles surfaces aligned to the language; legacy workbench styling deleted; interaction budgets measured and recorded; a11y pass; docs screenshots regenerated from the live console |

## Scope boundary

| In scope | Out of scope |
|---|---|
| Everything the user sees and touches on the Work plane: IA, layout, typography, color, iconography, motion, keyboard, microcopy, empty/loading states | Any schema, migration, mutator, verdict, fold, route, SDK, CLI, or MCP change (WV-1); if v5 needs one, it stops and files against the WH ladder |
| Consolidating Work routes into the home + redirects; board demoted to a Display layout | New nouns, new lifecycle semantics, new policy knobs — the model is v4's, frozen |
| Northwind primitive growth shared with other surfaces (icons, meters, chips) | Restyling non-Work surfaces (Catalog, Docs, Agents…) — they adopt the grown primitives on their own epics |
| Truth captions, evidence hovers, pin-beside-truth rendering as component contracts | Any softening of the split: no editable health, no status dropdown, no "quick close" that writes lifecycle |
| Light theme at mock fidelity; dark theme derived from the same tokens | A theme builder, per-user density settings, custom fields, Gantt/timeline views (still refused, per v4) |
