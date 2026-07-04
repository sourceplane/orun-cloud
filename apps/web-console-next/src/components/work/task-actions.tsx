"use client";

// Per-task coordination actions (orun-work v2 WP1b): comment and pin/unpin.
// These are the ONLY lifecycle-adjacent controls that exist, and neither
// writes a rung: a comment is coordination, and a pin is a public,
// attributed override rendered beside observed truth until truth catches
// up. A rejected mutation surfaces the mutator's verdict inline.

import * as React from "react";
import type { WorkRung, WorkTaskView } from "@saas/contracts/work";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSession } from "@/lib/session";
import { RUNGS_PINNABLE, rungLabel } from "@/lib/work/model";

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

  return (
    <div className="w-full">
      <div className="flex gap-1">
        <Button size="sm" variant="ghost" onClick={() => setMode(mode === "comment" ? "idle" : "comment")}>
          Comment
        </Button>
        {task.lifecycle.pinned ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => run(() => client.work.pin(orgId, task.key, { rung: null }))}
          >
            Unpin
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setMode(mode === "pin" ? "idle" : "pin")}>
            Pin
          </Button>
        )}
      </div>
      {mode === "comment" ? (
        <form
          className="mt-1 flex gap-2"
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
          className="mt-1 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => client.work.pin(orgId, task.key, { rung: pinRung, note: pinNote.trim() || undefined }));
          }}
        >
          <select
            className="h-8 rounded-md border border-input bg-background px-2 text-sm"
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
      {verdict ? <p className="mt-1 text-xs text-destructive">verdict: {verdict}</p> : null}
    </div>
  );
}
