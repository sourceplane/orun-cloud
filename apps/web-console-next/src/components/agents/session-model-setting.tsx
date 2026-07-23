"use client";

// Session model selector (DX-Q6 on the session path): choose which verified
// model connection AGENT SESSIONS boot with — the key provision injects into
// the sandbox at exec time. Persisted as the org setting
// `agents.sessions.connection` (the connection's public id, or empty for
// "auto: sole or default"), read by agents-worker at provision time.
// Anthropic connections ride natively (ANTHROPIC_API_KEY); OpenAI/OpenRouter
// connections need an Anthropic-compatible Base URL — the claude-code
// harness gateway convention. Thin wrapper over ModelConnectionSetting.

import { Bot } from "lucide-react";
import { ModelConnectionSetting } from "@/components/settings/model-connection-setting";
import { PROVIDER_META, SESSION_MODEL_SETTING_KEY, connectionSessionReady } from "@/lib/agents/model";

export function SessionModelSetting({ orgId }: { orgId: string }) {
  return (
    <ModelConnectionSetting
      orgId={orgId}
      settingKey={SESSION_MODEL_SETTING_KEY}
      title="Agent session model"
      description="The provider key your sandbox agent sessions boot with — injected at spawn, never stored on the session. Pick a connected provider below, or let the spawn pick automatically."
      icon={Bot}
      savedToast="Session model updated"
      saveErrorToast="Could not save the session model"
      savedHint="Saved to your workspace and used on the next spawn."
      ready={connectionSessionReady}
      notReadyLabel="Needs Base URL"
      notReadyHint={(c) =>
        `${PROVIDER_META[c.provider as keyof typeof PROVIDER_META]?.name ?? c.provider} connections power sessions through an Anthropic-compatible gateway: reconnect it below with a Base URL (and a default model), or select an Anthropic connection.`
      }
    />
  );
}
