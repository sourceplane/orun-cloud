"use client";

// Per-task coordination actions (orun-work v2 WP1b): comment and pin/unpin.
// These are the ONLY lifecycle-adjacent controls that exist, and neither
// writes a rung: a comment is coordination, and a pin is a public,
// attributed override rendered beside observed truth until truth catches
// up. A rejected mutation surfaces the mutator's verdict inline.
//
// Rendering: the root is `display: contents`, so the quiet trigger buttons
// participate directly in the task row's flex line (revealed on row hover on
// desktop — the parent row provides the `group` class) while the comment/pin
// forms wrap to a full-width line below via `order-last basis-full`.

import * as React from "react";
import type { WorkRung, WorkTaskView } from "@saas/contracts/work";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { useSession } from "@/lib/session";
import { RUNGS_PINNABLE, rungLabel } from "@/lib/work/model";

function QuietAction({
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        "-my-1 cursor-pointer py-1 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export function TaskActions({
  orgId,
  task,
  onMutated,
}: {
  orgId: string;
  task: WorkTaskView;
  onMutated: () => void;
}) {
  const { client } = useSession();
  const [mode, setMode] = React.useState<"idle" | "comment" | "pin">("idle");
  const [comment, setComment] = React.useState("");
  const [pinRung, setPinRung] = React.useState<WorkRung>("done");
  const [pinNote, setPinNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [verdict, setVerdict] = React.useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setVerdict(null);
    try {
      await fn();
      setMode("idle");
      setComment("");
      setPinNote("");
      onMutated();
    } catch (err) {
      const e = err as { message?: string };
      setVerdict(e.message ?? "rejected");
    } finally {
      setBusy(false);
    }
  };

  // Quiet by default on desktop: fade the triggers in on row hover / focus,
  // but keep them pinned visible while a form is open, a mutation is in
  // flight, or a verdict is showing (and always on touch layouts).
  const quiet = mode === "idle" && !busy && !verdict;

  return (
    <div className="contents">
      <span
        className={cn(
          "flex shrink-0 items-center gap-3.5 transition-opacity",
          quiet && "sm:opacity-0 sm:focus-within:opacity-100 sm:group-hover:opacity-100",
        )}
      >
        <QuietAction onClick={() => setMode(mode === "comment" ? "idle" : "comment")}>
          Comment
        </QuietAction>
        {task.lifecycle.pinned ? (
          <QuietAction
            disabled={busy}
            onClick={() => void run(() => client.work.pin(orgId, task.key, { rung: null }))}
          >
            Unpin
          </QuietAction>
        ) : (
          <QuietAction onClick={() => setMode(mode === "pin" ? "idle" : "pin")}>Pin</QuietAction>
        )}
      </span>
      {mode === "comment" ? (
        <form
          className="order-last flex basis-full items-center gap-2 sm:pl-[68px]"
          onSubmit={(e) => {
            e.preventDefault();
            if (comment.trim()) void run(() => client.work.comment(orgId, task.key, { body: comment.trim() }));
          }}
        >
          <Input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Add a comment…"
            className="h-8"
            autoFocus
          />
          <Button size="sm" type="submit" loading={busy} disabled={!comment.trim()}>
            Send
          </Button>
        </form>
      ) : null}
      {mode === "pin" ? (
        <form
          className="order-last flex basis-full flex-wrap items-center gap-2 sm:pl-[68px]"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => client.work.pin(orgId, task.key, { rung: pinRung, note: pinNote.trim() || undefined }));
          }}
        >
          <select
            className="h-8 cursor-pointer rounded-[8px] border border-border bg-card px-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={pinRung}
            onChange={(e) => setPinRung(e.target.value as WorkRung)}
          >
            {RUNGS_PINNABLE.map((r) => (
              <option key={r} value={r}>
                {rungLabel(r)}
              </option>
            ))}
          </select>
          <Input
            value={pinNote}
            onChange={(e) => setPinNote(e.target.value)}
            placeholder="Why? (rendered beside observed truth)"
            className="h-8 max-w-64"
          />
          <Button size="sm" type="submit" loading={busy}>
            Pin
          </Button>
        </form>
      ) : null}
      {verdict ? (
        <p className="order-last basis-full text-xs text-destructive sm:pl-[68px]">
          verdict: {verdict}
        </p>
      ) : null}
    </div>
  );
}
