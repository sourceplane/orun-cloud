# orun-work v5 — design

Status: Normative for WV0–WV6. This document is the committed extraction of
the `Northwind_Work.html` pixel mock (2026-07-11) — the mock's inline styles
are exact and this extraction records them; where the two ever disagree, fix
this file, then the code. It extends
[`apps/web-console-next/docs/northwind-design.md`](../../../apps/web-console-next/docs/northwind-design.md)
(the console-wide Northwind spec); shell, sidebar, and base tokens are
inherited from there and not restated except where Work deviates.

## 0. Design stance

Linear won by removing everything between intent and action: one list you
live in, a peek instead of a page load, a keyboard verb for every mouse
gesture, motion that acknowledges instead of entertains, and a visual
temperature so even that nothing shouts. v5 adopts that stance wholesale.

What v5 refuses to adopt is Linear's epistemology. In Linear, a status is
a *belief* — beautiful, instant, and worth exactly the discipline of the
person who set it. On this work plane a status is a *fold*, and the surface
must make that legible without lecturing. The mechanism is three-fold and
constant across every screen:

1. **Derived values render with their arithmetic** — `6/14`, `4/8 tasks`,
   `62% complete · 3 days left` — never as bare adjectives.
2. **Decisions render with their address** — `Approved @3f2a1c9 · Jun 28 ·
   by elena` — never as bare verbs.
3. **The captions say the quiet part** — each lens closes with one 12px
   `#999` sentence naming the truth source (§3.1–§3.3). They are part of
   the design language, in the register of Linear's own UI copy: short,
   declarative, slightly proud.

Density target: Linear's. Rows are 40–44px, type is 13–13.5px, chrome is
borderless until hovered, and nothing on the canvas is a "widget." The
serif (Newsreader) appears exactly where Northwind says it may: page
titles, stat numerals, peek titles. Everything else is the quiet sans.

## 1. Tokens (Work deltas over `northwind-design.md`)

Inherited unchanged: canvas `#FAFAFA`, sidebar `#F5F5F5` @ 230px, card
surface `#FFFFFF`, card border `#E6E6E6`, ink scale (`#171717 · #444444 ·
#737373 · #999999 · #A8A8A8`), success `#3A8159`/`#E7F3EC`, warn
`#9A7B2D` text · `#C39B45` dot/`#F5EDD8` wash · `#FBF7E8` row tint, error
`#C94A44`, info/run blue `#3B76C9`, link `#2563C9`, owner-avatar palettes,
type stacks (Newsreader serif · system sans · system mono).

New or specialized for Work:

| Token | Value | Used for |
|---|---|---|
| `work.column.maxWidth` | **1140px** (home and detail pages; vs 1060px console default) | The lists earn the extra 80px: meter + count + target + avatar columns |
| `work.page.padding` | `44px 40px 90px` home · `36px 40px 90px` detail | |
| `work.rail.width` | `250px`, sticky `top: 24px`, gap `40px` (grid `minmax(0,1fr) 250px`) | Detail-page properties rails |
| `work.row.dividers` | `#F2F2F2` inner · group bands `#F7F7F7` | List cards |
| `work.error.wash` | `#F7E4E3` (Off track pill bg) | |
| `work.info.wash` | `#E9F0FB` text `#3B76C9` | In Review chips, session banner bg |
| `work.drift.banner` | bg `#FBF7E8` · border `#EFE3C2` · ink `#6E5A22` · button border `#E0D5B5` | Approval-drift banner, at-risk callout |
| `work.agent.avatar` | 18px square, radius 5, bg `#ECE6F2`, 4-point star `#7A648F` | Agent actors (vs 18–20px round human initials) |
| `work.live.dot` | 6px `#3B76C9`, 2s opacity pulse (`paused` under reduced motion) | Running agent sessions |
| `work.meter` | height 4px, radius 2, track `#EDEDED`; segments: done+released `#3A8159`, in-progress+in-review `#C39B45` | All progress meters (150px home rows · 70px milestones · 60px epic rows) |
| Rung chip colors | Draft `#737373`/`#FAFAFA`+1px `#EDEDED` · Ready `#666666`/`#F5F5F5` · In Progress `#9A7B2D`/`#F5EDD8` · In Review `#3B76C9`/`#E9F0FB` · Done `#171717`/`#EDEDED` · Released `#3A8159`/`#E7F3EC` | Chips, group headers, peek ladder dots |

Dark theme: derive by token (V5-B); no Work component may hardcode a hex —
everything above lands as CSS variables beside the existing HSL tokens in
`globals.css`, with `northwind.tsx` primitives as the only consumers.

## 2. Component grammar (the Work primitive set, WV0)

All of these land in `northwind.tsx` (or a sibling `northwind-work.tsx`)
and are the *only* building blocks Work screens may use (WV-5).

**`RungIcon`** — the Linear-style status glyph, derived (V5-E). 14×14
viewBox, geometry a pure function of the fold rung:

| Rung | Geometry |
|---|---|
| Draft | dashed ring — circle r 5.4, stroke `#A8A8A8` @ 1.6, dasharray `2.4 2.6` |
| Ready | empty ring — stroke `#999999` @ 1.6 |
| In Progress | progress ring ½ — track `#EDE3C8`, arc `#C39B45`, dasharray 17/34, rotated −90°, round caps |
| In Review | progress ring ¾ — track `#D9E4F4`, arc `#3B76C9`, dasharray 25.4/34 |
| Done | filled disc `#171717`, white check |
| Released | filled disc `#3A8159`, white check |

The ring fraction encodes ladder position, not task-internal progress —
the icon is ordinal, honest, and needs no tooltip. A pinned task renders
its observed `RungIcon` unconditionally plus a `PinBadge` (existing v3
grammar) beside it (WV-3).

**`MilestoneDiamond` + rail** — 14×14 rotated square (7.2px, rx 1.6):
Complete = filled `#3A8159`; Active = white fill, `#C39B45` stroke 1.6;
Upcoming = white fill, `#C0C0C0` stroke. Diamonds connect with a 1.5px
`#E5E5E5` vertical rail; the ladder reads top-to-bottom like a subway map.

**`WorkMeter`** — the two-segment bar (`work.meter`). Always paired with
its fraction (`6/14`) in 11.5px `#737373`; a meter without its arithmetic
is a WV-2 violation.

**`IntentChip`** — the authored-ladder chip. Pill radius 20, 12px, with
the revision set in 11px mono *inside* the chip: `Approved @b81f0a4`
(green), `Approved · drifted @3f2a1c9` (amber), `In Review` (blue),
`Draft` (gray), `doc drifted @9c41d2e` (amber, epics-lens variant),
`Adopted @3f2a1c9` / `Superseded` (designs). The revision is part of the
state, never truncated (V4-2 rendered).

**`HealthPill`** — On track `#3A8159`/`#E7F3EC` · At risk `#9A7B2D`/
`#F5EDD8` · Off track `#C94A44`/`#F7E4E3`, preceded in rows by a 7px
health dot. Hover opens the evidence popover: the same content as the
detail page's callout (§3.4), because health *is* its evidence (WV-2).

**Avatars** — humans: round initials on the owner palettes (20px rows,
18px dense rows, 26px shell). Agents: `work.agent.avatar` square star.
Unassigned: 18px dashed `#C0C0C0` ring with `?` `#999999`. The three are
deliberately unconfusable at 100% zoom.

**`SessionChip`** — `● coder-01 · s_4f21` — live dot + 11px mono, blue;
click deep-links to the AG/AL session page. Rows carry it between title
and rung chip; the peek expands it to a banner (§3.6).

**`LensBar`** — sticky `top: 0`, z 5, `rgba(250,250,250,.95)` +
`backdrop-blur 6px`, bottom border `#ECECEC`, padding `14px 0 12px`.
Lens buttons: 12.5px, radius 7, padding `5px 12px`; active `#E9E9E9`
bg / `#171717` / 600; inactive transparent / `#666666` / 400. Right side:
`Filter` and `Display` chips (pill radius 20, 1px `#DBDBDB`, white, 12px
`#666666`, 12px icon), an 18px `#E5E5E5` divider, and the primary `New ⌄`
button (`#171717` bg, white, 12.5px/600, radius 8, padding `6px 13px`).

**`TruthCaption`** — 12px `#999999`, `margin-top: 10px`, one sentence,
sits under a list card. Exact copy per lens in §3.

**`GroupBand`** — full-width `#F7F7F7` band inside a list card: 11.5px/600
label tinted by state + faint count (Tasks lens adds the group's
`RungIcon`).

## 3. The screens

Five screens are normative. Everything else on the Work plane (milestone
page, design page, triage, cycles) aligns to the same grammar in WV6
without its own mock.

### 3.1 Work home — Initiatives lens

Header: serif `Work` 28px/500; subtitle 13.5px `#737373` max-width 600:
*"Initiatives hold the why. Epics are the unit a human approves and an
agent implements. Every status below is folded from delivery truth —
never typed in."* Right-aligned fold stats: serif 22px numerals over
11.5px `#999` labels — `9 / open tasks`, `2 / need attention` (numeral
`#9A7B2D`; the whole stat deep-links to `/work/triage`, which keeps its
job as the human-decision queue and stops being a nav destination).

List card (white, radius 12): one row per initiative —
`7px health dot · title 13.5/500 · "2 epics" 11.5 #999 · HealthPill ·
WorkMeter(150px) + 6/14 · target ("Q3 2026" | "Aug 30") 12px #737373
right-aligned 64px · 20px owner avatar · chevron`. Row padding
`12px 18px`; whole row clicks through to the initiative page.

TruthCaption: *"Health folds from member epics on every read — an
initiative is at risk because its evidence says so, one hover away."*

### 3.2 Work home — Epics lens

Rows grouped by intent state via GroupBands, in ladder order:
`Approved · drifted` (amber) → `Approved` (green) → `In Review` (blue) →
`Draft` (gray), count per band. Row grammar:
`key 11.5px mono #999 (saas-checkout-splits) · title 13.5 · IntentChip
(with @rev; drifted rows say "doc drifted @9c41d2e") · initiative chip
(11px mono, bordered pill) · WorkMeter(60px) · 4/8`. Click → epic page.

TruthCaption: *"Approval covers the document and the milestone ladder at
a revision. When either changes, the chip says so — the tracker never
lies for you."*

### 3.3 Work home — Tasks lens

Above the list, the **cycle bar** (white card, radius 10): cycle icon ·
`Cycle 14 · Jul 1 – Jul 14` 13px/600 · WorkMeter(120px) · `62% complete ·
3 days left` 12px `#666` · right link `Cycle report →`. Derived, of
course — it is the v3 burn-up's summary row.

The list groups by rung via GroupBands in ladder order (In Progress → In
Review → Ready → Draft → Done → Released), each band led by its
`RungIcon`. Row grammar: `RungIcon · key 11.5 mono #999 (0146) · title
13px · [SessionChip if a session is live] · epic chip (11px mono pill;
inbox tasks read "inbox · no epic") · assignee avatar (human round /
agent star / unassigned ?) · relative time 11.5 #999 right`. Click →
task peek (§3.6), not a navigation.

Layout is a Display option: `List` (default, the above) or `Board` — the
v3 kanban re-skinned to these tokens, drag semantics untouched (drop
mints an attributed pin beside observed truth; the 422 verdict toast
stays). The board is no longer a top-level destination.

### 3.4 Initiative page

Breadcrumb `Work / Initiatives / Checkout modernization` (12px, `#999`,
current `#444`). Serif title 26px + HealthPill. The why-paragraph
13.5/`#737373`. When health ≠ on-track, the **evidence callout**
(`work.drift.banner` tones): bold lead *"At risk — folded from 2 epics"*,
then one line per contributing signal, e.g. *"`saas-checkout-splits` —
approval drifted: doc changed after approval (`@9c41d2e`)"* and *"M2 ·
Tender providers — 2 of 3 tasks still active against a Jul 18 target."*
This is the HealthPill hover content, promoted to the page.

**Designs rail** (WH3, restyled): kicker `DESIGNS` + `+ New design`
action; caption *"Alternatives are artifacts, not chat scrollback — run
several, compare, adopt one. Adoption mints the proposed epics."* Cards
(min 220px): title 13.5/600, IntentChip (`Adopted @3f2a1c9` /
`Superseded`), provenance line 11.5 `#999` (`Jun 28 · by elena · minted
2 epics`); a dashed `+ New design` ghost card closes the row.

**Epics section**: rows of `title + IntentChip / key · M2 of 3 · target
Aug 2 (11.5 mono #999)` with WorkMeter(90px) + fraction.

**Rail** (250px sticky): `PROPERTIES` — Key (mono), Owner (avatar +
name), Target, Epics, Progress (`6/14 tasks`). `SUCCESS CRITERIA` —
authored bullets. Then the section that is this product's signature,
kicker `DERIVED · NOT ENTERED`: *"Health and progress fold from member
epics on every read. Owner, target, and criteria are the only authored
pixels here."*

### 3.5 Epic page

Breadcrumb `Work / Checkout modernization / Split-tender payments`.
Serif title 26px + IntentChip (`Approved · drifted @3f2a1c9`). Standing
description 13.5/`#737373`.

When drifted, the **drift banner** (`work.drift.banner`): warning
triangle, *"Approved at `@3f2a1c9` — the document is now `@9c41d2e`.
Re-approval required before agents pick up new tasks."* Actions:
secondary `Review changes` (white, `#E0D5B5` border) · primary
`Re-approve @9c41d2e` (`#171717`). The primary action names the revision
it will approve — approval is content-addressed all the way into the
button label (V4-2).

**Milestone ladder**: kicker `MILESTONE LADDER`. Per milestone: collapse
chevron · `M1` 11px mono `#999` · name 13.5/600 · state chip (`Complete`
green / `Active · target Jul 18` amber / `Upcoming · target Aug 2` gray)
· right WorkMeter(70px) + `3/3`. The diamond rail runs down the left.
Expanded milestones reveal a task list card (dense rows, `8px 16px`):
RungIcon · key · title · [SessionChip] · rung chip · assignee. Complete
milestones default collapsed; active expanded.

**Rail**: `PROPERTIES` — Key, Initiative (link), Target, Cycle, Progress.
`INTENT` — State (IntentChip) · Approved (`@3f2a1c9 · Jun 28` mono) · By
(`elena`) · Document (`spec.md` link `@9c41d2e`). `WORKING ON IT` —
avatar cluster + `2 humans · 1 agent` 11.5 `#999`.

### 3.6 Task peek

Right-docked floating panel: 440px, inset margin 14px, radius 14,
white, shadow-lg, **non-modal** — the page behind stays live and
scrollable; no backdrop. `Esc` closes; the row keeps focus.

Anatomy top-to-bottom: kicker row `TASK · 0146` + rung chip + faint
`observed` tag (or `pinned by <actor>` when a pin exists — the tag is
the truth-source label, always present). Serif title 20px. Mono
breadcrumb `saas-checkout-splits · M2 · Tender providers`. Description.
**Session banner** when live (blue wash `#F4F7FD`): *"coder-01 is
working — session s_4f21 · running 14m · 3 commits pushed · branch
feat/sandbox-conformance"* + `Open →`.

**`RUNG · FOLD WITH PIN`** — the six rungs as rows, each with its meta
dot; the observed rung carries bg `#F7F7F7`, weight 600, and the right-
aligned label *"observed · from evidence"*; a pinned rung carries bg
`#FBF7E8` and the pin badge. Clicking a rung mints/clears a pin (the
same v3 mutator the board uses); clicking the observed rung clears.
Caption: *"Click a rung to pin it. The fold keeps rendering what it
observes."* This panel is the product thesis rendered as an interaction:
the ladder is a display of the fold that accepts opinions and files them
as opinions.

`PROPERTIES` — Assignee, Epic, Milestone, Updated. `EVIDENCE` — the
observation timeline, newest last, each with relative time (*"Agent
session s_4f21 started by elena · 14m"*, *"Branch
feat/sandbox-conformance pushed · 9m"*, *"Rung folded to in progress ·
14m"*). Footer: primary `Open epic page`, secondary `View document`,
`esc` kbd hint.

## 4. Interaction: keyboard, palette, motion, states

**Keyboard grammar** (WV5; registered as U5 palette verbs so ⌘K lists
every one):

| Key | Context | Action |
|---|---|---|
| `1` `2` `3` | Work home | Switch lens (Initiatives / Epics / Tasks) |
| `↑`/`↓` or `k`/`j` | any list | Move row focus |
| `Enter` | focused row | Open (page for initiative/epic; peek for task) |
| `Space` | focused task row | Toggle peek without moving focus |
| `Esc` | peek / menus | Close; second Esc clears row focus |
| `c` | Work home | New item for the current lens (task/epic/initiative) |
| `f` / `d` | Work home | Open Filter / Display menus |
| `p` | task peek | Focus the rung ladder (then `↑↓` + `Enter` to pin) |
| `⌘K` | anywhere | All of the above as verbs, plus `Go to initiative/epic…` |

There is deliberately no key that "changes status" — `p` pins, and the
palette verb is worded `Pin rung…`, never `Mark as…`. The vocabulary of
the keyboard is the vocabulary of the model.

**Motion**: 120–160ms ease-out for peek slide-in, lens crossfade, and
milestone collapse; live dots pulse at 2s; meters animate width on data
change only (no mount animation). `prefers-reduced-motion` freezes the
pulse and replaces slides with fades. Nothing loops except the live dot,
because only the live dot reports something genuinely ongoing.

**States**: skeletons mirror final geometry (rows, meters, rail blocks —
per PX conventions). Empty lenses teach the model in one line each, e.g.
Initiatives: *"No initiatives yet. An initiative holds the why — create
one, then let designs propose the what."* + `New initiative`. Error
states keep the existing precondition-insight component. Fold-lag
(SSE reload in flight) renders the existing stale indicator; v5 does not
invent optimistic lifecycle rendering (the fold is the renderer, WV-1).

## 5. IA and routes

| Route | v5 role |
|---|---|
| `/orgs/{slug}/work` | The Work home. Lens in the query (`?lens=epics`), default **Initiatives**, last lens remembered per user (localStorage; see risks Q-2) |
| `/work/initiatives` | 301 → `/work` (lens=initiatives) |
| `/work/initiatives/[...key]` | Initiative page (unchanged path, new skin) |
| `/work/epics/[...path]` | Epic page; index (`/work/epics`) → `/work?lens=epics` |
| `/work/designs/[...key]` | Design page (aligned in WV6) |
| `/work/triage` | Unchanged — reached from the `need attention` stat and ⌘K, no longer a sibling tab |
| Board | `Display → Layout: Board` within the Tasks lens; old board deep-links redirect with the display param |

Breadcrumbs on every detail page; the sidebar `Work` item stays lit for
all of them (Northwind shell rule). Saved views (v3) attach to the Tasks
lens and serialize lens + filter + display, so existing views migrate by
mapping their layout field.

## 6. What v5 does not touch

The fold, the mutators, the verdict seam, the observation vocabulary, the
approval ladder, snapshots, dispatch preconditions, import, the MCP, the
CLI, the oracle. Component-level assertions from WH2 (derived values
accept no input) extend to every new component. If any WV milestone
appears to require an API change, that milestone stops and the need is
filed against a future WH revision — the surface bends to the model,
never the reverse (V5-D).
