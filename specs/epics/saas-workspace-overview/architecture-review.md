# saas-workspace-overview — Architecture review

Status: Review (2026-07-01) — **ADOPTED.** The epic (`README.md`, `model.md`,
`design.md`, `implementation-plan.md`, `risks-and-open-questions.md`) was revised
to incorporate every recommendation below; this document remains as the **rationale
record** — the "why" behind the phased delivery, the project-id `Repo` ref, the
pinned-commit doc read, the dropped `override_overview`, the read-edge assembly,
and the deferred `Product`. Grounded against the code as it stands today, not
against the spec's description of it. Cross-checked in `orun`
(`internal/catalogmodel/*`, `internal/catalogresolve/*`, `internal/model/intent.go`,
`internal/objremote/*`, `internal/remotestate/*`) and `orun-cloud`
(`apps/state-worker/src/catalog-projection.ts`, `object-store.ts`,
`handlers/objects.ts`, `packages/db/src/migrations/*`, `web-console-next/*`).

This is a lead-architect pass over an epic that is **fundamentally sound**. The
thesis — *the repo is the homepage; the console renders what git produced and
never authors it; docs ride the catalog snapshot as content-addressed objects
with no git-provider coupling* — is the right thesis, it is consistent with
`18-state.md`'s "derived, never authored, drift-free" invariant, and it reuses
the CAS + set-difference spine instead of inventing a plane. Keep all of that.

What follows is where the design **describes the code more cleanly than the code
actually behaves**, plus a handful of scoping and sequencing changes that make
the epic ship sooner, smaller, and with fewer new invariants to defend. Findings
are ordered by how much they change the plan.

---

## A. Code-reality corrections (the spec asserts things the code contradicts)

### A1 — `CatalogSnapshot.Repo` is **not** normalized; the `Repo` ref rests on a normalization that doesn't exist yet

`model.md`, `README.md`, and the `orun` half repeatedly key the `Repo` entity off
"the normalized git remote (`CatalogSnapshot.Repo`)" and assert it matches the
`state.workspace_links` normalization. **It does not.** `CatalogSnapshot.Repo` is
a verbatim passthrough of `ResolverInputs.Repo`
(`internal/catalogresolve/catalog_snapshot.go`) — a human string like
`sourceplane/orun`, with no host, no scheme-stripping, no lowercasing. Meanwhile
`state.workspace_links.remote_url` **is** normalized server-side (scheme/auth
stripped to host/owner/repo; migrations `220_state_foundation`, `260_state_link_provider`).

Consequences and the fix:

- **`state.repo_facet` is safe** — it is keyed `(org_id, source_project_id)` and
  projected from the `Repo` entity, so it joins the repos list via
  `source_project_id`, which the projector already carries. The repos list does
  **not** depend on the ref string. Good — keep it keyed by project.
- **The `Repo` *ref* is not safe.** `repo:<host>/<owner>/<name>` needs a real,
  specified normalization *on the CLI side*, and that normalization becomes a
  **cross-repo contract** (the CLI mints the ref; the console displays and dedups
  on it). Decide one of: (a) add a normalization function in `orun` that provably
  matches the server's `remote_url` normalization and freeze it as part of the
  wire contract; or (b) don't put host/owner in the ref at all — mint the `Repo`
  ref from the durable `ws_`/project id (`saas-workspace-id`), which is already
  stable and already the join key. **Lean: (b).** The ref should key off the
  identity the platform already trusts, not a string the CLI happens to print.
- Resolve Q1 in `risks-and-open-questions.md` accordingly — the current "confirm
  the normalization matches" understates it: there is nothing to match against yet.

### A2 — Adding `Repo`/`Product` kinds is **not** the "~5-site, array-driven" change the spec sells

`allEntityKinds` in `internal/catalogmodel/entity_ref.go` is genuinely
array-driven for `IsEntityKind`/`NormalizeEntityKind`/`AllEntityKinds` and CLI
`--kind` validation — that part is one line each. But a *new kind that carries
relations* also needs:

- graph wiring in `internal/catalogresolve/graph.go` `buildGraphs()` (the five
  graph types — dependencies/systems/apis/resources/owners — are hardcoded; a
  `Product`→`System` `partOf`/`hasPart` graph and `Repo` membership are net-new
  builder code, not inherited);
- a resolver stage that **emits** `entities/Repo/*.json` + `entities/Product/*.json`
  (System/Domain today are *derived* from component specs; there is no existing
  "emit a declared top-level entity" path to reuse);
- `internal/model/intent.go` struct fields (`Repo`, `Products`) — additive but real.

None of this is hard; it's just 3–4 sites of real logic, not a registry poke.
**Re-scope WO2a** so the estimate reflects "emit + relate + register," and add an
explicit note that the frontend `KINDS` array (`web-console-next/src/lib/catalog-kind.ts`,
today `Component|API|Resource|System|Domain|Group`) is the only styling registry
and must gain `Repo`/`Product` — which the projector's kind-agnosticism confirms
needs **no** server enum change (verified: `org_catalog_entities.kind` is TEXT,
no CHECK; projector stores `kind` as-is).

### A3 — "Read the doc at HEAD" is really "read the working tree" — the point-in-time guarantee leans entirely on the clean-tree gate

The resolver reads the **working tree**, not a git object at a commit
(`internal/catalogresolve/*` discovers and reads files from the workspace root;
there is no checkout-at-HEAD step). The autopush path already requires a clean
default branch, so working-tree == HEAD there and the "pinned to the commit the
head advanced at" claim holds. But `plan --push-catalog` can run on a **dirty**
tree, and then the `doc` bytes reflect uncommitted edits while `doc_ref.{ref,sha}`
and the provenance line "From `<repo>@<sha>`" point at a commit that never
contained them. For a surface whose entire pitch is *drift-free, provenance you
can trust*, that is the one place drift can silently enter.

Fix, cheap: when walking `docs.overview` into the closure, either (a) read the
bytes from the git object at the resolved commit rather than the working tree, or
(b) refuse to attach doc objects when the tree is dirty (same gate the autopush
path already enforces) and log why. Make the guarantee true, not incidental.

### A4 — The `state.objects.kind` CHECK is already out of sync with the write-time kind set — reconcile it, don't just append to it

The migration CHECK allows `plan | catalog-snapshot | composition-lock |
artifact-manifest` (`220_state_foundation`), but the write-time validator in
`object-store.ts` already accepts more (`job-result | log | run-record | blob |
tree`). Adding `doc` to the CHECK is correct, but do it as a **reconciliation**
migration that brings the CHECK in line with the actual `OBJECT_KINDS` set, so the
schema stops lying about what it stores. Otherwise the epic adds one value to a
constraint that is already wrong and leaves the drift for the next author.

---

## B. Simplify — does a `doc` object kind need to exist at all?

The constituent objects of a catalog snapshot **already travel as `blob`/`tree`
objects** in the closure (write-time `OBJECT_KINDS` includes `blob`/`tree`;
`objremote.Sync` walks that closure). A `docs.overview` file is, mechanically,
just another content-addressed `blob` the closure references, and the entity's
`doc_ref.digest` is sufficient to locate and render it. So the honest question the
epic should answer explicitly is: **what does the `doc` kind buy that `blob`
doesn't?**

There is a legitimate answer — **quota and lifecycle accounting**: a distinct
`doc` kind lets `limit.state.storage_gb`, retention, and GC reason about
repo-authored prose separately from plan/tree internals, and lets the console
list "docs" without walking every tree. If that's the reason, **say so** in
`model.md §3` and in the risks table; it justifies the one-value CHECK migration.

If it is *not* the reason — if `doc` is just a semantic label — then **drop it**:
let docs ride as ordinary closure blobs, keep `doc_ref.digest` on the entity, and
you delete a migration, a header value, and a cross-repo coordination step (the
WO2a→WO2b "server must accept `Orun-Object-Kind: doc` before the CLI pushes it"
dance in the sequencing note). Fewer new kinds is fewer things to defend against
the "kind sprawl" risk the epic already names. **Lean: keep `doc` only if it is
the quota/GC boundary; otherwise ride the blob closure.**

---

## C. Design-fit tensions (where the epic strains an existing invariant)

### C1 — `override_overview` is the first console-authored content the catalog renders — quarantine it or drop it

`18-state.md` is emphatic and it is the crown jewel: *"the console never writes
catalog content; the platform renders what git produced (provenance is verifiably
drift-free)."* `model.md §4c` introduces `override_overview JSONB` on the org —
authored name/description/narrative, set in the console, **merged field-by-field**
with git-authored catalog content at render time. That merge is exactly where the
invariant frays: a rendered overview becomes part git-derived, part
console-authored, with no visible seam, and "is this drift-free?" stops having a
clean yes.

The empty-state CTA in `design.md §4` *already* solves the real problem
("never blank for a not-yet-linked workspace"). So:

- **Preferred:** drop `override_overview` for v1. A workspace with no repo linked
  shows the link-a-repo CTA — that is a *better* first impression than
  console-typed placeholder prose, and it keeps the invariant pure.
- **If kept:** quarantine it as **org profile metadata**, clearly outside the
  catalog/state plane and clearly labeled "set in console," and render it in a
  visibly distinct slot — never field-merged into the git-authored narrative. The
  moment a repo publishes a `Repo`/`Product`, the profile override yields wholesale
  (not field-by-field) and the UI says "now sourced from `<repo>`."

Either way, name the tension in `risks-and-open-questions.md` (Q5 currently treats
this as a lifecycle detail; it is actually an invariant question).

### C2 — `GET …/overview` is a cross-bounded-context aggregation — make it an api-edge composition, or skip it for v1

The resolver the plan describes spans **three** owners: `membership`
(`organizations`, the net-new `primary_project_id`/`override_overview`), `state`
(`repo_facet`, the catalog rollup), and the **activity/runs** feed. `18-state.md`
is strict — every context is reached through the api-edge `state-facade` and "no
component bypasses the contract." A single new endpoint inside one worker that
reaches across domains violates that ownership model.

Two clean options, both smaller than the plan implies:

- **v1 (recommended): no bespoke `/overview` endpoint.** The console already has
  SDK reads for the catalog rollup, the runs feed, and the repos list. Assemble
  the page client-side from those, and add only the two genuinely new reads: the
  `repo_facet` row and the `doc` object body by digest (the `GET …/objects/{digest}`
  path already exists under `state.object.read`). This ships the page without a new
  contract, and it is exactly how the signal row is *already* specified to work
  ("keeps reading the catalog + runs endpoints it already uses").
- **Later:** if a server-side `/overview` is wanted for latency, define it as an
  **api-edge composition** that fans out to the per-context reads — not a
  state-worker or membership-worker route that owns another context's data.

### C3 — Two different "Repo" concepts now live in the product — reconcile the vocabulary before it ships

`saas-unified-onboarding` **locks** the user-facing noun: *"a project **is** a git
repo… user-facing noun becomes 'repo' while internal IDs stay `project*`."* The
nav already says "Git Repos." This epic now adds a `Repo` catalog **kind**, one
per `intent.yaml`. That is two "Repo"s in one product: the repo-that-is-a-project
(a tenancy/link concept) and the `Repo` entity (a catalog-kind concept). Operators
and future maintainers will conflate them.

They are, happily, **1:1** — one `intent.yaml`, one project, one `Repo` entity. So
lean into that instead of pretending they're separate: frame the `Repo` kind
explicitly as *"the self-description of the repo/project you already have,"* make
`repo_facet` the identity facet **of that existing project** (which its
`(org_id, source_project_id)` key already makes true), and never introduce a
parallel "Repo" object in the UI. One concept, one word, described in git.

### C4 — Defer the `Product` kind; derive product identity for v1

The epic already applies exactly this judgment to `primary_project_id` (Q2:
"ship the default; add the explicit setting only when multi-repo workspaces
appear"). Apply it to `Product` too. In the overwhelmingly common single-product
workspace, the **workspace is the product** and a `Product` entity is a concept
users won't populate — while it costs the graph-wiring, emit-path, and merge-conflict
questions (Q3) now. For v1, derive the hero identity from `metadata.{name,
description,namespace}` + the primary `Repo`. Ship the `Repo` kind (a clean 1:1
win that directly powers the repos list) and make `Product` **opt-in / later**,
when multi-product workspaces are real and the "which repo's overview wins" merge
(Q3) is a problem someone actually has. This shrinks WO2a and directly answers the
epic's own "kind sprawl" risk.

---

## D. Sequencing — ship the front door before the cross-repo chain

The plan gates the *entire* user-visible win (the Overview replacing the
`/projects` redirect) behind WO2a→WO2b: a coordinated **`orun` CLI release** +
object-kind migration + projector change. But two of the page's three bands need
**none** of that — they read data the platform already has:

- **Band 2 (signal row)** reuses the catalog `rollup`/`MetricTiles` and the runs
  feed — both already shipped.
- **Band 3 right rail** (repos, recent activity) reads the repos list and
  `run-rows` — already shipped.
- **Empty/first-run states** are pure console.

So split the delivery:

- **Phase 1 — pure `orun-cloud`, no CLI release, no new object kind:** flip
  `/orgs/{slug}` from redirect to a real Overview landing (`app/(app)/orgs/[orgSlug]/page.tsx`),
  add the Overview nav item, render the signal row + repos + recent-activity + the
  onboarding CTA. This delivers the "front door" — the actual thesis of the epic,
  *"a Workspace has no home"* — **immediately**, and it is where the buyer-credibility
  payoff lives (compare `saas-product-experience`'s "the surface lags the backend").
- **Phase 2 — the git-authored narrative:** land WO2a/WO2b behind the page that is
  already live: `docs.overview`, the `Repo` kind, `repo_facet`, the doc render.
  Now the narrative band lights up, and the risky cross-repo CLI coordination is
  no longer on the critical path to *any* user-visible value.

This is the single highest-leverage change in this review: it decouples "give the
Workspace a home" (shippable this week, one repo) from "carry repo-authored prose
into the platform" (the genuinely new capability), so a slip in the latter doesn't
hold the former hostage.

---

## E. Smaller notes

- **MetricTiles reuse is not a drop-in.** The shipped `MetricTiles`
  (`components/catalog/portal/metric-tiles.tsx`) renders
  Services/Ownership/Production-ready/Needs-attention. The design's signal row is
  Components/Health/Production-ready/**Activity** — the Activity tile (runs) is not
  in the component. WO4 is "reuse 3 tiles + compose an Activity tile from the runs
  feed," not "reuse the component." Say so, so WO4 isn't under-scoped.
- **Make staleness actionable.** The overview only refreshes on the next
  `orun plan`; the provenance line makes staleness *visible* but not *actionable*.
  If the platform knows the latest linked commit (via push events /
  `workspace_links.last_seen_at`), surface "overview is N commits behind `main`."
  That's the difference between "looks live" and "is trustworthy" for a homepage.
- **The word "product" is now overloaded** across `saas-product-areas`,
  `saas-product-experience`, and the new `Product` kind. If C4's deferral is
  rejected and `Product` ships, add a one-line glossary note distinguishing the
  catalog kind from the roadmap/register senses.
- **Read authorization is fine as-is.** `GET …/objects/{digest}` already gates on
  `state.object.read` and 404s cross-tenant; reusing `catalog.read` for the doc
  read (Q6) needs no new gate — confirmed, close Q6.

---

## Prioritized recommendation

| # | Recommendation | Type | Effort | Priority |
|---|----------------|------|--------|----------|
| D | Split delivery: ship the Overview landing (signal row + repos + CTA) from `orun-cloud` alone in Phase 1; narrative (WO2a/2b) in Phase 2 | Sequencing | S | **P0** |
| A1 | Mint the `Repo` ref from the durable project/`ws_` id, not an un-normalized remote string; keep `repo_facet` keyed by project | Correctness | S | **P0** |
| A3 | Read `docs.overview` bytes from the pinned commit (or refuse on dirty tree) so provenance can't lie | Correctness | S | **P0** |
| C1 | Drop `override_overview` for v1 (empty-state CTA already covers it); if kept, quarantine as labeled org profile, no field-merge | Invariant | S | **P1** |
| B | Justify the `doc` kind by quota/GC accounting or drop it and ride the blob closure | Simplification | S | **P1** |
| C2 | No bespoke `/overview` endpoint for v1 — assemble client-side; if server-side later, make it an api-edge composition | Boundary | M | **P1** |
| C4 | Defer the `Product` kind; derive product identity from `metadata` + primary `Repo` for v1 | Scope | M | **P1** |
| A2 | Re-scope WO2a: emitting/relating `Repo`/`Product` is graph + emit-path work, not an array poke | Estimate | — | **P2** |
| A4 | Reconcile the `state.objects.kind` CHECK with the real write-time kind set when adding `doc` | Hygiene | S | **P2** |
| E | MetricTiles honesty (compose the Activity tile); make staleness actionable; close Q6 | Polish | S | **P2** |

None of these change the thesis. A1/A3/D are the ones to act on before code lands;
the rest tighten scope and shrink the cross-repo surface. The epic is good — this
makes it shippable in a smaller, truer first cut.
