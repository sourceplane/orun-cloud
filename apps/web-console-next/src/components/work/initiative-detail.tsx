"use client";

// The initiative page (orun-work-v4 WH2, resurfaced by orun-work-v5 WV4 to
// design.md §3.4): the why. Health promotes its evidence onto the page as
// a callout whenever the fold says anything but on-track; the Designs rail
// keeps alternatives as artifacts; the rail closes with the product's
// signature section — DERIVED · NOT ENTERED. Derived values render with
// evidence and accept no input (V4-4); owner, target, and criteria are the
// only authored pixels here.

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { WorkDesignView, WorkRollupsResponse } from "@saas/contracts/work";
import {
  Breadcrumbs,
  Kicker,
  ListCard,
  OwnerAvatar,
  Pill,
  RowChevron,
  Screen,
} from "@/components/ui/northwind";
import { WorkMeter } from "@/components/ui/northwind-work";
import { Skeleton } from "@/components/ui/skeleton";
import { wrap } from "@/lib/api";
import { qk, useApiQuery } from "@/lib/query";
import { useSession } from "@/lib/session";
import { targetLabel } from "@/lib/work/home";
import { HealthChip, IntentChip, shortDigest } from "@/components/work/hierarchy-chips";
import { EditWorkItemDialog } from "@/components/work/create-work-item-dialog";

export function InitiativeDetail({ orgId, initiativeKey }: { orgId: string; initiativeKey: string }) {
  const { client } = useSession();
  const params = useParams<{ orgSlug?: string }>();
  const orgSlug = params?.orgSlug ?? "";
  const [editOpen, setEditOpen] = React.useState(false);

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
      <Screen detail className="max-w-[1140px]">
        <Skeleton className="mt-8 h-8 w-72" />
        <Skeleton className="mt-6 h-40 w-full" />
      </Screen>
    );
  }
  if (rollups.error) {
    return (
      <Screen detail className="max-w-[1140px]">
        <Breadcrumbs
          items={[
            { label: "Work", href: `/orgs/${orgSlug}/work` },
            { label: "Initiatives", href: `/orgs/${orgSlug}/work?lens=initiatives` },
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

  const troubled = data.health && data.health !== "on_track";

  return (
    <Screen detail className="max-w-[1140px]">
      <Breadcrumbs
        className="mb-4"
        items={[
          { label: "Work", href: `/orgs/${orgSlug}/work` },
          { label: "Initiatives", href: `/orgs/${orgSlug}/work?lens=initiatives` },
          { label: initiative?.title ?? initiativeKey },
        ]}
      />
      <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_250px]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-serif text-[26px] font-medium leading-tight tracking-[-0.01em]">
              {initiative?.title ?? initiativeKey}
            </h1>
            <HealthChip health={data.health} evidence={data.evidence} pinned={data.pinnedHealth} />
            {initiative ? (
              <button
                type="button"
                onClick={() => setEditOpen(true)}
                className="rounded-md px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                Edit
              </button>
            ) : null}
          </div>
          <p className="mt-2 max-w-[560px] text-[13.5px] leading-normal text-muted-foreground">
            {initiative?.description ??
              "A business objective — the why. Designs propose the what; approved epics execute it."}
          </p>

          {/* health promotes its evidence onto the page (§3.4) */}
          {troubled && data.evidence?.length ? (
            <div className="mt-3.5 rounded-[10px] border border-[hsl(var(--warning-border))] bg-warning-wash px-4 py-3">
              <div className="flex items-center gap-2 text-[12.5px] font-semibold text-[hsl(var(--warning-ink))]">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                  <line x1="12" x2="12" y1="9" y2="13" />
                  <line x1="12" x2="12.01" y1="17" y2="17" />
                </svg>
                {data.health === "off_track" ? "Off track" : "At risk"} — folded from {data.epics.length}{" "}
                {data.epics.length === 1 ? "epic" : "epics"}
              </div>
              <div className="mt-1.5 flex flex-col gap-1 text-[12.5px] leading-normal text-[hsl(var(--warning-ink))]/90">
                {data.evidence.map((e, i) => (
                  <div key={i}>· {e}</div>
                ))}
              </div>
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
            <p className="mb-3 mt-1 max-w-[560px] text-[12px] leading-normal text-muted-foreground">
              Alternatives are artifacts, not chat scrollback — run several, compare, adopt one. Adoption
              mints the proposed epics.
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
        </div>

        {/* the rail (§3.4): properties · success criteria · derived, not entered */}
        <aside className="sticky top-6 hidden flex-col gap-[18px] pt-1.5 lg:flex">
          <div>
            <Kicker className="mb-2">Properties</Kicker>
            <div className="flex flex-col gap-[9px] text-[12.5px]">
              <RailRow label="Key">
                <span className="font-mono text-[11.5px] text-secondary-foreground">{initiativeKey}</span>
              </RailRow>
              {initiative?.owner ? (
                <RailRow label="Owner">
                  <span className="inline-flex items-center gap-1.5 font-medium">
                    <OwnerAvatar name={initiative.owner} size={16} />
                    {initiative.owner}
                  </span>
                </RailRow>
              ) : null}
              {initiative?.targetDate ? (
                <RailRow label="Target">
                  <span className="font-medium">{targetLabel(initiative.targetDate, new Date())}</span>
                </RailRow>
              ) : null}
              <RailRow label="Epics">
                <span className="font-medium">{data.epics.length}</span>
              </RailRow>
              <RailRow label="Progress">
                <span className="font-medium">
                  {data.complete}/{data.total} tasks
                </span>
              </RailRow>
            </div>
          </div>

          {initiative?.successCriteria?.length ? (
            <div className="border-t border-border/70 pt-3.5">
              <Kicker className="mb-2">Success criteria</Kicker>
              <div className="flex flex-col gap-1.5 text-[12.5px] leading-normal text-secondary-foreground">
                {initiative.successCriteria.map((c, i) => (
                  <div key={i}>· {c}</div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="border-t border-border/70 pt-3.5">
            <Kicker className="mb-2">Derived · not entered</Kicker>
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              Health and progress fold from member epics on every read. Owner, target, and criteria are
              the only authored pixels here.
            </p>
          </div>
        </aside>
      </div>

      {initiative ? (
        <EditWorkItemDialog
          orgId={orgId}
          itemKey={initiativeKey}
          currentTitle={initiative.title}
          currentDescription={initiative.description}
          currentOwner={initiative.owner}
          currentTargetDate={initiative.targetDate}
          currentSuccessCriteria={initiative.successCriteria}
          withDescription
          withOwner
          withTargetDate
          withSuccessCriteria
          open={editOpen}
          onOpenChange={setEditOpen}
          onSaved={() => {
            summary.reload();
            rollups.reload();
          }}
        />
      ) : null}
    </Screen>
  );
}

function RailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right">{children}</span>
    </div>
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

function DesignsRail({
  designs,
  orgSlug,
  loading,
}: {
  designs: WorkDesignView[];
  orgSlug: string;
  loading: boolean;
}) {
  if (loading) return <Skeleton className="h-24 w-full" />;
  if (designs.length === 0) {
    return (
      <div className="grid place-items-center rounded-xl border border-dashed border-border px-5 py-9 text-[12.5px] text-muted-foreground">
        No designs yet. A design is a living document plus a structured proposal of the epics it would
        mint — authored by hand or by a design run.
      </div>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {designs.map((d) => (
        <Link
          key={d.key}
          href={`/orgs/${orgSlug}/work/designs/${encodeURIComponent(d.key)}`}
          className="rounded-xl border border-border bg-card p-4 transition-colors hover:border-foreground/25"
        >
          <div className="text-[13.5px] font-semibold leading-snug">{d.title}</div>
          <div className="mt-1.5">
            <DesignStatePill state={d.intent.state} docRef={d.intent.state === "adopted" ? d.docRef : undefined} />
          </div>
          <div className="mt-2 text-[11.5px] leading-normal text-muted-foreground">
            {d.createdAt ? `${d.createdAt.slice(0, 10)} · ` : ""}by {d.createdBy.type === "agent" ? "agent " : ""}
            {d.createdBy.id}
            {d.intent.state === "adopted" && d.intent.minted?.length
              ? ` · minted ${d.intent.minted.length} epic${d.intent.minted.length === 1 ? "" : "s"}`
              : ""}
          </div>
          <div className="mt-1 text-[11.5px] text-muted-foreground/85">{proposalSummary(d)}</div>
        </Link>
      ))}
    </div>
  );
}

function DesignStatePill({ state, docRef }: { state: WorkDesignView["intent"]["state"]; docRef?: string | undefined }) {
  const tone = state === "adopted" ? "success" : state === "in_review" ? "info" : "neutral";
  const label = state === "in_review" ? "In Review" : state.charAt(0).toUpperCase() + state.slice(1);
  return (
    <Pill tone={tone}>
      {label}
      {docRef ? <span className="ml-1 font-mono opacity-80">@{shortDigest(docRef)}</span> : null}
    </Pill>
  );
}

function proposalSummary(d: WorkDesignView): string {
  const epics = d.proposal?.epics ?? [];
  if (epics.length === 0) return "no proposal yet";
  const milestones = epics.reduce((n, e) => n + (e.milestones?.length ?? 0), 0);
  const tasks = epics.reduce((n, e) => n + (e.taskSkeletons?.length ?? 0), 0);
  return `proposes ${epics.length} epic${epics.length === 1 ? "" : "s"} · ${milestones} milestone${milestones === 1 ? "" : "s"}${tasks ? ` · ${tasks} task${tasks === 1 ? "" : "s"}` : ""}`;
}

function EpicRow({ epic, orgSlug }: { epic: WorkRollupsResponse["epics"][number]; orgSlug: string }) {
  const donePct = epic.total > 0 ? (epic.complete / epic.total) * 100 : 0;
  return (
    <li className="group border-t border-border/50 first:border-t-0">
      <Link
        href={`/orgs/${orgSlug}/work/epics/${encodeURIComponent(epic.key)}`}
        className="flex w-full items-center gap-3.5 px-[18px] py-3 transition-colors duration-100 hover:bg-muted"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[13.5px] font-medium">{epic.title}</span>
            <IntentChip intent={epic.intent} compact />
            {epic.blocked > 0 ? <Pill tone="warning">{epic.blocked} blocked</Pill> : null}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 font-mono text-[11.5px] text-muted-foreground">
            <span>{epic.key}</span>
            {epic.targetDate ? <span>target {targetLabel(epic.targetDate, new Date())}</span> : null}
          </div>
        </div>
        <WorkMeter donePct={donePct} fraction={`${epic.complete}/${epic.total}`} width={130} className="hidden sm:inline-flex" />
        <RowChevron />
      </Link>
    </li>
  );
}
