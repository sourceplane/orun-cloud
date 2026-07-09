"use client";

// Agent-session detail (saas-agents AG7).

import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { SessionDetail } from "@/components/agents/session-detail";

export default function AgentSessionPage() {
  const params = useParams<{ orgSlug: string; sessionId: string }>();
  const slug = params?.orgSlug ?? "";
  const sessionId = params?.sessionId ?? "";
  return (
    <OrgScope slug={slug}>
      {(org) => <SessionDetail orgId={org.id} orgSlug={slug} sessionId={sessionId} />}
    </OrgScope>
  );
}
