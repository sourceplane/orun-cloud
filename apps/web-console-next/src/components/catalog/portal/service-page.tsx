"use client";

/**
 * Catalog-portal dedicated service page (saas-catalog-portal CP5), Northwind design.
 *
 * The drilled-in view of one entity (per entity-detail.html): a Screen with
 * breadcrumbs, a serif identity hero with kind/health/tier pills + a mono
 * provenance line, a four-up ops strip (runtime-gated), a five-tab switch over a
 * two-column body (README / Dependencies / Recent activity in the main column,
 * Ownership / Scorecard / Docs in the right rail). Driven by `buildPage`.
 *
 * Honest by construction: every data-less section degrades through the same
 * `hasOps` / `hasScore` / `noRelations` paths — the layout is always the
 * design's; only real values fill it.
 */

import * as React from "react";
import { ArrowUpRight, AreaChart, ChevronRight, Github } from "lucide-react";
import type { CatalogDoc } from "@saas/contracts/state";
import type { PageRef, ServicePage as ServicePageModel } from "@/lib/catalog-portal/page";
import type { HealthKey } from "@/lib/catalog-portal/palette";
import { CHECK_COLOR } from "@/lib/catalog-portal/palette";
import { CHECK_MARK, DOC_ICON } from "@/lib/catalog-portal/icons";
import {
  Screen,
  Breadcrumbs,
  Pill,
  OwnerAvatar,
  PersonAvatar,
  MonoRef,
  QuietLink,
  type Tone,
} from "@/components/ui/northwind";
import { PathIcon } from "./icon";
import { MarkdownView } from "./markdown-view";
import { DocBody, DocProvenance, DocShelf, useEntityDocs, docRoleIcon } from "@/components/catalog/docs/entity-docs";

const MONO_LABEL = "text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70";
const CARD = "rounded-xl border border-border bg-card overflow-hidden";
const RING_R_LG = 32;
const RING_CIRC_LG = 2 * Math.PI * RING_R_LG;

const HEALTH_TONE: Record<HealthKey, Tone> = {
  healthy: "success",
  degraded: "warning",
  down: "error",
  managed: "neutral",
};

// Maturity tier → the literal ink used across the catalog (no theme token).
const TIER_TONE: Record<string, string> = {
  Gold: "#9A7B2D",
  Silver: "#737373",
  Bronze: "#A6906B",
};

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
  onViewMap,
  onSelectRef,
}: {
  page: ServicePageModel;
  orgId: string;
  orgSlug: string;
  orgLabel: string;
  onBack: () => void;
  onViewMap: () => void;
  onSelectRef: (key: string) => void;
}) {
  const [tab, setTab] = React.useState<TabKey>("overview");
  const [docKey, setDocKey] = React.useState<string | null>(null);
  // The entity's real doc set (saas-catalog-docs CD4).
  const { docs, loading: docsLoading } = useEntityDocs(orgId, page.ref);

  return (
    <Screen detail>
      <Breadcrumbs
        items={[{ label: "Catalog", href: `/orgs/${orgSlug}/catalog` }, { label: page.name }]}
      />

      <Hero page={page} />

      {page.hasOps ? <OpsStrip page={page} /> : null}

      {/* tabs — horizontally scrollable so all five stay reachable on a phone */}
      <div className="-mx-5 mt-[26px] flex gap-0.5 overflow-x-auto border-b border-b-border px-5 sm:mx-0 sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className="relative shrink-0 bg-transparent px-3.5 py-[9px] text-[13px]"
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

      {/* two-column body: main first (stacks on mobile), rail after */}
      <div className="mt-[14px] grid grid-cols-1 items-start gap-[26px] lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-[14px]">
          {tab === "overview" ? <OverviewMain page={page} orgId={orgId} orgSlug={orgSlug} docs={docs} onSelectRef={onSelectRef} /> : null}
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
        <RightRail page={page} orgId={orgId} orgSlug={orgSlug} />
      </div>
    </Screen>
  );
}

// ── Hero ─────────────────────────────────────────────────────────

function Hero({ page }: { page: ServicePageModel }) {
  const healthTone = HEALTH_TONE[page.healthKey];
  const tierInk = page.tier ? TIER_TONE[page.tier] : undefined;
  // Provenance: ref · system · lifecycle · commit (only the parts we know).
  const commit = page.svc.sourceCommit ? page.svc.sourceCommit.replace(/^sha\d*:/i, "").slice(0, 7) : null;
  const prov = [page.ref, page.system, page.lifeShow ? page.lifeLabel : null, commit]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-[10px]">
          <h1 className="m-0 font-serif text-[26px] font-medium tracking-[-0.01em] text-foreground sm:text-[30px]">
            {page.name}
          </h1>
          <Pill tone="neutral">{page.kindLabel}</Pill>
          <Pill tone={healthTone} dot>
            {page.healthLabel}
          </Pill>
          {tierInk ? (
            <span
              className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[11.5px] font-medium"
              style={{ color: tierInk, background: `${tierInk}1f` }}
            >
              {page.tierLabel}
            </span>
          ) : null}
        </div>
        <MonoRef className="mt-[7px] block text-[12px] text-muted-foreground/70">{prov}</MonoRef>
        {page.description ? (
          <p className="mt-3 max-w-[560px] text-[14px] leading-[1.6] text-secondary-foreground">{page.description}</p>
        ) : null}
      </div>
      <div className="flex w-full gap-2 sm:w-auto sm:shrink-0">
        <button
          type="button"
          className="flex h-10 flex-1 items-center justify-center gap-[7px] rounded-[9px] border border-border bg-card px-[13px] text-[12.5px] font-medium text-secondary-foreground transition-colors hover:border-input sm:h-[34px] sm:flex-none"
        >
          <Github className="h-3.5 w-3.5" strokeWidth={1.8} />
          View in repo
        </button>
        <button
          type="button"
          className="flex h-10 flex-1 items-center justify-center gap-[7px] rounded-[9px] bg-primary px-3.5 text-[12.5px] font-semibold text-primary-foreground transition-colors hover:brightness-110 sm:h-[34px] sm:flex-none"
        >
          <AreaChart className="h-3.5 w-3.5" strokeWidth={1.8} />
          Dashboards
        </button>
      </div>
    </div>
  );
}

// ── Ops strip (four stat tiles) ──────────────────────────────────

function OpsStrip({ page }: { page: ServicePageModel }) {
  return (
    <div className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-4">
      <OpsTile label="SLO · 30d" value={page.sloCur != null ? `${page.sloCur}%` : "—"} sub={page.sloTarget != null ? `target ${page.sloTarget}%` : "no target"} />
      <OpsTile label="Open incidents" value={String(page.incidents)} sub={page.incidents > 0 ? "live" : "none open"} />
      <OpsTile label="Deploys" value={page.deploysWeek} sub={`last ${page.deployLabel}`} />
      <div className="rounded-[11px] border border-border bg-card px-[18px] py-[15px]">
        <div className={MONO_LABEL}>Readiness</div>
        {page.hasScore ? (
          <>
            <div className="mt-[7px] font-serif text-[24px] font-medium leading-none text-foreground">{page.scoreNum}</div>
            <div className="mt-2 h-1 overflow-hidden rounded-[2px] bg-[#EDEDED] dark:bg-secondary">
              <span className="block h-full rounded-[2px]" style={{ width: `${page.scorePct}%`, background: page.tierColor }} />
            </div>
          </>
        ) : (
          <div className="mt-[7px] font-serif text-[24px] font-medium leading-none text-muted-foreground/45">—</div>
        )}
      </div>
    </div>
  );
}

function OpsTile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-[11px] border border-border bg-card px-[18px] py-[15px]">
      <div className={MONO_LABEL}>{label}</div>
      <div className="mt-[7px] font-serif text-[24px] font-medium leading-none text-foreground">{value}</div>
      <div className="mt-[3px] text-[11.5px] text-muted-foreground/70">{sub}</div>
    </div>
  );
}

// ── Overview main column (README + Dependencies + Recent activity) ─

function OverviewMain({
  page,
  orgId,
  orgSlug,
  docs,
  onSelectRef,
}: {
  page: ServicePageModel;
  orgId: string;
  orgSlug: string;
  docs: CatalogDoc[];
  onSelectRef: (key: string) => void;
}) {
  return (
    <>
      <OverviewCard page={page} orgId={orgId} orgSlug={orgSlug} docs={docs} />
      {!page.noRelations ? <DependenciesCard page={page} onSelectRef={onSelectRef} /> : null}
      <RecentActivityCard page={page} orgSlug={orgSlug} />
    </>
  );
}

function OverviewCard({
  page,
  orgId,
  orgSlug,
  docs,
}: {
  page: ServicePageModel;
  orgId: string;
  orgSlug: string;
  docs: CatalogDoc[];
}) {
  const overview = docs.find((d) => d.docKey === "overview") ?? null;
  if (overview) {
    return (
      <div className="rounded-xl border border-border bg-card px-[26px] py-[22px]">
        <div className="flex items-center gap-2.5">
          <span className="font-mono text-[12px] font-semibold text-secondary-foreground">{overview.title}</span>
          <DocProvenance doc={overview} />
        </div>
        <div className="mt-4">
          <DocBody orgId={orgId} doc={overview} orgSlug={orgSlug} siblings={docs} />
        </div>
      </div>
    );
  }
  // The one derived surface: catalog facts, visibly badged, never a "file".
  return (
    <div className="rounded-xl border border-border bg-card px-[26px] py-[22px]">
      <div className="flex items-center gap-2.5">
        <span className="font-mono text-[12px] font-semibold text-secondary-foreground">
          About this {page.kindLabel.toLowerCase()}
        </span>
        <span className="text-[11.5px] text-muted-foreground/70">derived — not a repo file</span>
      </div>
      <div className="mt-4">
        <MarkdownView blocks={page.derivedBlocks} />
      </div>
    </div>
  );
}

function DependenciesCard({ page, onSelectRef }: { page: ServicePageModel; onSelectRef: (key: string) => void }) {
  return (
    <div className={CARD}>
      <div className="px-[24px] pb-3 pt-4 text-[13.5px] font-semibold text-foreground">Dependencies</div>
      {page.dependsOnRefs.map((d, i) => (
        <DepRow key={`dep-${d.key ?? d.name}-${i}`} ref_={d} caption="depends on" onSelectRef={onSelectRef} />
      ))}
      {page.usedByRefs.map((u, i) => (
        <DepRow key={`used-${u.key ?? u.name}-${i}`} ref_={u} caption="used by" onSelectRef={onSelectRef} />
      ))}
    </div>
  );
}

function DepRow({
  ref_,
  caption,
  onSelectRef,
}: {
  ref_: PageRef;
  caption: string;
  onSelectRef: (key: string) => void;
}) {
  return (
    <button
      type="button"
      data-row
      onClick={() => ref_.key && onSelectRef(ref_.key)}
      disabled={!ref_.key}
      className="flex w-full items-center gap-[11px] border-t border-t-border/60 px-[24px] py-[11px] text-left transition-colors hover:bg-foreground/[0.022] disabled:cursor-default"
    >
      <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: ref_.healthColor }} />
      <span className="min-w-0 truncate font-mono text-[12.5px] text-foreground">{ref_.name}</span>
      <span className="text-[11.5px] text-muted-foreground/70">{caption}</span>
    </button>
  );
}

function RecentActivityCard({ page, orgSlug }: { page: ServicePageModel; orgSlug: string }) {
  return (
    <div className={CARD}>
      <div className="flex items-center justify-between px-[24px] pb-3 pt-4">
        <span className="text-[13.5px] font-semibold text-foreground">Recent activity</span>
        <QuietLink href={`/orgs/${orgSlug}/activities`}>All activity →</QuietLink>
      </div>
      {page.activity.map((ev) => (
        <div
          key={ev.id}
          className="flex items-center gap-[11px] border-t border-t-border/60 px-[24px] py-[11px]"
        >
          <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[7px]" style={{ background: ev.bg }}>
            <PathIcon d={ev.iconD} size={13} strokeWidth={1.9} style={{ color: ev.color }} />
          </span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground">{ev.title}</span>
          <MonoRef className="shrink-0 text-[11.5px]">{ev.meta}</MonoRef>
        </div>
      ))}
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
  page: ServicePageModel;
  orgId: string;
  orgSlug: string;
  docs: CatalogDoc[];
  docsLoading: boolean;
  activeDocKey: string | null;
  onSelectDoc: (docKey: string) => void;
}) {
  if (docsLoading && docs.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card px-5 py-10 text-center text-[13px] text-muted-foreground/60">
        Loading documents…
      </div>
    );
  }
  if (docs.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <OverviewCard page={page} orgId={orgId} orgSlug={orgSlug} docs={docs} />
        <DocsNudge page={page} />
      </div>
    );
  }
  const active = docs.find((d) => d.docKey === activeDocKey) ?? docs[0]!;
  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[210px_minmax(0,1fr)]">
      <DocShelf docs={docs} activeKey={active.docKey} onSelect={onSelectDoc} />
      <div className="rounded-xl border border-border bg-card px-[26px] py-[22px]">
        <div className="flex items-center gap-2.5">
          <span className="font-mono text-[12px] font-semibold text-secondary-foreground">{active.title}</span>
          <DocProvenance doc={active} />
        </div>
        <div className="mt-4">
          <DocBody orgId={orgId} doc={active} orgSlug={orgSlug} siblings={docs} />
        </div>
      </div>
    </div>
  );
}

function DocsNudge({ page }: { page: ServicePageModel }) {
  const snippet = [
    "spec:",
    "  docs:",
    "    overview: docs/overview.md",
    "    pages:",
    "      - { path: docs/architecture.md, role: architecture }",
    "      - { path: docs/runbook.md, role: runbook }",
  ].join("\n");
  return (
    <div className="rounded-xl border border-dashed border-border bg-card/50 px-5 py-4">
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

// ── Dependencies tab ─────────────────────────────────────────────

function DepsTab({
  page,
  onViewMap,
  onSelectRef,
}: {
  page: ServicePageModel;
  onViewMap: () => void;
  onSelectRef: (key: string) => void;
}) {
  if (page.noRelations) {
    return (
      <div className="rounded-xl border border-border bg-card px-5 py-10 text-center text-[13px] text-muted-foreground/60">
        No dependencies declared.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {page.hasDeps ? (
        <div className={CARD}>
          <div className="flex items-center gap-2 px-[24px] pb-3 pt-4">
            <span className="text-[13.5px] font-semibold text-foreground">Depends on</span>
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
          {page.dependsOnRefs.map((d, i) => (
            <FullDepRow key={`${d.key ?? d.name}-${i}`} ref_={d} onSelectRef={onSelectRef} />
          ))}
        </div>
      ) : null}
      {page.hasUsedBy ? (
        <div className={CARD}>
          <div className="flex items-center gap-2 px-[24px] pb-3 pt-4">
            <span className="text-[13.5px] font-semibold text-foreground">Used by</span>
            <span className="font-mono text-[11px] text-muted-foreground/60">{page.usedByRefs.length}</span>
          </div>
          {page.usedByRefs.map((u, i) => (
            <FullDepRow key={`${u.key ?? u.name}-${i}`} ref_={u} onSelectRef={onSelectRef} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FullDepRow({ ref_, onSelectRef }: { ref_: PageRef; onSelectRef: (key: string) => void }) {
  return (
    <button
      type="button"
      data-row
      onClick={() => ref_.key && onSelectRef(ref_.key)}
      disabled={!ref_.key}
      className="flex w-full items-center gap-[11px] border-t border-t-border/60 px-[24px] py-3 text-left transition-colors hover:bg-foreground/[0.022] disabled:cursor-default"
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

function ActivityTab({ page }: { page: ServicePageModel }) {
  return (
    <div className={CARD}>
      <div className="flex items-center justify-between px-[24px] pb-3 pt-4">
        <span className="text-[13.5px] font-semibold text-foreground">Recent activity</span>
        <span className="text-[11px] text-muted-foreground/60">catalog provenance</span>
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
                <MonoRef className="mt-[3px] block text-[11.5px]">{ev.meta}</MonoRef>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Scorecard tab ────────────────────────────────────────────────

function ScorecardTab({ page }: { page: ServicePageModel }) {
  if (!page.hasScore) {
    return (
      <div className="rounded-xl border border-border bg-card px-5 py-10 text-center text-[13px] text-muted-foreground/60">
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
            <span className="font-serif text-[24px] font-medium text-foreground">{page.scoreNum}</span>
          </div>
        </div>
        <div>
          <div
            className="inline-flex h-6 items-center gap-1.5 rounded-[7px] px-2.5 text-[13px] font-semibold"
            style={{ background: page.tierBg, border: `1px solid ${page.tierBorder}`, color: page.tierColor }}
          >
            {page.tierLabel} tier
          </div>
          <div className="mt-2.5 flex flex-wrap gap-4 text-[12.5px] text-muted-foreground/80">
            <span>
              <span className="font-semibold text-success">{page.passCount}</span> pass
            </span>
            <span>
              <span className="font-semibold text-warning">{page.warnCount}</span> warn
            </span>
            <span>
              <span className="font-semibold text-destructive">{page.failCount}</span> fail
            </span>
            {page.unknownCount > 0 ? (
              <span>
                <span className="font-semibold text-muted-foreground/70">{page.unknownCount}</span> no signal
              </span>
            ) : null}
          </div>
        </div>
      </div>
      <div className="px-3 py-2">
        {page.checks.map((ck) => {
          const c = CHECK_COLOR[ck.status];
          return (
            <div key={ck.id} className="flex flex-col gap-1 border-b border-b-border/60 px-2.5 py-2.5 last:border-b-0">
              <div className="flex items-center gap-3">
                <span className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[5px]" style={{ background: c.bg }}>
                  <PathIcon d={CHECK_MARK[ck.status]} size={11} strokeWidth={3} style={{ color: c.c }} />
                </span>
                <span className="flex-1 text-[13px] text-foreground/90">{ck.label}</span>
                <span className="text-[11.5px] capitalize" style={{ color: c.c }}>
                  {ck.status}
                </span>
              </div>
              {ck.detail ? <span className="ml-[30px] text-[11.5px] text-muted-foreground">{ck.detail}</span> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Right rail (Ownership · Scorecard summary · Docs) ─────────────

function RightRail({ page, orgId, orgSlug }: { page: ServicePageModel; orgId: string; orgSlug: string }) {
  return (
    <div className="flex flex-col gap-[14px]">
      {/* Ownership */}
      <div className="rounded-xl border border-border bg-card px-5 py-[18px]">
        <div className={MONO_LABEL}>Ownership</div>
        <div className="mt-3 flex items-center gap-[11px]">
          <OwnerAvatar name={page.ownerName} size={32} shape="square" unowned={!page.owned} />
          <div className="min-w-0">
            <div
              className="text-[13px] font-semibold"
              style={{ color: page.owned ? "hsl(var(--foreground))" : "hsl(var(--muted-foreground) / 0.8)" }}
            >
              {page.ownerName}
            </div>
            <div className="text-[11.5px] text-muted-foreground/70">{page.ownerSub}</div>
          </div>
        </div>
        {page.hasOnCall ? (
          <div className="mt-3 flex items-center gap-[9px] border-t border-t-border/70 pt-3">
            <PersonAvatar name={page.onCall} size={24} />
            <span className="text-[12.5px] text-foreground">{page.onCall}</span>
            <Pill tone="success" className="ml-auto">
              on-call
            </Pill>
          </div>
        ) : null}
      </div>

      {/* Scorecard summary */}
      {page.hasScore ? (
        <div className="rounded-xl border border-border bg-card px-5 py-[18px]">
          <div className={MONO_LABEL}>Scorecard</div>
          <div className="mt-3 flex flex-col gap-[9px] text-[12.5px]">
            {page.checks.map((ck) => {
              const c = CHECK_COLOR[ck.status];
              const failing = ck.status === "fail" || ck.status === "warn";
              return (
                <span key={ck.id} className="flex items-center gap-2" style={{ color: failing ? c.c : "hsl(var(--secondary-foreground))" }}>
                  <PathIcon d={CHECK_MARK[ck.status]} size={13} strokeWidth={2.4} style={{ color: c.c }} />
                  {ck.label}
                </span>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* Docs */}
      <DocsRail page={page} orgId={orgId} orgSlug={orgSlug} />
    </div>
  );
}

const DOC_ROLE_INK: Record<string, string> = {
  overview: "#2563C9",
  architecture: "#3B76C9",
  adr: "#3B76C9",
  runbook: "#C94A44",
  api: "#3A8159",
};

function DocsRail({ page, orgId, orgSlug }: { page: ServicePageModel; orgId: string; orgSlug: string }) {
  const { docs } = useEntityDocs(orgId, page.ref);
  if (docs.length === 0) return null;
  const shown = docs.slice(0, 6);
  return (
    <div className="rounded-xl border border-border bg-card px-5 py-[18px]">
      <div className={MONO_LABEL}>Docs</div>
      <div className="mt-2.5 flex flex-col gap-0.5">
        {shown.map((d) => {
          const role = d.docKey === "overview" ? "overview" : d.role;
          const ink = DOC_ROLE_INK[role] ?? "hsl(var(--muted-foreground))";
          return (
            <a
              key={d.docKey}
              href={`/orgs/${orgSlug}/docs/${encodeURIComponent(page.key)}/${encodeURIComponent(d.docKey)}`}
              className="-mx-2 flex items-center gap-2 rounded-[7px] px-2 py-[7px] text-[12.5px] text-secondary-foreground transition-colors hover:bg-muted"
            >
              <span className="w-[58px] shrink-0 text-[10px] font-semibold uppercase tracking-[0.06em]" style={{ color: ink }}>
                {role}
              </span>
              <span className="min-w-0 flex-1 truncate">{d.title}</span>
              <PathIcon
                d={d.docKey === "overview" ? DOC_ICON.file : docRoleIcon(d.role)}
                size={13}
                strokeWidth={1.7}
                className="shrink-0 text-muted-foreground/50"
              />
            </a>
          );
        })}
      </div>
    </div>
  );
}
