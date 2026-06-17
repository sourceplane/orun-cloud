"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { useSession } from "@/lib/session";
import { wrap } from "@/lib/api";
import { useApiQuery, qk } from "@/lib/query";
import { readLastOrgSlug } from "@/lib/last-org";
import { resolveEffectiveOrgSlug } from "@/lib/effective-org";

/**
 * The org the always-visible chrome should treat as current: the URL's org when
 * present, else the remembered last-used org, else the account default (see
 * `resolveEffectiveOrgSlug`). Backed by the shared `orgs` query (PERF11), so it
 * paints from cache and adds no request — the mobile bottom tabs and topbar
 * scope crumb always have a concrete org to point at without the operator having
 * to re-select one on org-less routes.
 */
export function useEffectiveOrgSlug(): string | null {
  const params = useParams<{ orgSlug?: string }>();
  const urlSlug = params?.orgSlug ?? null;
  const { client, token } = useSession();
  const orgs =
    useApiQuery(
      qk.orgs(),
      () => wrap(async () => (await client.organizations.list()).organizations),
      { enabled: !!token },
    ).data ?? null;

  // localStorage isn't reactive, so `readLastOrgSlug()` is read on each render
  // and folded into the memo via the URL scope + org list — both of which change
  // exactly when the resolution could change (navigation / list load).
  return React.useMemo(
    () => resolveEffectiveOrgSlug({ urlSlug, lastOrgSlug: readLastOrgSlug(), orgs }),
    [urlSlug, orgs],
  );
}
