"use client";

// The Dispatch surface (saas-dispatch DX2) — the two-pane command surface:
// the Workspace Agent threads on the left (the command line), the live
// Situation rail on the right (Ready · In flight · Waiting on you · Budget).
// Snapshot-first: the shell paints immediately; the fold hydrates into it;
// the DX1 socket pushes invalidations so the rail is fresh without a hot
// poll. Mobile stacks command-first (DX-Q4).

import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { WorkspaceChatList } from "@/components/agents/workspace-chat";
import { SituationRail } from "@/components/dispatch/situation-rail";
import { useSituation } from "@/lib/dispatch/use-situation";

function DispatchSurface({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const live = useSituation(orgId);
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="min-w-0">
        <WorkspaceChatList orgId={orgId} orgSlug={orgSlug} />
      </div>
      <aside className="min-w-0">
        <SituationRail
          orgId={orgId}
          orgSlug={orgSlug}
          situation={live.situation}
          loading={live.loading}
          transport={live.transport}
          reload={live.reload}
        />
      </aside>
    </div>
  );
}

export default function DispatchPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <DispatchSurface orgId={org.id} orgSlug={slug} />}</OrgScope>;
}
