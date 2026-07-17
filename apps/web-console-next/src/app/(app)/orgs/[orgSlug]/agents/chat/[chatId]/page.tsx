"use client";

// One Workspace Agent thread (saas-agents-native AN4).

import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { WorkspaceChatThread } from "@/components/agents/workspace-chat";

export default function WorkspaceChatThreadPage() {
  const params = useParams<{ orgSlug: string; chatId: string }>();
  const slug = params?.orgSlug ?? "";
  const chatId = params?.chatId ?? "";
  return (
    <OrgScope slug={slug}>
      {(org) => <WorkspaceChatThread orgId={org.id} orgSlug={slug} chatId={chatId} />}
    </OrgScope>
  );
}
