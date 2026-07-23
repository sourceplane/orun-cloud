"use client";

// Settings › AI providers (saas-dispatch DX6 → saas-integration-registry IR5):
// the model/dispatch/copilot SETTINGS stay here; the provider-key CONNECTIONS
// moved to the unified Integrations hub (`/orgs/{slug}/integrations`), where
// AI & compute providers now render as registry cards with their own spaces.
// This page keeps every shipped setting reachable and points at the new home
// for keys — the `settings/integrations` redirect-stub precedent, softened so
// the settings themselves don't lose their door.

import Link from "next/link";
import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { SettingsHeader } from "@/components/settings/settings-primitives";
import { SessionModelSetting } from "@/components/agents/session-model-setting";
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
            description="Model selection for agent sessions, dispatch, and the Workspace Agent copilot."
          />
          <SessionModelSetting orgId={org.id} />
          <DispatchModelSetting orgId={org.id} />
          <div className="rounded-xl border bg-card px-5 py-4">
            <h3 className="text-[13.5px] font-semibold">Copilot cockpit</h3>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              The dispatch chat and agent sessions render through the copilot cockpit — streaming
              markdown, tool cards, agent actions, and a live session lens. This is the standard
              experience for every workspace; the classic surfaces have been retired.
            </p>
          </div>
          <div className="rounded-xl border bg-card px-5 py-4">
            <h3 className="text-[13.5px] font-semibold">Provider connections moved</h3>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              Anthropic, OpenAI, OpenRouter, and Daytona keys are now connected from the{" "}
              <Link href={`/orgs/${slug}/integrations`} className="underline underline-offset-2">
                Integrations hub
              </Link>{" "}
              like every other integration. Keys remain stored write-only in the workspace secret
              manager; existing connections carried over unchanged.
            </p>
          </div>
        </div>
      )}
    </OrgScope>
  );
}
