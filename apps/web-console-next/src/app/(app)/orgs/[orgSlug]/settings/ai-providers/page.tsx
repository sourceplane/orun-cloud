"use client";

// Settings › AI providers (saas-dispatch DX6): the canonical home for BYO
// provider keys + details — the same ProviderConnections surface the Agents
// tab and the Integrations hub render (three doors, one component, one API).
// Keys stay write-only with a …last4 hint; custody never changes here.

import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { SettingsHeader } from "@/components/settings/settings-primitives";
import { ProviderConnections } from "@/components/agents/provider-connections";
import { DispatchModelSetting } from "@/components/dispatch/dispatch-model-setting";

export default function SettingsAiProvidersPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return (
    <OrgScope slug={slug}>
      {(org) => (
        <div className="grid gap-6">
          <SettingsHeader
            title="AI providers"
            description="Model and sandbox credentials for agent sessions and the Workspace Agent — Anthropic, OpenAI, OpenRouter keys and your Daytona compute account. Keys are stored write-only in the workspace secret manager."
          />
          <DispatchModelSetting orgId={org.id} />
          <div className="grid gap-3">
            <div>
              <h3 className="text-[13.5px] font-semibold">Connections</h3>
              <p className="mt-0.5 text-[12.5px] text-muted-foreground">
                Your connected provider keys. Model providers power dispatch and agent sessions; Daytona provides sandbox compute.
              </p>
            </div>
            <ProviderConnections orgId={org.id} />
          </div>
        </div>
      )}
    </OrgScope>
  );
}
