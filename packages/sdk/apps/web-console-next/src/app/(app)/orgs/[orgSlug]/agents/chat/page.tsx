"use client";

// The Workspace Agent thread list (saas-agents-native AN4).

import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { WorkspaceChatList } from "@/components/agents/workspace-chat";

export default function WorkspaceChatListPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <WorkspaceChatList orgId={org.id} orgSlug={slug} />}</OrgScope>;
}
