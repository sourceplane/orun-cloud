"use client";

// The shared model-connection selector (saas-dispatch DX-Q6, generalized):
// one component, two settings — which verified model connection powers the
// Workspace Agent chat (`agents.chat.connection`) and which one agent
// sessions boot with (`agents.sessions.connection`). Persisted as an org
// setting holding the connection's public id, or empty for "auto: sole or
// default" — the exact rule the reading worker applies, mirrored here so the
// panel shows what will ACTUALLY run, not just what's stored.

import * as React from "react";
import type { ProviderConnection } from "@saas/contracts/agents";
import { Check, TriangleAlert, type LucideIcon } from "lucide-react";
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
  pickDispatchConnection,
} from "@/lib/agents/model";
import { cn } from "@/lib/cn";

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

export interface ModelConnectionSettingProps {
  orgId: string;
  /** The org setting persisted (`agents.chat.connection` / `agents.sessions.connection`). */
  settingKey: string;
  title: string;
  description: string;
  icon: LucideIcon;
  savedToast: string;
  saveErrorToast: string;
  savedHint: string;
  /** Whether a verified connection can actually route THIS consumer. */
  ready(c: ProviderConnection): boolean;
  /** Why a not-ready connection is a dead end (actionable, one line). */
  notReadyHint(c: ProviderConnection): string;
  /** The short pill label on a not-ready active connection. */
  notReadyLabel: string;
}

export function ModelConnectionSetting({
  orgId,
  settingKey,
  title,
  description,
  icon: Icon,
  savedToast,
  saveErrorToast,
  savedHint,
  ready,
  notReadyHint,
  notReadyLabel,
}: ModelConnectionSettingProps) {
  const { client } = useSession();
  const { toast } = useToast();
  const scope = React.useMemo(() => ({ kind: "organization" as const, orgId }), [orgId]);

  const providers = useApiQuery(qk.orgAgentProviders(orgId), () => wrap(async () => client.agents.listProviders(orgId)));
  const settings = useApiQuery(qk.configSettings(`org:${orgId}`), () => wrap(async () => client.config.listSettings(scope)));

  const [busy, setBusy] = React.useState(false);

  const modelConns = (providers.data ?? []).filter(
    (c) => MODEL_PROVIDER_SET.has(c.provider) && c.status === "verified",
  );
  const existing = (settings.data?.settings ?? []).find((s) => s.key === settingKey);
  const current = typeof existing?.value === "string" && existing.value ? existing.value : AUTO;

  // What the consumer will ACTUALLY use, by the same rule the worker applies.
  const preferredId = current === AUTO ? null : current;
  const active = pickDispatchConnection(modelConns, preferredId);
  const isAuto = current === AUTO;
  const activeReady = active ? ready(active) : false;

  async function choose(value: string) {
    const stored = value === AUTO ? "" : value;
    setBusy(true);
    const res = await wrap(async () => {
      if (existing) return client.config.updateSetting(scope, existing.id, { value: stored });
      return client.config.createSetting(scope, { key: settingKey, value: stored });
    });
    setBusy(false);
    if (res.ok) {
      toast({ kind: "success", title: savedToast });
      settings.reload();
    } else {
      toast({ kind: "error", title: saveErrorToast, description: res.error.message });
    }
  }

  if (providers.loading && !providers.data) return <Skeleton className="h-40 w-full rounded-xl" />;

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-start gap-3 px-5 pb-4 pt-4">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-secondary text-foreground/70">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold">{title}</h3>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">{description}</p>
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
              {active && activeReady ? (
                <Pill tone="success" dot>
                  Verified
                </Pill>
              ) : active && !activeReady ? (
                <Pill tone="warning" dot>
                  {notReadyLabel}
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
                  activeReady ? "border-border bg-[#FCFCFC] dark:bg-secondary/40" : "border-warning-accent/40 bg-warning-wash",
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

            {active && !activeReady ? (
              <p className="text-[12px] leading-relaxed text-[#7A6C4E] dark:text-warning">{notReadyHint(active)}</p>
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
                    const ok = ready(c);
                    return (
                      <SelectItem key={c.id} value={c.id}>
                        <span className="flex items-center gap-2">
                          <StatusDot tone={ok ? "success" : "warning"} />
                          <ConnLine c={c} />
                          {!ok ? <span className="text-[11px] text-warning">{notReadyLabel.toLowerCase()}</span> : null}
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              <p className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                <Check className="h-3 w-3" />
                {savedHint}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
