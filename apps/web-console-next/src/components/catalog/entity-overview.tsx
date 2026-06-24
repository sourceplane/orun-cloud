"use client";

// The catalog entity "Overview" — full provenance + typed relations
// (saas-service-catalog SC0). Extracted so it backs both the index quick-peek
// drawer and the dedicated entity route without duplicating the layout.

import type { OrgCatalogEntity } from "@saas/contracts/state";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";

export function EntityOverview({
  entity: e,
  projectLabel,
}: {
  entity: OrgCatalogEntity;
  projectLabel: (id: string) => string;
}) {
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
        <Pair label="Owner" value={e.owner ?? "—"} />
        <Pair label="Lifecycle" value={e.lifecycle ?? "—"} />
        <Pair label="Repo" value={projectLabel(e.sourceProjectId)} />
        <Pair label="Environment" value={e.sourceEnvironment ?? "repo-wide"} />
        <Pair label="Commit" value={e.sourceCommit ? e.sourceCommit.slice(0, 12) : "—"} mono />
        <Pair label="Snapshot" value={e.headDigest.slice(0, 19)} mono />
      </dl>

      <div>
        <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
          Relations ({e.relations.length})
        </div>
        {e.relations.length === 0 ? (
          <p className="text-sm text-muted-foreground">No relations.</p>
        ) : (
          <ul className="space-y-1">
            {e.relations.map((r, i) => (
              <li key={i} className="flex items-center gap-2 text-xs">
                <Badge variant="outline">{r.type}</Badge>
                <span className="text-muted-foreground">→</span>
                <span className="break-all font-mono">{r.targetRef}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Pair({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 border-b border-dashed py-1 last:border-0 sm:last:border-b">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn("truncate", mono && "font-mono text-xs")} title={value}>
        {value}
      </dd>
    </div>
  );
}
