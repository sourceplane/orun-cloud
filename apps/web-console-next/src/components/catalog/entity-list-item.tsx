"use client";

// The "thick" catalog row (saas-service-catalog index redesign). Replaces the
// dense table row with a scannable card carrying a kind avatar, the name + ref,
// a provenance meta line, and lifecycle / relations / data-quality chips. A
// lifecycle-coloured accent rail runs down the left edge. Selecting a row drives
// the master-detail panel (`?entity=`); it never navigates on its own, so the
// peek stays fast (Expand lives in the detail panel).

import * as React from "react";
import {
  Box,
  Boxes,
  Database,
  Globe,
  Users,
  Webhook,
  GitFork,
  AlertTriangle,
  UserCircle2,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import type { OrgCatalogEntity } from "@saas/contracts/state";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { kindTone, lifecycleTone } from "@/lib/catalog-kind";

// Kind → icon. Lives in the renderer (not the pure tone map), mirroring how
// `sidebar.tsx` resolves icon names to components.
const KIND_ICON: Record<string, LucideIcon> = {
  Component: Box,
  API: Webhook,
  Resource: Database,
  System: Boxes,
  Domain: Globe,
  Group: Users,
};

export function EntityListItem({
  entity: e,
  projectLabel,
  selected,
  dangling,
  urlKey,
  onSelect,
}: {
  entity: OrgCatalogEntity;
  projectLabel: (id: string) => string;
  selected: boolean;
  /** This entity has a relation pointing at a target not in the loaded catalog. */
  dangling: boolean;
  /** The opaque identity key — used to scroll the row into view on keyboard nav. */
  urlKey: string;
  onSelect: () => void;
}) {
  const tone = kindTone(e.kind);
  const life = lifecycleTone(e.lifecycle);
  const Icon = KIND_ICON[tone.key] ?? Box;

  return (
    <button
      type="button"
      data-entitykey={urlKey}
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "group relative flex w-full items-start gap-3 overflow-hidden rounded-xl border bg-card p-3 pl-4 text-left shadow-sm transition-colors",
        "hover:border-primary/40 hover:bg-accent/40",
        selected ? "border-primary/60 bg-accent/50 ring-1 ring-primary/30" : "border-border",
      )}
    >
      {/* Lifecycle accent rail. */}
      <span className={cn("absolute inset-y-2 left-0 w-1 rounded-full", life.accent)} aria-hidden />

      {/* Kind avatar. */}
      <span className={cn("mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg", tone.avatar)}>
        <Icon className="h-[18px] w-[18px]" aria-hidden />
      </span>

      {/* Body. */}
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex items-center gap-2">
          <span className="truncate font-medium">{e.name}</span>
          <Badge variant="secondary" className="shrink-0">
            {e.kind}
          </Badge>
          {dangling ? (
            <Badge variant="warning" className="shrink-0 gap-1" title="A dependency points outside the loaded catalog">
              <AlertTriangle className="h-3 w-3" />
              dangling
            </Badge>
          ) : null}
        </span>

        <span className="block truncate font-mono text-[11px] text-muted-foreground">{e.entityRef}</span>

        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground">
          <span className="truncate">{projectLabel(e.sourceProjectId)}</span>
          <Dot />
          <span>{e.sourceEnvironment ? `env: ${e.sourceEnvironment}` : "project-wide"}</span>
          <Dot />
          {e.owner ? (
            <span className="inline-flex items-center gap-1">
              <UserCircle2 className="h-3 w-3" />
              {e.owner}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-warning-foreground/80 dark:text-warning">
              <UserCircle2 className="h-3 w-3" />
              unowned
            </span>
          )}
          {e.lifecycle ? (
            <Badge variant={life.variant} className="px-1.5 py-0 text-[10px] font-normal">
              {e.lifecycle}
            </Badge>
          ) : null}
          {e.relations.length > 0 ? (
            <span className="inline-flex items-center gap-1" title={`${e.relations.length} relation(s)`}>
              <GitFork className="h-3 w-3" />
              {e.relations.length}
            </span>
          ) : null}
        </span>
      </span>

      <ChevronRight
        className={cn(
          "mt-2 h-4 w-4 shrink-0 transition-colors",
          selected ? "text-primary" : "text-muted-foreground/40 group-hover:text-foreground",
        )}
        aria-hidden
      />
    </button>
  );
}

function Dot() {
  return <span className="text-muted-foreground/40">·</span>;
}
