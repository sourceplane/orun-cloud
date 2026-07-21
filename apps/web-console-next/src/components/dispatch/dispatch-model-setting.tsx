"use client";

// Dispatch model selector (saas-dispatch DX-Q6): choose which verified model
// connection the Workspace Agent (dispatch chat) uses — Anthropic, OpenAI, or
// OpenRouter. Persisted as the org setting `agents.chat.connection` (the
// connection's public id, or empty for "auto: sole or default"), read by
// chat-worker at turn time. Sits under Settings › AI providers, right where
// the keys are connected.
//
// The panel is a live mirror of what dispatch will actually do: it resolves the
// SAME rule chat-worker's custody uses (pickDispatchConnection) and shows the
// concrete provider + model + verification, including what "Auto" maps to — so
// "which model is my chat using?" is answerable at a glance.

import * as React from "react";
import type { ProviderConnection } from "@saas/contracts/agents";
import { Check, TriangleAlert, Cpu } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Pill, StatusDot } from "@/components/ui/northwind";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import { qk, useApiQuery } from "@/lib/query";
import { useSession } from "@/lib/session";
import {
  PROVIDER_META,
  MODEL_PROVIDER_SET,
  connectionModel,
  connectionReady,
  pickDispatchConnection,
} from "@/lib/agents/model";
import { cn } from "@/lib/cn";

const SETTING_KEY = "agents.chat.connection";
const AUTO = "__auto__";

/** One line describing a connection: provider badge · name · model. Reused in
 * the trigger and the option rows so the selector reads consistently. */
function ConnLine({ c, muted }: { c: ProviderConnection; muted?: boolean }) {
  const meta = PROVIDER_META[c.provider as keyof typeof PROVIDER_META];
  const model = connectionModel(c);
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 truncate">
        <span className={cn("font-medium", muted && "text-muted-foreground")}>{meta?.name ?? c.provider}</span>
        <span className="text-muted-foreground"> · {c.name}</span>
        {model ? <span className="text-muted-foreground"> · </span> : null}
        {model ? <span className="font-mono text-[12px]">{model}</span> : null}
      </span>
    </span>
  );
}

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

  // What dispatch will ACTUALLY use, by the same rule chat-worker applies.
  const preferredId = current === AUTO ? null : current;
  const active = pickDispatchConnection(modelConns, preferredId);
  const isAuto = current === AUTO;
  const ready = active ? connectionReady(active) : false;

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

  if (providers.loading && !providers.data) return <Skeleton className="h-40 w-full rounded-xl" />;

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-start gap-3 px-5 pb-4 pt-4">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-secondary text-foreground/70">
          <Cpu className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold">Dispatch model</h3>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
            The model that powers your Workspace Agent chat. Pick a connected provider below — or let dispatch pick
            automatically.
          </p>
        </div>
      </div>

      {/* Active-model summary — the honest "what's running right now" line. */}
      <div className="border-t border-border/50 px-5 py-4">
        {modelConns.length === 0 ? (
          <div className="flex items-center gap-2.5 rounded-lg border border-warning-accent/40 bg-warning-wash px-3.5 py-3 text-[12.5px] text-[#7A6C4E] dark:text-warning">
            <TriangleAlert className="h-4 w-4 shrink-0" />
            <span>No verified model provider yet. Connect an Anthropic, OpenAI, or OpenRouter key below, then choose it here.</span>
          </div>
        ) : (
          <div className="grid gap-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-muted-foreground/85">
                Active model
              </span>
              {active && ready ? (
                <Pill tone="success" dot>
                  Verified
                </Pill>
              ) : active && !ready ? (
                <Pill tone="warning" dot>
                  No model set
                </Pill>
              ) : (
                <Pill tone="warning" dot>
                  Not resolved
                </Pill>
              )}
            </div>

            {active ? (
              <div
                className={cn(
                  "flex items-center gap-3 rounded-lg border px-3.5 py-3",
                  ready ? "border-border bg-[#FCFCFC] dark:bg-secondary/40" : "border-warning-accent/40 bg-warning-wash",
                )}
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-secondary font-mono text-[13px] font-semibold text-foreground/70">
                  {(PROVIDER_META[active.provider as keyof typeof PROVIDER_META]?.name ?? active.provider).slice(0, 2)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium">
                    {connectionModel(active) || PROVIDER_META[active.provider as keyof typeof PROVIDER_META]?.name || active.provider}
                  </div>
                  <div className="mt-0.5 truncate text-[12px] text-muted-foreground">
                    {PROVIDER_META[active.provider as keyof typeof PROVIDER_META]?.name ?? active.provider}
                    {" · "}
                    {active.name}
                    {isAuto ? " · chosen automatically" : ""}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2.5 rounded-lg border border-warning-accent/40 bg-warning-wash px-3.5 py-3 text-[12.5px] text-[#7A6C4E] dark:text-warning">
                <TriangleAlert className="h-4 w-4 shrink-0" />
                <span>
                  {modelConns.length > 1
                    ? "More than one provider is connected and none is named “default”. Pick one below."
                    : "No provider resolves. Pick one below."}
                </span>
              </div>
            )}

            {active && !ready ? (
              <p className="text-[12px] leading-relaxed text-[#7A6C4E] dark:text-warning">
                {PROVIDER_META[active.provider as keyof typeof PROVIDER_META]?.name ?? active.provider} has no default
                model set, so dispatch can’t route chat. Reconnect it below with a model id.
              </p>
            ) : null}

            {/* The picker. */}
            <div className="grid gap-1.5">
              <Select value={current} onValueChange={(v) => void choose(v)} disabled={busy}>
                <SelectTrigger className="h-auto py-2">
                  <span className="flex min-w-0 items-center gap-2 text-[13px]">
                    {isAuto ? (
                      <span className="rounded bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                        Auto
                      </span>
                    ) : null}
                    {isAuto && !active ? (
                      <span className="text-muted-foreground">Sole or “default” connection</span>
                    ) : current === AUTO && active ? (
                      <ConnLine c={active} muted />
                    ) : (
                      (() => {
                        const c = modelConns.find((x) => x.id === current);
                        return c ? <ConnLine c={c} /> : <span className="text-muted-foreground">Select a model</span>;
                      })()
                    )}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AUTO}>
                    <span className="flex flex-col">
                      <span>Auto</span>
                      <span className="text-[11.5px] text-muted-foreground">The sole connection, or the one named “default”</span>
                    </span>
                  </SelectItem>
                  {modelConns.map((c) => {
                    const ok = connectionReady(c);
                    return (
                      <SelectItem key={c.id} value={c.id}>
                        <span className="flex items-center gap-2">
                          <StatusDot tone={ok ? "success" : "warning"} />
                          <ConnLine c={c} />
                          {!ok ? <span className="text-[11px] text-warning">no model</span> : null}
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              <p className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                <Check className="h-3 w-3" />
                Saved to your workspace and used on the next chat turn.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
