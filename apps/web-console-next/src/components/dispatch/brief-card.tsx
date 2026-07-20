"use client";

// The standing brief card (saas-dispatch DX4) — "while you were away", folded
// from the Situation the viewer just authorized. Dismiss stamps the visit;
// mute silences the workspace's brief until unmuted (per-thread mute rides
// the preference, DX-Q5 posture: a muted brief schedules nothing and spends
// nothing — this one spends nothing by construction, it is pull-rendered).

import * as React from "react";
import type { Situation } from "@saas/contracts/dispatch";
import { Button } from "@/components/ui/button";
import { ListCard, ListCardHeader, Pill } from "@/components/ui/northwind";
import {
  composeBrief,
  readBriefMuted,
  writeBriefMuted,
  writeLastVisit,
} from "@/lib/dispatch/brief";

export function BriefCard({ orgSlug, situation }: { orgSlug: string; situation: Situation | null }) {
  const [dismissed, setDismissed] = React.useState(false);
  const [muted, setMuted] = React.useState(false);
  React.useEffect(() => {
    setMuted(readBriefMuted(window.localStorage, orgSlug));
  }, [orgSlug]);

  if (!situation || dismissed || muted) return null;
  const brief = composeBrief(situation);
  if (!brief) return null;

  function dismiss() {
    writeLastVisit(window.localStorage, orgSlug, new Date().toISOString());
    setDismissed(true);
  }
  function mute() {
    writeBriefMuted(window.localStorage, orgSlug, true);
    setMuted(true);
  }

  return (
    <ListCard>
      <ListCardHeader
        title={
          <span className="flex items-center gap-2">
            Standing brief
            {brief.pending > 0 ? <Pill tone="warning">{brief.pending} pending</Pill> : null}
          </span>
        }
        action={
          <span className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={mute}>
              Mute
            </Button>
            <Button size="sm" variant="ghost" onClick={dismiss}>
              Dismiss
            </Button>
          </span>
        }
      />
      <p className="px-5 pb-4 text-[12.5px] leading-relaxed text-muted-foreground">
        {brief.lines.join(" · ")}
      </p>
    </ListCard>
  );
}
