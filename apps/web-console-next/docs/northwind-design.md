# Northwind Console — Design Spec (extracted from catalog-design/Northwind Console.html)

Pixel source of truth: the per-screen HTML files in this directory (inline styles are exact).
Screens: shell, overview, catalog, docs, activities, events, work, teams, repos, integrations,
secrets, usage, settings (with 6 sub-screens), entity-detail, doc-detail, run-detail,
team-detail, repo-detail, entity-drawer.

## Type
- Display serif: 'Newsreader', Georgia, serif — page h1 (28px/500, letter-spacing -.01em;
  Overview greeting 32px), big stat numbers (34px card stats, 22-26px drawer), lede paragraphs
  (18px/1.6). Always font-weight 500, never bold.
- UI sans: ui-sans-serif,system-ui,-apple-system,'Segoe UI','Helvetica Neue',Arial,sans-serif.
  Base 14px on the root; most UI text 12–13.5px.
- Mono: ui-monospace,monospace — refs (11px), commit shas (11.5px), repo names (13.5px/600),
  kbd hints (10px).
- Section labels: 11px/600 uppercase letter-spacing .08em color #999999 (sidebar groups 10.5px
  / .09em).

## Colors
Canvas #FAFAFA · sidebar #F5F5F5 · surface (cards) #FFFFFF
Borders: sidebar/right #E5E5E5 · card #E6E6E6 · inner row dividers #EFEFEF (tables #F2F2F2)
Ink: primary #171717 · body #444444 · muted #737373 · faint #999999 · disabled #A8A8A8
Link/action blue #2563C9 (hover #1D4FA3), link underline #BDD2F0; info/run blue #3B76C9
Success green #3A8159 (bg #E7F3EC) · warn #9A7B2D text / #C39B45 dot (bg #F5EDD8, row tint #FBF7E8)
Error red #C94A44 · neutral "Managed" #666666 on #EFEFEF
Maturity: gold #9A7B2D/#C39B45, silver #737373/#B0AA9A, bronze #A6906B/#D8C6A8
Lifecycle accent for Beta/Experimental text: #7A648F
Owner avatar palettes: Payments #E8DFCE/#7A6C4E · Platform #DDE3D6/#5C6B50 · Data #D9E2E8/#4E6473 · Storefront #E3DBE8/#6E5C7A · unowned: dashed 1px #C0C0C0 border, "?" #999999
Selection rgba(37,99,201,.14). Scrollbar thumb #DBDBDB (hover #C6C6C6), 10px, 6px radius, 2px #FAFAFA border.

## Layout
- App: flex row, h-100vh, overflow hidden. Sidebar 230px fixed #F5F5F5, border-right #E5E5E5.
  Main: flex-1 overflow-y auto #FAFAFA.
- Screen container: max-width 1060px, margin 0 auto, padding 52px 48px 90px (detail pages 40px top).
- Card grid gaps 14px. Section spacing ~40px.

## Sidebar (see shell.html)
- Org switcher button: white, 1px #E5E5E5, radius 9px, padding 7px 8px; 24px black (#171717)
  radius-7 logo with white initial; name 13px/600 + "Pro · workspace" 11px #737373; up/down chevron.
- Search field: #F7F7F7, 1px #E5E5E5, radius 9px, padding 6px 9px, 12.5px #737373, ⌘K kbd chip
  (white bg, 1px #DBDBDB, radius 4, 10px mono #999999).
- Nav: padding 8px 8px 12px, gap 1px. Group label as above. Items: flex gap 9px, padding 6px 8px,
  radius 7px, 13px, 15px lucide icon stroke-width 1.8.
  Active: bg #E4E4E4, fg #171717, fw 600. Inactive: fg #666666, fw 400. Hover: #EBEBEB fg #171717.
  Groups: "Workspace" (Overview, Catalog, Docs, Activities, Events, Work, Teams, Git Repos,
  Integrations, Secrets) then spacer then "Manage" (Usage & quota, Settings→chevron).
  Detail pages keep parent nav item lit (entity→catalog, doc→docs, run→activities, team→teams, repo→repos).
- Footer: border-top #E5E5E5, padding 10px; 26px round #E0E0E0 avatar w/ 11px/600 #555555
  initials; name 12.5px/500; email 11px #737373.

## Core recipes
- Card: bg #FFF, 1px #E6E6E6, radius 12px, padding 20px 22px (compact 16px 18px).
  Hover (data-card): border #D0D0D0, shadow 0 2px 12px rgba(0,0,0,.05), .15s.
- Stat card: label (11px caps) → 34px serif number + 13px #737373 unit (baseline, gap 8) →
  12.5px status line w/ 7px dot, margin-top 12.
- List card: header row (13.5px/600 title + right 12.5px #737373 quiet-link "X →"), rows with
  border-top #EFEFEF, padding 12px 22px.
- Row (data-row): hover #F7F7F7; chevron (data-rowgo) 14px #999 fades/slides in on row hover
  (opacity 0, translateX(-3px) → visible).
- Table: card wrapper + overflow-x:auto; CSS-grid rows (e.g. catalog: minmax(220px,1.6fr)
  minmax(110px,1fr) 110px 110px 80px 90px 34px; gap 12px; padding 13px 22px; row border
  #F2F2F2). Header row 11px caps #999 border-bottom #EFEFEF. Warn rows tinted #FBF7E8.
- Chip/filter pill (data-chip): padding 5px 13px, radius 20px, 12.5px; active = black bg/border
  white text fw 500; inactive white bg, 1px #DBDBDB, #666. Hover border #C0C0C0. Divider: 1×18px
  #E5E5E5. Right-aligned count "10 of 42 shown" 12px #999.
- Buttons: secondary (data-btn) — white? actually #F5F5F5-ish: hover #ECECEC; primary (data-btnp)
  #171717 bg, white text, hover #000. Radius ~8-9px, 12.5-13px text, padding ~6px 12px.
- Status dot: 6-8px circle; live/running dot pulses (livepulse 1.6s opacity 1↔.3) in #3B76C9.
- Running progress bar (data-runbar): striped 115deg rgba(59,118,201,.45) 20px, animated 1s.
- Health pill: 12px text, radius 20, padding 2px 10px, fg/bg pairs above.
- Search/filter input: white, 1px #E5E5E5, radius 9px, padding 7px 12px, 13px, placeholder #999,
  leading 13px search icon, fixed width 230px on list pages.
- Page header: h1 serif 28px + sub 13.5px #737373 max-width 520px line-height 1.5; actions
  right-aligned (flex-end justify-between).
- Quiet link (data-quiet): 12.5px #737373 hover #171717, "Label →".
- Entity drawer: scrim rgba(0,0,0,.22) (scrimIn .2s); panel absolute 12px inset right, width
  440px, white, 1px #E5E5E5, radius 14, shadow 0 18px 50px rgba(0,0,0,.16), drawerIn .24s
  cubic-bezier(.2,.8,.25,1). Header: kind label caps + health pill + close. Name serif 26px,
  ref mono 12px #999, description 13.5px/1.55 #444. Two stat tiles (22px serif). Key-value rows
  (13px; label #737373, value fw 500) divided #EFEFEF. Esc closes.
- Screen transition: fadeUp .28s (opacity 0 translateY(6px) → 1/0).
- Links in prose: no underline, border-bottom 1px #BDD2F0, color inherit-ish (#2563C9 for real links).

## Screen inventory (structure; see files for exact markup)
- overview.html: date line, serif greeting "Good morning, X.", 18px serif narrative lede with
  inline links, 3 stat tiles, 2-col cards (Needs attention / Latest activity), Repositories
  header + 4-col repo cards.
- catalog.html: header + 230px filter box; chip row (All/Components/APIs/Resources | Needs
  attention); table (Entity/Owner/Lifecycle/Health/SLO 30d/Maturity/→); footnote 12px #999.
- docs.html: TechDocs-style; shelf cards (data-shelfdoc) etc.
- activities.html: run list w/ live running row + striped runbar, filters.
- events.html: event stream table, lanes/channels.
- work.html: work items list.
- teams.html: team cards grid.
- repos.html: repo list with branch health.
- integrations.html / secrets.html / usage.html: settings-flavored list/table pages.
- settings.html: 2-col — left sub-nav (items: General, Members, Billing, API keys, Webhooks,
  Audit; active bg #ECECEC fw 600 radius 7 padding ~6px 10px 13px) + right content panels
  (cards w/ forms, 13px inputs, danger zone red text #C94A44).
- entity-detail / doc-detail / run-detail / team-detail / repo-detail: breadcrumb 12px #999
  ("Catalog / checkout-api"), serif title, meta chips, content cards; padding-top 40px.

## Mobile (not in mock — derive with same philosophy)
- <1024px: main padding 32px 24px 72px; grids collapse 3→2→1; tables keep overflow-x scroll.
- <768px: sidebar becomes off-canvas drawer (same #F5F5F5 styling, width 280px max 85vw),
  scrim rgba(0,0,0,.22), slides with drawerIn-like ease; sticky mobile topbar: 56px, #FAFAFA
  w/ bottom border #E5E5E5, hamburger + org logo + name + right search icon; entity drawer
  becomes full-width bottom sheet or inset 8px full-height panel; filter chips scroll
  horizontally (no wrap, -webkit-overflow-scrolling, hidden scrollbar); stat grids 1-col;
  settings sub-nav becomes horizontal scrollable chip row above content; 2-col settings → stacked.
- Touch targets ≥40px on mobile rows/nav.
