"use client";

// The drilled-in component page (saas-service-catalog). Rendered in the CENTER
// panel of the entity route — the full, calm view of one component: identity
// header, a quiet Overview · Dependencies tab switch, then the content in page
// cards. It flows naturally so the center column owns the scroll (the side info
// panel stays fixed). The right "Additional details" panel is a deliberate seam
// left blank until scorecards / richer service definitions land.

import * as React from "react";
import {
  Box,
  Boxes,
  Database,
  Globe,
  Users,
  Webhook,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import type { OrgCatalogEntity } from "@saas/contracts/state";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EntityOverview } from "@/components/catalog/entity-overview";
import { DependencyGraph } from "@/components/catalog/dependency-graph";
import { cn } from "@/lib/cn";
import { kindTone } from "@/lib/catalog-kind";
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

export function EntityPage({
  entity: e,
  projectLabel,
  orgSlug,
}: {
  entity: OrgCatalogEntity;
  projectLabel: (id: string) => string;
  orgSlug: string;
}) {
  const [tab, setTab] = React.useState<Tab>("overview");
  const tone = kindTone(e.kind);
  const Icon = KIND_ICON[tone.key] ?? Box;
  const graph = React.useMemo(() => buildNeighborhood(e, orgSlug), [e, orgSlug]);

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <span className={cn("grid h-11 w-11 shrink-0 place-items-center rounded-xl", tone.avatar)}>
          <Icon className="h-[22px] w-[22px]" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-lg font-semibold tracking-tight" title={e.name}>
              {e.name}
            </h1>
            <Badge variant="outline" className="font-normal text-muted-foreground">
              {e.kind}
            </Badge>
          </div>
          <p className="mt-0.5 break-all font-mono text-xs text-muted-foreground">{e.entityRef}</p>
        </div>
      </div>

      <div className="inline-flex w-fit rounded-md border p-0.5 text-xs" role="tablist">
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

      {tab === "overview" ? (
        <Card>
          <CardContent className="pt-6">
            <EntityOverview entity={e} projectLabel={projectLabel} />
          </CardContent>
        </Card>
      ) : e.relations.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No dependencies declared.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="pt-6">
            <DependencyGraph graph={graph} height={420} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/**
 * The drilled-in right-hand "Additional details" panel — fixed beside the
 * component page. A deliberate placeholder: scorecards (SC5) and richer service
 * definitions (SC6) will fill it; until then it states its own emptiness.
 */
export function EntityInfoPanel() {
  return (
    <div className="flex h-full flex-col rounded-xl border bg-card p-4 shadow-sm">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Additional details</div>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
        <SlidersHorizontal className="h-7 w-7 text-muted-foreground/25" aria-hidden />
        <p className="max-w-[15rem] text-xs text-muted-foreground">
          No additional details yet — scorecards and richer service definitions will land here.
        </p>
      </div>
    </div>
  );
}
