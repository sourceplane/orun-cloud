"use client";

// The copilot surface toggle (saas-copilot-surface CX6, lock 7): the
// self-serve face of the `dispatch.copilot` org setting. On = the copilot
// thread + session lens render; off = the native surfaces, byte-identical.
// The setting is the kill switch — this panel is just its handle.

import * as React from "react";
import { Sparkles } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Pill } from "@/components/ui/northwind";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import { qk, useApiQuery } from "@/lib/query";
import { useSession } from "@/lib/session";
import { COPILOT_FLAG_KEY, parseCopilotFlag } from "./flag";

export function CopilotToggle({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const scope = React.useMemo(() => ({ kind: "organization" as const, orgId }), [orgId]);
  const settings = useApiQuery(qk.configSettings(`org:${orgId}`), () => wrap(async () => client.config.listSettings(scope)));
  const [busy, setBusy] = React.useState(false);

  const existing = (settings.data?.settings ?? []).find((s) => s.key === COPILOT_FLAG_KEY);
  const on = parseCopilotFlag(existing?.value);

  async function setFlag(next: boolean) {
    setBusy(true);
    const value = next ? "on" : "off";
    const res = await wrap(async () => {
      if (existing) return client.config.updateSetting(scope, existing.id, { value });
      return client.config.createSetting(scope, { key: COPILOT_FLAG_KEY, value });
    });
    setBusy(false);
    if (res.ok) {
      toast({ kind: "success", title: next ? "Copilot surface enabled" : "Copilot surface disabled" });
      settings.reload();
    } else {
      toast({ kind: "error", title: "Could not update the copilot setting", description: res.error.message });
    }
  }

  if (settings.loading && !settings.data) return <Skeleton className="h-20 w-full rounded-xl" />;

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-start gap-3 px-5 py-4">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-secondary text-foreground/70">
          <Sparkles className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-[14px] font-semibold">Copilot surface</h3>
            {on ? (
              <Pill tone="success" dot>
                On
              </Pill>
            ) : (
              <Pill tone="neutral">Off</Pill>
            )}
          </div>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
            The new dispatch chat (streaming markdown, tool cards, agent actions) and the live session lens. Off
            returns the classic surfaces instantly — nothing is lost either way.
          </p>
        </div>
        <Switch checked={on} onCheckedChange={(v) => void setFlag(v)} disabled={busy} aria-label="Copilot surface" />
      </div>
    </div>
  );
}
