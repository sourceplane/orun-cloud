"use client";

// The initiative page (orun-work-v4 WH2): overview · Designs rail · epics
// table · properties. The page grammar every drill-down level shares:
// header (breadcrumb · title · derived chips) → properties → children.
//
// Derived values (health, progress, execution) render with evidence and
// accept no input (V4-4). Properties (owner, target, success criteria) are
// pure intent, edited via the ordinary item_edited mutator.

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { WorkDesignView, WorkRollupsResponse } from "@saas/contracts/work";
import {
  Breadcrumbs,
  Kicker,
  ListCard,
  ListRow,
  PageHeader,
  Pill,
  RowChevron,
  Screen,
} from "@/components/ui/northwind";
import { Skeleton } from "@/components/ui/skeleton";
import { wrap } from "@/lib/api";
import { qk, useApiQuery } from "@/lib/query";
import { useSession } from "@/lib/session";
import { HealthChip, IntentChip, shortDigest } from "@/components/work/hierarchy-chips";

export function InitiativeDetail({ orgId, initiativeKey }: { orgId: string; initiativeKey: string }) {
  const { client } = useSession();
  const params = useParams<{ orgSlug?: string }>();
  const orgSlug = params?.orgSlug ?? "";

  const rollups = useApiQuery(qk.orgWorkRollups(orgId, initiativeKey), () =>
    wrap(async () => client.work.rollups(orgId, initiativeKey)),
  );
  const designs = useApiQuery(qk.orgWorkDesigns(orgId, initiativeKey), () =>
    wrap(async () => client.work.listDesigns(orgId, initiativeKey)),
  );
  const summary = useApiQuery(qk.orgWork(orgId), () => wrap(async () => client.work.summary(orgId)));
  const initiative = summary.data?.initiatives.find((i) => i.key === initiativeKey);

  if (rollups.loading || summary.loading) {
    return (
      <Screen>
        <Skeleton className="mt-8 h-8 w-72" />
        <Skeleton className="mt-6 h-40 w-full" />
      </Screen>
    );
  }
  if (rollups.error) {
    return (
      <Screen>
        <Breadcrumbs
          items={[
            { label: "Work", href: `/orgs/${orgSlug}/work` },
            { label: "Initiatives", href: `/orgs/${orgSlug}/work/initiatives` },
            { label: initiativeKey, mono: true },
          ]}
        />
        <div className="text-[13px] text-muted-foreground">
          {rollups.error.code}: {rollups.error.message}
        </div>
      </Screen>
    );
  }
  const data = rollups.data;
  if (!data) return null;

  return (
    <Screen>
      <Breadcrumbs
        items={[
          { label: "Work", href: `/orgs/${orgSlug}/work` },
          { label: "Initiatives", href: `/orgs/${orgSlug}/work/initiatives` },
          { label: initiative?.title ?? initiativeKey },
        ]}
      />
      <PageHeader
        title={initiative?.title ?? initiativeKey}
        description={initiative?.description ?? "A business objective — the why. Designs propose the what; approved epics execute it."}
        actions={
          <div className="flex items-center gap-4">
            <HealthChip health={data.health} evidence={data.evidence} pinned={data.pinnedHealth} />
            <span className="text-[12.5px] text-muted-foreground">
              {data.complete}/{data.total} tasks complete
            </span>
          </div>
        }
      />

      <PropertiesRow
        entries={[
          ...(initiative?.owner ? [{ k: "Owner", v: initiative.owner }] : []),
          ...(initiative?.targetDate ? [{ k: "Target", v: initiative.targetDate }] : []),
          ...(initiative?.successCriteria?.length
            ? [{ k: "Success criteria", v: initiative.successCriteria.join(" · ") }]
            : []),
        ]}
      />

      {data.evidence?.length ? (
        <div className="mt-3 text-[12px] text-muted-foreground">
          {data.evidence.map((e, i) => (
            <div key={i}>· {e}</div>
          ))}
        </div>
      ) : null}

      <section className="mt-[30px]">
        <div className="flex items-center gap-3">
          <Kicker>Designs</Kicker>
          <NewDesignButton
            orgId={orgId}
            initiativeKey={initiativeKey}
            onCreated={() => {
              designs.reload();
            }}
          />
        </div>
        <p className="mb-2.5 mt-1 text-[12px] text-muted-foreground">
          Alternatives are artifacts, not chat scrollback — run several, compare, adopt one. Adoption mints
          the proposed epics; the design forever shows what was adopted.
        </p>
        <DesignsRail designs={designs.data?.designs ?? []} orgSlug={orgSlug} loading={designs.loading} />
      </section>

      <section className="mt-[30px]">
        <Kicker>Epics</Kicker>
        {data.epics.length === 0 ? (
          <ListCard className="mt-2.5">
            <div className="px-5 py-6 text-[13px] text-muted-foreground">
              No epics yet — adopt a design above, or file an existing epic here from its page.
            </div>
          </ListCard>
        ) : (
          <ListCard className="mt-2.5">
            <ul>
              {data.epics.map((e) => (
                <EpicRow key={e.key} epic={e} orgSlug={orgSlug} />
              ))}
            </ul>
          </ListCard>
        )}
      </section>
    </Screen>
  );
}

function NewDesignButton({
  orgId,
  initiativeKey,
  onCreated,
}: {
  orgId: string;
  initiativeKey: string;
  onCreated: () => void;
}) {
  const { client } = useSession();
  const [open, setOpen] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded px-1.5 py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        + New design
      </button>
    );
  }
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        setBusy(true);
        setError(null);
        void client.work
          .createDesign(orgId, initiativeKey, { title: title.trim() })
          .then(() => {
            setOpen(false);
            setTitle("");
            onCreated();
          })
          .catch((err: { message?: string }) => setError(err.message ?? "rejected"))
          .finally(() => setBusy(false));
      }}
    >
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Design title"
        className="rounded border border-border bg-background px-2 py-1 text-[12.5px] text-foreground"
      />
      <button type="submit" disabled={busy || !title.trim()} className="rounded bg-primary px-2.5 py-1 text-[12px] text-primary-foreground disabled:opacity-40">
        Create
      </button>
      <button type="button" onClick={() => setOpen(false)} className="rounded px-2 py-1 text-[12px] text-muted-foreground hover:bg-muted">
        Cancel
      </button>
      {error ? <span className="text-[11.5px] text-warning-accent">{error}</span> : null}
    </form>
  );
}

function PropertiesRow({ entries }: { entries: { k: string; v: string }[] }) {
  if (entries.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-[12.5px]">
      {entries.map(({ k, v }) => (
        <span key={k} className="text-muted-foreground">
          <span className="uppercase tracking-wide text-[10.5px] mr-1.5">{k}</span>
          <span className="text-secondary-foreground">{v}</span>
        </span>
      ))}
    </div>
  );
}

function DesignsRail({
  designs,
  orgSlug,
  loading,
}: {
  designs: WorkDesignView[];
  orgSlug: string;
  loading: boolean;
}) {
  if (loading) return <Skeleton className="h-20 w-full" />;
  if (designs.length === 0) {
    return (
      <ListCard>
        <div className="px-5 py-6 text-[13px] text-muted-foreground">
          No designs yet. A design is a living document plus a structured proposal of the epics it would
          mint — authored by hand or by a design run.
        </div>
      </ListCard>
    );
  }
  return (
    <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
      {designs.map((d) => (
        <Link
          key={d.key}
          href={`/orgs/${orgSlug}/work/designs/${encodeURIComponent(d.key)}`}
          className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-foreground/25"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[13px] font-medium text-secondary-foreground">{d.title}</span>
            <DesignStatePill state={d.intent.state} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[11.5px] text-muted-foreground">
            <span className="font-mono">{d.key}</span>
            <span>
              by {d.createdBy.type === "agent" ? "agent " : ""}
              {d.createdBy.id}
            </span>
            {d.docRef ? <span className="font-mono">@{shortDigest(d.docRef)}</span> : null}
          </div>
          <div className="mt-2 text-[11.5px] text-muted-foreground">
            {proposalSummary(d)}
            {d.intent.state === "adopted" && d.intent.minted?.length
              ? ` · minted ${d.intent.minted.join(", ")}`
              : ""}
          </div>
        </Link>
      ))}
    </div>
  );
}

function DesignStatePill({ state }: { state: WorkDesignView["intent"]["state"] }) {
  const tone = state === "adopted" ? "success" : state === "in_review" ? "info" : state === "superseded" ? "neutral" : "neutral";
  const label = state === "in_review" ? "In Review" : state.charAt(0).toUpperCase() + state.slice(1);
  return <Pill tone={tone}>{label}</Pill>;
}

function proposalSummary(d: WorkDesignView): string {
  const epics = d.proposal?.epics ?? [];
  if (epics.length === 0) return "no proposal yet";
  const milestones = epics.reduce((n, e) => n + (e.milestones?.length ?? 0), 0);
  const tasks = epics.reduce((n, e) => n + (e.taskSkeletons?.length ?? 0), 0);
  return `proposes ${epics.length} epic${epics.length === 1 ? "" : "s"} · ${milestones} milestone${milestones === 1 ? "" : "s"}${tasks ? ` · ${tasks} task${tasks === 1 ? "" : "s"}` : ""}`;
}

function EpicRow({ epic, orgSlug }: { epic: WorkRollupsResponse["epics"][number]; orgSlug: string }) {
  return (
    <ListRow>
      <Link
        href={`/orgs/${orgSlug}/work/epics/${encodeURIComponent(epic.key)}`}
        className="flex w-full items-center gap-3 px-5 py-3.5"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[13.5px] font-medium text-secondary-foreground">{epic.title}</span>
            <IntentChip intent={epic.intent} />
            {epic.blocked > 0 ? <Pill tone="warning">{epic.blocked} blocked</Pill> : null}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11.5px] text-muted-foreground">
            <span className="font-mono">{epic.key}</span>
            {epic.targetDate ? <span>target {epic.targetDate}</span> : null}
            <span>
              {epic.complete}/{epic.total} complete
            </span>
          </div>
        </div>
        <RowChevron />
      </Link>
    </ListRow>
  );
}
