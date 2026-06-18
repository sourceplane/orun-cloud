"use client";

// The catalog master-detail panel (saas-service-catalog index redesign). One
// reusable body shared by the pinned right-hand panel (≥ xl) and the fallback
// peek drawer (< xl). Calm and self-contained: a quiet identity header, a
// subtle tab switch (Overview · Dependencies), then the content. There is no
// prominent "open" button — the row is double-clicked to drill into the full
// page; a faint ↗ in the header is the discoverable secondary affordance.

import * as React from "react";
import Link from "next/link";
import {
  Box,
  Boxes,
  Database,
  Globe,
  Users,
  Webhook,
  ArrowUpRight,
  X,
  type LucideIcon,
} from "lucide-react";
import type { OrgCatalogEntity } from "@saas/contracts/state";
import { Badge } from "@/components/ui/badge";
import { EntityOverview } from "@/components/catalog/entity-overview";
import { DependencyGraph } from "@/components/catalog/dependency-graph";
import { cn } from "@/lib/cn";
import { kindTone } from "@/lib/catalog-kind";
import { encodeEntityKey } from "@/lib/catalog-entity-key";
import { buildNeighborhood } from "@/lib/catalog-graph";

const KIND_ICON: Record<string, LucideIcon> = {
  Component: Box,
  API: Webhook,
  Resource: Database,
  System: Boxes,
  Domain: Globe,
  Group: Users,
};

const TABS = ["overview", "dependencies"] as const;
type Tab = (typeof TABS)[number];

export function EntityDetailPanel({
  entity: e,
  projectLabel,
  orgSlug,
  onClose,
  showOpenLink = true,
}: {
  entity: OrgCatalogEntity;
  projectLabel: (id: string) => string;
  orgSlug: string;
  /** When provided, render a close affordance (the pinned panel deselects). */
  onClose?: () => void;
  /** Hide the ↗ when the panel is already on the entity's own full page. */
  showOpenLink?: boolean;
}) {
  const [tab, setTab] = React.useState<Tab>("overview");
  const tone = kindTone(e.kind);
  const Icon = KIND_ICON[tone.key] ?? Box;
  const key = encodeEntityKey({
    sourceProjectId: e.sourceProjectId,
    sourceEnvironment: e.sourceEnvironment,
    entityRef: e.entityRef,
  });
  const fullHref = `/orgs/${orgSlug}/catalog/${key}`;
  const graph = React.useMemo(() => buildNeighborhood(e, orgSlug), [e, orgSlug]);

  return (
    <div className="flex h-full flex-col">
      {/* Identity header. `pr-8` keeps clear of the close affordance. */}
      <div className="flex items-start gap-3 pr-8">
        <span className={cn("grid h-10 w-10 shrink-0 place-items-center rounded-lg", tone.avatar)}>
          <Icon className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-semibold tracking-tight" title={e.name}>
              {e.name}
            </h2>
            <Badge variant="outline" className="shrink-0 font-normal text-muted-foreground">
              {e.kind}
            </Badge>
            {showOpenLink ? (
              <Link
                href={fullHref}
                aria-label="Open full page"
                title="Open full page"
                className="shrink-0 rounded text-muted-foreground/60 transition-colors hover:text-foreground"
              >
                <ArrowUpRight className="h-4 w-4" />
              </Link>
            ) : null}
          </div>
          <p className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">{e.entityRef}</p>
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      {/* Quiet tab switch. */}
      <div className="mt-4 inline-flex w-fit rounded-md border p-0.5 text-xs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              "rounded px-2.5 py-1 capitalize transition-colors",
              tab === t ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="mt-4 min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {tab === "overview" ? (
          <EntityOverview entity={e} projectLabel={projectLabel} />
        ) : e.relations.length === 0 ? (
          <p className="text-sm text-muted-foreground">No dependencies declared.</p>
        ) : (
          <DependencyGraph graph={graph} height={300} />
        )}
      </div>
    </div>
  );
}

/** Placeholder shown in the pinned panel when nothing is selected. */
export function EntityDetailEmpty() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <Boxes className="h-8 w-8 text-muted-foreground/30" aria-hidden />
      <p className="text-sm font-medium">Select a component</p>
      <p className="max-w-[16rem] text-xs text-muted-foreground">
        Click a component to preview it here. Double-click to open its full page.
      </p>
      <p className="mt-1 text-[11px] text-muted-foreground/70">
        <kbd className="rounded border px-1">↑</kbd> <kbd className="rounded border px-1">↓</kbd> move ·{" "}
        <kbd className="rounded border px-1">↵</kbd> open
      </p>
    </div>
  );
}
