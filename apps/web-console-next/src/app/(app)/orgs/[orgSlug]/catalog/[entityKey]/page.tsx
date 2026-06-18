"use client";

// The catalog entity detail route (saas-service-catalog SC0/SC1). A
// deep-linkable page for one merged-graph entity, reached from the index
// drawer's "Expand" or directly by URL. The left rail swaps to this entity's
// contextual nav (see `sidebar.tsx` + `entity-nav.ts`). Tabs (Overview ·
// Dependencies) are URL-synced via `?tab=` so each is shareable.
//
// The entity resolves over the existing org-catalog list endpoint (narrowed by
// the provenance project + a name query, then matched on the exact identity
// triple). The dedicated single-entity read (`state.getOrgCatalogEntity`) is a
// follow-up backend slice; this keeps the console self-contained.

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Boxes, ChevronLeft } from "lucide-react";
import type { OrgCatalogEntity } from "@saas/contracts/state";
import { OrgScope } from "@/components/shell/org-scope";
import { EntityOverview } from "@/components/catalog/entity-overview";
import { DependencyGraph } from "@/components/catalog/dependency-graph";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { decodeEntityKey, parseEntityRef, type EntityIdentity } from "@/lib/catalog-entity-key";
import { buildNeighborhood } from "@/lib/catalog-graph";

const TABS = ["overview", "dependencies"] as const;
type Tab = (typeof TABS)[number];

function sameEntity(e: OrgCatalogEntity, id: EntityIdentity): boolean {
  return (
    e.entityRef === id.entityRef &&
    e.sourceProjectId === id.sourceProjectId &&
    (e.sourceEnvironment ?? null) === id.sourceEnvironment
  );
}

export default function CatalogEntityPage() {
  const params = useParams<{ orgSlug: string; entityKey: string }>();
  const slug = params?.orgSlug ?? "";
  const entityKey = params?.entityKey ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} orgSlug={slug} entityKey={entityKey} />}</OrgScope>;
}

function Inner({ orgId, orgSlug, entityKey }: { orgId: string; orgSlug: string; entityKey: string }) {
  const { client } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = React.useMemo(() => decodeEntityKey(entityKey), [entityKey]);
  const catalogHref = `/orgs/${orgSlug}/catalog`;
  const entityHref = `/orgs/${orgSlug}/catalog/${entityKey}`;

  const rawTab = searchParams?.get("tab") ?? "";
  const activeTab: Tab = (TABS as readonly string[]).includes(rawTab) ? (rawTab as Tab) : "overview";
  const setTab = React.useCallback(
    (tab: string) => {
      router.replace(tab === "overview" ? entityHref : `${entityHref}?tab=${tab}`, { scroll: false });
    },
    [router, entityHref],
  );

  // Provenance + name narrow the merged graph to a tight candidate set; the
  // exact identity triple then disambiguates same-named entities across envs.
  const query = useApiQuery(
    qk.catalogEntity(orgId, entityKey),
    () =>
      wrap(() =>
        client.state.listOrgCatalogEntities(orgId, {
          project: id!.sourceProjectId,
          q: parseEntityRef(id!.entityRef).name || id!.entityRef,
        }),
      ),
    { enabled: id !== null },
  );

  const projects = useApiQuery(qk.projects(orgId), () =>
    wrap(async () => (await client.projects.list(orgId)).projects),
  );
  const projectLabel = React.useCallback(
    (pid: string) => {
      const p = projects.data?.find((x) => x.id === pid);
      return p?.name ?? p?.slug ?? pid;
    },
    [projects.data],
  );

  const entity = React.useMemo(
    () => (id && query.data ? (query.data.entities.find((e) => sameEntity(e, id)) ?? null) : null),
    [id, query.data],
  );
  const graph = React.useMemo(() => (entity ? buildNeighborhood(entity, orgSlug) : null), [entity, orgSlug]);

  const back = (
    <Link
      href={catalogHref}
      className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronLeft className="h-4 w-4" />
      Back to catalog
    </Link>
  );

  if (id === null) {
    return (
      <div className="space-y-5">
        {back}
        <EmptyState
          icon={Boxes}
          title="Entity not found"
          description="This catalog link is malformed or out of date."
          primaryAction={{ label: "Back to catalog", href: catalogHref }}
        />
      </div>
    );
  }

  if (query.loading) {
    return (
      <div className="space-y-5">
        {back}
        <Skeleton className="h-7 w-64" />
        <Card>
          <CardContent className="space-y-2 pt-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (query.error) {
    return (
      <div className="space-y-5">
        {back}
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{query.error.code}</CardTitle>
            <CardDescription>{query.error.message}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (!entity) {
    return (
      <div className="space-y-5">
        {back}
        <EmptyState
          icon={Boxes}
          title="Component not found"
          description="This component is no longer in the catalog, or its snapshot has moved on. It may have been removed from the source project."
          primaryAction={{ label: "Back to catalog", href: catalogHref }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {back}
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-xl font-semibold tracking-tight">{entity.name}</h1>
          <Badge variant="secondary">{entity.kind}</Badge>
        </div>
        <p className="break-all font-mono text-xs text-muted-foreground">{entity.entityRef}</p>
      </header>

      <Tabs value={activeTab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="dependencies">Dependencies</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Overview</CardTitle>
            </CardHeader>
            <CardContent>
              <EntityOverview entity={entity} projectLabel={projectLabel} />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="dependencies">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Dependencies</CardTitle>
              <CardDescription>
                This component and its direct relations. Click a node to open it.
              </CardDescription>
            </CardHeader>
            <CardContent>{graph ? <DependencyGraph graph={graph} /> : null}</CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
