"use client";

// The org-global Activities surface (run feed). A thin route wrapper around the
// shared workbench, mirroring the catalog route. Selection (repo / environment /
// source / status) lives at the top of the workbench, not in the sidebar.

import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { ActivityWorkbench } from "@/components/activity/activity-workbench";

export default function ActivitiesPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <ActivityWorkbench orgId={org.id} orgSlug={slug} />}</OrgScope>;
}
