# Proposal — Re-arrange `specs/` into Orun-style epics, a `core/` section, and an archive

> **Status: ACCEPTED & EXECUTED (2026-06-08).** The reorg in this proposal was
> applied on branch `claude/funny-feynman-qTuEW` (this PR) with the conservative
> defaults: per-milestone ✅ status (no shipped-epic archiving), `saas-console-ux`
> kept active, and `schedule.md` split (evergreen → `core/operating-model.md`) then
> archived. This file is kept as the design rationale / record.

## Found By

Architecture/spec-management review requested 2026-06-08 (rahul.varghese@sourceplane.ai):
"Re-arrange the multi-tenant-saas specs to match the Orun-style epics. Move
completed ones to archive and core architecture to a core section. Use spec-
management best practices. Deep-understand the repo's current SaaS status first."

## Related Task

None yet — this is a structure/spec-management proposal that, if accepted, becomes
a small sequence of reviewable PRs (see **Migration plan**). No behavior, contract,
API, or persistence change.

---

## Current Spec Text / Layout (what exists today)

`specs/` is a flat pack with three implicit tiers that aren't visually separated:

```
specs/
  access-and-infra.md          product/infra access, Terraform, secrets        (CORE/infra)
  constitution.md              normative platform rules                          (CORE)
  domain-model.md              canonical entities                                (CORE)
  product-overview.md          product vision                                    (CORE)
  repo.md                      monorepo shape + rules                            (CORE)
  orun-golden-path.md          in-repo Orun CI context                           (CORE/infra)
  roadmap.md                   forward direction in clusters B / U / P / PERF    (PLANNING/epics index)
  schedule.md                  the original 8-week bootstrap plan                (PLANNING, now historical)
  performance-epic.md          the PERF cluster as a stand-alone epic            (EPIC — the only one)
  components/00..16.md         17 per-bounded-context reference specs            (DURABLE CONTRACTS)
  contracts/                   api-guidelines, tenancy-and-rbac, 3 schemas       (CORE contracts)
```

Each `components/NN-*.md` is a single 94–333-line file with a fixed section
shape: `Intent / Scope / Out Of Scope / Hard Contracts To Honor / Required
Capabilities / Data Ownership / Agent Freedom / Acceptance Criteria / Extraction
Seam`.

### Status reality (code beats docs — verified against the working tree + git)

The component spec **headers are stale**. They say `Status: Ready for
implementation` / `Starter module pending implementation`, but the code reality is
that the baseline is **built and live**:

- **All 13 workers exist and deploy:** `api-edge, identity, policy, membership,
  projects, config, events, metering, billing, notifications, webhooks, admin,
  web-console-next`.
- **All 9 packages exist:** `contracts, sdk, cli, ui, shared, db, testing,
  policy-engine, notifications-client, webhook-verifier`.
- **~130 tasks done** (`ai/state.json` `completed[]` = 0001→0133) and `main` is
  well past the 2026-06-01 `ai/context/current.md` snapshot — git HEAD is at the
  PERF6 edge-gate work (`#248`), with the console actively polished (`#236–#243`).
- Roadmap clusters and their real state:
  - **B (Baseline):** B3, B4, B5, B7, B8, B9 shipped; B2 shipped (provider swap
    deferred); **B1, B6, B10 are human-blocked** (need OAuth/email/Stripe/SSO
    secrets + decisions).
  - **U (Console UX):** U1–U11 shipped and still being polished — **active**.
  - **PERF:** PERF1–PERF6 shipped/closing; **PERF7–PERF9 open**.
  - **P (Product areas):** P1 promote-flow is the next likely human-independent
    leg; **P2 (resources + runtime — the moat) is the big un-started design-stage
    program**; P3–P7 are future.

**Conclusion:** the repo has *two different kinds of spec artifact* tangled
together in one flat directory:

1. **Durable reference/contract specs** — `constitution`, `domain-model`,
   `product-overview`, `repo`, `access-and-infra`, `orun-golden-path`,
   `contracts/*`, and the per-component `components/NN-*` contracts. These stay
   normative **after** implementation; they are *not* "done and archivable."
2. **Work-tracking epics** — the roadmap clusters (B / U / P / PERF) and the
   bootstrap `schedule.md`. These have a lifecycle: draft → in progress → shipped
   → closed.

The flat layout makes (1) and (2) look the same and lets status drift.

---

## Repo Reality / New Information — how Orun structures specs (the target style)

`../orun/specs/` is organised as **one directory per epic**, each carrying a
canonical document set. Distilled conventions:

| Convention | What Orun does |
|---|---|
| **Epic = folder** | `orun-<slug>/` (product prefix + kebab slug): `orun-object-model`, `orun-catalog-state`, `orun-env-scoping`, `orun-affected-worker`, `orun-legacy-retirement`, … |
| **Canonical doc set per epic** | `README.md`, `design.md`, `data-model.md`, `cli-surface.md`, `implementation-plan.md`, `test-plan.md`, `risks-and-open-questions.md`, `compatibility-and-migration.md` (+ epic-specific docs as needed) |
| **README status table** | `Status` (Draft → Ready for implementation → …), `Phase`, `Predecessors`, `Supersedes`, `Target branch`, `Decisions locked`; plus a one-paragraph thesis, an explicit **read order**, and **phase/scope boundaries** (in-scope vs out-of-scope) |
| **As-built ≠ intent** | A separate **`IMPLEMENTATION-STATUS.md`** records what actually shipped ("M0–M13 implemented, merged, tested"), kept distinct from the design docs |
| **Deferred register** | **`FOLLOW-UPS.md`** lists optional/not-required-for-correctness items |
| **In-epic archive** | **`_archive/`** holds superseded drafts only, guarded by a README: *"NOT authoritative… preserved for provenance only."* (Orun archived its 2090-line monolith draft here.) |
| **Lineage** | Epics reference each other (`Predecessors`, `Supersedes`, `Builds on`); phases supersede earlier phases |
| **Holding epics** | An epic can be parked ("do not implement / under review") and **promoted** to a ready spec when picked up (`orun-env-scoping`, `orun-affected-worker`) |
| **Program register / closeout** | `orun-legacy-retirement` is a program-level register that **promotes** deferred items, enumerates remaining epics in **buckets**, and defines a program **definition-of-done** |
| **RFC-2119** | `MUST/SHOULD/MAY` carry weight inside contract docs |

Key nuance to carry over: **Orun does not archive an epic just because it
shipped.** `orun-object-model` is fully implemented (M0–M13) yet stays in place
with `IMPLEMENTATION-STATUS.md`. `_archive/` is reserved for *superseded
drafts*, not *completed work*.

---

## Proposed Spec Change — target layout

```
specs/
├── README.md                       # NEW — spec index, conventions, status legend, read order
│
├── core/                           # the "core architecture" section (durable, normative; never archived for being "done")
│   ├── constitution.md
│   ├── product-overview.md
│   ├── domain-model.md
│   ├── repo.md
│   ├── access-and-infra.md
│   ├── orun-golden-path.md
│   └── contracts/
│       ├── api-guidelines.md
│       ├── tenancy-and-rbac.md
│       ├── component-manifest.schema.yaml
│       ├── event-envelope.schema.yaml
│       └── resource-contract.schema.yaml
│
├── components/                     # UNCHANGED location; durable per-bounded-context contracts (status headers refreshed)
│   ├── 00-foundation-and-tooling.md … 16-admin-support.md
│
├── epics/                          # NEW — Orun-style work epics (status + milestones + as-built)
│   ├── README.md                   # epic index + lifecycle legend
│   ├── saas-baseline/              # B-track (B1–B10)
│   │   ├── README.md               # status table, thesis, read order, scope boundary
│   │   ├── implementation-plan.md  # B1…B10 as milestones, each with "done when"
│   │   ├── risks-and-open-questions.md
│   │   ├── test-plan.md
│   │   └── IMPLEMENTATION-STATUS.md # shipped: B3/B4/B5/B7/B8/B9; blocked: B1/B6/B10
│   ├── saas-console-ux/            # U-track (U1–U11)
│   │   ├── README.md
│   │   ├── design.md               # the "Design Direction (Normative)" material
│   │   ├── implementation-plan.md  # U1…U11
│   │   └── IMPLEMENTATION-STATUS.md
│   ├── saas-performance/           # PERF — performance-epic.md promoted into the folder shape
│   │   ├── README.md               # status table + one-line PERF index (from roadmap §PERF)
│   │   ├── design.md               # the 2026-06-08 measurement record + root-cause analysis
│   │   ├── implementation-plan.md  # PERF1…PERF9
│   │   ├── risks-and-open-questions.md
│   │   └── IMPLEMENTATION-STATUS.md # shipped: PERF1–PERF6; open: PERF7–PERF9
│   ├── saas-resources-runtime/     # P2 — the moat (resources + runtime); DESIGN STAGE
│   │   ├── README.md               # Status: Draft / not started; consumes components 06 + 08
│   │   ├── design.md
│   │   ├── data-model.md
│   │   ├── implementation-plan.md
│   │   └── risks-and-open-questions.md
│   └── saas-product-areas/         # P1, P3–P7 — holding/register epic
│       └── README.md               # register; promote each Pn to its own saas-<slug>/ when work starts
│
├── roadmap.md                      # STAYS at root — becomes the cross-epic program index/register
│                                   #   (one-liners per cluster → link into epics/<folder>); detail moves into epic plans
│
└── _archive/                       # NEW — superseded / closed material only (guarded, non-authoritative)
    ├── README.md                   # guard: provenance only, NOT authoritative, cite the live docs instead
    └── schedule.md                 # the 8-week bootstrap plan (bootstrap complete) — see note
```

### Why this shape

- It makes the **two artifact kinds explicit**: `core/` + `components/` = durable
  truth; `epics/` = lifecycle-tracked work; `_archive/` = history. Status can no
  longer hide.
- It is **the Orun model, named for SaaS** (`saas-<slug>` mirrors `orun-<slug>`),
  so an engineer moving between the two repos finds the same affordances:
  README status table, `implementation-plan.md` milestones, `IMPLEMENTATION-
  STATUS.md` as-built, `_archive/` guard, holding/promote epics, a program
  register (here, `roadmap.md`).
- It is **non-destructive**: every move is `git mv` (history preserved); no spec
  content is rewritten except stale status headers and cross-reference paths.

---

## File-by-file mapping

| Current path | New path | Action / rationale |
|---|---|---|
| `specs/constitution.md` | `specs/core/constitution.md` | move — core rule of law |
| `specs/product-overview.md` | `specs/core/product-overview.md` | move — core product framing |
| `specs/domain-model.md` | `specs/core/domain-model.md` | move — core entities |
| `specs/repo.md` | `specs/core/repo.md` | move — core monorepo shape |
| `specs/access-and-infra.md` | `specs/core/access-and-infra.md` | move — core infra/access |
| `specs/orun-golden-path.md` | `specs/core/orun-golden-path.md` | move — core CI context |
| `specs/contracts/*` | `specs/core/contracts/*` | move — frozen contracts belong with core |
| `specs/components/NN-*.md` | `specs/components/NN-*.md` | **stay**; refresh stale `Status:` headers + add an "Owning epic" pointer |
| `specs/performance-epic.md` | `specs/epics/saas-performance/` (split into README + design + implementation-plan + IMPLEMENTATION-STATUS) | promote — it is already an epic in all but folder shape |
| `specs/roadmap.md` (PERF cluster) | `specs/epics/saas-performance/implementation-plan.md` | carve PERF1–PERF9 detail into the epic; keep a one-line index in roadmap |
| `specs/roadmap.md` (B cluster) | `specs/epics/saas-baseline/` | carve B1–B10 into the epic |
| `specs/roadmap.md` (U cluster) | `specs/epics/saas-console-ux/` | carve U1–U11 into the epic |
| `specs/roadmap.md` (P2) | `specs/epics/saas-resources-runtime/` | carve into the moat epic; consumes components 06 + 08 |
| `specs/roadmap.md` (P1, P3–P7) | `specs/epics/saas-product-areas/README.md` | register; promote individually when picked up |
| `specs/roadmap.md` (shell) | `specs/roadmap.md` | **stays** as the program index/register linking to all epics |
| `specs/schedule.md` | `specs/_archive/schedule.md` | archive — the 8-week bootstrap plan is historical (bootstrap done) **†** |

**† Evergreen carve-out:** `schedule.md` also contains still-useful, non-dated
guidance — **Delegation Checklist Per Component**, **Merge Policy**, and **First
Extraction Candidates**. Recommend lifting those three sections into
`core/repo.md` (or a small `core/operating-model.md`) before archiving the dated
8-week plan, so nothing live is lost.

---

## Archive policy (the part to get right)

The literal ask — "move completed ones to archive" — collides with a spec-
management best practice that Orun itself follows: **a shipped spec is still the
authoritative description of the thing that shipped; deleting/archiving it loses
the as-built record.** Resolution:

- **Completed *programs/epics* → archive.** An epic moves to `epics/_archive/`
  only when it is **fully shipped AND closed** — no open milestones, no
  follow-ups, and either terminal or superseded. Its `IMPLEMENTATION-STATUS.md`
  travels with it as the closeout record.
- **Completed *milestones inside an active epic* → marked ✅, not archived.**
  They are recorded in that epic's `IMPLEMENTATION-STATUS.md` and flagged ✅ in
  `implementation-plan.md` (exactly how the PERF cluster already shows
  `PERF1–PERF5 ✅ / PERF6 🗓️`). The as-built record stays discoverable.
- **Superseded drafts → `_archive/`** with the guard README, Orun-style.

**Applying this today:** no SaaS epic is 100% closed (baseline has blocked tails;
console + perf have open items), so the *current* archive set is small and
honest:
1. `schedule.md` — the bootstrap program is complete → archive (with the
   evergreen carve-out above).
2. Any superseded drafts — none currently in the working tree (the SaaS pack is
   lean; the bulky historical `ai/` task/report artifacts are already git-history-
   only per the 2026-06-01 compaction).

> If you want a more aggressive archive — e.g., declare **U-console-UX v1
> "complete"** and move the whole epic to `epics/_archive/` now, treating further
> polish as a fresh `saas-console-ux-v2` — that's a reasonable call and is listed
> as **Decision 2** below. My default keeps it active because `#236–#243` show it
> is still being worked.

---

## New scaffolding files this introduces (all additive)

1. `specs/README.md` — the index: the three tiers, a **status legend**
   (`Draft → Ready → In progress → Shipped → Closed/Archived`), the read order
   (core → components → epics), and the "trust code over stale docs" rule already
   in `roadmap.md`/`orchestrator.md`.
2. `specs/epics/README.md` — epic index + lifecycle legend + the
   "holding-epic → promote" and "milestone ✅ vs epic archive" rules.
3. Per-epic `README.md` (status table), `implementation-plan.md`,
   `IMPLEMENTATION-STATUS.md`, and (where they carry design weight)
   `design.md` / `data-model.md` / `risks-and-open-questions.md` / `test-plan.md`.
4. `specs/_archive/README.md` — the non-authoritative guard.
5. Refreshed `Status:` headers on `components/NN-*` pointing at the owning epic
   and reflecting code reality (e.g. `02-identity.md`: `Status: Shipped (live;
   see epics/saas-baseline). Forward work: B1 real auth.`).

---

## Why This Is Needed

- **Status drift is real and already biting:** component headers say "Ready for
  implementation" for things that have been live for ~130 tasks; `ai/context/
  current.md` is a week stale vs `main`. A layout that separates durable contracts
  from lifecycle-tracked epics, plus a mandatory `IMPLEMENTATION-STATUS.md`, makes
  drift visible instead of silent.
- **Cross-repo consistency:** engineers and agents move between `orun` and
  `multi-tenant-saas`; one spec idiom lowers friction and lets the same tooling/
  prompts target both.
- **Epic legibility:** "what is the state of PERF / the moat / baseline auth?"
  becomes a single folder with a status table, not a cluster buried inside a
  1-of-9 section in `roadmap.md`.
- **It matches the team's own stated rules:** `roadmap.md` already says the
  per-component specs "remain the contract" and "trust code reality over stale
  docs" — this structure operationalises both.

---

## Impacted Files / Tasks (blast radius)

Measured across the repo (excluding `specs/` itself and `.git`):

- **~41 path references in ~19 files.** Breakdown: mostly historical
  `ai/tasks/task-012x.md` (7) + a few worker source comments (`apps/*/src/*.ts`,
  4) + package READMEs (`packages/{sdk,cli}/README.md`) + `agents/orchestrator.md`
  + `ai/{deferred,context/decisions}.md` + one infra README.
- **Zero hard markdown links between spec files** (they cross-reference by prose
  path), so intra-`specs/` breakage is limited to prose mentions.
- The only **operationally live** consumer to update carefully is
  `agents/orchestrator.md` (its boot/read lists name `specs/constitution.md`,
  `specs/repo.md`, `specs/access-and-infra.md`, `specs/components/…`,
  `specs/roadmap.md`). Source-comment references are cosmetic.

This is a **bounded, mechanical rewrite**, not a refactor.

---

## Compatibility / Migration Notes (phased; one reviewable PR per phase)

Follows the repo's "one accepted task per PR" + "merge contracts before
dependents" rules.

- **PR 1 — Scaffolding (non-breaking):** add `specs/README.md`,
  `specs/epics/README.md`, `specs/_archive/README.md`, and empty epic folders with
  README status tables. Nothing moves yet. Lets the team react to the shape before
  any `git mv`.
- **PR 2 — `core/`:** `git mv` the six core docs + `contracts/` into `core/`;
  rewrite references (scripted `sed` pass + manual review of `orchestrator.md`).
- **PR 3 — `epics/`:** promote `performance-epic.md` into `saas-performance/`;
  carve the B/U/P clusters out of `roadmap.md` into their epic folders; add each
  epic's `IMPLEMENTATION-STATUS.md`. `roadmap.md` slims to the cross-epic index.
- **PR 4 — Archive + header refresh:** `schedule.md → _archive/` (with the
  evergreen carve-out); refresh all `components/NN-*` `Status:` headers + add
  owning-epic pointers.
- **PR 5 — Reference sweep:** finish rewriting the remaining ~41 external
  references; optionally leave **thin redirect stubs** at old paths for one release
  (a one-line "moved to …" file) so external bookmarks/anchors don't 404.

History is preserved throughout (`git mv`). Each PR is independently revertible.

---

## Non-goals (deliberate deviations from a naïve "make everything an Orun folder")

- **Components stay single-file.** Orun uses 8–13-doc folders only for large,
  multi-workstream epics; the SaaS component specs are 94–333 lines of stable
  contract. Exploding each into a 12-doc folder would be ceremony, not clarity.
  They stay as files; only the epics that genuinely span design + plan + as-built
  get the folder treatment.
- **No content rewrite.** Only stale status headers and reference paths change;
  normative prose is moved verbatim.
- **No new behavior, contracts, APIs, persistence, or roadmap *ordering*** — purely
  organisational. (Per `orchestrator.md` rules this keeps the proposal in the
  "clarification / non-behavioral" lane, modulo your sign-off on the moves.)

---

## Decisions I need from you

1. **Archive granularity** — confirm the recommended policy (archive only
   fully-closed *programs* + superseded drafts; mark completed *milestones* ✅
   inside active epics). Default: **yes**. Alternative: a more aggressive "archive
   every shipped milestone's detail" — not recommended (loses the as-built trail).
2. **Console-UX epic** — keep `saas-console-ux` **active** (my default, given
   `#236–#243`), or declare **v1 complete → archive** and start a fresh v2 epic?
3. **`schedule.md`** — archive whole, or split (lift Merge Policy / Extraction
   Candidates / Delegation Checklist into `core/` first, then archive the dated
   8-week plan)? Default: **split, then archive**.
4. **Execution** — want me to execute PR 1 (non-breaking scaffolding) now on
   `claude/funny-feynman-qTuEW` so you can see the shape, then proceed PR-by-PR?
   Or hold entirely until you've reviewed this doc?

## Recommendation

Adopt the layout. Sequence it as PR 1→5 above. Take the conservative defaults on
Decisions 1–3 (per-milestone ✅ status, keep console active, split-then-archive
`schedule.md`). Start with PR 1 (pure additive scaffolding) so the shape is
visible and reversible before any file moves.
