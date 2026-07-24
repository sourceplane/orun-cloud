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
import { Screen } from "@/components/ui/northwind";
import { Skeleton } from "@/components/ui/skeleton";
import { useApiQuery, qk } from "@/lib/query";
import { useSession } from "@/lib/session";
import { wrap } from "@/lib/api";
import { resolveIntegrationSlug } from "@/components/integrations/route-model";
import { ProviderRoute } from "@/components/integrations/detail/provider-route";

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
