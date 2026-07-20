"use client";

import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { WorkspaceOverview } from "@/components/overview/workspace-overview";
import { LandingToggle } from "@/components/dispatch/landing-toggle";

/**
 * The Workspace Overview (saas-workspace-overview WO2), demoted from the
 * landing to a first-class metrics view by saas-dispatch DX3 — content
 * unchanged, one rail row away, and it can reclaim the landing via the
 * preference toggle below.
 */
export default function OrgOverviewPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return (
    <OrgScope slug={slug}>
      {(org) => (
        <div className="grid gap-4">
          <div className="flex justify-end">
            <LandingToggle orgSlug={slug} />
          </div>
          <WorkspaceOverview orgId={org.id} orgSlug={org.slug} />
        </div>
      )}
    </OrgScope>
  );
}
