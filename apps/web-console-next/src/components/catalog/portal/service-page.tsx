"use client";

/**
 * Catalog-portal dedicated service page (saas-catalog-portal CP5).
 *
 * The drilled-in, full-width view of one component from the design
 * (`design/Service_Catalog.dc.html`, the `isPage` branch): breadcrumb bar,
 * identity hero, the operational ops strip (runtime-gated), a five-tab switch
 * (Overview · Docs · Dependencies · Activity · Scorecard) over a two-column body
 * with an Ownership / About / quick-links right rail. Driven by `buildPage`.
 *
 * Honest by construction: every data-less section degrades through the same
 * `hasOps` / `hasScore` / `noRelations` paths the drawer uses — the layout is
 * always the design's; only real values fill it.
 */

import * as React from "react";
import { ArrowLeft, ArrowUpRight, AreaChart, BookText, ChevronRight, Github } from "lucide-react";
import type { CatalogDoc } from "@saas/contracts/state";
import type { PageRef, ServicePage } from "@/lib/catalog-portal/page";
import { CHECK_COLOR } from "@/lib/catalog-portal/palette";
import { CHECK_MARK, DOC_ICON } from "@/lib/catalog-portal/icons";
import { PathIcon } from "./icon";
import { MarkdownView } from "./markdown-view";
import { DocBody, DocProvenance, DocShelf, useEntityDocs } from "@/components/catalog/docs/entity-docs";

const MONO_LABEL = "font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground/80";
const CARD = "rounded-[13px] border border-border bg-card overflow-hidden";
const CARD_HEAD = "flex items-center gap-2 border-b border-b-border bg-popover px-4 py-[11px]";
const RING_R_LG = 32;
const RING_CIRC_LG = 2 * Math.PI * RING_R_LG;

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "docs", label: "Docs" },
  { key: "dependencies", label: "Dependencies" },
  { key: "activity", label: "Activity" },
  { key: "scorecard", label: "Scorecard" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export function ServicePage({
  page,
  orgId,
  orgSlug,
  orgLabel,
  onBack,
  onViewMap,
  onSelectRef,
}: {
  page: ServicePage;
  orgId: string;
  orgSlug: string;
  orgLabel: string;
  onBack: () => void;
  onViewMap: () => void;
  onSelectRef: (key: string) => void;
}) {
  const [tab, setTab] = React.useState<TabKey>("overview");
  const [docKey, setDocKey] = React.useState<string | null>(null);
  // The entity's real doc set (saas-catalog-docs CD4) — git-authored, indexed
  // at projection, rendered by digest. Empty ⇒ the badged derived card.
  const { docs, loading: docsLoading } = useEntityDocs(orgId, page.ref);

  return (
    <div className="flex flex-col md:h-full md:min-h-0">
      {/* breadcrumb bar */}
      <div className="flex h-[50px] shrink-0 items-center gap-2.5 border-b border-b-border bg-background/70 px-4 md:px-5">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to catalog"
          className="-ml-1 grid h-8 w-8 shrink-0 place-items-center rounded-[7px] text-muted-foreground hover:text-foreground sm:hidden"
        >
          <ArrowLeft className="h-[18px] w-[18px]" />
        </button>
        <span className="hidden text-[13px] text-muted-foreground/80 sm:inline">{orgLabel}</span>
        <span className="hidden text-muted-foreground/45 sm:inline">/</span>
        <button
          type="button"
          onClick={onBack}
          className="hidden bg-transparent p-0 text-[13px] text-muted-foreground/80 hover:text-foreground sm:inline"
        >
          Catalog
        </button>
        <span className="hidden text-muted-foreground/45 sm:inline">/</span>
        <span className="truncate font-mono text-[13px] font-medium text-foreground">{page.name}</span>
        <button
          type="button"
          onClick={onBack}
          className="ml-auto hidden h-[30px] items-center gap-1.5 rounded-[7px] border border-border bg-transparent px-[11px] text-[12.5px] text-muted-foreground hover:text-foreground sm:flex"
        >
          <ArrowLeft className="h-[13px] w-[13px]" />
          Catalog
        </button>
      </div>

      {/* scroll body */}
      <div className="md:min-h-0 md:flex-1 md:overflow-y-auto">
        <div className="mx-auto flex max-w-[1200px] flex-col gap-5 px-4 pb-10 pt-5 md:gap-[22px] md:px-[30px] md:pb-12 md:pt-[26px]">
          <Hero page={page} />
          {page.hasOps ? <OpsStrip page={page} /> : null}

          {/* tabs — horizontally scrollable so all five stay reachable on a phone */}
          <div className="-mx-4 flex gap-0.5 overflow-x-auto border-b border-b-border px-4 md:mx-0 md:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {TABS.map((t) => {
              const active = tab === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className="relative shrink-0 bg-transparent px-3.5 py-[11px] text-[13.5px] md:py-[9px] md:text-[13px]"
                  style={{ color: active ? "hsl(var(--foreground))" : "hsl(var(--muted-foreground))", fontWeight: active ? 600 : 500 }}
                >
                  {t.label}
                  <span
                    className="absolute inset-x-2 -bottom-px h-0.5 rounded-sm"
                    style={{ background: active ? "hsl(var(--primary))" : "transparent" }}
                  />
                </button>
              );
            })}
          </div>

          {/* two column */}
          <div className="grid grid-cols-1 items-start gap-[26px] xl:grid-cols-[minmax(0,1fr)_290px]">
            <div className="flex min-w-0 flex-col gap-4">
              {tab === "overview" ? <OverviewTab page={page} orgId={orgId} orgSlug={orgSlug} docs={docs} /> : null}
              {tab === "docs" ? (
                <DocsTab
                  page={page}
                  orgId={orgId}
                  orgSlug={orgSlug}
                  docs={docs}
                  docsLoading={docsLoading}
                  activeDocKey={docKey}
                  onSelectDoc={setDocKey}
                />
              ) : null}
              {tab === "dependencies" ? <DepsTab page={page} onViewMap={onViewMap} onSelectRef={onSelectRef} /> : null}
              {tab === "activity" ? <ActivityTab page={page} /> : null}
              {tab === "scorecard" ? <ScorecardTab page={page} /> : null}
            </div>
            <RightRail page={page} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Hero ─────────────────────────────────────────────────────────

function Hero({ page }: { page: ServicePage }) {
  return (
    <div className="flex flex-col gap-4 md:flex-row md:items-start">
      <div className="flex min-w-0 items-start gap-4">
      <span className="grid h-[46px] w-[46px] shrink-0 place-items-center rounded-[13px] border border-border bg-muted text-foreground/90 md:h-[54px] md:w-[54px]">
        <PathIcon d={page.iconD} size={26} strokeWidth={1.6} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-[9px]">
          <h1 className="m-0 text-[23px] font-semibold tracking-[-0.015em] text-foreground">{page.name}</h1>
          <span className="rounded-[5px] border border-input px-[7px] py-px text-[11px] text-muted-foreground/80">
            {page.kindLabel}
          </span>
        </div>
        <div className="mt-[5px] font-mono text-[12px] text-muted-foreground/60">{page.ref}</div>
        {page.description ? (
          <p className="mt-3 max-w-[680px] text-[13.5px] leading-[1.6] text-muted-foreground">{page.description}</p>
        ) : null}
        <div className="mt-3.5 flex flex-wrap gap-2">
          {page.lifeShow ? (
            <HeroChip color={page.lifeText}>
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: page.lifeColor }} />
              <span className="capitalize">{page.lifeLabel}</span>
            </HeroChip>
          ) : null}
          <HeroChip color={page.healthText}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: page.healthColor }} />
            {page.healthLabel}
          </HeroChip>
          {page.language ? <HeroChip>{page.language}</HeroChip> : null}
          <HeroChip>{page.system}</HeroChip>
        </div>
      </div>
      </div>
      <div className="flex w-full gap-2 md:w-auto md:shrink-0">
        <button
          type="button"
          className="flex h-10 flex-1 items-center justify-center gap-[7px] rounded-[8px] border border-border bg-transparent px-[13px] text-[13px] font-medium text-foreground/90 hover:border-input md:h-[34px] md:flex-none md:text-[12.5px]"
        >
          <Github className="h-3.5 w-3.5" />
          Repo
        </button>
        <button
          type="button"
          className="flex h-10 flex-1 items-center justify-center gap-[7px] rounded-[8px] border border-primary bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground md:h-[34px] md:flex-none md:text-[12.5px]"
        >
          <AreaChart className="h-3.5 w-3.5" />
          Dashboards
        </button>
      </div>
    </div>
  );
}

function HeroChip({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <span
      className="inline-flex h-6 items-center gap-1.5 rounded-md border border-input px-2.5 text-[11.5px]"
      style={{ color: color ?? "hsl(var(--muted-foreground))" }}
    >
      {children}
    </span>
  );
}

// ── Ops strip ────────────────────────────────────────────────────

function OpsStrip({ page }: { page: ServicePage }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <OpsTile label="SLO · 30d" value={page.sloCur != null ? `${page.sloCur}%` : "—"} valueColor={page.sloColor} sub={page.sloTarget != null ? `target ${page.sloTarget}%` : "no target"} />
      <OpsTile label="Open incidents" value={String(page.incidents)} valueColor={page.incColor} sub="live" />
      <OpsTile label="Deploys" value={page.deploysWeek} valueColor="hsl(var(--foreground))" sub={`last ${page.deployLabel}`} />
      <div className="rounded-[12px] border border-border bg-card px-4 py-[13px]">
        <div className={MONO_LABEL}>Readiness</div>
        {page.hasScore ? (
          <>
            <div className="mt-1.5 flex items-baseline gap-[7px]">
              <span className="text-[21px] font-semibold leading-none text-foreground">{page.scoreNum}</span>
              <span className="text-[11px] font-semibold" style={{ color: page.tierColor }}>
                {page.tierLabel}
              </span>
            </div>
            <div className="mt-2 h-1 overflow-hidden rounded-sm bg-accent">
              <div className="h-full rounded-sm" style={{ background: page.tierColor, width: `${page.scorePct}%` }} />
            </div>
          </>
        ) : (
          <div className="mt-1.5 text-[21px] font-semibold leading-none text-muted-foreground/45">—</div>
        )}
      </div>
    </div>
  );
}

function OpsTile({ label, value, valueColor, sub }: { label: string; value: string; valueColor: string; sub: string }) {
  return (
    <div className="rounded-[12px] border border-border bg-card px-4 py-[13px]">
      <div className={MONO_LABEL}>{label}</div>
      <div className="mt-1.5 text-[21px] font-semibold leading-none" style={{ color: valueColor }}>
        {value}
      </div>
      <div className="mt-[3px] text-[10.5px] text-muted-foreground/60">{sub}</div>
    </div>
  );
}

// ── Overview tab ─────────────────────────────────────────────────

function OverviewTab({
  page,
  orgId,
  orgSlug,
  docs,
}: {
  page: ServicePage;
  orgId: string;
  orgSlug: string;
  docs: CatalogDoc[];
}) {
  // The real git-authored overview leads when the entity attached one; the
  // badged derived card is the fallback — never presented as a file (the
  // honesty rule, saas-catalog-docs design.md §4).
  const overview = docs.find((d) => d.docKey === "overview") ?? null;
  if (overview) {
    return (
      <div className={CARD}>
        <div className={CARD_HEAD}>
          <PathIcon d={DOC_ICON.file} size={14} strokeWidth={1.8} className="text-muted-foreground/80" />
          <span className="text-[12.5px] font-medium text-foreground/90">{overview.title}</span>
          <span className="ml-auto">
            <DocProvenance doc={overview} />
          </span>
        </div>
        <div className="px-[26px] py-[22px]">
          <DocBody orgId={orgId} doc={overview} orgSlug={orgSlug} siblings={docs} />
        </div>
      </div>
    );
  }
  return <DerivedCard page={page} />;
}

/** The one computed surface: catalog facts, visibly badged, never a "file". */
function DerivedCard({ page }: { page: ServicePage }) {
  return (
    <div className={CARD}>
      <div className={CARD_HEAD}>
        <span className="text-[12.5px] font-medium text-foreground/90">About this {page.kindLabel.toLowerCase()}</span>
        <span className="ml-auto rounded-[5px] border border-input px-[7px] py-px text-[10.5px] text-muted-foreground/70">
          derived — not a repo file
        </span>
      </div>
      <div className="px-[26px] py-[22px]">
        <MarkdownView blocks={page.derivedBlocks} />
      </div>
    </div>
  );
}

/** The no-docs nudge: teach the manifest, never offer a textbox. */
function DocsNudge({ page }: { page: ServicePage }) {
  const snippet = [
    "spec:",
    "  docs:",
    "    overview: docs/overview.md",
    "    pages:",
    "      - { path: docs/architecture.md, role: architecture }",
    "      - { path: docs/runbook.md, role: runbook }",
  ].join("\n");
  return (
    <div className="rounded-[13px] border border-dashed border-border bg-card/50 px-5 py-4">
      <div className="text-[13px] font-medium text-foreground/90">
        Document this {page.kindLabel.toLowerCase()} from its repo
      </div>
      <p className="mt-1 text-[12.5px] leading-[1.55] text-muted-foreground">
        Point <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11.5px]">docs.overview</code> and{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11.5px]">docs.pages</code> at markdown files in
        the repo — the next <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11.5px]">orun plan</code>{" "}
        carries them here, pinned to the commit, with no CMS and no drift.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg border border-border bg-muted p-3 font-mono text-[11.5px] leading-[1.5] text-foreground/85">
        {snippet}
      </pre>
    </div>
  );
}

// ── Docs tab ─────────────────────────────────────────────────────

function DocsTab({
  page,
  orgId,
  orgSlug,
  docs,
  docsLoading,
  activeDocKey,
  onSelectDoc,
}: {
  page: ServicePage;
  orgId: string;
  orgSlug: string;
  docs: CatalogDoc[];
  docsLoading: boolean;
  activeDocKey: string | null;
  onSelectDoc: (docKey: string) => void;
}) {
  if (docsLoading && docs.length === 0) {
    return (
      <div className="rounded-[13px] border border-border bg-card px-5 py-10 text-center text-[13px] text-muted-foreground/60">
        Loading documents…
      </div>
    );
  }
  // No git-authored docs: the badged derived card + the manifest nudge — never
  // a fabricated file (saas-catalog-docs CD4, closing WO review F2).
  if (docs.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <DerivedCard page={page} />
        <DocsNudge page={page} />
      </div>
    );
  }
  const active = docs.find((d) => d.docKey === activeDocKey) ?? docs[0]!;
  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[210px_minmax(0,1fr)]">
      <DocShelf docs={docs} activeKey={active.docKey} onSelect={onSelectDoc} />
      <div className={CARD}>
        <div className={CARD_HEAD}>
          <span className="text-[12.5px] font-medium text-foreground/90">{active.title}</span>
          <span className="ml-auto">
            <DocProvenance doc={active} />
          </span>
        </div>
        <div className="px-[26px] py-[22px]">
          <DocBody orgId={orgId} doc={active} orgSlug={orgSlug} siblings={docs} />
        </div>
      </div>
    </div>
  );
}

// ── Dependencies tab ─────────────────────────────────────────────

function DepsTab({
  page,
  onViewMap,
  onSelectRef,
}: {
  page: ServicePage;
  onViewMap: () => void;
  onSelectRef: (key: string) => void;
}) {
  if (page.noRelations) {
    return (
      <div className="rounded-[13px] border border-border bg-card px-5 py-10 text-center text-[13px] text-muted-foreground/60">
        No dependencies declared.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {page.hasDeps ? (
        <div className={CARD}>
          <div className={CARD_HEAD}>
            <span className="text-[12.5px] font-semibold text-foreground">Depends on</span>
            <span className="font-mono text-[11px] text-muted-foreground/60">{page.dependsOnRefs.length}</span>
            <button
              type="button"
              onClick={onViewMap}
              className="ml-auto flex items-center gap-1 bg-transparent text-[11.5px] text-primary"
            >
              View map
              <ArrowUpRight className="h-[11px] w-[11px]" strokeWidth={2.4} />
            </button>
          </div>
          <div className="p-2">
            {page.dependsOnRefs.map((d, i) => (
              <DepRow key={`${d.key ?? d.name}-${i}`} ref_={d} onSelectRef={onSelectRef} />
            ))}
          </div>
        </div>
      ) : null}
      {page.hasUsedBy ? (
        <div className={CARD}>
          <div className={CARD_HEAD}>
            <span className="text-[12.5px] font-semibold text-foreground">Used by</span>
            <span className="font-mono text-[11px] text-muted-foreground/60">{page.usedByRefs.length}</span>
          </div>
          <div className="p-2">
            {page.usedByRefs.map((u, i) => (
              <DepRow key={`${u.key ?? u.name}-${i}`} ref_={u} onSelectRef={onSelectRef} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DepRow({ ref_, onSelectRef }: { ref_: PageRef; onSelectRef: (key: string) => void }) {
  return (
    <button
      type="button"
      data-row
      onClick={() => ref_.key && onSelectRef(ref_.key)}
      disabled={!ref_.key}
      className="flex w-full items-center gap-[11px] rounded-[9px] bg-transparent px-[11px] py-2.5 text-left transition-colors hover:bg-foreground/[0.022] disabled:cursor-default"
    >
      <span className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[8px] border border-border bg-muted text-muted-foreground">
        <PathIcon d={ref_.iconD} size={15} strokeWidth={1.7} />
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-foreground">{ref_.name}</span>
      <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: ref_.healthColor }} />
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/45" />
    </button>
  );
}

// ── Activity tab ─────────────────────────────────────────────────

function ActivityTab({ page }: { page: ServicePage }) {
  return (
    <div className={CARD}>
      <div className={CARD_HEAD}>
        <span className="text-[12.5px] font-semibold text-foreground">Recent activity</span>
        <span className="ml-auto text-[11px] text-muted-foreground/60">catalog provenance</span>
      </div>
      <div className="px-5 pb-1 pt-[18px]">
        {page.activity.map((ev, i) => {
          const last = i === page.activity.length - 1;
          return (
            <div key={ev.id} className="flex gap-[13px]">
              <div className="flex shrink-0 flex-col items-center">
                <span className="grid h-[30px] w-[30px] place-items-center rounded-[8px]" style={{ background: ev.bg }}>
                  <PathIcon d={ev.iconD} size={15} strokeWidth={1.9} style={{ color: ev.color }} />
                </span>
                {!last ? <span className="my-1 w-[1.5px] flex-1 bg-border" /> : null}
              </div>
              <div className="min-w-0 pb-[18px]">
                <div className="text-[13px] leading-[1.4] text-foreground">{ev.title}</div>
                <div className="mt-[3px] font-mono text-[11.5px] text-muted-foreground/60">{ev.meta}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Scorecard tab ────────────────────────────────────────────────

function ScorecardTab({ page }: { page: ServicePage }) {
  if (!page.hasScore) {
    return (
      <div className="rounded-[13px] border border-border bg-card px-5 py-10 text-center text-[13px] text-muted-foreground/60">
        Scorecards do not apply to managed resources.
      </div>
    );
  }
  return (
    <div className={CARD}>
      <div className="flex items-center gap-[18px] border-b border-b-border px-[22px] py-5">
        <div className="relative h-[76px] w-[76px] shrink-0">
          <svg width="76" height="76" viewBox="0 0 76 76" className="-rotate-90">
            <circle cx="38" cy="38" r={RING_R_LG} fill="none" stroke="hsl(var(--border))" strokeWidth="7" />
            <circle
              cx="38"
              cy="38"
              r={RING_R_LG}
              fill="none"
              stroke={page.tierColor}
              strokeWidth="7"
              strokeLinecap="round"
              strokeDasharray={RING_CIRC_LG.toFixed(1)}
              strokeDashoffset={page.ringOffsetLg}
            />
          </svg>
          <div className="absolute inset-0 grid place-items-center">
            <span className="text-[22px] font-bold text-foreground">{page.scoreNum}</span>
          </div>
        </div>
        <div>
          <div
            className="inline-flex h-6 items-center gap-1.5 rounded-[7px] px-2.5 text-[13px] font-semibold"
            style={{ background: page.tierBg, border: `1px solid ${page.tierBorder}`, color: page.tierColor }}
          >
            {page.tierLabel} tier
          </div>
          <div className="mt-2.5 flex gap-4 text-[12.5px] text-muted-foreground/80">
            <span>
              <span className="font-semibold text-success">{page.passCount}</span> pass
            </span>
            <span>
              <span className="font-semibold text-primary">{page.warnCount}</span> warn
            </span>
            <span>
              <span className="font-semibold text-destructive">{page.failCount}</span> fail
            </span>
          </div>
        </div>
      </div>
      <div className="px-3 py-2">
        {page.checks.map((ck) => {
          const c = CHECK_COLOR[ck.status];
          return (
            <div key={ck.id} className="flex flex-col gap-1 border-b border-b-border px-2.5 py-2.5">
              <div className="flex items-center gap-3">
                <span className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[5px]" style={{ background: c.bg }}>
                  <PathIcon d={CHECK_MARK[ck.status]} size={11} strokeWidth={3} style={{ color: c.c }} />
                </span>
                <span className="flex-1 text-[13px] text-foreground/90">{ck.label}</span>
                <span className="text-[11.5px] capitalize" style={{ color: c.c }}>
                  {ck.status}
                </span>
              </div>
              {/* teams-ownership TO4 — remediation copy on a failing check. */}
              {ck.detail ? <span className="ml-[30px] text-[11.5px] text-muted-foreground">{ck.detail}</span> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Right rail ───────────────────────────────────────────────────

function RightRail({ page }: { page: ServicePage }) {
  // A muted runbook link when the runbook check is failing or this is a managed
  // resource (no runbook applies) — mirrors the design's `runbookColor`.
  const runbookMuted = !page.hasScore || page.checks.some((c) => c.id === "runbook" && c.status === "fail");
  const runbookColor = runbookMuted ? "hsl(var(--muted-foreground) / 0.6)" : "hsl(var(--foreground) / 0.9)";
  return (
    <div className="flex flex-col gap-3.5">
      <div className="rounded-[12px] border border-border bg-card px-4 py-[15px]">
        <div className={`${MONO_LABEL} mb-[13px]`}>Ownership</div>
        <div className="flex items-center gap-[11px]">
          <span
            className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[9px] text-[12px] font-semibold"
            style={{
              background: page.owned ? "hsl(var(--accent))" : "transparent",
              border: page.owned ? "1px solid hsl(var(--input))" : "1px dashed hsl(var(--input))",
              color: page.owned ? "hsl(var(--foreground) / 0.9)" : "hsl(var(--muted-foreground) / 0.6)",
            }}
          >
            {page.ownerInitials}
          </span>
          <div className="min-w-0">
            <div className="text-[13px] font-medium" style={{ color: page.owned ? "hsl(var(--foreground) / 0.9)" : "hsl(var(--muted-foreground) / 0.8)" }}>
              {page.ownerName}
            </div>
            <div className="text-[11px] text-muted-foreground/60">{page.ownerSub}</div>
          </div>
        </div>
        {page.hasOnCall ? (
          <div className="mt-[13px] flex items-center gap-2.5 border-t border-dashed border-t-border pt-[13px]">
            <span className="h-2 w-2 shrink-0 rounded-full bg-success shadow-[0_0_0_3px_hsl(var(--success)/0.15)]" />
            <span className="text-[12.5px] text-foreground/90">{page.onCall}</span>
            <span className="text-[11px] text-muted-foreground/60">on-call</span>
          </div>
        ) : null}
      </div>

      <div className="rounded-[12px] border border-border bg-card px-4 py-[15px]">
        <div className={`${MONO_LABEL} mb-[11px]`}>About</div>
        <div className="flex flex-col gap-[9px]">
          <AboutRow label="System" value={page.system} />
          <AboutRow label="Language" value={page.language ?? "—"} />
          <AboutRow label="Lifecycle" value={page.lifeShow ? page.lifeLabel : "—"} capitalize={page.lifeShow} />
          <AboutRow label="Health" value={page.healthLabel} valueColor={page.healthText} />
        </div>
      </div>

      <div className="rounded-[12px] border border-border bg-card p-[9px]">
        <RailLink icon={<Github className="h-[15px] w-[15px] text-muted-foreground/80" />} label="Source repository" />
        <RailLink icon={<BookText className="h-[15px] w-[15px] text-muted-foreground/80" />} label="Runbook" color={runbookColor} />
        <RailLink icon={<AreaChart className="h-[15px] w-[15px] text-muted-foreground/80" />} label="Dashboards" />
      </div>
    </div>
  );
}

function AboutRow({
  label,
  value,
  valueColor,
  capitalize,
}: {
  label: string;
  value: string;
  valueColor?: string;
  capitalize?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2.5">
      <span className="text-[12px] text-muted-foreground/80">{label}</span>
      <span className={`text-[12.5px] ${capitalize ? "capitalize" : ""}`} style={{ color: valueColor ?? "hsl(var(--foreground) / 0.9)" }}>
        {value}
      </span>
    </div>
  );
}

function RailLink({ icon, label, color }: { icon: React.ReactNode; label: string; color?: string }) {
  return (
    <button
      type="button"
      data-doclink
      className="flex w-full items-center gap-2.5 rounded-[8px] bg-transparent px-[9px] py-[9px] text-left hover:bg-foreground/[0.03]"
      style={{ color: color ?? "hsl(var(--foreground) / 0.9)" }}
    >
      {icon}
      <span className="text-[12.5px]">{label}</span>
      <ArrowUpRight className="ml-auto h-[13px] w-[13px] text-muted-foreground/45" strokeWidth={2} />
    </button>
  );
}
