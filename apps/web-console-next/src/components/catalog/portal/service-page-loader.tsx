"use client";

/**
 * Dedicated service page loader (saas-catalog-portal CP5).
 *
 * The data shell for the deep entity route. It loads the full org graph through
 * the SAME shared query as the index (`qk.orgCatalog`) so the cache is reused —
 * arriving from a row drill-in paints instantly, and a cold deep-link still
 * resolves the whole neighborhood (depends-on / used-by names) the page needs.
 * Builds the portal context once, resolves the focused entity by its URL key,
 * and renders `ServicePage`; otherwise shows the skeleton / not-found seam.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Boxes } from "lucide-react";
import { useSession } from "@/lib/session";
import { wrap } from "@/lib/api";
import { useApiQuery, qk } from "@/lib/query";
import { collectOrgCatalog } from "@/lib/catalog-portal/fetch";
import { buildContext, toServices, annotateDocSignals, annotateRunSignals } from "@/lib/catalog-portal/model";
import { useOrgDocs } from "@/components/catalog/docs/entity-docs";
import { buildPage } from "@/lib/catalog-portal/page";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ServicePage } from "./service-page";

export function ServicePageLoader({
  orgId,
  orgSlug,
  entityKey,
}: {
  orgId: string;
  orgSlug: string;
  entityKey: string;
}) {
  const { client } = useSession();
  const router = useRouter();
  const qc = useQueryClient();
  const catalogHref = `/orgs/${orgSlug}/catalog`;

  // Identical query to CatalogPortal — same key, same streaming fill — so the
  // index and the deep page share one cache entry (PERF C1/C2).
  const { data: entities, loading, error } = useApiQuery(qk.orgCatalog(orgId), () =>
    wrap(() =>
      collectOrgCatalog((query) => client.state.listOrgCatalogEntities(orgId, query), {
        onPage: (soFar) => qc.setQueryData(qk.orgCatalog(orgId), soFar),
      }),
    ),
  );

  // Scorecard v2 signals (same sources + caches as the index) so the deep
  // page's ring/tier agree with the portal row that drilled in.
  const { data: orgDocs } = useOrgDocs(orgId);
  const { data: orgRuns } = useApiQuery(qk.orgRuns(orgId), () =>
    wrap(async () => (await client.state.listOrgRuns(orgId, { limit: 24 })).runs),
  );
  const services = React.useMemo(() => {
    let out = toServices(entities ?? []);
    if (orgDocs) out = annotateDocSignals(out, orgDocs);
    if (orgRuns) out = annotateRunSignals(out, orgRuns, Date.now());
    return out;
  }, [entities, orgDocs, orgRuns]);
  const ctx = React.useMemo(() => buildContext(services), [services]);
  const selected = React.useMemo(() => services.find((s) => s.key === entityKey) ?? null, [services, entityKey]);
  const page = React.useMemo(() => (selected ? buildPage(selected, ctx) : null), [selected, ctx]);

  const onBack = React.useCallback(() => router.push(catalogHref), [router, catalogHref]);
  const onViewMap = React.useCallback(() => router.push(catalogHref), [router, catalogHref]);
  const onSelectRef = React.useCallback(
    (key: string) => router.push(`${catalogHref}/${key}`),
    [router, catalogHref],
  );

  if (page) {
    return (
      <ServicePage page={page} orgId={orgId} orgSlug={orgSlug} orgLabel={orgSlug} onBack={onBack} onViewMap={onViewMap} onSelectRef={onSelectRef} />
    );
  }

  if (loading && !entities) {
    return (
      <div className="mx-auto flex w-full max-w-[1060px] flex-col gap-4 px-5 pt-7 sm:px-8 sm:pt-10 lg:px-12">
        <div className="flex items-start gap-4">
          <Skeleton className="h-[54px] w-[54px] rounded-[14px] bg-muted" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-6 w-64 bg-muted" />
            <Skeleton className="h-3 w-80 bg-muted" />
          </div>
        </div>
        <Skeleton className="h-9 w-96 bg-muted" />
        <Skeleton className="h-72 w-full rounded-[13px] bg-muted" />
      </div>
    );
  }

  return (
    <EmptyState
      icon={Boxes}
      title={error ? "Could not load the catalog" : "Component not found"}
      description={
        error
          ? error.message
          : "This component is no longer in the catalog, or its snapshot has moved on."
      }
      primaryAction={{ label: "Back to catalog", href: catalogHref }}
    />
  );
}
