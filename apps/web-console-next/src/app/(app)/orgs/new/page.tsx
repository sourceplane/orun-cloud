"use client";

import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { pickAccountBillingOrg } from "@/components/billing/account-org";
import { CreateOrgFlow } from "@/components/orgs/create-org-flow";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";

/**
 * Guided create-organization flow. Whether this is the account's first
 * (parent) organization or an additional (child) one decides which steps the
 * wizard shows, so the page resolves the org list before mounting the flow.
 */
export default function NewOrgPage() {
  const { client } = useSession();
  const orgs = useApiQuery(qk.orgs(), () =>
    wrap(async () => (await client.organizations.list()).organizations),
  );

  if (orgs.loading) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <Skeleton className="h-4 w-28" />
        <div className="space-y-2">
          <Skeleton className="h-7 w-72 max-w-full" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <div className="flex gap-10 pt-2">
          <div className="hidden w-56 shrink-0 space-y-8 md:block">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
          <Skeleton className="h-72 flex-1 rounded-lg" />
        </div>
      </div>
    );
  }

  if (orgs.error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-destructive">Failed to load your account</CardTitle>
          <CardDescription>{orgs.error.message}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const list = orgs.data ?? [];
  return (
    <CreateOrgFlow
      mode={list.length === 0 ? "parent" : "child"}
      billingParent={pickAccountBillingOrg(list)}
    />
  );
}
