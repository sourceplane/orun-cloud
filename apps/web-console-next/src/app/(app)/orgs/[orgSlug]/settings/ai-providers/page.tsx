"use client";

// Settings › AI providers (saas-dispatch DX6): the canonical home for BYO
// provider keys + details — the same ProviderConnections surface the Agents
// tab and the Integrations hub render (three doors, one component, one API).
// Keys stay write-only with a …last4 hint; custody never changes here.

import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { SettingsHeader } from "@/components/settings/settings-primitives";
import { ProviderConnections } from "@/components/agents/provider-connections";

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
          <ProviderConnections orgId={org.id} />
        </div>
      )}
    </OrgScope>
  );
}
