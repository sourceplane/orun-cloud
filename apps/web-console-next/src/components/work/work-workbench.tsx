"use client";

// The work lens, read-only (orun-work v2 WP1). Every rung on this page is the
// fold's output rendered WITH its evidence — nothing here is a stored status,
// and a pin always renders beside observed truth, never instead of it.

import * as React from "react";
import type {
  WorkRung,
  WorkSummaryResponse,
  WorkTaskView,
} from "@saas/contracts/work";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { wrap } from "@/lib/api";
import { qk, useApiQuery } from "@/lib/query";
import { useSession } from "@/lib/session";
import { rungBadgeVariant, rungLabel, groupTasksBySpec } from "@/lib/work/model";
import { TaskActions } from "@/components/work/task-actions";

export function WorkWorkbench({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const summary = useApiQuery(qk.orgWork(orgId), () =>
    wrap(async () => client.work.summary(orgId)),
  );

  // WP1b live-ness: the coordination log IS the sync signal. Poll the
  // events endpoint from the last seen cursor; any new event (another tab,
  // a teammate, an agent via the MCP) triggers one summary refetch. The
  // mutation/verdict seam stays transport-agnostic — SSE can replace this
  // poll without touching anything else.
  const cursor = React.useRef(0);
  React.useEffect(() => {
    if (summary.data) cursor.current = Math.max(cursor.current, summary.data.coordSeq);
  }, [summary.data]);
  const reload = summary.reload;
  React.useEffect(() => {
    const t = setInterval(() => {
      void (async () => {
        try {
          const page = await client.work.listEvents(orgId, cursor.current);
          if (page.events.length > 0) {
            cursor.current = page.seq;
            reload();
          }
        } catch {
          // transient — the next tick retries
        }
      })();
    }, 12_000);
    return () => clearInterval(t);
  }, [client, orgId, reload]);

  if (summary.loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (summary.error) {
    return <ErrorCard code={summary.error.code} message={summary.error.message} />;
  }
  const data = summary.data;
  if (!data || (data.tasks.length === 0 && data.specs.length === 0)) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Work</CardTitle>
          <CardDescription>
            Nothing here yet. Import a specs tree with{" "}
            <code className="font-mono text-xs">orun work import specs/ --workspace …</code> — lifecycle
            derives from delivery history, not from anything you type.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return <WorkSummary data={data} orgId={orgId} onMutated={summary.reload} />;
}

function WorkSummary({ data, orgId, onMutated }: { data: WorkSummaryResponse; orgId: string; onMutated: () => void }) {
  const groups = groupTasksBySpec(data.tasks);
  const specTitles = new Map(data.specs.map((s) => [s.key, s.title]));

  return (
    <div className="space-y-4">
      {data.drift.length > 0 ? <DriftInbox drift={data.drift} /> : null}
      {data.suggestions.length > 0 ? <Suggestions suggestions={data.suggestions} /> : null}
      {groups.map((group) => (
        <Card key={group.spec ?? "__inbox__"}>
          <CardHeader>
            <CardTitle className="text-base">
              {group.spec ? (specTitles.get(group.spec) ?? group.spec) : "Inbox"}
            </CardTitle>
            {group.spec ? (
              <CardDescription className="font-mono text-xs">{group.spec}</CardDescription>
            ) : null}
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border">
              {group.tasks.map((task) => (
                <TaskRow key={task.key} task={task} orgId={orgId} onMutated={onMutated} />
              ))}
            </ul>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function TaskRow({ task, orgId, onMutated }: { task: WorkTaskView; orgId: string; onMutated: () => void }) {
  const lc = task.lifecycle;
  return (
    <li className="flex flex-wrap items-center gap-2 py-2">
      <span className="font-mono text-xs text-muted-foreground">{task.key}</span>
      <span className="flex-1 text-sm">{task.title}</span>
      {lc.pinned ? (
        <Badge variant="warning" title={`pinned by ${lc.pinned.by.id}${lc.pinned.note ? ` — ${lc.pinned.note}` : ""}`}>
          pinned {rungLabel(lc.pinned.rung)}
        </Badge>
      ) : null}
      {lc.blocked ? <Badge variant="destructive">blocked</Badge> : null}
      <Badge variant={rungBadgeVariant(lc.rung)}>{rungLabel(lc.rung)}</Badge>
      {lc.evidence?.length ? (
        <span className="w-full pl-1 text-xs text-muted-foreground sm:w-auto">{lc.evidence[0]}</span>
      ) : null}
      <TaskActions orgId={orgId} task={task} onMutated={onMutated} />
    </li>
  );
}

function DriftInbox({ drift }: { drift: WorkSummaryResponse["drift"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Drift inbox</CardTitle>
        <CardDescription>Merged PRs no open task claims — unplanned changes.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1">
          {drift.map((d) => (
            <li key={d.pr} className="text-sm">
              <span className="font-mono text-xs">{d.pr}</span>{" "}
              <span className="text-muted-foreground">→ {d.affected.join(", ")}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function Suggestions({ suggestions }: { suggestions: WorkSummaryResponse["suggestions"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Claim suggestions</CardTitle>
        <CardDescription>
          PRs whose components match more than one open task — ambiguity suggests, never links.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1">
          {suggestions.map((s) => (
            <li key={s.pr} className="text-sm">
              <span className="font-mono text-xs">{s.pr}</span>{" "}
              <span className="text-muted-foreground">could claim {s.taskKeys.join(" or ")}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function ErrorCard({ code, message }: { code: string; message: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-destructive">{code}</CardTitle>
        <CardDescription>{message}</CardDescription>
      </CardHeader>
    </Card>
  );
}

const RUNG_ORDER: WorkRung[] = ["released", "done", "in_review", "in_progress", "ready", "draft", "canceled"];
export { RUNG_ORDER };
