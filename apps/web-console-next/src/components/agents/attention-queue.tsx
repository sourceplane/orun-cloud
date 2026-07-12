"use client";

// The needs-you queue (saas-agents-fleet AF5, design §2.1/§4) — the top of
// the fleet home. Every card is a derived fact with its provenance inline;
// there is deliberately no dismiss affordance — answering the verdict (or
// re-dispatching, or killing) removes the card by making its fact false.
// Verdicts are answerable here: the fleet home is a head too, posting the
// same attach-v1 frame the session page posts.

import * as React from "react";
import Link from "next/link";
import type { AttentionItem, AttentionSummary } from "@saas/contracts/agents";
import { Button } from "@/components/ui/button";
import { Kicker, ListCard, ListRow, Pill, StatusText } from "@/components/ui/northwind";
import { attentionKindLabel, attentionTone, compactAge, isAnswerable } from "@/lib/agents/attention";
import { useSession } from "@/lib/session";

export function AttentionQueue({
  orgId,
  orgSlug,
  attention,
  onActed,
}: {
  orgId: string;
  orgSlug: string;
  attention: AttentionSummary;
  onActed: () => void;
}) {
  const { client } = useSession();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const refSeq = React.useRef(0);

  const answer = React.useCallback(
    async (item: AttentionItem, approved: boolean) => {
      if (!item.request) return;
      setBusy(item.sessionId);
      setError(null);
      try {
        refSeq.current += 1;
        const ack = await client.agents.sendInput(orgId, item.sessionId, {
          v: 1,
          ref: `fleet-${refSeq.current}`,
          t: "verdict",
          requestId: item.request.requestId,
          approved,
        });
        if (ack.ok === false) setError(`Verdict rejected: ${ack.reason ?? "unknown"}`);
        onActed();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to send verdict");
      } finally {
        setBusy(null);
      }
    },
    [client, orgId, onActed],
  );

  if (attention.items.length === 0) return null;

  return (
    <>
      <Kicker className="mb-2.5">Needs you · {attention.items.length}</Kicker>
      <ListCard className="mb-8">
        {attention.items.map((item) => (
          <ListRow key={`${item.kind}:${item.sessionId}`}>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-mono text-[12.5px]">{item.sessionId}</span>
                <Pill tone={attentionTone(item.kind)}>{attentionKindLabel(item.kind)}</Pill>
                <span className="truncate text-[12.5px]">{item.reason}</span>
              </div>
              <div className="mt-0.5 truncate text-[12px] text-muted-foreground">
                {item.workRef ? `${item.workRef} · ` : ""}
                {item.taskKey ? `${item.taskKey} · ` : ""}
                {compactAge(item.at, new Date())} ago
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {isAnswerable(item) ? (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === item.sessionId}
                    onClick={() => void answer(item, false)}
                  >
                    Deny
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy === item.sessionId}
                    onClick={() => void answer(item, true)}
                  >
                    Approve
                  </Button>
                </>
              ) : null}
              <Link
                href={`/orgs/${orgSlug}/agents/${item.sessionId}`}
                className="text-[12.5px] text-muted-foreground hover:text-foreground"
              >
                View session →
              </Link>
            </div>
          </ListRow>
        ))}
        {error ? (
          <div className="px-4 pb-3">
            <StatusText tone="error">{error}</StatusText>
          </div>
        ) : null}
      </ListCard>
    </>
  );
}
