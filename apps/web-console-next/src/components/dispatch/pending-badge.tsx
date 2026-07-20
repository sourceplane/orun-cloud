"use client";

// The ambient pending badge (saas-dispatch DX4): the needs-you numeral on
// the Dispatch home row, sourced from the DX1 shell — viewer-agnostic
// aggregate counts, one cheap GET, zero authorized content in chrome.

import { Pill } from "@/components/ui/northwind";
import { pendingBadgeCount } from "@/lib/dispatch/brief";
import { wrap } from "@/lib/api";
import { qk, useApiQuery } from "@/lib/query";
import { useSession } from "@/lib/session";
import { useOrgBySlug } from "@/lib/use-org";

export function DispatchPendingBadge({ orgSlug }: { orgSlug: string }) {
  const { client } = useSession();
  const { org } = useOrgBySlug(orgSlug);
  const shell = useApiQuery(
    qk.orgDispatchShell(org?.id ?? ""),
    () => wrap(async () => client.dispatch.shell(org!.id)),
    { enabled: !!org },
  );
  const count = pendingBadgeCount(shell.data?.counts);
  if (count === 0) return null;
  return <Pill tone="warning">{count}</Pill>;
}
