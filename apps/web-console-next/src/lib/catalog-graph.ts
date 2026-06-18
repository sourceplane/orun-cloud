/**
 * Catalog dependency-graph model (saas-service-catalog SC1).
 *
 * A second renderer over the catalog's existing `relations[]` — no new data. We
 * build a small node/edge graph (a single entity's one-hop neighborhood, or the
 * merged org graph over a loaded page) and lay it out radially in a normalized
 * `[0,1] × [0,1]` space so the SVG renderer can position nodes by percentage
 * without measuring the DOM. Dependency-free and pure, so it is unit-testable.
 */

import type { OrgCatalogEntity } from "@saas/contracts/state";
import { encodeEntityKey, parseEntityRef } from "./catalog-entity-key";

export interface GraphNode {
  /** Stable node id (the URL key for resolvable entities, else `ref:<ref>`). */
  id: string;
  ref: string;
  name: string;
  kind: string;
  /** Entity route when this node resolves to a routable entity, else null. */
  href: string | null;
  /** The focus node of a neighborhood graph (rendered at the centre). */
  center?: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface PositionedNode extends GraphNode {
  /** Normalized position in [0,1]. */
  x: number;
  y: number;
}

function entityHref(orgSlug: string, e: { sourceProjectId: string; sourceEnvironment: string | null; entityRef: string }): string {
  return `/orgs/${orgSlug}/catalog/${encodeEntityKey({
    sourceProjectId: e.sourceProjectId,
    sourceEnvironment: e.sourceEnvironment,
    entityRef: e.entityRef,
  })}`;
}

/**
 * One entity's one-hop neighborhood: the entity at the centre, one node per
 * distinct relation target. Targets are assumed to live in the same provenance
 * scope (project + environment) as the source — correct for intra-service
 * dependencies; cross-scope targets resolve to a designed not-found page. The
 * exact cross-project resolution lands with the single-entity backend read.
 */
export function buildNeighborhood(entity: OrgCatalogEntity, orgSlug: string): Graph {
  const centerId = encodeEntityKey({
    sourceProjectId: entity.sourceProjectId,
    sourceEnvironment: entity.sourceEnvironment,
    entityRef: entity.entityRef,
  });
  const nodes: GraphNode[] = [
    { id: centerId, ref: entity.entityRef, name: entity.name, kind: entity.kind, href: null, center: true },
  ];
  const edges: GraphEdge[] = [];
  const seen = new Map<string, string>(); // targetRef → node id

  for (const r of entity.relations) {
    let nodeId = seen.get(r.targetRef);
    if (nodeId === undefined) {
      const { kind, name } = parseEntityRef(r.targetRef);
      nodeId = `ref:${r.targetRef}`;
      seen.set(r.targetRef, nodeId);
      nodes.push({
        id: nodeId,
        ref: r.targetRef,
        name: name || r.targetRef,
        kind,
        href: entityHref(orgSlug, {
          sourceProjectId: entity.sourceProjectId,
          sourceEnvironment: entity.sourceEnvironment,
          entityRef: r.targetRef,
        }),
      });
    }
    edges.push({ source: centerId, target: nodeId, type: r.type });
  }
  return { nodes, edges };
}

/**
 * The merged org graph over a loaded set of entities: one node per entity, with
 * an edge per relation whose target resolves to another loaded entity (matched
 * by exact provenance scope first, then by bare ref). Unresolved relations are
 * dropped — the graph only draws edges it can land on a real node.
 */
export function buildOrgGraph(entities: OrgCatalogEntity[], orgSlug: string): Graph {
  const nodes: GraphNode[] = [];
  const byScope = new Map<string, string>(); // project:env:ref → node id
  const byRef = new Map<string, string>(); // ref → node id (first wins)

  for (const e of entities) {
    const id = encodeEntityKey({
      sourceProjectId: e.sourceProjectId,
      sourceEnvironment: e.sourceEnvironment,
      entityRef: e.entityRef,
    });
    nodes.push({ id, ref: e.entityRef, name: e.name, kind: e.kind, href: entityHref(orgSlug, e) });
    byScope.set(`${e.sourceProjectId}:${e.sourceEnvironment ?? ""}:${e.entityRef}`, id);
    if (!byRef.has(e.entityRef)) byRef.set(e.entityRef, id);
  }

  const edges: GraphEdge[] = [];
  for (const e of entities) {
    const sourceId = byScope.get(`${e.sourceProjectId}:${e.sourceEnvironment ?? ""}:${e.entityRef}`)!;
    for (const r of e.relations) {
      const targetId =
        byScope.get(`${e.sourceProjectId}:${e.sourceEnvironment ?? ""}:${r.targetRef}`) ?? byRef.get(r.targetRef);
      if (targetId && targetId !== sourceId) edges.push({ source: sourceId, target: targetId, type: r.type });
    }
  }
  return { nodes, edges };
}

/**
 * Radial layout in normalized `[0,1]` space: a `center` node (if any) sits at
 * the middle, the rest are spread evenly on a circle. Deterministic, so the
 * graph is stable across renders.
 */
export function layoutGraph(graph: Graph, opts: { radius?: number } = {}): PositionedNode[] {
  const center = graph.nodes.find((n) => n.center);
  const ring = graph.nodes.filter((n) => !n.center);
  const radius = opts.radius ?? (center ? 0.38 : 0.42);
  const out: PositionedNode[] = [];
  if (center) out.push({ ...center, x: 0.5, y: 0.5 });
  const n = ring.length;
  ring.forEach((node, i) => {
    // Start at the top (-90°) and go clockwise for a stable, readable order.
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(n, 1);
    out.push({ ...node, x: 0.5 + radius * Math.cos(angle), y: 0.5 + radius * Math.sin(angle) });
  });
  return out;
}
