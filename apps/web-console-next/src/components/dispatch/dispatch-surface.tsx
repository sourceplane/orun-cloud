"use client";

// The Dispatch surface (saas-dispatch DX2/DX3) — the two-pane command
// surface, extracted so the org ROOT can render it as the landing (DX3)
// without a redirect hop: the Workspace Agent threads on the left, the live
// Situation rail on the right. Mobile stacks command-first (DX-Q4).

import { WorkspaceChatList } from "@/components/agents/workspace-chat";
import { BriefCard } from "@/components/dispatch/brief-card";
import { SituationRail } from "@/components/dispatch/situation-rail";
import { useSituation } from "@/lib/dispatch/use-situation";

export function DispatchSurface({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const live = useSituation(orgId);
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="min-w-0 space-y-4">
        <BriefCard orgSlug={orgSlug} situation={live.situation} />
        <WorkspaceChatList orgId={orgId} orgSlug={orgSlug} />
      </div>
      <aside className="min-w-0">
        <SituationRail
          orgId={orgId}
          orgSlug={orgSlug}
          situation={live.situation}
          loading={live.loading}
          error={live.error}
          transport={live.transport}
          reload={live.reload}
        />
      </aside>
    </div>
  );
}
