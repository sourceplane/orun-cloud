"use client";

import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { DispatchSurface } from "@/components/dispatch/dispatch-surface";
import { WorkspaceOverview } from "@/components/overview/workspace-overview";
import { readLanding } from "@/lib/dispatch/landing";

/**
 * The Workspace landing (saas-dispatch DX3): the org root renders the
 * DISPATCH by default — you land where intent is spoken and everything
 * pending is visible — with the Overview one preference away (demoted to
 * /overview, content unchanged). The landing choice reads synchronously
 * (never blocks on a server round-trip: the snapshot-first budget applies
 * to the front door most of all).
 */
export default function OrgLandingPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  const landing = readLanding(typeof window === "undefined" ? null : window.localStorage, slug);
  return (
    <OrgScope slug={slug}>
      {(org) =>
        landing === "overview" ? (
          <WorkspaceOverview orgId={org.id} orgSlug={org.slug} />
        ) : (
          <DispatchSurface orgId={org.id} orgSlug={slug} />
        )
      }
    </OrgScope>
  );
}
