# orun-work v5 — implementation plan

Status: Normative ladder. Milestones follow the importable convention
(`orun work import` reads this file); each is independently shippable and
lands as one or more PRs with CI green. IDs are WV0–WV6.

Cross-cutting acceptance for every milestone: no schema, migration,
mutator, verdict, fold, API route, SDK, CLI, or MCP change lands anywhere
(WV-1 — the diff is confined to `apps/web-console-next` and docs); no
component renders a derived value without its evidence/arithmetic (WV-2,
asserted in component tests extended from the WH2 suite); every lifecycle
rendering shows observed truth unconditionally with pins as badges beside
it (WV-3); Work components compose Northwind primitives only — a
`git grep` gate keeps raw hex values and ad-hoc Tailwind palettes out of
`src/components/work/` (WV-5); the v2/v3/v4 conformance fixtures and the
existing console test suite pass unmodified.

## WV0 — The design language

**Goal:** The Work vocabulary exists as tokens and primitives in Northwind, both themes, before any screen is rebuilt.
**Done when:** the Work tokens (design.md §1) land as CSS variables in `src/styles/globals.css` for light and dark; `northwind.tsx` (or a sibling `northwind-work.tsx`) exports `RungIcon`, `MilestoneDiamond` + rail, `WorkMeter`, `IntentChip`, `HealthPill` (with evidence popover slot), human/agent/unassigned avatars, `SessionChip`, `LensBar`, `GroupBand`, and `TruthCaption` with the exact geometry of design.md §2; `RungIcon` is a pure function of fold output with a unit test per rung and a pin-beside-icon rendering test (WV-3); `docs/northwind-design.md` gains the Work section (tokens + component inventory) and cites this epic; a demo-gallery page renders every primitive in both themes for screenshot review.
**Deps:** —

## WV1 — The Work home

**Goal:** One Work home at `/work`: header, lens bar, and the Initiatives lens at mock fidelity, with the old entry points consolidated.
**Done when:** the home renders the header (serif title, subtitle copy, fold stats with the `need attention` stat deep-linking to `/work/triage`) and the sticky `LensBar` with Filter/Display/New shells; the Initiatives lens ships the full row grammar (health dot · title · epic count · `HealthPill` with hover evidence · `WorkMeter` + fraction · target · owner · chevron) and its `TruthCaption`, from the existing WH1 portfolio reads only; lens selection lives in the URL (`?lens=`), defaults to Initiatives, and the last lens is remembered per user; `/work/initiatives` redirects to the home; the initiatives-workbench component is deleted or reduced to the lens; Lighthouse/aXe smoke on the home is clean.
**Deps:** WV0

## WV2 — Epics & Tasks lenses

**Goal:** The remaining two lenses: intent-grouped Epics, rung-grouped Tasks with the cycle bar, live Filter/Display, board demoted to a layout.
**Done when:** the Epics lens groups by intent state via `GroupBand`s in ladder order with per-row `IntentChip` (revision inside, drifted variant) and initiative chips, plus its `TruthCaption`; the Tasks lens renders the cycle bar (derived from the v3 burn-up summary), rung-grouped rows with `RungIcon`/key/title/`SessionChip`/epic-or-inbox chip/assignee/relative-time, and inbox tasks render `inbox · no epic`; Filter and Display menus work (filters carry the v3 filter model; Display owns grouping, ordering, and Layout: List | Board); the board renders inside the Tasks lens with drag-mints-pin semantics and the 422 verdict toast unchanged; saved views serialize lens + filter + display and existing saved views migrate; old board/list deep-links redirect.
**Deps:** WV1

## WV3 — The task peek

**Goal:** Tasks stop being navigations: the right-docked, non-modal peek with the rung-pin ladder, evidence timeline, and session banner.
**Done when:** clicking (or `Enter`/`Space` on) a task row anywhere on the Work plane opens the peek per design.md §3.6 (440px, radius 14, no backdrop, page stays live); the truth-source tag renders `observed` or `pinned by <actor>` and is never absent; the `RUNG · FOLD WITH PIN` ladder renders all six rungs, highlights observed unconditionally, and click/`p`+`Enter` mints or clears a pin through the existing v3 mutator with its verdict handling; the evidence timeline renders the observation log with relative times; the session banner renders for live sessions and deep-links to the AG session page; `Esc` closes and restores row focus; the task-conversation sheet remains reachable from the peek; component tests assert the ladder accepts no lifecycle write besides the pin mutator (WV-3).
**Deps:** WV2

## WV4 — Initiative & epic pages

**Goal:** The two durable drill-downs at mock fidelity: evidence callout, Designs rail, milestone ladder, drift banner, sticky rails.
**Done when:** the initiative page ships breadcrumb, serif header + `HealthPill`, the health-evidence callout (rendered whenever health ≠ on-track, one line per contributing signal), the restyled Designs rail (cards with `Adopted @rev`/`Superseded` chips, provenance lines, ghost create card), the epics section rows, and the rail with `PROPERTIES` / `SUCCESS CRITERIA` / `DERIVED · NOT ENTERED` exactly per design.md §3.4; the epic page ships breadcrumb, header + `IntentChip`, the drift banner with `Review changes` + `Re-approve @<rev>` (the button label carries the revision; both wire to the existing WH4 flows), the milestone ladder with diamond rail, collapse behavior (complete collapsed, active expanded), per-milestone meters, dense task rows opening the peek, and the `PROPERTIES` / `INTENT` / `WORKING ON IT` rail; every derived value on both pages renders evidence on hover and accepts no input.
**Deps:** WV0 (primitives) · WV3 (rows open the peek)

## WV5 — Keyboard, motion, command

**Goal:** The surface becomes an instrument: full keyboard grammar, Work verbs in ⌘K, the New menu, the motion pass, skeleton and empty states.
**Done when:** the keyboard table in design.md §4 works end-to-end (lens switch, row focus, open/peek, create, filter/display, pin focus) with visible focus rings; every keyboard action registers as a U5 command-palette verb (worded `Pin rung…`, never `Mark as…` — asserted by a palette-registry test); the `New ⌄` menu creates task/epic/initiative/design via the existing dialogs, lens-aware; motion lands per spec (120–160ms, pulse only for live dots, data-change-only meter animation) with `prefers-reduced-motion` honored; every lens and both detail pages have geometry-mirroring skeletons and one-line teaching empty states; keyboard + reduced-motion paths covered by integration tests.
**Deps:** WV1–WV4

## WV6 — The sweep and the proof

**Goal:** The rest of the Work plane joins the language, the legacy skin is deleted, and the epic's claims are measured.
**Done when:** milestone, design, triage, and cycles surfaces compose the WV0 primitives (no visual forks; triage keeps its queue IA); the legacy workbench styling and any now-dead components are deleted (`work-workbench` reduced to the Tasks lens shell or removed); the WV-5 grep gate is CI-enforced for `src/components/work/`; interaction budgets are measured on the dogfood workspace corpus and recorded in this file (targets: lens switch < 100ms perceived, peek open < 150ms from cached fold, home render with 50 initiatives / 500 tasks without jank — virtualize if exceeded); an a11y pass records contrast results for the amber-on-wash chips and fixes or documents deviations; docs screenshots (web-docs work-plane pages) are regenerated from the live v5 console.
**Deps:** WV1–WV5
**Interaction budgets:** to be recorded here at WV6 close.

## Ordering

WV0 → WV1 → WV2 → WV3 → WV4 → WV5 → WV6. WV3 and WV4 can proceed in
parallel after WV2 if staffing allows (the peek and the detail pages share
only WV0 primitives); WV5 needs all screens; WV6 is the closing sweep.

## Explicitly out of scope

Any backend change (WV-1); restyling non-Work console surfaces; a theme
builder or density preference; custom fields; Gantt/timeline/roadmap
slideware; editable health or any status write path (the refusals of v2–v4
carry forward unweakened); mobile-specific Work layouts beyond Northwind's
existing responsive rules (tracked as risks Q-6).
