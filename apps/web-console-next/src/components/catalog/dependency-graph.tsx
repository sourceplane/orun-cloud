"use client";

// The catalog dependency graph (saas-service-catalog SC1) — a dependency-free
// SVG/HTML renderer over the pure graph model. Edges live in a stretched
// `0..100` SVG layer; nodes are percentage-positioned HTML chips on top, so the
// two align at any container aspect without measuring the DOM. Resolvable nodes
// are Links into the entity route.

import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { layoutGraph, type Graph, type PositionedNode } from "@/lib/catalog-graph";

const KIND_COLOR: Record<string, string> = {
  Component: "border-sky-500/60 bg-sky-500/10",
  API: "border-violet-500/60 bg-violet-500/10",
  Resource: "border-amber-500/60 bg-amber-500/10",
  System: "border-emerald-500/60 bg-emerald-500/10",
  Domain: "border-rose-500/60 bg-rose-500/10",
  Group: "border-slate-500/60 bg-slate-500/10",
};
const DEFAULT_COLOR = "border-border bg-muted";

/** Past this, a client-side radial layout stops being legible — ask to filter. */
const MAX_NODES = 60;

export function DependencyGraph({ graph, height = 420 }: { graph: Graph; height?: number }) {
  const positioned = React.useMemo(() => layoutGraph(graph), [graph]);
  const byId = React.useMemo(() => new Map(positioned.map((n) => [n.id, n] as const)), [positioned]);

  const frame = "flex items-center justify-center rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground";

  if (graph.nodes.length > MAX_NODES) {
    return (
      <div className={frame} style={{ height }}>
        {graph.nodes.length} components is too many to graph clearly — narrow the filters to focus the view.
      </div>
    );
  }
  if (graph.edges.length === 0) {
    return (
      <div className={frame} style={{ height }}>
        No relations to graph for this view.
      </div>
    );
  }

  return (
    <div className="relative w-full rounded-lg border bg-card/40" style={{ height }}>
      <svg className="absolute inset-0 h-full w-full text-border" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
        {graph.edges.map((e, i) => {
          const s = byId.get(e.source);
          const t = byId.get(e.target);
          if (!s || !t) return null;
          return (
            <line
              key={i}
              x1={s.x * 100}
              y1={s.y * 100}
              x2={t.x * 100}
              y2={t.y * 100}
              stroke="currentColor"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>
      {positioned.map((n) => (
        <NodeChip key={n.id} node={n} />
      ))}
    </div>
  );
}

function NodeChip({ node }: { node: PositionedNode }) {
  const color = KIND_COLOR[node.kind] ?? DEFAULT_COLOR;
  const chip = (
    <span
      className={cn(
        "block max-w-[150px] truncate rounded-md border px-2 py-1 text-xs font-medium text-foreground shadow-sm",
        color,
        node.center && "ring-2 ring-primary",
      )}
    >
      {node.name}
    </span>
  );
  return (
    <div
      className="absolute"
      style={{ left: `${node.x * 100}%`, top: `${node.y * 100}%`, transform: "translate(-50%, -50%)" }}
      title={`${node.kind || "?"}: ${node.ref}`}
    >
      {node.href && !node.center ? (
        <Link href={node.href} className="block transition-opacity hover:opacity-80">
          {chip}
        </Link>
      ) : (
        chip
      )}
    </div>
  );
}
