/**
 * Catalog-portal board & map layout (saas-catalog-portal CP2).
 *
 * Pure layout over the filtered services: the Kanban board columns (by
 * lifecycle + an infrastructure column for resources) and the dependency-map
 * node/edge positions (laid out in per-system columns, normalized to a 0–100
 * space so the SVG renderer positions by percentage). Mirrors the design's
 * `boardCols` / map layout. Unit-tested.
 */

import { healthOf, isResource, lifecycleKey, type CatalogService } from "./model";
import { iconForKind } from "./icons";
import { HEALTH } from "./palette";

// ── Board ────────────────────────────────────────────────────

export interface BoardColumn {
  key: string;
  title: string;
  /** Header dot colour. */
  color: string;
  count: number;
  services: CatalogService[];
}

const BOARD_DEFS: Array<{ key: string; title: string; color: string }> = [
  { key: "production", title: "Production", color: "#34d399" },
  { key: "experimental", title: "Experimental", color: "#fbbf24" },
  { key: "deprecated", title: "Deprecated", color: "#71717a" },
  { key: "infra", title: "Infrastructure", color: "#52525b" },
];

/** Group the filtered services into the design's four board columns. */
export function buildBoard(services: CatalogService[]): BoardColumn[] {
  return BOARD_DEFS.map((c) => {
    const list = services.filter((s) =>
      c.key === "infra" ? isResource(s) : !isResource(s) && lifecycleKey(s.lifecycle) === c.key,
    );
    return { key: c.key, title: c.title, color: c.color, count: list.length, services: list };
  });
}

// ── Dependency map ───────────────────────────────────────────

export interface MapNode {
  key: string;
  name: string;
  iconD: string;
  healthColor: string;
  /** Position as a percentage in [0,100]. */
  x: number;
  y: number;
  system: string;
}

export interface MapEdge {
  fromKey: string;
  toKey: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface MapModel {
  columns: string[];
  colCount: number;
  nodes: MapNode[];
  edges: MapEdge[];
  count: number;
}

/**
 * Lay out the non-resource services in per-system columns. Systems are ordered
 * alphabetically for determinism; within a column, nodes are spread vertically.
 */
export function buildMap(services: CatalogService[]): MapModel {
  const mapList = services.filter((s) => !isResource(s));
  const columns = [...new Set(mapList.map((s) => s.system))].sort((a, b) => a.localeCompare(b));
  const colCount = Math.max(columns.length, 1);
  const pos = new Map<string, { x: number; y: number }>();
  const nodes: MapNode[] = [];

  columns.forEach((sys, ci) => {
    const inCol = mapList.filter((s) => s.system === sys);
    const cx = ((ci + 0.5) / columns.length) * 100;
    inCol.forEach((s, ri) => {
      const cy = inCol.length === 1 ? 50 : 14 + (ri / (inCol.length - 1)) * 72;
      pos.set(s.entityRef, { x: cx, y: cy });
      pos.set(s.key, { x: cx, y: cy });
      nodes.push({
        key: s.key,
        name: s.name,
        iconD: iconForKind(s.kind),
        healthColor: HEALTH[healthOf(s)].c,
        x: Number(cx.toFixed(2)),
        y: Number(cy.toFixed(2)),
        system: sys,
      });
    });
  });

  const edges: MapEdge[] = [];
  for (const s of mapList) {
    const a = pos.get(s.entityRef);
    if (!a) continue;
    for (const dep of s.deps) {
      const b = pos.get(dep);
      if (!b) continue;
      const target = mapList.find((x) => x.entityRef === dep);
      edges.push({
        fromKey: s.key,
        toKey: target?.key ?? dep,
        x1: Number(a.x.toFixed(2)),
        y1: Number(a.y.toFixed(2)),
        x2: Number(b.x.toFixed(2)),
        y2: Number(b.y.toFixed(2)),
      });
    }
  }

  return { columns, colCount, nodes, edges, count: mapList.length };
}
