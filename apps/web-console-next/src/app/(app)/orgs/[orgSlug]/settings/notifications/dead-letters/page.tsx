"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { Inbox, RotateCcw, ShieldAlert } from "lucide-react";
import type { DeadLetterStatus, PublicDeadLetter } from "@saas/contracts/events";
import { OrgScope } from "@/components/shell/org-scope";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { CopyButton } from "@/components/ui/copy-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsHeader, SettingsPanel } from "@/components/settings/settings-primitives";
import { ListCard, Pill, type Tone } from "@/components/ui/northwind";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { formatRelativeTime } from "@/components/events/event-log";

/**
 * The admin action that gates this ops surface. Holding it marks an operator
 * who administers the workspace (the same authority the events-worker checks
 * server-side as `dead_letter.read`, which isn't in the effective-access set,
 * so we use this as the client-side proxy; the API is still the authority).
 */
const ADMIN_ACTION = "organization.settings.update";

const STATUS_TONE: Record<DeadLetterStatus, Tone> = {
  open: "warning",
  replayed: "success",
  discarded: "neutral",
};

export default function DeadLettersPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

function Inner({ orgId }: { orgId: string }) {
  const { client } = useSession();

  // Admin gate: reuse the effective-access read (same pattern as the Access
  // page). Non-admins get a not-authorized state, never a crash.
  const access = useApiQuery(qk.effectiveAccess(orgId), () =>
    wrap(async () => (await client.teams.effectiveAccess(orgId)).permissions),
  );
  const isAdmin = React.useMemo(
    () => (access.data ?? []).some((p) => p.action === ADMIN_ACTION && p.allow),
    [access.data],
  );

  if (access.loading) {
    return (
      <SettingsPanel className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </SettingsPanel>
    );
  }

  if (!isAdmin) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="Not authorized"
        description="Dead-letter operations are limited to workspace administrators."
      />
    );
  }

  return <DeadLettersView orgId={orgId} />;
}

function DeadLettersView({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const [status, setStatus] = React.useState<"all" | DeadLetterStatus>("open");
  const [items, setItems] = React.useState<ReadonlyArray<PublicDeadLetter>>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<{ code: string; message: string } | null>(null);
  const [replayingId, setReplayingId] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await wrap(() => client.deadLetters.listPage(orgId, status === "all" ? {} : { status }));
    if (res.ok) {
      setItems(res.data.deadLetters);
      setCursor(res.data.cursor);
    } else {
      setError({ code: res.error.code, message: res.error.message });
      setItems([]);
    }
    setLoading(false);
  }, [client, orgId, status]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const loadMore = React.useCallback(async () => {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    const res = await wrap(() =>
      client.deadLetters.listPage(orgId, status === "all" ? { cursor } : { status, cursor }),
    );
    if (res.ok) {
      setItems((prev) => [...prev, ...res.data.deadLetters]);
      setCursor(res.data.cursor);
    }
    setLoadingMore(false);
  }, [client, orgId, status, cursor, loadingMore]);

  const replay = async (dl: PublicDeadLetter) => {
    setReplayingId(dl.id);
    const res = await wrap(() => client.deadLetters.replay(orgId, dl.id));
    setReplayingId(null);
    if (!res.ok) {
      toast({ kind: "error", title: "Replay failed", description: res.error.message });
      return;
    }
    toast({ kind: "success", title: "Replayed", description: `Dead letter on lane ${dl.laneKey} was replayed.` });
    void load();
  };

  return (
    <div className="space-y-[18px]">
      <SettingsHeader
        title="Dead letters"
        description="Events a delivery lane failed to process. Replay an open letter to re-run its lane handler."
        actions={
          <Select value={status} onValueChange={(v) => setStatus(v as "all" | DeadLetterStatus)}>
            <SelectTrigger className="h-8 w-[160px] text-xs" aria-label="Status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="replayed">Replayed</SelectItem>
              <SelectItem value="discarded">Discarded</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
        }
      />

      {loading ? (
        <SettingsPanel className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </SettingsPanel>
      ) : error ? (
        <SettingsPanel>
          <div className="text-[13px] font-medium text-destructive">{error.code}</div>
          <div className="text-xs text-muted-foreground">{error.message}</div>
        </SettingsPanel>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No dead letters"
          description="Nothing has failed delivery for this status. That's a good thing."
        />
      ) : (
        <ListCard>
          {items.map((dl) => (
            <div
              key={dl.id}
              className="flex items-start gap-3 border-t border-border/60 px-5 py-[13px] first:border-t-0"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium">{dl.reason || "delivery failed"}</span>
                  <Pill tone={STATUS_TONE[dl.status]}>{dl.status}</Pill>
                  <Pill tone="neutral" className="font-mono">lane {dl.laneKey}</Pill>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <span className="font-mono">{dl.eventId}</span>
                    <CopyButton value={dl.eventId} variant="ghost" size="sm" className="h-4 w-4 p-0" />
                  </span>
                  <span aria-hidden>·</span>
                  <span>{dl.attempts} attempts</span>
                  <span aria-hidden>·</span>
                  <span title={new Date(dl.lastFailedAt).toLocaleString()}>failed {formatRelativeTime(dl.lastFailedAt)}</span>
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={dl.status !== "open"}
                loading={replayingId === dl.id}
                onClick={() => void replay(dl)}
              >
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.8} />
                Replay
              </Button>
            </div>
          ))}
          {cursor !== null ? (
            <div className="flex justify-center border-t border-border/60 py-3">
              <Button type="button" variant="outline" onClick={() => void loadMore()} loading={loadingMore}>
                Load more
              </Button>
            </div>
          ) : null}
        </ListCard>
      )}
    </div>
  );
}
