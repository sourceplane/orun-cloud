# Workspace Overview — normative shared model

Status: **Normative.** This is the cross-repo contract for the Workspace Overview
epic. The CLI half (`sourceplane/orun` `specs/orun-workspace-overview/`, milestone
**WO3**, landed) and the platform half (this epic, **WO2/WO4/WO5**) both conform to
this document. When the CLI spec and this model disagree, **this model wins** — the
CLI spec says so in its §5 ("The normative model … lives in orun-cloud `model.md`").

Read this before `design.md`. `design.md` is the platform-side *how*; this file is
the *what* both repos agree on.

## §0. Object model & the `blob` kind (no net-new object kind)

The overview document travels as an ordinary content-addressed **`blob`** in the
catalog-snapshot closure — **not** a new object kind. The `blob` kind has been
legal server-side since migration `250_state_refs` (the `objects_kind_check`
CHECK admits `plan | catalog-snapshot | composition-lock | artifact-manifest |
blob | tree`). Consequences that are part of the contract:

- **No CHECK migration, no WO3↔WO4 release ordering.** The CLI can push doc blobs
  before WO4 lands; an older platform accepts the `blob` object and the extra
  `Repo` entity harmlessly and simply does not project them.
- **GC is closure-based.** Reachability GC (`gc-reachability.ts`) reclaims a
  superseded doc blob exactly like any other snapshot object once no live
  catalog head pins it. No per-doc lifecycle, no reference counting.
- **Storage attribution.** A per-kind `doc` object kind was rejected (it buys
  only storage attribution, recoverable via a `doc_ref.digest → object size`
  join). Decided in `architecture-review.md §B`.

## §1. Entity kinds

| Kind | Status | Ref grammar | Scope | Merges across repos? |
|------|--------|-------------|-------|----------------------|
| `Repo` | **Live (WO3)** | `<namespace>/<repo>/<name>` (`FormatEntityKey`, repo-local) | one per snapshot | No |
| `Product` | **Deferred → WO6 (§7)** | `product:<namespace>/<name>` | namespace-scoped | Yes (like `System`) |

The `Repo` entity self-describes the repo that produced the snapshot. Exactly one
`Repo` entity exists per catalog snapshot. It carries: `metadata`
(displayName, description, tags), `ownership` (owner), `links[]`, and
`docs.overview` (the doc_ref, §3). It participates in the relation graph only via
`owner → Group`; it is **not** a dependency-graph node.

### §1a. The `Repo` ref is repo-local; the platform joins by `source_project_id`

The `Repo` entity_ref is the repo-local key `<namespace>/<repo>/<name>`, identical
in shape to every other derived entity. It is **not** a cloud project/workspace id
(none exists at `orun plan` time — the CLI runs offline) and **not** the
un-normalized `CatalogSnapshot.Repo` git string.

**The platform does not key state on the ref string.** The projection keys the
repo facet on `(org_id, source_project_id)` — the durable ids the push already
carries and the object store already scopes by (`objects` are stored under
`state/{orgId}/{projectId}/objects/{digest}`). The `entity_ref` is stored for
display and dedup only. This is the resolution of `architecture-review.md §A1`
(do not mint a cross-repo contract from an ad-hoc CLI string).

## §2. Refs & the snapshot shape

A catalog snapshot is a Merkle tree: `catalog.json` + `components/<name>.json` +
`entities/<Kind>/<name>.json` + `graph/<edgeKind>.json` + `relations.json` +
`impact/`. WO3 adds `entities/Repo/<name>.json` and the doc `blob` it references.
The snapshot root is what a catalog head pins; everything reachable from it
(including doc blobs) is point-in-time-consistent with that head.

## §3. `doc_ref` — the overview document reference

On the `Repo` entity, `docs.overview` is a **reference**, never inline bytes:

```json
"docs": { "overview": { "path": "docs/overview.md",
                          "sha":  "<sha256 of the file bytes, hex>",
                          "digest": "sha256:<closure blob object id>" } }
```

- `path` — the repo-relative source path (display / provenance).
- `sha` — `sha256(bytes)` of the file content, hex, no prefix (the provenance
  line the CLI advertises).
- `digest` — the object-store id (`sha256:<hex>`) of the closure `blob` holding
  those exact bytes. This is what the read edge dereferences (§6).

`sha` and the blob content behind `digest` are the same bytes; a consumer MAY
verify `digest`'s content hashes to `sha`.

### §3a. Bytes are pinned to the commit, not the working tree

The pushed doc bytes MUST match the `sha` the provenance line advertises. On the
autopush path (clean default branch) the working tree equals HEAD and this holds
trivially. On `plan --push-catalog` over a **dirty** tree, the CLI reads the doc
bytes from the git object at the resolved commit, or refuses to attach the doc
object and logs why. The platform therefore trusts that `doc_ref.{sha,digest}`
and the doc bytes agree; it does not re-derive them from a working tree it never
sees. (CLI-side invariant; stated here because the read edge depends on it.)

## §4. State tables

### §4a. `state.repo_facet`

WO4 projects the one `Repo` entity per scope into a `state.repo_facet` row, keyed
`(org_id, source_project_id, COALESCE(source_environment,''))` — the same scope
keystone the org-catalog index uses (`330_state_org_catalog_index`). Columns
carry the repo self-description and the overview doc_ref:

| Column | Source |
|--------|--------|
| `org_id`, `source_project_id`, `source_environment` | projection scope |
| `entity_ref` | `Repo.identity.entityKey` (display/dedup only, §1a) |
| `display_name`, `description`, `tags` | `Repo.metadata` |
| `owner` | `Repo.ownership.owner` |
| `links` (jsonb) | `Repo.links[]` |
| `overview_path`, `overview_sha`, `overview_digest` | `Repo.docs.overview` doc_ref (§3) |
| `head_digest`, `source_commit`, `updated_at` | projection provenance |

Projection is **idempotent scope-replace**, matching `org_catalog_entities`:
delete the prior facet for the scope, upsert the new one. A snapshot with no
`Repo` entity leaves no facet (and clears any stale one for the scope).

### §4b. `doc_ref` on entities (general)

`docs.overview` is defined on the shared entity docs struct, so any kind may carry
it. WO4 projects it for `Repo`; other kinds' overview refs ride along in the
`org_catalog_entities` projection as additive JSON and are rendered opportunistically
(WO5). No schema change beyond the doc_ref columns.

## §5. Push & projection flow (no new wire call)

1. `orun catalog push` (or `plan --push-catalog`) resolves the snapshot, walks the
   overview into the closure as a `blob`, and `objremote.Sync` uploads missing
   objects (`POST …/objects/missing` → `PUT …/objects/{digest}`, header
   `Orun-Object-Kind: blob`), then `AdvanceCatalogHead`.
2. `PUT /state/catalog/head` verifies the digest is present and records the head,
   then triggers projection off-response-path (`ctx.waitUntil`).
3. Projection (`catalog-projection.ts`) walks `entities/<Kind>/`; WO4 adds a
   `Repo` branch that upserts `state.repo_facet` (§4a) alongside the existing
   `org_catalog_entities` upsert.
4. The doc `blob` is **not** projected into a column; it stays in the object store
   and is dereferenced on read (§6).

No new endpoint is added to the push path. The `Repo` entity + doc blob ride the
existing catalog-snapshot push.

## §6. Read edge — the Overview is assembled, not stored

There is **no `/overview` endpoint** and **no console-authored override**. The
console assembles the Workspace Overview at the read edge from:

- the `repo_facet` row (identity, owner, links, tags, the overview doc_ref), and
- the overview **markdown**, fetched by digest via the existing object GET
  (`GET /v1/state/{orgId}/projects/{projectId}/objects/{overview_digest}`,
  tenant-scoped — a cross-tenant digest 404s), rendered client-side.

The doc read reuses the object store's existing scoping and auth
(`state.object.read`); no new storage path, no provider round-trip. This preserves
the "any git remote, no GitHub App" invariant: the CLI reads git and pushes bytes;
the console reads bytes from state.

## §7. `Product` — deferred to WO6 (both repos)

The `Product` kind (multi-repo composition), the `products:` intent block, the
`EntityKindProduct`/`ProductSpec` emit+merge path (CLI), and the namespace-scoped
`product_facet` projection + primary-repo selection (platform) are **out of scope**
until WO6 is scoped. `Product` merges across repos like `System`; the Repo facet
does not. Nothing in WO2–WO5 depends on `Product`.
