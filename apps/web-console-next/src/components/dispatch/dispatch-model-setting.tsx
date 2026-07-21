"use client";

// Dispatch model selector (saas-dispatch DX-Q6): choose which verified model
// connection the Workspace Agent (dispatch chat) uses — Anthropic, OpenAI, or
// OpenRouter. Persisted as the org setting `agents.chat.connection` (the
// connection's public id, or empty for "auto: sole or default"), read by
// chat-worker at turn time. Sits under Settings › AI providers, right where
// the keys are connected.

import * as React from "react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusText } from "@/components/ui/northwind";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import { qk, useApiQuery } from "@/lib/query";
import { useSession } from "@/lib/session";
import { PROVIDER_META, MODEL_PROVIDER_SET } from "@/lib/agents/model";

const SETTING_KEY = "agents.chat.connection";
const AUTO = "__auto__";

export function DispatchModelSetting({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const scope = React.useMemo(() => ({ kind: "organization" as const, orgId }), [orgId]);

  const providers = useApiQuery(qk.orgAgentProviders(orgId), () => wrap(async () => client.agents.listProviders(orgId)));
  const settings = useApiQuery(qk.configSettings(`org:${orgId}`), () => wrap(async () => client.config.listSettings(scope)));

  const [busy, setBusy] = React.useState(false);

  const modelConns = (providers.data ?? []).filter(
    (c) => MODEL_PROVIDER_SET.has(c.provider) && c.status === "verified",
  );
  const existing = (settings.data?.settings ?? []).find((s) => s.key === SETTING_KEY);
  const current = typeof existing?.value === "string" && existing.value ? existing.value : AUTO;

  async function choose(value: string) {
    const stored = value === AUTO ? "" : value;
    setBusy(true);
    const res = await wrap(async () => {
      if (existing) return client.config.updateSetting(scope, existing.id, { value: stored });
      return client.config.createSetting(scope, { key: SETTING_KEY, value: stored });
    });
    setBusy(false);
    if (res.ok) {
      toast({ kind: "success", title: "Dispatch model updated" });
      settings.reload();
    } else {
      toast({ kind: "error", title: "Could not save the dispatch model", description: res.error.message });
    }
  }

  if (providers.loading && !providers.data) return <Skeleton className="h-20 w-full rounded-xl" />;

  return (
    <div className="grid gap-2 rounded-xl border border-border/60 p-4">
      <div>
        <h3 className="text-[13.5px] font-semibold">Dispatch model</h3>
        <p className="mt-0.5 text-[12px] text-muted-foreground">
          Which connected provider the Workspace Agent chat uses. OpenAI and OpenRouter need a Default model set on
          the connection.
        </p>
      </div>
      {modelConns.length === 0 ? (
        <StatusText tone="warning" className="text-[12px]">
          No verified model provider yet — connect an Anthropic, OpenAI, or OpenRouter key above, then pick it here.
        </StatusText>
      ) : (
        <div className="grid max-w-md gap-1.5">
          <Label className="sr-only">Dispatch model</Label>
          <Select value={current} onValueChange={(v) => void choose(v)} disabled={busy}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTO}>Auto — the sole connection, or the one named “default”</SelectItem>
              {modelConns.map((c) => {
                const meta = PROVIDER_META[c.provider as keyof typeof PROVIDER_META];
                const model = typeof c.config?.defaultModel === "string" ? c.config.defaultModel : "";
                return (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} · {meta?.name ?? c.provider}
                    {model ? ` · ${model}` : ""}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}
