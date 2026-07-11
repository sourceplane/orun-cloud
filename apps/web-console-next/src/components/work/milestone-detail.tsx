"use client";

// The milestone page (orun-work-v4 WH2): one checkpoint's goal, done-when,
// and member tasks. Progress is the fold over the tasks below — the page
// shows exactly why the number is what it is.

import * as React from "react";
import { useParams } from "next/navigation";
import { Breadcrumbs, Kicker, PageHeader, Screen } from "@/components/ui/northwind";
import { Skeleton } from "@/components/ui/skeleton";
import { wrap } from "@/lib/api";
import { qk, useApiQuery } from "@/lib/query";
import { useSession } from "@/lib/session";
import { ProgressBar } from "@/components/work/hierarchy-chips";
import { HierarchyTaskList } from "@/components/work/epic-detail";

export function MilestoneDetail({
  orgId,
  epicKey,
  milestoneKey,
}: {
  orgId: string;
  epicKey: string;
  milestoneKey: string;
}) {
  const { client } = useSession();
  const params = useParams<{ orgSlug?: string }>();
  const orgSlug = params?.orgSlug ?? "";

  const summary = useApiQuery(qk.orgWork(orgId), () => wrap(async () => client.work.summary(orgId)));

  if (summary.loading) {
    return (
      <Screen>
        <Skeleton className="mt-8 h-8 w-72" />
        <Skeleton className="mt-6 h-40 w-full" />
      </Screen>
    );
  }
  const epic = summary.data?.specs.find((s) => s.key === epicKey);
  const milestone = epic?.milestones?.find((m) => m.key === milestoneKey);
  const tasks = (summary.data?.tasks ?? []).filter((t) => t.spec === epicKey && t.milestone === milestoneKey);

  const crumbs: Array<{ label: React.ReactNode; href?: string; mono?: boolean }> = [
    { label: "Work", href: `/orgs/${orgSlug}/work` },
  ];
  if (epic?.initiative) {
    crumbs.push({
      label: epic.initiative,
      href: `/orgs/${orgSlug}/work/initiatives/${encodeURIComponent(epic.initiative)}`,
      mono: true,
    });
  }
  crumbs.push({
    label: epic?.title ?? epicKey,
    href: `/orgs/${orgSlug}/work/epics/${encodeURIComponent(epicKey)}`,
  });
  crumbs.push({ label: milestoneKey, mono: true });

  if (!epic || !milestone) {
    return (
      <Screen>
        <Breadcrumbs items={crumbs} />
        <div className="text-[13px] text-muted-foreground">
          Unknown milestone {milestoneKey} in {epicKey}.
        </div>
      </Screen>
    );
  }

  const total = milestone.total ?? tasks.length;
  const complete =
    milestone.complete ?? tasks.filter((t) => t.lifecycle.rung === "done" || t.lifecycle.rung === "released").length;

  return (
    <Screen>
      <Breadcrumbs items={crumbs} />
      <PageHeader
        title={`${milestone.key} — ${milestone.title}`}
        description={milestone.goal ?? "A meaningful checkpoint: independently shippable, with its own goal and done-when."}
        actions={
          <div className="flex items-center gap-3">
            <span className="text-[12.5px] text-muted-foreground">
              {complete}/{total} complete
            </span>
            <ProgressBar counts={milestone.progress} total={total} className="w-32" />
          </div>
        }
      />
      {milestone.targetDate ? (
        <div className="mt-1 text-[12.5px] text-muted-foreground">target {milestone.targetDate}</div>
      ) : null}

      {milestone.doneWhen?.length ? (
        <section className="mt-6">
          <Kicker>Done when</Kicker>
          <ul className="mt-2 flex flex-col gap-1 text-[13px] text-secondary-foreground">
            {milestone.doneWhen.map((d, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-muted-foreground">—</span>
                <span>{d}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-[30px]">
        <Kicker>Tasks</Kicker>
        <div className="mt-2.5">
          <HierarchyTaskList
            tasks={tasks}
            emptyText="No tasks in this milestone yet — an agent generates them at dispatch, or create them from the Work page."
          />
        </div>
      </section>
    </Screen>
  );
}
