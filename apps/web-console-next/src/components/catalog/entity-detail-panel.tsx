"use client";

// The catalog master-detail panel (saas-service-catalog index redesign). The
// body shared by the pinned right-hand panel (≥ xl) and the fallback peek drawer
// (< xl), so both render identically. It promotes the previous inline drawer
// markup into one reusable surface: identity header, quick actions, then the
// shared `EntityOverview` (provenance + relations). "Open page" expands to the
// deep-linkable entity route; "Dependencies" jumps straight to that tab.

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
  GitFork,
  X,
  type LucideIcon,
} from "lucide-react";
import type { OrgCatalogEntity } from "@saas/contracts/state";
import { Badge } from "@/components/ui/badge";
import { EntityOverview } from "@/components/catalog/entity-overview";
import { cn } from "@/lib/cn";
import { kindTone } from "@/lib/catalog-kind";
import { encodeEntityKey } from "@/lib/catalog-entity-key";

const KIND_ICON: Record<string, LucideIcon> = {
  Component: Box,
  API: Webhook,
  Resource: Database,
  System: Boxes,
  Domain: Globe,
  Group: Users,
};

export function EntityDetailPanel({
  entity: e,
  projectLabel,
  orgSlug,
  onClose,
}: {
  entity: OrgCatalogEntity;
  projectLabel: (id: string) => string;
  orgSlug: string;
  /** When provided, render a close affordance (the pinned panel deselects). */
  onClose?: () => void;
}) {
  const tone = kindTone(e.kind);
  const Icon = KIND_ICON[tone.key] ?? Box;
  const key = encodeEntityKey({
    sourceProjectId: e.sourceProjectId,
    sourceEnvironment: e.sourceEnvironment,
    entityRef: e.entityRef,
  });
  const base = `/orgs/${orgSlug}/catalog/${key}`;

  return (
    <div className="flex h-full flex-col">
      {/* Identity header. `pr-8` keeps clear of the close affordance (this
          panel's own, or the Sheet's, depending on the host). */}
      <div className="flex items-start gap-3 pr-8">
        <span className={cn("grid h-10 w-10 shrink-0 place-items-center rounded-lg", tone.avatar)}>
          <Icon className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-semibold tracking-tight" title={e.name}>
              {e.name}
            </h2>
            <Badge variant="secondary" className="shrink-0">
              {e.kind}
            </Badge>
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

      {/* Quick actions. */}
      <div className="mt-4 grid grid-cols-2 gap-2">
        <Link
          href={base}
          className="inline-flex items-center justify-center gap-1 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
        >
          Open page
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
        <Link
          href={`${base}?tab=dependencies`}
          className="inline-flex items-center justify-center gap-1 rounded-md border px-3 py-2 text-xs font-medium transition-colors hover:bg-accent"
        >
          <GitFork className="h-3.5 w-3.5" />
          Dependencies
        </Link>
      </div>

      {/* Provenance + relations. Scrolls within the pinned/drawer host. */}
      <div className="mt-4 min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <EntityOverview entity={e} projectLabel={projectLabel} />
      </div>
    </div>
  );
}

/** Placeholder shown in the pinned panel when nothing is selected. */
export function EntityDetailEmpty() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <Boxes className="h-8 w-8 text-muted-foreground/40" aria-hidden />
      <p className="text-sm font-medium">Select a component</p>
      <p className="max-w-[15rem] text-xs text-muted-foreground">
        Pick a component to see its owner, provenance, and dependencies here.
      </p>
      <p className="mt-1 text-[11px] text-muted-foreground/70">
        <kbd className="rounded border px-1">↑</kbd> <kbd className="rounded border px-1">↓</kbd> to move ·{" "}
        <kbd className="rounded border px-1">↵</kbd> to open
      </p>
    </div>
  );
}
