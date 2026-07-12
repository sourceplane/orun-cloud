"use client";

// The routine registry (saas-agents-fleet AF6, design §5): standing work on
// the fleet home. Rows are configuration + the standing state; firings are
// ordinary sessions grouped by routine_id in the session lists. Quiet by
// default — a healthy routine is one line here and a digest line elsewhere.

import * as React from "react";
import type { AgentRoutine } from "@saas/contracts/agents";
import { Button } from "@/components/ui/button";
import { Kicker, ListCard, ListRow, Pill, StatusText } from "@/components/ui/northwind";
import { useSession } from "@/lib/session";

function triggerLabel(r: AgentRoutine): string {
  if (r.triggerKind === "cron") {
    const expr = typeof r.triggerConfig.cron === "string" ? r.triggerConfig.cron : "?";
    return `cron ${expr}`;
  }
  return "on event";
}

export function RoutinesCard({
  orgId,
  routines,
  onChanged,
}: {
  orgId: string;
  routines: AgentRoutine[];
  onChanged: () => void;
}) {
  const { client } = useSession();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const act = React.useCallback(
    async (id: string, fn: () => Promise<unknown>) => {
      setBusy(id);
      setError(null);
      try {
        await fn();
        onChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Routine update failed");
      } finally {
        setBusy(null);
      }
    },
    [onChanged],
  );

  if (routines.length === 0) return null;

  return (
    <>
      <Kicker className="mb-2.5 mt-8">Routines</Kicker>
      <ListCard>
        {routines.map((r) => (
          <ListRow key={r.id}>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium">{r.name}</span>
                {r.parked ? (
                  <Pill tone="warning">Parked</Pill>
                ) : r.enabled ? (
                  <Pill tone="success">On</Pill>
                ) : (
                  <Pill tone="neutral">Off</Pill>
                )}
                <Pill tone="neutral">{triggerLabel(r)}</Pill>
                <Pill tone="neutral">{r.runKind}</Pill>
              </div>
              <div className="mt-0.5 truncate text-[12px] text-muted-foreground">
                {r.parked && r.parkedReason ? `${r.parkedReason} · ` : ""}
                {r.lastFiredAt ? `last fired ${new Date(r.lastFiredAt).toLocaleString()}` : "never fired"}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {r.parked ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy === r.id}
                  onClick={() => void act(r.id, () => client.agents.updateRoutine(orgId, r.id, { parked: false }))}
                >
                  Resume
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy === r.id}
                  onClick={() =>
                    void act(r.id, () => client.agents.updateRoutine(orgId, r.id, { enabled: !r.enabled }))
                  }
                >
                  {r.enabled ? "Disable" : "Enable"}
                </Button>
              )}
            </div>
          </ListRow>
        ))}
        {error ? (
          <div className="px-4 pb-3">
            <StatusText tone="error">{error}</StatusText>
          </div>
        ) : null}
      </ListCard>
      <p className="mt-2 text-[12px] text-muted-foreground">
        A routine spawns sessions on its trigger — never acts inline. Success is digest material;
        two consecutive failures park it until you resume.
      </p>
    </>
  );
}
