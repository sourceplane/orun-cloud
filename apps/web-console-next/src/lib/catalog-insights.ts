/**
 * Catalog data-quality insights (saas-service-catalog SC4).
 *
 * A computed read over the catalog's existing fields — no new data. Surfaces the
 * gaps an internal developer portal should nag about: components without an
 * owner or lifecycle, and dependencies that point at components not present in
 * the catalog. Pure, so it is unit-testable.
 *
 * Scope note: computed over the entities currently loaded in the browser, so the
 * numbers describe "this view". The org-wide aggregate (and a `stale` signal,
 * which needs a per-entity timestamp the projection does not yet expose) is the
 * documented `state.getCatalogInsights` backend follow-up.
 */

import type { OrgCatalogEntity } from "@saas/contracts/state";

export type InsightId = "missing-owner" | "missing-lifecycle" | "dangling-deps";

export interface CatalogInsights {
  total: number;
  /** Percent of components that declare an owner (0–100). */
  ownedPct: number;
  counts: Record<InsightId, number>;
}

function presentRefs(entities: OrgCatalogEntity[]): Set<string> {
  return new Set(entities.map((e) => e.entityRef));
}

function hasDanglingDep(e: OrgCatalogEntity, present: Set<string>): boolean {
  return e.relations.some((r) => !present.has(r.targetRef));
}

export function computeInsights(entities: OrgCatalogEntity[]): CatalogInsights {
  const total = entities.length;
  const present = presentRefs(entities);
  let missingOwner = 0;
  let missingLifecycle = 0;
  let dangling = 0;
  for (const e of entities) {
    if (!e.owner) missingOwner++;
    if (!e.lifecycle) missingLifecycle++;
    if (hasDanglingDep(e, present)) dangling++;
  }
  const owned = total - missingOwner;
  return {
    total,
    ownedPct: total === 0 ? 0 : Math.round((owned / total) * 100),
    counts: {
      "missing-owner": missingOwner,
      "missing-lifecycle": missingLifecycle,
      "dangling-deps": dangling,
    },
  };
}

/** The offending subset for one insight — drives the index's click-to-filter. */
export function filterByInsight(entities: OrgCatalogEntity[], id: InsightId): OrgCatalogEntity[] {
  if (id === "missing-owner") return entities.filter((e) => !e.owner);
  if (id === "missing-lifecycle") return entities.filter((e) => !e.lifecycle);
  const present = presentRefs(entities);
  return entities.filter((e) => hasDanglingDep(e, present));
}

/** Human label for an insight chip. */
export const INSIGHT_LABEL: Record<InsightId, string> = {
  "missing-owner": "Missing owner",
  "missing-lifecycle": "No lifecycle",
  "dangling-deps": "Dangling deps",
};
