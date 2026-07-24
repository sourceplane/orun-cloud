"use client";

/**
 * ProviderRoute (saas-integrations-console IX5) — the shared dispatcher for the
 * integration routes. A connected provider whose archetype has a console detail
 * body renders the tabbed IntegrationDetail; everything else — connect flows
 * (`?connect=1`/`?create=1`), unconnected providers, unimplemented archetypes —
 * stays on the generic ProviderSpace, which owns those postures. Pure function
 * of the served descriptor + this org's connections (no per-provider branch).
 *
 * Used by both `/integrations/{provider}` and the nested
 * `/integrations/{provider}/connections/{connectionId}` route (the latter passes
 * `focusConnectionId` so a specific connection deep-links into its detail).
 */

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { Screen } from "@/components/ui/northwind";
import { Skeleton } from "@/components/ui/skeleton";
import { useApiQuery, qk } from "@/lib/query";
import { useSession } from "@/lib/session";
import { wrap } from "@/lib/api";
import { ProviderSpace } from "@/components/integrations/provider-space";
import { IntegrationDetail } from "@/components/integrations/detail/integration-detail";
import { descriptorById } from "@/components/integrations/registry";
import { hasArchetypeDetail } from "@/components/integrations/detail-model";

export function ProviderRoute({
  orgId,
  orgSlug,
  providerId,
  focusConnectionId,
}: {
  orgId: string;
  orgSlug: string;
  providerId: string;
  focusConnectionId?: string;
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
  const connections = list.data ?? [];
  // "connected" means the target row exists (a specific connection when focused,
  // else any live row for the provider).
  const connected = focusConnectionId
    ? connections.some((c) => c.id === focusConnectionId && c.status !== "revoked")
    : connections.some((c) => c.provider === providerId && c.status !== "revoked");
  const useDetail = !flowActive && connected && descriptor != null && hasArchetypeDetail(descriptor);

  return useDetail ? (
    <IntegrationDetail
      orgId={orgId}
      orgSlug={orgSlug}
      providerId={providerId}
      {...(focusConnectionId ? { focusConnectionId } : {})}
    />
  ) : (
    <ProviderSpace
      orgId={orgId}
      orgSlug={orgSlug}
      providerId={providerId}
      {...(focusConnectionId ? { focusConnectionId } : {})}
    />
  );
}
