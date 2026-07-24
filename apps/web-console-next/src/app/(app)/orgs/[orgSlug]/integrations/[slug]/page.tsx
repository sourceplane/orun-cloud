"use client";

// The canonical integration route (saas-integration-registry IR2):
// `/integrations/{provider}` IS the integration's page. The one dynamic
// segment resolves by SHAPE (epic risks R2 — exactly two shapes, nothing
// else): a `int_…` public id is a legacy per-connection deep link and
// redirects to the nested detail route (`…/{provider}/connections/{id}`,
// provider resolved from the connections list — the SP-A4 pattern);
// anything else renders the provider space, which 404s unknown providers
// itself via the registry read.

import * as React from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { ProviderSpace } from "@/components/integrations/provider-space";
import { IntegrationDetail } from "@/components/integrations/detail/integration-detail";
import { Screen } from "@/components/ui/northwind";
import { Skeleton } from "@/components/ui/skeleton";
import { useApiQuery, qk } from "@/lib/query";
import { useSession } from "@/lib/session";
import { wrap } from "@/lib/api";
import { resolveIntegrationSlug } from "@/components/integrations/route-model";
import { descriptorById } from "@/components/integrations/registry";
import { hasArchetypeDetail } from "@/components/integrations/detail-model";

export default function IntegrationSlugPage() {
  const params = useParams<{ orgSlug: string; slug: string }>();
  const slug = params?.orgSlug ?? "";
  const segment = params?.slug ?? "";

  if (resolveIntegrationSlug(segment).kind === "connection") {
    return (
      <OrgScope slug={slug}>
        {(org) => (
          <LegacyConnectionRedirect orgId={org.id} orgSlug={slug} connectionId={segment} />
        )}
      </OrgScope>
    );
  }

  return (
    <OrgScope slug={slug}>
      {(org) => <ProviderRoute orgId={org.id} orgSlug={slug} providerId={segment} />}
    </OrgScope>
  );
}

/**
 * Dispatch the provider segment (saas-integrations-console IX2): a connected
 * provider whose archetype has a console detail body renders the new tabbed
 * detail page; everything else — connect flows (`?connect=1`/`?create=1`),
 * unconnected providers, unimplemented archetypes — stays on the generic
 * ProviderSpace, which owns those postures. The decision is a pure function of
 * the served descriptor + this org's connections (no per-provider branch).
 */
function ProviderRoute({
  orgId,
  orgSlug,
  providerId,
}: {
  orgId: string;
  orgSlug: string;
  providerId: string;
}) {
  const { client } = useSession();
  const searchParams = useSearchParams();
  const flowActive = searchParams?.has("connect") || searchParams?.has("create");

  const list = useApiQuery(qk.integrations(orgId), () =>
    wrap(async () => (await client.integrations.list(orgId)).connections),
  );
  const registry = useApiQuery(qk.integrationRegistry(orgId), () =>
    wrap(async () => (await client.integrations.getRegistry(orgId)).registry),
  );

  if (list.loading || registry.loading) {
    return (
      <Screen detail>
        <Skeleton className="h-9 w-40 rounded" />
        <Skeleton className="mt-6 h-[86px] w-full rounded-xl" />
        <Skeleton className="mt-6 h-[220px] w-full rounded-xl" />
      </Screen>
    );
  }

  const descriptor = descriptorById(registry.data, providerId);
  const connected = (list.data ?? []).some(
    (c) => c.provider === providerId && c.status !== "revoked",
  );
  const useDetail = !flowActive && connected && descriptor != null && hasArchetypeDetail(descriptor);

  return useDetail ? (
    <IntegrationDetail orgId={orgId} orgSlug={orgSlug} providerId={providerId} />
  ) : (
    <ProviderSpace orgId={orgId} orgSlug={orgSlug} providerId={providerId} />
  );
}

/** Legacy `/integrations/int_…` bookmarks: resolve the connection's provider
 *  and land on the nested detail route; unknown ids fall back to the hub
 *  (which renders its own honest state). Query params carry through. */
function LegacyConnectionRedirect({
  orgId,
  orgSlug,
  connectionId,
}: {
  orgId: string;
  orgSlug: string;
  connectionId: string;
}) {
  const { client } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const list = useApiQuery(qk.integrations(orgId), () =>
    wrap(async () => (await client.integrations.list(orgId)).connections),
  );

  React.useEffect(() => {
    if (!list.data && !list.error) return;
    const provider = list.data?.find((c) => c.id === connectionId)?.provider;
    const qs = searchParams?.toString();
    const suffix = qs ? `?${qs}` : "";
    router.replace(
      provider
        ? `/orgs/${orgSlug}/integrations/${provider}/connections/${connectionId}${suffix}`
        : `/orgs/${orgSlug}/integrations`,
    );
  }, [list.data, list.error, connectionId, orgSlug, router, searchParams]);

  return (
    <Screen>
      <div className="space-y-4 pt-2">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-[120px] w-full rounded-xl" />
      </div>
    </Screen>
  );
}
