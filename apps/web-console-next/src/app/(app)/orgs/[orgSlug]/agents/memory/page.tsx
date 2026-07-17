"use client";

// The workspace memory page (saas-agents-native AN6).

import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { WorkspaceMemoryPage } from "@/components/agents/workspace-memory";

export default function AgentsMemoryPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <WorkspaceMemoryPage orgId={org.id} orgSlug={slug} />}</OrgScope>;
}
