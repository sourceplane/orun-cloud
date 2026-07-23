"use client";

// Dispatch model selector (saas-dispatch DX-Q6): choose which verified model
// connection the Workspace Agent (dispatch chat) uses — Anthropic, OpenAI, or
// OpenRouter. Persisted as the org setting `agents.chat.connection` (the
// connection's public id, or empty for "auto: sole or default"), read by
// chat-worker at turn time. Sits under Settings › AI providers, right where
// the keys are connected. Thin wrapper over the shared ModelConnectionSetting.

import { Cpu } from "lucide-react";
import { ModelConnectionSetting } from "@/components/settings/model-connection-setting";
import { DISPATCH_MODEL_SETTING_KEY, PROVIDER_META, connectionReady } from "@/lib/agents/model";

export function DispatchModelSetting({ orgId }: { orgId: string }) {
  return (
    <ModelConnectionSetting
      orgId={orgId}
      settingKey={DISPATCH_MODEL_SETTING_KEY}
      title="Dispatch model"
      description="The model that powers your Workspace Agent chat. Pick a connected provider below — or let dispatch pick automatically."
      icon={Cpu}
      savedToast="Dispatch model updated"
      saveErrorToast="Could not save the dispatch model"
      savedHint="Saved to your workspace and used on the next chat turn."
      ready={connectionReady}
      notReadyLabel="No model set"
      notReadyHint={(c) =>
        `${PROVIDER_META[c.provider as keyof typeof PROVIDER_META]?.name ?? c.provider} has no default model set, so dispatch can’t route chat. Reconnect it below with a model id.`
      }
    />
  );
}
