"use client";

// The Activity tab's merged timeline (saas-integrations-console IX5 polish).
// One newest-first timeline of colored-dot events, merging the connection's mint
// ledger + inbound delivery log — the mockup's Activity form. Reuses the existing
// reads (listMintedCredentials + listDeliveries); no new backend, no values.

import * as React from "react";
import type { PublicConnection } from "@saas/contracts/integrations";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/northwind";
import { wrap } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { mergeActivity, relativeTime } from "@/components/integrations/activity-model";

export function ConnectionActivity({
  orgId,
  connection,
}: {
  orgId: string;
  connection: PublicConnection;
}) {
  const { client } = useSession();
  const mints = useApiQuery(qk.mintedCredentials(orgId, connection.id), () =>
    wrap(async () => (await client.integrations.listMintedCredentials(orgId, connection.id)).mints),
  );
  const deliveries = useApiQuery(qk.inboundDeliveries(orgId, connection.id), () =>
    wrap(async () => (await client.integrations.listDeliveries(orgId, connection.id)).deliveries),
  );

  const loading = mints.loading || deliveries.loading;
  const events = React.useMemo(
    () => mergeActivity(mints.data, deliveries.data),
    [mints.data, deliveries.data],
  );

  if (loading) return <Skeleton className="h-[220px] w-full rounded-xl" />;

  if (events.length === 0) {
    return (
      <div className="rounded-xl border border-dashed px-6 py-8 text-center text-[13px] text-muted-foreground">
        No activity yet. Minted credentials and delivered events land here — never the values.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      {events.map((e, i) => (
        <div key={e.id} className={cn("flex items-center gap-3 px-5 py-3.5", i > 0 && "border-t border-border/50")}>
          <StatusDot tone={e.tone} className="h-2 w-2" />
          <span className="text-[13.5px]">{e.title}</span>
          {e.detail ? <span className="truncate font-mono text-[12px] text-muted-foreground">{e.detail}</span> : null}
          <span className="ml-auto shrink-0 text-[12px] text-muted-foreground">{relativeTime(e.at)}</span>
        </div>
      ))}
    </div>
  );
}
