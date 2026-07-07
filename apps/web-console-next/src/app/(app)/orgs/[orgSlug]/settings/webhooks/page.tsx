"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { Webhook, Plus } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { SettingsHeader } from "@/components/settings/settings-primitives";
import { ListCard, ListRow, StatusDot } from "@/components/ui/northwind";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";
import { CreateEndpointDialog } from "@/components/webhooks/create-endpoint-dialog";

export default function WebhooksListPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return (
    <OrgScope slug={slug}>
      {(org) => <Inner orgId={org.id} orgSlug={org.slug} />}
    </OrgScope>
  );
}

function Inner({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { client } = useSession();
  const router = useRouter();
  const endpoints = useApiQuery(qk.webhooks(orgId), () =>
    wrap(async () => (await client.webhooks.listEndpoints(orgId)).endpoints),
  );
  const [createOpen, setCreateOpen] = React.useState(false);

  const handleCreated = React.useCallback(
    (endpointId: string) => {
      router.push(`/orgs/${orgSlug}/settings/webhooks/${endpointId}`);
    },
    [router, orgSlug],
  );

  return (
    <div>
      <SettingsHeader
        title="Webhooks"
        description="Signed event deliveries to your endpoints."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" strokeWidth={1.8} />
            New endpoint
          </Button>
        }
      />

      <div className="mt-[18px]">
        {endpoints.loading ? (
          <Card>
            <CardContent className="space-y-2 pt-6">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </CardContent>
          </Card>
        ) : endpoints.error ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-destructive">{endpoints.error.code}</CardTitle>
              <CardDescription>{endpoints.error.message}</CardDescription>
            </CardHeader>
          </Card>
        ) : !endpoints.data || endpoints.data.length === 0 ? (
          <EmptyState
            icon={Webhook}
            title="No webhook endpoints"
            description="Create your first endpoint to start receiving signed event deliveries from this workspace."
            primaryAction={{ label: "Create endpoint", onClick: () => setCreateOpen(true) }}
          />
        ) : (
          <ListCard>
            {endpoints.data.map((ep) => {
              const active = ep.status === "active";
              return (
                <ListRow
                  key={ep.id}
                  href={`/orgs/${orgSlug}/settings/webhooks/${ep.id}`}
                >
                  <StatusDot tone={active ? "success" : "error"} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[12.5px] font-medium">
                      {ep.name ? (
                        <>
                          <span className="font-sans">{ep.name}</span>
                          <span className="text-muted-foreground"> · </span>
                          {ep.url}
                        </>
                      ) : (
                        ep.url
                      )}
                    </span>
                    <span className="mt-0.5 block text-[11.5px] text-muted-foreground">
                      secret v{ep.secretVersion} · rotated{" "}
                      {ep.secretLastRotatedAt
                        ? new Date(ep.secretLastRotatedAt).toLocaleDateString()
                        : "never"}
                    </span>
                  </span>
                  <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                    {active ? "active" : "disabled"}
                  </span>
                </ListRow>
              );
            })}
          </ListCard>
        )}
      </div>

      <CreateEndpointDialog
        orgId={orgId}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={handleCreated}
      />
    </div>
  );
}
