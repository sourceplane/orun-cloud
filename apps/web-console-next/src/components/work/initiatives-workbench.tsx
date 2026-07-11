"use client";

// The initiative portfolio (orun-work-v4 WH2). The roadmap screen that is
// always current because NOTHING on it is entered: health and progress fold
// from member epics' delivery truth on every read (V4-4); owner, target,
// and priority are the only authored pixels.

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { WorkInitiativeView, WorkRung } from "@saas/contracts/work";
import { ListCard, ListRow, PageHeader, RowChevron, Screen } from "@/components/ui/northwind";
import { Skeleton } from "@/components/ui/skeleton";
import { wrap } from "@/lib/api";
import { qk, useApiQuery } from "@/lib/query";
import { useSession } from "@/lib/session";
import { HealthChip, ProgressBar } from "@/components/work/hierarchy-chips";

function progressTotals(progress?: Partial<Record<WorkRung, number>>): { total: number; done: number } {
  let total = 0;
  let done = 0;
  for (const [rung, n] of Object.entries(progress ?? {})) {
    total += n ?? 0;
    if (rung === "done" || rung === "released") done += n ?? 0;
  }
  return { total, done };
}

export function InitiativesWorkbench({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const params = useParams<{ orgSlug?: string }>();
  const orgSlug = params?.orgSlug ?? "";
  const summary = useApiQuery(qk.orgWork(orgId), () => wrap(async () => client.work.summary(orgId)));

  const initiatives = summary.data?.initiatives ?? [];

  let body: React.ReactNode;
  if (summary.loading) {
    body = (
      <div className="mt-[30px] flex flex-col gap-3">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  } else if (summary.error) {
    body = (
      <div className="mt-[30px] text-[13px] text-muted-foreground">
        {summary.error.code}: {summary.error.message}
      </div>
    );
  } else if (initiatives.length === 0) {
    body = (
      <ListCard className="mt-[30px]">
        <div className="px-5 py-8 text-[13px] text-muted-foreground">
          No initiatives yet. An initiative is the why — create one from the Work page&apos;s New menu, then
          run designs on it to propose epics.
        </div>
      </ListCard>
    );
  } else {
    body = (
      <ListCard className="mt-[30px]">
        <ul>
          {initiatives.map((i) => (
            <InitiativeRow key={i.key} initiative={i} orgSlug={orgSlug} />
          ))}
        </ul>
      </ListCard>
    );
  }

  return (
    <Screen>
      <PageHeader
        title="Initiatives"
        description="The portfolio. Health and progress fold from delivery truth — this screen is always current because nothing on it is entered."
        actions={
          <Link
            href={`/orgs/${orgSlug}/work`}
            className="text-[12.5px] text-muted-foreground underline-offset-2 hover:underline"
          >
            Work
          </Link>
        }
      />
      {body}
    </Screen>
  );
}

function InitiativeRow({ initiative, orgSlug }: { initiative: WorkInitiativeView; orgSlug: string }) {
  const { total, done } = progressTotals(initiative.progress);
  return (
    <ListRow>
      <Link
        href={`/orgs/${orgSlug}/work/initiatives/${encodeURIComponent(initiative.key)}`}
        className="flex w-full items-center gap-3 px-5 py-3.5"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[13.5px] font-medium text-secondary-foreground">{initiative.title}</span>
            <HealthChip health={initiative.health} evidence={initiative.healthEvidence} />
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] text-muted-foreground">
            <span className="font-mono">{initiative.key}</span>
            {initiative.owner ? <span>owner {initiative.owner}</span> : null}
            {initiative.targetDate ? <span>target {initiative.targetDate}</span> : null}
            {total > 0 ? (
              <span>
                {done}/{total} tasks complete
              </span>
            ) : null}
          </div>
        </div>
        <ProgressBar counts={initiative.progress} total={total} className="w-32" />
        <RowChevron />
      </Link>
    </ListRow>
  );
}
