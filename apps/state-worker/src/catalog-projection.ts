// Catalog projection (OV6.2b — the org-global read model's writer; design-v2 §6).
// When a catalog head advances, the pushed snapshot's components + derived
// entities are indexed into the org-wide graph (state.org_catalog_entities) with
// provenance. This is the TS projector: it fetches the snapshot's object-model
// tree from R2, walks it with the OV6.2a reader, and replaces this (project,
// environment) scope's rows — derived, never authored, idempotently rebuildable.
//
// Best-effort + dormant: it needs the ORUN_STATE R2 bucket (absent on dev), and
// the head-advance handler calls it AFTER the advance + event, in a try/catch —
// so a projection miss never fails a push (the head is the source of truth; the
// read model can always be rebuilt from it).
//
// "Replace the scope": delete-then-upsert under the (org, project, environment)
// scope makes re-projection idempotent and drops entities no longer present in
// the new snapshot — the bijection between a head and its projected rows.

import type { Env } from "./env.js";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import type { Uuid } from "@saas/db/ids";
import { createStateRepository, type UpsertOrgCatalogEntityInput, type CatalogEntityRelation } from "@saas/db/state";
import { requireBucket, objectKey } from "./object-store.js";
import { readTree, readJsonBlob, type ObjectFetcher } from "./object-model.js";
import { generateUuid } from "./ids.js";

// Root tree entry names (orun objcatalog: components/<name>.json blobs and the
// entities/<Kind>/ subtree of derived multi-kind entity blobs).
const DIR_COMPONENTS = "components";
const DIR_ENTITIES = "entities";

export interface CatalogProjectionScope {
  orgId: Uuid;
  projectId: Uuid;
  /** Public ids — the R2 key layout (object-store.ts) addresses by these. */
  orgPublic: string;
  projectPublic: string;
  environment: string | null;
  /** The catalog snapshot root digest (sha256:<hex>). */
  digest: string;
  /** Source git commit the snapshot was resolved at, when known. */
  commit: string | null;
}

export interface CatalogProjectionSummary {
  deleted: number;
  projected: number;
}

export interface CatalogProjectionDeps {
  executor?: SqlExecutor;
  /** Override the object byte-fetch (tests inject a synthetic store). */
  fetcher?: ObjectFetcher;
}

// ── On-disk blob shapes (the JSON the orun CLI writes; nodes/model.go) ──

interface ComponentIdentity {
  componentKey?: string;
  name?: string;
}
interface EntityRelationJson {
  type?: string;
  to?: string;
}
interface ComponentManifestJson {
  identity?: ComponentIdentity;
  ownership?: Record<string, unknown>;
  lifecycle?: Record<string, unknown>;
  relations?: EntityRelationJson[];
  spec?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  docs?: Record<string, unknown>;
}
interface EntityIdentity {
  entityKey?: string;
  kind?: string;
  name?: string;
}
interface EntityJson {
  kind?: string;
  identity?: EntityIdentity;
  ownership?: Record<string, unknown>;
  lifecycle?: Record<string, unknown>;
  spec?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  docs?: Record<string, unknown>;
  links?: Array<Record<string, unknown>>;
}

function pickString(obj: Record<string, unknown> | undefined, ...keys: string[]): string | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/** A []string field from a generic []any (drops non-strings). */
function stringArray(obj: Record<string, unknown> | undefined, key: string): string[] {
  const raw = obj?.[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string" && v.length > 0);
}

/** The git-authored portal fields, mirroring orun objcatalog's CPF precedence. */
function portalFields(spec?: Record<string, unknown>, metadata?: Record<string, unknown>, docs?: Record<string, unknown>) {
  const description =
    pickString(spec, "description") ?? pickString(metadata, "description") ?? pickString(docs, "summary");
  let language = pickString(spec, "language") ?? pickString(metadata, "language");
  if (!language) {
    const langs = stringArray(spec, "languages");
    language = langs[0] ?? null;
  }
  const tags = stringArray(spec, "tags").length ? stringArray(spec, "tags") : stringArray(metadata, "tags");
  const system = pickString(spec, "system");
  return { description, language, tags, system };
}

/** The doc_ref pointer from a docs block: docs.overview may be a bare path
 *  string (WO3a) or a {path,ref,sha,digest} object (WO3b). Normalize to an
 *  object (or null) — the digest points at the doc blob in CAS. */
function docRefOf(docs: Record<string, unknown> | undefined): Record<string, unknown> | null {
  const ov = docs?.overview;
  if (typeof ov === "string" && ov.length > 0) return { path: ov };
  if (ov && typeof ov === "object" && !Array.isArray(ov)) return ov as Record<string, unknown>;
  return null;
}

function relationsOf(rels: EntityRelationJson[] | undefined): CatalogEntityRelation[] {
  if (!Array.isArray(rels)) return [];
  const out: CatalogEntityRelation[] = [];
  for (const r of rels) {
    if (r && typeof r.type === "string" && typeof r.to === "string") {
      out.push({ type: r.type, targetRef: r.to });
    }
  }
  return out;
}

/** One projected entity, pre-provenance. Exported for the cross-language
 *  golden-vector test (object-golden.test.ts) which pins this reader to the
 *  authoritative fixtures generated by orun's internal/objgolden. */
export interface ProjectedEntity {
  entityRef: string;
  kind: string;
  name: string;
  owner: string | null;
  lifecycle: string | null;
  relations: CatalogEntityRelation[];
  /** Git-authored portal fields (CP4); null/[] when the snapshot omits them. */
  description: string | null;
  system: string | null;
  language: string | null;
  tags: string[];
  /** {path,ref,sha,digest} pointer to docs.overview in CAS (WO4), or null. */
  docRef: Record<string, unknown> | null;
  /** Repo-entity-only fields, for the state.repo_facet projection (WO4). */
  displayName?: string | null;
  links?: Array<Record<string, unknown>>;
}

function componentEntity(m: ComponentManifestJson): ProjectedEntity | null {
  const entityRef = pickString(m.identity as Record<string, unknown> | undefined, "componentKey");
  if (!entityRef) return null;
  const portal = portalFields(m.spec, m.metadata, m.docs);
  return {
    entityRef,
    kind: "Component",
    name: pickString(m.identity as Record<string, unknown> | undefined, "name") ?? entityRef,
    owner: pickString(m.ownership, "owner"),
    lifecycle: pickString(m.lifecycle, "stage", "lifecycle"),
    relations: relationsOf(m.relations),
    docRef: docRefOf(m.docs),
    ...portal,
  };
}

function derivedEntity(e: EntityJson): ProjectedEntity | null {
  const id = e.identity as Record<string, unknown> | undefined;
  const entityRef = pickString(id, "entityKey");
  if (!entityRef) return null;
  const kind = (typeof e.kind === "string" && e.kind) || pickString(id, "kind");
  if (!kind) return null;
  // Declared entities (e.g. Repo) carry description/tags/displayName on metadata;
  // derived ones carry description on spec. Read both so each kind projects.
  const tags = stringArray(e.spec, "tags").length ? stringArray(e.spec, "tags") : stringArray(e.metadata, "tags");
  return {
    entityRef,
    kind,
    name: pickString(id, "name") ?? entityRef,
    owner: pickString(e.ownership, "owner"),
    lifecycle: pickString(e.lifecycle, "stage", "lifecycle"),
    relations: [],
    description: pickString(e.spec, "description") ?? pickString(e.metadata, "description"),
    system: pickString(e.spec, "system"),
    language: pickString(e.spec, "language"),
    tags,
    docRef: docRefOf(e.docs),
    displayName: pickString(e.metadata, "displayName"),
    links: Array.isArray(e.links) ? e.links : [],
  };
}

/** Walk the snapshot tree and collect every component + derived entity. Exported
 *  for the cross-language golden-vector test (the production read path). */
export async function collectEntities(fetch: ObjectFetcher, rootDigest: string): Promise<ProjectedEntity[]> {
  const root = await readTree(fetch, rootDigest);
  if (!root) return [];
  const out: ProjectedEntity[] = [];

  const components = root.find((e) => e.name === DIR_COMPONENTS && e.kind === "tree");
  if (components) {
    const blobs = await readTree(fetch, components.id);
    for (const b of blobs ?? []) {
      if (b.kind !== "blob") continue;
      const manifest = await readJsonBlob<ComponentManifestJson>(fetch, b.id);
      const ent = manifest ? componentEntity(manifest) : null;
      if (ent) out.push(ent);
    }
  }

  const entities = root.find((e) => e.name === DIR_ENTITIES && e.kind === "tree");
  if (entities) {
    const kindTrees = await readTree(fetch, entities.id);
    for (const kt of kindTrees ?? []) {
      if (kt.kind !== "tree") continue;
      const blobs = await readTree(fetch, kt.id);
      for (const b of blobs ?? []) {
        if (b.kind !== "blob") continue;
        const entity = await readJsonBlob<EntityJson>(fetch, b.id);
        const ent = entity ? derivedEntity(entity) : null;
        if (ent) out.push(ent);
      }
    }
  }

  return out;
}

/**
 * Project a catalog snapshot into the org-global read model for one (project,
 * environment) scope. Best-effort: returns null when storage is unavailable
 * (dormant dev) or the snapshot root is unreadable; otherwise replaces the
 * scope's rows and returns the counts. Never throws to the caller's happy path —
 * the head-advance must succeed regardless.
 */
export async function projectCatalogSnapshot(
  env: Env,
  scope: CatalogProjectionScope,
  deps?: CatalogProjectionDeps,
): Promise<CatalogProjectionSummary | null> {
  // Structured, greppable diagnostics. The projection runs off the response
  // path (ctx.waitUntil) and used to surface no outcome at all, so a push could
  // advance the head yet leave the org-global read model empty with zero
  // signal. Log the result (and any failure) under one scope so an empty
  // console is diagnosable from `wrangler tail state-worker`.
  const base = {
    scope: "state.catalog.projection",
    digest: scope.digest,
    orgPublic: scope.orgPublic,
    projectPublic: scope.projectPublic,
    environment: scope.environment,
  };

  let fetcher = deps?.fetcher;
  if (!fetcher) {
    const bucket = requireBucket(env);
    if (!bucket.ok) {
      // Dormant on dev (no R2); on stage/prod this means storage is misbound.
      console.warn(JSON.stringify({ level: "warn", reason: "r2_unbound", ...base }));
      return null; // no R2 binding (dev) — dormant no-op
    }
    fetcher = (digest: string) =>
      bucket.bucket
        .get(objectKey(scope.orgPublic, scope.projectPublic, digest))
        .then(async (o) => (o ? new Uint8Array(await o.arrayBuffer()) : null));
  }

  if (!deps?.executor && !env.PLATFORM_DB) return null;
  const executor = deps?.executor ?? (await import("@saas/db/hyperdrive")).createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  const repo = createStateRepository(executor);

  // Track which phase failed so the diagnostic reason stays precise, and so any
  // failure is recorded on the catalog_projection outbox (attempts++). The cron
  // sweep drives from that outbox: it keeps re-projecting a scope whose read
  // model lags its head, then parks a poison scope after maxAttempts. This is
  // what closes the "frozen read model" gap when the on-advance ctx.waitUntil
  // projection is torn down mid-flight (state-worker invoked over a service
  // binding — migration 570).
  let phase: "collect" | "write" = "collect";
  try {
    const entities = await collectEntities(fetcher, scope.digest);
    if (entities.length === 0) {
      // Root unreadable (readTree → null) or a snapshot carrying no components/
      // entities. A valid-but-empty snapshot still "catches up" this scope's
      // read model to the head, so it is recorded as a success below.
      console.warn(JSON.stringify({ level: "warn", reason: "zero_entities", ...base }));
    }

    phase = "write";
    // Replace the scope: drop the prior projection, then upsert the new set.
    const deleted = await repo.deleteOrgCatalogEntitiesForScope(scope.orgId, scope.projectId, scope.environment);
    // The repo facet is keyed per project (env-independent): clear it and
    // re-derive from this snapshot's Repo entity (if any), so dropping the
    // `repo:` block clears the stale facet — the same bijection.
    await repo.deleteRepoFacetForScope(scope.orgId, scope.projectId);
    let projected = 0;
    for (const e of entities) {
      const input: UpsertOrgCatalogEntityInput = {
        id: generateUuid(),
        orgId: scope.orgId,
        entityRef: e.entityRef,
        kind: e.kind,
        name: e.name,
        sourceProjectId: scope.projectId,
        headDigest: scope.digest,
        owner: e.owner,
        lifecycle: e.lifecycle,
        relations: e.relations,
        description: e.description,
        system: e.system,
        language: e.language,
        tags: e.tags,
        docRef: e.docRef,
        sourceEnvironment: scope.environment,
        sourceCommit: scope.commit,
      };
      const up = await repo.upsertOrgCatalogEntity(input);
      if (up.ok) projected++;

      // The declared Repo entity also drives the per-project repo_facet.
      if (e.kind === "Repo") {
        await repo.upsertRepoFacet({
          orgId: scope.orgId,
          sourceProjectId: scope.projectId,
          headDigest: scope.digest,
          displayName: e.displayName ?? e.name,
          description: e.description,
          owner: e.owner,
          links: e.links ?? [],
          tags: e.tags,
          docRef: e.docRef,
          entityRef: e.entityRef,
          sourceCommit: scope.commit,
        });
      }
    }
    // Durably record that this scope's read model has caught up to `digest` (and
    // reset the failure counter) so the cron sweep stops re-projecting it. A
    // clean run otherwise leaves no log — a populated console is the signal.
    await repo.recordCatalogProjectionSuccess(scope.orgId, scope.projectId, scope.environment, scope.digest);
    return { deleted: deleted.ok ? deleted.value : 0, projected };
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        reason: phase === "collect" ? "collect_failed" : "write_failed",
        error: String(err),
        ...base,
      }),
    );
    // Best-effort: record the failure so the sweep tracks attempts; never mask
    // the original error.
    await repo
      .recordCatalogProjectionFailure(scope.orgId, scope.projectId, scope.environment, String(err))
      .catch(() => {});
    throw err;
  } finally {
    if (owned && "dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
      await (executor as unknown as { dispose: () => Promise<void> }).dispose();
    }
  }
}
