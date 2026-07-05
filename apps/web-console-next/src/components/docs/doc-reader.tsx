"use client";

/**
 * The doc reader (saas-catalog-docs CD5) — one git-authored document, deep-
 * linkable at `/orgs/{slug}/docs/{entityKey}/{docKey}`. Identity-addressed
 * (`(entity, key)`, model.md §2c) so links survive content changes; the body
 * always renders the digest currently projected for that identity, through the
 * sanitizing pipeline, under its provenance line.
 *
 * Layout: the entity's shelf on the left (the same DocShelf the service page
 * embeds — the two surfaces cannot drift), the rendered body on the right,
 * with backlinks to the entity page and the hub.
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, BookOpen } from "lucide-react";
import { decodeEntityKey, parseEntityRef } from "@/lib/catalog-entity-key";
import { DocBody, DocProvenance, DocShelf, useEntityDocs } from "@/components/catalog/docs/entity-docs";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

export function DocReader({
  orgId,
  orgSlug,
  entityKey,
  docKey,
}: {
  orgId: string;
  orgSlug: string;
  entityKey: string;
  docKey: string;
}) {
  const router = useRouter();
  const identity = React.useMemo(() => decodeEntityKey(entityKey), [entityKey]);
  const { docs, loading } = useEntityDocs(orgId, identity?.entityRef ?? null);

  if (!identity) {
    return (
      <EmptyState
        icon={BookOpen}
        title="Document not found"
        description="This link doesn't resolve to a catalog entity."
        primaryAction={{ label: "All docs", href: `/orgs/${orgSlug}/docs` }}
      />
    );
  }

  if (loading && docs.length === 0) {
    return (
      <div className="space-y-3 p-1">
        <Skeleton className="h-6 w-64 bg-muted" />
        <Skeleton className="h-40 w-full bg-muted" />
      </div>
    );
  }

  const active = docs.find((d) => d.docKey === docKey) ?? null;
  const entityName = active?.entityName ?? parseEntityRef(identity.entityRef).name ?? identity.entityRef;

  if (!active) {
    return (
      <EmptyState
        icon={BookOpen}
        title="Document not found"
        description={`${entityName} has no “${docKey}” document at the current catalog head. It may have been renamed or removed in the repo.`}
        primaryAction={{ label: "All docs", href: `/orgs/${orgSlug}/docs` }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* breadcrumb */}
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <Link href={`/orgs/${orgSlug}/docs`} className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" />
          Docs
        </Link>
        <span className="text-muted-foreground/45">/</span>
        <Link href={`/orgs/${orgSlug}/catalog/${entityKey}`} className="font-medium text-muted-foreground hover:text-foreground">
          {entityName}
        </Link>
        <span className="text-muted-foreground/45">/</span>
        <span className="truncate font-medium text-foreground">{active.title}</span>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[230px_minmax(0,1fr)]">
        <div className="flex flex-col gap-3">
          <DocShelf
            docs={docs}
            activeKey={active.docKey}
            onSelect={(key) => router.push(`/orgs/${orgSlug}/docs/${entityKey}/${encodeURIComponent(key)}`)}
          />
          <Link
            href={`/orgs/${orgSlug}/catalog/${entityKey}`}
            className="rounded-[12px] border border-border bg-card px-3.5 py-3 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground"
          >
            Open <span className="font-medium text-foreground/90">{entityName}</span> in the catalog →
          </Link>
        </div>

        <div className="overflow-hidden rounded-[13px] border border-border bg-card">
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-popover px-4 py-[11px]">
            <span className="text-[13px] font-medium text-foreground/90">{active.title}</span>
            {active.docKey !== "overview" ? (
              <span className="rounded-[5px] border border-input px-1.5 py-px text-[10px] text-muted-foreground/70">
                {active.role}
              </span>
            ) : null}
            <span className="ml-auto">
              <DocProvenance doc={active} />
            </span>
          </div>
          <div className="px-5 py-5 md:px-7 md:py-6">
            <DocBody orgId={orgId} doc={active} />
          </div>
        </div>
      </div>
    </div>
  );
}
