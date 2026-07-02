"use client";

import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { WorkspaceOverview } from "@/components/overview/workspace-overview";

/**
 * The Workspace landing is the Overview (saas-workspace-overview WO2): the org
 * root renders it instead of redirecting to Git Repos, so the shortest,
 * most-linked URL answers "what is this Workspace, is it healthy, what next?".
 */
export default function OrgOverviewPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <WorkspaceOverview orgId={org.id} orgSlug={org.slug} />}</OrgScope>;
}
