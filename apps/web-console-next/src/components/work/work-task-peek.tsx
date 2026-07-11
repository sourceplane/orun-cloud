"use client";

// The task peek (orun-work-v5 WV3) — the right-docked, NON-MODAL panel per
// specs/epics/orun-work-v5/design.md §3.6. Tasks stop being navigations:
// the peek covers the 90% read (where is it, who's on it, what's the
// evidence) at zero navigation cost. The rung ladder is the product thesis
// as an interaction: a display of the fold that accepts opinions and files
// them as opinions — clicking a rung mints or clears an attributed pin
// through the same v2 mutator the board uses; the observed rung renders
// unconditionally either way (WV-3).

import * as React from "react";
import Link from "next/link";
import type { AgentSession } from "@saas/contracts/agents";
import type { WorkRung, WorkSpecView, WorkTaskView } from "@saas/contracts/work";
import { Button } from "@/components/ui/button";
import { Kicker, Pill, type Tone } from "@/components/ui/northwind";
import { PinBadge, RungIcon, SessionChip as LiveSessionChip } from "@/components/ui/northwind-work";
import { cn } from "@/lib/cn";
import { useSession } from "@/lib/session";
import { RUNGS_PINNABLE, rungLabel } from "@/lib/work/model";
import { pinIntent, truthSourceTag } from "@/lib/work/rungs";
import { EditWorkItemDialog } from "@/components/work/create-work-item-dialog";
import { SpecDocSheet } from "@/components/work/spec-doc-sheet";
import { TaskConversationSheet } from "@/components/work/task-conversation-sheet";

const RUNG_CHIP_TONE: Partial<Record<WorkRung, Tone>> = {
  released: "success",
  done: "neutral",
  in_review: "info",
  in_progress: "warning",
};

export function TaskPeek({
  orgId,
  orgSlug,
  task,
  spec,
  session,
  sessionHref,
  onClose,
  onMutated,
}: {
  orgId: string;
  orgSlug: string;
  task: WorkTaskView;
  spec?: WorkSpecView | undefined;
  session?: AgentSession | undefined;
  sessionHref?: ((sessionId: string) => string) | undefined;
  onClose: () => void;
  onMutated: () => void;
}) {
  const { client } = useSession();
  const [busy, setBusy] = React.useState(false);
  const [verdict, setVerdict] = React.useState<string | null>(null);
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [threadOpen, setThreadOpen] = React.useState(false);
  const [docOpen, setDocOpen] = React.useState(false);
  const panelRef = React.useRef<HTMLDivElement>(null);

  const lc = task.lifecycle;

  // Esc closes (unless a sheet/dialog stacked above owns the key); `p`
  // focuses the rung ladder so ↑↓ + Enter can pin without the mouse (WV5).
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (renameOpen || threadOpen || docOpen) return;
      if (e.key === "Escape") onClose();
      if (e.key === "p" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName?.toUpperCase();
        if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
        e.preventDefault();
        panelRef.current?.querySelector<HTMLButtonElement>("[data-rung-row]")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, renameOpen, threadOpen, docOpen]);

  React.useEffect(() => {
    panelRef.current?.focus();
  }, [task.key]);

  const clickRung = async (rung: WorkRung) => {
    const intent = pinIntent(rung, lc);
    if (!intent || busy) return;
    setBusy(true);
    setVerdict(null);
    try {
      await client.work.pin(orgId, task.key, intent);
      onMutated();
    } catch (err) {
      const e = err as { message?: string };
      setVerdict(e.message ?? "rejected"); // the fold's answer shows through
    } finally {
      setBusy(false);
    }
  };

  const epicHref = task.spec
    ? `/orgs/${orgSlug}/work/epics/${encodeURIComponent(task.spec)}`
    : undefined;

  return (
    <div
      ref={panelRef}
      role="complementary"
      aria-label={`Task ${task.key}`}
      tabIndex={-1}
      className="fixed bottom-3.5 right-3.5 top-3.5 z-40 flex w-[440px] max-w-[calc(100vw-28px)] flex-col overflow-hidden rounded-[14px] border bg-card shadow-2xl outline-none animate-peek-in"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {/* header */}
        <div className="flex items-center gap-2.5">
          <Kicker className="tracking-[0.08em]">Task · {task.key}</Kicker>
          <Pill tone={RUNG_CHIP_TONE[lc.rung] ?? "neutral"}>{rungLabel(lc.rung)}</Pill>
          <span className="text-[11px] text-muted-foreground/70">{truthSourceTag(lc)}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <button
          type="button"
          onClick={() => setRenameOpen(true)}
          title="Edit title"
          className="mt-2 text-left font-serif text-[20px] font-medium leading-snug tracking-[-0.01em] decoration-border underline-offset-4 hover:underline"
        >
          {task.title}
        </button>

        <div className="mt-1.5 font-mono text-[11.5px] text-muted-foreground/85">
          {task.spec ?? "inbox · no epic"}
          {task.milestone ? ` · ${task.milestone}` : ""}
        </div>

        {/* live session banner */}
        {session ? (
          <div className="mt-4 flex items-start gap-3 rounded-[10px] bg-info-soft/70 px-3.5 py-3">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 animate-livepulse rounded-full bg-info" aria-hidden />
            <div className="min-w-0 flex-1 text-[12.5px] leading-snug">
              <span className="font-medium">{session.spawnedBy}</span>
              <span className="text-muted-foreground"> is working — session </span>
              <span className="font-mono text-[11.5px]">{session.id}</span>
              <div className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                {session.state}
                {session.startedAt ? ` · started ${session.startedAt.slice(0, 16).replace("T", " ")}` : ""}
                {session.prUrl ? " · PR open" : ""}
              </div>
            </div>
            {sessionHref ? (
              <Link href={sessionHref(session.id)} className="shrink-0 text-xs text-info hover:underline">
                Open →
              </Link>
            ) : null}
          </div>
        ) : null}

        {/* the rung ladder — fold with pin */}
        <div className="mt-5">
          <Kicker>Rung · fold with pin</Kicker>
          <div className="mt-2 overflow-hidden rounded-[10px] border">
            {RUNGS_PINNABLE.map((rung) => {
              const isObserved = rung === lc.rung;
              const isPinned = lc.pinned?.rung === rung && rung !== lc.rung;
              return (
                <button
                  key={rung}
                  type="button"
                  data-rung-row
                  disabled={busy}
                  onClick={() => void clickRung(rung)}
                  className={cn(
                    "flex w-full items-center gap-2.5 border-t border-border/50 px-3.5 py-[7px] text-left text-[12.5px] transition-colors first:border-t-0",
                    isPinned ? "bg-warning-wash" : isObserved ? "bg-muted" : "hover:bg-muted/60",
                    (isObserved || isPinned) && "font-semibold",
                  )}
                >
                  <RungIcon rung={rung} size={12} />
                  {rungLabel(rung)}
                  {isObserved ? (
                    <span className="ml-auto text-[10.5px] font-normal text-muted-foreground/70">
                      observed · from evidence
                    </span>
                  ) : null}
                  {isPinned && lc.pinned ? (
                    <span className="ml-auto">
                      <PinBadge pin={lc.pinned} />
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground/80">
            Click a rung to pin it. The fold keeps rendering what it observes.
          </p>
          {verdict ? <p className="mt-1 text-xs text-destructive">verdict: {verdict}</p> : null}
        </div>

        {/* properties */}
        <div className="mt-5">
          <Kicker>Properties</Kicker>
          <div className="mt-2 flex flex-col gap-[7px] text-[12.5px]">
            <PropRow label="Assignee">
              {task.assignees?.length ? task.assignees.join(", ") : "Unassigned"}
            </PropRow>
            <PropRow label="Epic">{spec?.title ?? task.spec ?? "—"}</PropRow>
            <PropRow label="Milestone">{task.milestone ?? "—"}</PropRow>
            {task.priority && task.priority !== "none" ? (
              <PropRow label="Priority">{task.priority}</PropRow>
            ) : null}
            {task.cycleKey ? <PropRow label="Cycle">{task.cycleKey}</PropRow> : null}
            {session ? (
              <PropRow label="Session">
                <LiveSessionChip agent={session.profileId} session={session.id} />
              </PropRow>
            ) : null}
          </div>
        </div>

        {/* evidence */}
        <div className="mt-5">
          <Kicker>Evidence</Kicker>
          {lc.evidence?.length ? (
            <ul className="mt-2 flex flex-col gap-[7px]">
              {lc.evidence.map((line, i) => (
                <li key={i} className="flex items-baseline gap-2.5 text-[12.5px] leading-snug">
                  <span aria-hidden className="h-1.5 w-1.5 shrink-0 translate-y-px rounded-full bg-foreground/15" />
                  <span className="min-w-0">{line}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-[12.5px] text-muted-foreground">
              Nothing observed yet — the ladder moves when delivery does.
            </p>
          )}
        </div>
      </div>

      {/* footer */}
      <div className="flex shrink-0 items-center gap-2.5 border-t px-6 py-3.5">
        {epicHref ? (
          <Button asChild size="sm">
            <Link href={epicHref}>Open epic page</Link>
          </Button>
        ) : null}
        {spec?.docRef ? (
          <Button variant="outline" size="sm" onClick={() => setDocOpen(true)}>
            View document
          </Button>
        ) : null}
        <Button variant="outline" size="sm" onClick={() => setThreadOpen(true)}>
          Thread
        </Button>
        <kbd className="ml-auto rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          esc
        </kbd>
      </div>

      <EditWorkItemDialog
        orgId={orgId}
        itemKey={task.key}
        currentTitle={task.title}
        open={renameOpen}
        onOpenChange={setRenameOpen}
        onSaved={onMutated}
      />
      <TaskConversationSheet
        orgId={orgId}
        taskKey={task.key}
        open={threadOpen}
        onOpenChange={setThreadOpen}
        onMutated={onMutated}
      />
      {task.spec && spec ? (
        <SpecDocSheet
          orgId={orgId}
          specKey={task.spec}
          docRef={spec.docRef}
          open={docOpen}
          onOpenChange={setDocOpen}
          onMutated={onMutated}
        />
      ) : null}
    </div>
  );
}

function PropRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right font-medium">{children}</span>
    </div>
  );
}
