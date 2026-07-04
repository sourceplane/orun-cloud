/**
 * Catalog-portal filtering, sorting & grouping (saas-catalog-portal CP0).
 *
 * Reproduces the design's `filtered()` / `sortList()` / grouping exactly over
 * the normalized `CatalogService`, including the Unowned / No-lifecycle
 * sink-to-bottom order. Pure and unit-tested.
 */

import {
  type CatalogService,
  healthOf,
  lifecycleKey,
  needsAttention,
  ownerLabel,
  resolvedOwnerLabel,
  scoreOf,
} from "./model";
import type { HealthKey } from "./palette";

export interface CatalogFilters {
  /** Free-text query over name, ref, owner, language, system. */
  query: string;
  /** "all" | a kind. */
  kind: string;
  /** "all" | production | experimental | deprecated. */
  lifecycle: string;
  /** "all" | healthy | degraded | down. */
  health: string;
  /** Restrict to entities needing attention. */
  attention: boolean;
}

export const EMPTY_FILTERS: CatalogFilters = {
  query: "",
  kind: "all",
  lifecycle: "all",
  health: "all",
  attention: false,
};

/** Apply the toolbar filters, matching the design's `filtered()`. */
export function filterServices(services: CatalogService[], f: CatalogFilters): CatalogService[] {
  const q = f.query.trim().toLowerCase();
  return services.filter((s) => {
    if (f.kind !== "all" && s.kind.toLowerCase() !== f.kind.toLowerCase()) return false;
    if (f.lifecycle !== "all" && lifecycleKey(s.lifecycle) !== f.lifecycle) return false;
    if (f.health !== "all" && healthOf(s) !== f.health) return false;
    if (f.attention && !needsAttention(s)) return false;
    if (q) {
      // teams-ownership TO2 — search resolved team name + handle alongside the raw owner.
      const ownerHay = s.ownerTeam ? `${s.ownerTeam.name} ${s.ownerTeam.handle ?? ""}` : ownerLabel(s.owner);
      const hay = `${s.name} ${s.ref} ${ownerHay} ${s.language ?? ""} ${s.system}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export type SortKey = "name" | "health" | "readiness" | "deploy";
export type SortDir = "asc" | "desc";

const HEALTH_RANK: Record<HealthKey, number> = { down: 3, degraded: 2, healthy: 1, managed: 0 };

/** Sort by a column, matching the design's `sortList()`. */
export function sortServices(services: CatalogService[], key: SortKey, dir: SortDir): CatalogService[] {
  const cmp = (a: CatalogService, b: CatalogService): number => {
    if (key === "name") return a.entityRef.localeCompare(b.entityRef);
    if (key === "health") return HEALTH_RANK[healthOf(b)] - HEALTH_RANK[healthOf(a)];
    if (key === "readiness") return (scoreOf(b) ?? -1) - (scoreOf(a) ?? -1);
    if (key === "deploy") return (a.lastDeployHours ?? 1e9) - (b.lastDeployHours ?? 1e9);
    return 0;
  };
  const out = [...services].sort(cmp);
  if (dir === "desc") out.reverse();
  return out;
}

export type GroupKey = "none" | "team" | "system" | "lifecycle";

export interface CatalogGroup {
  key: string;
  label: string;
  count: number;
  /** "N need attention" or "all healthy". */
  sub: string;
  services: CatalogService[];
}

const SINK_LABELS = new Set(["Unowned", "No lifecycle"]);

/** Group the list for the Table view; null when ungrouped. */
export function groupServices(services: CatalogService[], key: GroupKey): CatalogGroup[] | null {
  if (key === "none") return null;
  const keyOf = (s: CatalogService): string => {
    // teams-ownership TO2 — group by RESOLVED team identity, not the raw owner
    // string. Unmapped owners bucket distinctly from truly unowned entities.
    if (key === "team") return resolvedOwnerLabel(s);
    if (key === "system") return s.system;
    const lk = lifecycleKey(s.lifecycle);
    return lk ? lk[0]!.toUpperCase() + lk.slice(1) : "No lifecycle";
  };
  const buckets = new Map<string, CatalogService[]>();
  const order: string[] = [];
  for (const s of services) {
    const k = keyOf(s);
    if (!buckets.has(k)) {
      buckets.set(k, []);
      order.push(k);
    }
    buckets.get(k)!.push(s);
  }
  order.sort((a, b) => (SINK_LABELS.has(a) ? 1 : 0) - (SINK_LABELS.has(b) ? 1 : 0));
  return order.map((label) => {
    const list = buckets.get(label)!;
    const att = list.filter(needsAttention).length;
    return {
      key: label,
      label,
      count: list.length,
      sub: att > 0 ? `${att} need attention` : "all healthy",
      services: list,
    };
  });
}

/** The active-facet chips, matching the design's `chips` builder. */
export interface FilterChip {
  field: keyof CatalogFilters;
  kind: string;
  label: string;
}

export function activeChips(f: CatalogFilters): FilterChip[] {
  const chips: FilterChip[] = [];
  if (f.kind !== "all") chips.push({ field: "kind", kind: "kind", label: f.kind });
  if (f.lifecycle !== "all") chips.push({ field: "lifecycle", kind: "lifecycle", label: f.lifecycle });
  if (f.health !== "all") chips.push({ field: "health", kind: "health", label: f.health });
  if (f.attention) chips.push({ field: "attention", kind: "", label: "Needs attention" });
  if (f.query.trim()) chips.push({ field: "query", kind: "search", label: `“${f.query.trim()}”` });
  return chips;
}

export function hasActiveFilters(f: CatalogFilters): boolean {
  return f.kind !== "all" || f.lifecycle !== "all" || f.health !== "all" || f.attention || f.query.trim() !== "";
}
