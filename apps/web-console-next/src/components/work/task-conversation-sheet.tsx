"use client";

// The task conversation drawer (orun-work-v3 PM1): the unified timeline —
// both logs interleaved — with threaded comments, @mentions, and reactions.
// Coordination entries carry actor chips; observation entries carry evidence.
// Nothing here writes a rung; a comment is conversation, a reaction is a nod.

import * as React from "react";
import type { WorkEventView, WorkTimelineEntry } from "@saas/contracts/work";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pill, StatusText } from "@/components/ui/northwind";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/lib/session";
import { groupThreads, reactionCounts, timelineLabel, type CommentNode } from "@/lib/work/conversation";

const QUICK_EMOJI = ["👍", "🎉", "👀"];

export function TaskConversationSheet({
  orgId,
  taskKey,
  open,
  onOpenChange,
  onMutated,
}: {
  orgId: string;
  taskKey: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMutated: () => void;
}) {
  const { client } = useSession();
  const [entries, setEntries] = React.useState<WorkTimelineEntry[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [comment, setComment] = React.useState("");
  const [replyTo, setReplyTo] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [verdict, setVerdict] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const res = await client.work.timeline(orgId, taskKey);
      setEntries(res.entries);
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? "failed to load");
    }
  }, [client, orgId, taskKey]);

  React.useEffect(() => {
    if (open) {
      setEntries(null);
      void load();
    }
  }, [open, load]);

  const events = (entries ?? []).filter((e) => e.type === "event" && e.event).map((e) => e.event!);
  const threads = groupThreads(events);
  const reactions = reactionCounts(events);

  const send = async () => {
    if (!comment.trim()) return;
    setBusy(true);
    setVerdict(null);
    try {
      await client.work.comment(orgId, taskKey, {
        body: comment.trim(),
        parentEvent: replyTo ?? undefined,
      });
      setComment("");
      setReplyTo(null);
      onMutated();
      await load();
    } catch (err) {
      const e = err as { message?: string };
      setVerdict(e.message ?? "rejected");
    } finally {
      setBusy(false);
    }
  };

  const toggleReaction = async (target: string, emoji: string, active: boolean) => {
    try {
      if (active) await client.work.unreact(orgId, target, { emoji });
      else await client.work.react(orgId, target, { emoji });
      await load();
    } catch {
      // verdict-level failures on reactions are non-critical; reload shows truth
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[560px] max-w-[92vw] overflow-y-auto sm:w-[560px]">
        <SheetHeader>
          <SheetTitle className="font-mono text-[13px]">{taskKey}</SheetTitle>
          <SheetDescription>
            The timeline — what people said and what the world did, interleaved. @mention to notify.
          </SheetDescription>
        </SheetHeader>

        {entries === null && !error ? (
          <div className="mt-4 space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : error ? (
          <StatusText tone="error" className="mt-4 block">
            {error}
          </StatusText>
        ) : (
          <div className="mt-4 flex flex-col gap-4">
            <section>
              <div className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                Timeline
              </div>
              <ul className="flex flex-col gap-1.5">
                {(entries ?? [])
                  .filter((t) => t.type === "observation" || t.event?.kind !== "comment_added")
                  .map((t, i) => (
                    <li key={i} className="flex items-baseline gap-2 text-[12px]">
                      {t.type === "observation" ? (
                        <Pill tone="info">fact</Pill>
                      ) : (
                        <ActorChip actor={t.event!.actor} />
                      )}
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">{timelineLabel(t)}</span>
                      <span className="shrink-0 text-[10.5px] text-muted-foreground/70">{t.at.slice(0, 16)}</span>
                    </li>
                  ))}
              </ul>
            </section>

            <section>
              <div className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                Thread
              </div>
              <ul className="flex flex-col gap-2">
                {threads.map((node) => (
                  <CommentRow
                    key={node.event.eventId}
                    node={node}
                    depth={0}
                    reactions={reactions}
                    onReply={(id) => setReplyTo(id)}
                    onToggle={toggleReaction}
                  />
                ))}
              </ul>
              <form
                className="mt-3 flex flex-col gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
              >
                {replyTo ? (
                  <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
                    replying to <span className="font-mono">{replyTo.slice(0, 8)}</span>
                    <button type="button" className="underline" onClick={() => setReplyTo(null)}>
                      cancel
                    </button>
                  </div>
                ) : null}
                <div className="flex gap-2">
                  <Input
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    placeholder="Comment… (@handle to notify)"
                    className="h-8"
                  />
                  <Button size="sm" type="submit" loading={busy} disabled={!comment.trim()}>
                    Send
                  </Button>
                </div>
                {verdict ? <p className="text-[12px] text-destructive">verdict: {verdict}</p> : null}
              </form>
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function ActorChip({ actor }: { actor: WorkEventView["actor"] }) {
  const tone = actor.type === "agent" ? "warning" : actor.type === "automation" ? "info" : "neutral";
  return <Pill tone={tone}>{actor.type}</Pill>;
}

function CommentRow({
  node,
  depth,
  reactions,
  onReply,
  onToggle,
}: {
  node: CommentNode;
  depth: number;
  reactions: Map<string, Map<string, number>>;
  onReply: (eventId: string) => void;
  onToggle: (target: string, emoji: string, active: boolean) => void;
}) {
  const e = node.event;
  const body = (e.payload as { body?: string } | undefined)?.body ?? "";
  const counts = reactions.get(e.eventId);
  return (
    <li style={{ marginLeft: depth * 16 }} className="rounded-md border border-border/60 px-3 py-2">
      <div className="flex items-baseline gap-2">
        <ActorChip actor={e.actor} />
        <span className="text-[11.5px] text-muted-foreground">{e.actor.id}</span>
        <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground/70">{e.at.slice(0, 16)}</span>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-[13px]">{body}</p>
      <div className="mt-1.5 flex items-center gap-1.5">
        {QUICK_EMOJI.map((emoji) => {
          const n = counts?.get(emoji) ?? 0;
          return (
            <button
              key={emoji}
              type="button"
              onClick={() => onToggle(e.eventId, emoji, n > 0)}
              className={`rounded-full border px-1.5 py-0.5 text-[11px] transition-colors ${
                n > 0 ? "border-foreground/30 bg-muted" : "border-border text-muted-foreground hover:bg-muted"
              }`}
            >
              {emoji}
              {n > 0 ? ` ${n}` : ""}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => onReply(e.eventId)}
          className="ml-1 text-[11.5px] text-muted-foreground underline-offset-2 hover:underline"
        >
          Reply
        </button>
      </div>
      {node.replies.map((r) => (
        <ul key={r.event.eventId} className="mt-2">
          <CommentRow node={r} depth={depth + 1} reactions={reactions} onReply={onReply} onToggle={onToggle} />
        </ul>
      ))}
    </li>
  );
}
