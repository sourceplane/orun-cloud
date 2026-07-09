"use client";

// Cycles (orun-work-v3 PM3): authored time-boxes whose progress is derived,
// never entered. The burn-up below is the fold replayed day by day — scope
// is what was planned in by each date, done is what the evidence confirmed.
// There is no editable series and no "mark cycle complete" button; carry-over
// renders as the gap between the two lines, not as cards moved by hand.

import * as React from "react";
import type { WorkBurnupResponse, WorkCycleView } from "@saas/contracts/work";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ListCard, StatusText } from "@/components/ui/northwind";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/lib/session";
import { burnupGeometry, carryOver } from "@/lib/work/burnup";

export function CyclesSection({
  orgId,
  cycles,
  onMutated,
}: {
  orgId: string;
  cycles: WorkCycleView[];
  onMutated: () => void;
}) {
  const [createOpen, setCreateOpen] = React.useState(false);
  const [openKey, setOpenKey] = React.useState<string | null>(null);

  return (
    <section>
      <div className="mb-2.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <span className="text-[12.5px] font-semibold text-muted-foreground">Cycles</span>
        <span className="text-[11.5px] text-muted-foreground/85">
          authored time-boxes — the burn-up is derived from delivery facts, never entered
        </span>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="rounded px-1.5 py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          New cycle
        </button>
      </div>
      {cycles.length > 0 ? (
        <ListCard>
          {cycles.map((c) => (
            <div key={c.key} className="border-t border-border/50 first:border-t-0">
              <button
                type="button"
                onClick={() => setOpenKey((k) => (k === c.key ? null : c.key))}
                className="flex w-full items-baseline gap-3 px-5 py-2.5 text-left transition-colors hover:bg-muted/60"
              >
                <span className="min-w-[56px] shrink-0 font-mono text-[11.5px] text-secondary-foreground">{c.key}</span>
                <span className="min-w-0 flex-1 truncate text-[13px]">{c.name}</span>
                <span className="hidden shrink-0 text-[11.5px] text-muted-foreground sm:block">
                  {c.startsAt} → {c.endsAt}
                </span>
                <span className="shrink-0 text-[11.5px] text-muted-foreground">
                  {c.done}/{c.scope} done
                </span>
              </button>
              {openKey === c.key ? <BurnupPanel orgId={orgId} cycleKey={c.key} /> : null}
            </div>
          ))}
        </ListCard>
      ) : (
        <ListCard>
          <div className="px-5 py-4 text-[12.5px] text-muted-foreground">
            No cycles yet — create one and plan tasks into it from the board card menu.
          </div>
        </ListCard>
      )}
      <CreateCycleDialog
        orgId={orgId}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={onMutated}
      />
    </section>
  );
}

/* ── The burn-up (derived; one axis; scope vs done) ────────────── */

const CHART_W = 560;
const CHART_H = 96;

function BurnupPanel({ orgId, cycleKey }: { orgId: string; cycleKey: string }) {
  const { client } = useSession();
  const [data, setData] = React.useState<WorkBurnupResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await client.work.burnup(orgId, cycleKey);
        if (!cancelled) setData(res);
      } catch (err) {
        const e = err as { message?: string };
        if (!cancelled) setError(e.message ?? "failed to load");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, orgId, cycleKey]);

  if (error) {
    return (
      <div className="px-5 pb-3">
        <StatusText tone="error">{error}</StatusText>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="px-5 pb-3">
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const geometry = burnupGeometry(data.points, CHART_W, CHART_H);
  if (!geometry) {
    return (
      <div className="px-5 pb-3 text-[12px] text-muted-foreground">
        The window hasn’t started yet — the burn-up begins when its first day does.
      </div>
    );
  }
  const remaining = carryOver(data.points);
  const last = geometry.points[geometry.points.length - 1]!;

  return (
    <div className="px-5 pb-4">
      {/* legend — identity by label + mark style, never color alone */}
      <div className="mb-1.5 flex items-center gap-4 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <svg width="18" height="6" aria-hidden>
            <line x1="0" y1="3" x2="18" y2="3" className="stroke-muted-foreground" strokeWidth="2" strokeDasharray="4 3" />
          </svg>
          scope (planned in)
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="18" height="6" aria-hidden>
            <line x1="0" y1="3" x2="18" y2="3" className="stroke-success" strokeWidth="2" />
          </svg>
          done (evidence)
        </span>
        {remaining > 0 ? (
          <span className="ml-auto">
            carry-over: {remaining} — facts that didn’t arrive, not cards to move
          </span>
        ) : null}
      </div>
      <svg
        viewBox={`-4 -6 ${CHART_W + 46} ${CHART_H + 24}`}
        className="w-full"
        role="img"
        aria-label={`Burn-up for ${data.name}: ${last.point.done} of ${last.point.scope} done`}
      >
        {/* baseline + max gridline, recessive */}
        <line x1="0" y1={CHART_H} x2={CHART_W} y2={CHART_H} className="stroke-border" strokeWidth="1" />
        <line x1="0" y1="0" x2={CHART_W} y2="0" className="stroke-border/50" strokeWidth="1" strokeDasharray="2 4" />
        <text x={CHART_W + 6} y="4" className="fill-muted-foreground text-[10px]">
          {geometry.maxY}
        </text>
        <path d={geometry.doneArea} className="fill-success/15" />
        <polyline points={geometry.scopeLine} fill="none" className="stroke-muted-foreground" strokeWidth="2" strokeDasharray="4 3" />
        <polyline points={geometry.doneLine} fill="none" className="stroke-success" strokeWidth="2" />
        {/* direct end labels (selective — the last point only) */}
        <text x={last.x + 6} y={Math.max(10, last.yDone + 3)} className="fill-success text-[10px] font-medium">
          {last.point.done}
        </text>
        <text x={last.x + 6} y={Math.max(10, last.yScope - 4)} className="fill-muted-foreground text-[10px]">
          {last.point.scope}
        </text>
        {/* hover layer: one target per day, native tooltip */}
        {geometry.points.map((p, i) => {
          const half = geometry.points.length > 1 ? CHART_W / (geometry.points.length - 1) / 2 : CHART_W / 2;
          return (
            <rect
              key={i}
              x={p.x - half}
              y={-6}
              width={half * 2}
              height={CHART_H + 12}
              fill="transparent"
              className="hover:fill-muted/40"
            >
              <title>{`${p.point.date} — ${p.point.done}/${p.point.scope} done`}</title>
            </rect>
          );
        })}
      </svg>
    </div>
  );
}

/* ── Create dialog (the only authored part: a name and two dates) ── */

function CreateCycleDialog({
  orgId,
  open,
  onOpenChange,
  onCreated,
}: {
  orgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const { client } = useSession();
  const [name, setName] = React.useState("");
  const [startsAt, setStartsAt] = React.useState("");
  const [endsAt, setEndsAt] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [verdict, setVerdict] = React.useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setVerdict(null);
    try {
      await client.work.createCycle(orgId, { name: name.trim(), startsAt, endsAt });
      onOpenChange(false);
      setName("");
      setStartsAt("");
      setEndsAt("");
      onCreated();
    } catch (err) {
      const e = err as { message?: string };
      setVerdict(e.message ?? "rejected");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="text-[14px]">New cycle</DialogTitle>
          <DialogDescription>
            A time-box is the only thing you author — a name and two dates. Progress inside derives
            from delivery facts.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Cycle 12" autoFocus />
          <div className="flex gap-2">
            <Input type="date" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} aria-label="Starts" />
            <Input type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} aria-label="Ends" />
          </div>
          {verdict ? <p className="text-[12px] text-destructive">verdict: {verdict}</p> : null}
          <DialogFooter>
            <Button variant="outline" size="sm" type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button size="sm" type="submit" loading={busy} disabled={!name.trim() || !startsAt || !endsAt}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
