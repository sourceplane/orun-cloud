"use client";

// The org-level Agents surface (saas-agents AG7). A thin route wrapper
// around the workbench component.

import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { AgentsWorkbench } from "@/components/agents/agents-workbench";

export default function AgentsPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <AgentsWorkbench orgId={org.id} orgSlug={slug} />}</OrgScope>;
}
