"use client";

// The Work home (orun-work-v5 WV1). One surface, three lenses —
// Initiatives (the why) · Epics (the unit of approval) · Tasks (the day) —
// per specs/epics/orun-work-v5/design.md §3.1–§3.3. Everything rendered
// here is a projection of the summary fold: the stats, the health pills,
// the meters, and the captions all name their truth source (WV-2), and
// nothing on this screen accepts a status (WP-3, carried).

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import type { WorkHealth, WorkInitiativeView, WorkSpecView } from "@saas/contracts/work";
import {
  HeaderStat,
  ListCard,
  OwnerAvatar,
  Pill,
  RowChevron,
  Screen,
  StatusDot,
  type Tone,
} from "@/components/ui/northwind";
import {
  GroupBand,
  LensBar,
  LensTab,
  TruthCaption,
  WorkMeter,
} from "@/components/ui/northwind-work";
import { Skeleton } from "@/components/ui/skeleton";
import { wrap } from "@/lib/api";
import { qk, useApiQuery } from "@/lib/query";
import { useSession } from "@/lib/session";
import {
  attentionCount,
  epicCountLabel,
  epicGroups,
  openTaskCount,
  parseLens,
  progressTotals,
  targetLabel,
  type WorkLens,
} from "@/lib/work/home";
import { createKindForLens, nextNavIndex, workKeyAction } from "@/lib/work/keys";
import { meterSegments } from "@/lib/work/rungs";
import { HealthChip, IntentChip } from "@/components/work/hierarchy-chips";
import { WorkWorkbench } from "@/components/work/work-workbench";
import { WorkCreateMenu, type WorkItemKind } from "@/components/work/create-work-item-dialog";

const LENS_STORAGE_KEY = "nw.work.lens";

const HEALTH_TONE: Record<WorkHealth, Tone> = {
  on_track: "success",
  at_risk: "warning",
  off_track: "error",
};

const EPIC_GROUP_META: Record<string, { label: string; className: string }> = {
  approved_drifted: { label: "Approved · drifted", className: "text-warning" },
  approved: { label: "Approved", className: "text-success" },
  in_review: { label: "In Review", className: "text-info" },
  draft: { label: "Draft", className: "text-muted-foreground" },
  superseded: { label: "Superseded", className: "text-muted-foreground" },
  canceled: { label: "Canceled", className: "text-muted-foreground" },
};

export function WorkHome({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const summary = useApiQuery(qk.orgWork(orgId), () => wrap(async () => client.work.summary(orgId)));
  const params = useParams<{ orgSlug?: string }>();
  const orgSlug = params?.orgSlug ?? "";
  const router = useRouter();
  const searchParams = useSearchParams();

  // The lens lives in the URL (?lens=), defaults to Initiatives, and the
  // last choice is remembered per user (risks Q-2 revisits the default).
  const urlLens = parseLens(searchParams?.get("lens"));
  const [lens, setLensState] = React.useState<WorkLens>(urlLens ?? "initiatives");
  const setLens = React.useCallback(
    (next: WorkLens) => {
      setLensState(next);
      try {
        window.localStorage.setItem(LENS_STORAGE_KEY, next);
      } catch {
        // storage may be unavailable; the URL still carries the lens
      }
      const qs = new URLSearchParams(window.location.search);
      qs.set("lens", next);
      router.replace(`${window.location.pathname}?${qs.toString()}`, { scroll: false });
    },
    [router],
  );
  React.useEffect(() => {
    if (urlLens) return; // an explicit URL wins over memory
    // Cmd-K authoring/layout verbs target the matching lens before their
    // params are consumed downstream (?new=task|spec, ?layout= → Tasks).
    const created = searchParams?.get("new");
    const layoutParam = searchParams?.get("layout");
    if (created === "task" || created === "spec" || layoutParam) {
      setLensState("tasks");
      return;
    }
    if (created === "initiative") return; // stay on the default lens; menu opens below
    try {
      const stored = parseLens(window.localStorage.getItem(LENS_STORAGE_KEY));
      if (stored) setLensState(stored);
    } catch {
      // fall through to the default
    }
    // (mount-only lens bootstrap — an explicit URL or later clicks win)
  }, []);

  // ?new=initiative is consumed here (the other kinds ride the embedded
  // workbench's own effect on the Tasks lens).
  const [requestedKind, setRequestedKind] = React.useState<WorkItemKind | null>(null);
  React.useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    if (qs.get("new") === "initiative") {
      setRequestedKind("initiative");
      qs.delete("new");
      const rest = qs.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
    }
  }, []);

  // WV5: the keyboard grammar (design.md §4). 1/2/3 switch lens; j/k rove
  // row focus; c creates for the current lens; f/d open Filter/Display.
  // There is no key that changes status — the vocabulary of the keyboard
  // is the vocabulary of the model.
  const [externalKind, setExternalKind] = React.useState<WorkItemKind | null>(null);
  const lensRef = React.useRef(lens);
  lensRef.current = lens;
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = workKeyAction(e, e.target as HTMLElement | null);
      if (!action) return;
      const current = lensRef.current;
      switch (action.type) {
        case "lens":
          e.preventDefault();
          setLens(action.lens);
          break;
        case "focus-next":
        case "focus-prev": {
          const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-navrow]"));
          if (rows.length === 0) return;
          e.preventDefault();
          const active = document.activeElement as HTMLElement | null;
          const idx = active ? rows.indexOf(active) : -1;
          rows[nextNavIndex(idx, action.type === "focus-next" ? 1 : -1, rows.length)]?.focus();
          break;
        }
        case "create": {
          e.preventDefault();
          const kind = createKindForLens(current);
          if (current === "tasks") setExternalKind(kind);
          else setRequestedKind(kind);
          break;
        }
        case "filter":
        case "display": {
          if (current !== "tasks") return;
          e.preventDefault();
          document.getElementById(action.type === "filter" ? "work-filter-trigger" : "work-display-trigger")?.click();
          break;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setLens]);

  const data = summary.data;
  const openTasks = data ? openTaskCount(data.tasks) : 0;
  const attention = data ? attentionCount(data) : 0;

  return (
    <Screen className="max-w-[1140px]">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between sm:gap-5">
        <div className="min-w-0">
          <h1 className="font-serif text-[26px] font-medium leading-tight tracking-[-0.01em] sm:text-[28px]">
            Work
          </h1>
          <p className="mt-2 max-w-[600px] text-[13.5px] leading-normal text-muted-foreground">
            Initiatives hold the why. Epics are the unit a human approves and an agent implements. Every
            status below is folded from delivery truth — never typed in.
          </p>
        </div>
        {data ? (
          <div className="flex shrink-0 gap-6">
            <HeaderStat value={openTasks} caption={openTasks === 1 ? "open task" : "open tasks"} className="text-left sm:text-right" />
            <Link href={`/orgs/${orgSlug}/work/triage`} className="group">
              <HeaderStat
                value={attention}
                caption="need attention"
                {...(attention > 0 ? { tone: "warning" as Tone } : {})}
                className="text-left transition-opacity group-hover:opacity-75 sm:text-right"
              />
            </Link>
          </div>
        ) : null}
      </div>

      <LensBar
        className="mt-4"
        actions={
          lens !== "tasks" && data ? (
            <WorkCreateMenu
              orgId={orgId}
              specs={data.specs}
              onCreated={summary.reload}
              requestedKind={requestedKind}
              onRequestConsumed={() => setRequestedKind(null)}
            />
          ) : null
        }
      >
        <LensTab active={lens === "initiatives"} onClick={() => setLens("initiatives")}>
          Initiatives
        </LensTab>
        <LensTab active={lens === "epics"} onClick={() => setLens("epics")}>
          Epics
        </LensTab>
        <LensTab active={lens === "tasks"} onClick={() => setLens("tasks")}>
          Tasks
        </LensTab>
      </LensBar>

      {lens === "tasks" ? (
        <WorkWorkbench
          orgId={orgId}
          embedded
          requestKind={externalKind}
          onRequestKindConsumed={() => setExternalKind(null)}
        />
      ) : summary.loading ? (
        <div className="mt-5 flex flex-col gap-3">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : summary.error ? (
        <div className="mt-5 text-[13px] text-muted-foreground">
          {summary.error.code}: {summary.error.message}
        </div>
      ) : lens === "initiatives" ? (
        <InitiativesLens initiatives={data?.initiatives ?? []} orgSlug={orgSlug} />
      ) : (
        <EpicsLens specs={data?.specs ?? []} orgSlug={orgSlug} />
      )}
    </Screen>
  );
}

/* ── Initiatives lens (§3.1) ────────────────────────────────────────── */

function InitiativesLens({
  initiatives,
  orgSlug,
}: {
  initiatives: WorkInitiativeView[];
  orgSlug: string;
}) {
  const now = new Date();
  if (initiatives.length === 0) {
    return (
      <ListCard className="mt-5">
        <div className="px-5 py-8 text-[13px] text-muted-foreground">
          No initiatives yet. An initiative holds the why — create one, then let designs propose the what.
        </div>
      </ListCard>
    );
  }
  return (
    <div className="mt-5">
      <ListCard>
        {initiatives.map((initiative) => {
          const { total, done } = progressTotals(initiative.progress);
          const seg = meterSegments(initiative.progress, total);
          return (
            <Link
              key={initiative.key}
              data-navrow
              href={`/orgs/${orgSlug}/work/initiatives/${encodeURIComponent(initiative.key)}`}
              className="group flex items-center gap-3.5 border-t border-border/50 px-[18px] py-3 transition-colors duration-100 first:border-t-0 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
            >
              <StatusDot tone={initiative.health ? HEALTH_TONE[initiative.health] : "neutral"} />
              <span className="min-w-0 flex-1">
                <span className="text-[13.5px] font-medium">{initiative.title}</span>
                <span className="ml-2.5 text-[11.5px] text-muted-foreground/85">
                  {epicCountLabel(initiative.specs?.length ?? 0)}
                </span>
              </span>
              <HealthChip health={initiative.health} evidence={initiative.healthEvidence} />
              {total > 0 ? (
                <WorkMeter
                  donePct={seg.donePct}
                  activePct={seg.activePct}
                  fraction={`${done}/${total}`}
                  width={150}
                  className="hidden sm:inline-flex"
                />
              ) : (
                <span className="hidden w-[150px] sm:block" />
              )}
              <span className="hidden w-16 shrink-0 text-right text-xs text-muted-foreground md:block">
                {targetLabel(initiative.targetDate, now)}
              </span>
              <OwnerAvatar name={initiative.owner ?? "?"} size={20} unowned={!initiative.owner} className="hidden sm:grid" />
              <RowChevron />
            </Link>
          );
        })}
      </ListCard>
      <TruthCaption>
        Health folds from member epics on every read — an initiative is at risk because its evidence says
        so, one hover away.
      </TruthCaption>
    </div>
  );
}

/* ── Epics lens (§3.2) ──────────────────────────────────────────────── */

function EpicsLens({ specs, orgSlug }: { specs: WorkSpecView[]; orgSlug: string }) {
  if (specs.length === 0) {
    return (
      <ListCard className="mt-5">
        <div className="px-5 py-8 text-[13px] text-muted-foreground">
          No epics yet. An epic is the unit a human approves and an agent implements — author one, or adopt
          a design to mint them.
        </div>
      </ListCard>
    );
  }
  const groups = epicGroups(specs);
  return (
    <div className="mt-5">
      <ListCard>
        {groups.map((group) => {
          const meta = EPIC_GROUP_META[group.state] ?? {
            label: group.state,
            className: "text-muted-foreground",
          };
          return (
            <React.Fragment key={group.state}>
              <GroupBand label={meta.label} labelClassName={meta.className} count={group.specs.length} />
              {group.specs.map((spec) => {
                const { total, done } = progressTotals(spec.progress);
                const seg = meterSegments(spec.progress, total);
                return (
                  <Link
                    key={spec.key}
                    data-navrow
                    href={`/orgs/${orgSlug}/work/epics/${encodeURIComponent(spec.key)}`}
                    className="group flex items-center gap-3.5 border-t border-border/50 px-[18px] py-2.5 transition-colors duration-100 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                  >
                    <span className="w-44 shrink-0 truncate font-mono text-[11.5px] text-muted-foreground/85">
                      {spec.key}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13.5px]">{spec.title}</span>
                    <span className="hidden lg:inline-flex">
                      <IntentChip intent={spec.intent} />
                    </span>
                    {spec.initiative ? (
                      <Pill tone="neutral" className="hidden font-mono text-[11px] xl:inline-flex">
                        {spec.initiative}
                      </Pill>
                    ) : null}
                    {total > 0 ? (
                      <WorkMeter
                        donePct={seg.donePct}
                        activePct={seg.activePct}
                        fraction={`${done}/${total}`}
                        width={102}
                        className="hidden sm:inline-flex"
                      />
                    ) : (
                      <span className="hidden w-[102px] sm:block" />
                    )}
                    <RowChevron />
                  </Link>
                );
              })}
            </React.Fragment>
          );
        })}
      </ListCard>
      <TruthCaption>
        Approval covers the document and the milestone ladder at a revision. When either changes, the chip
        says so — the tracker never lies for you.
      </TruthCaption>
    </div>
  );
}
