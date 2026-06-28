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
import type { PageRef, ServicePage } from "@/lib/catalog-portal/page";
import { CHECK_COLOR } from "@/lib/catalog-portal/palette";
import { CHECK_MARK, DOC_ICON } from "@/lib/catalog-portal/icons";
import { PathIcon } from "./icon";
import { MarkdownView } from "./markdown-view";

const MONO_LABEL = "font-mono text-[10px] uppercase tracking-[0.1em] text-[#71717a]";
const CARD = "rounded-[13px] border border-[#1a1a1e] bg-[#0c0c0f] overflow-hidden";
const CARD_HEAD = "flex items-center gap-2 border-b border-b-[#18181b] bg-[#0e0e12] px-4 py-[11px]";
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
  orgLabel,
  onBack,
  onViewMap,
  onSelectRef,
}: {
  page: ServicePage;
  orgLabel: string;
  onBack: () => void;
  onViewMap: () => void;
  onSelectRef: (key: string) => void;
}) {
  const [tab, setTab] = React.useState<TabKey>("overview");
  const [docId, setDocId] = React.useState<string | null>(null);
  const activeDoc = page.docs.find((d) => d.id === docId) ?? page.docs[0]!;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* breadcrumb bar */}
      <div className="flex h-[50px] shrink-0 items-center gap-2.5 border-b border-b-[#18181b] bg-[rgba(10,10,12,.7)] px-5">
        <span className="text-[13px] text-[#71717a]">{orgLabel}</span>
        <span className="text-[#3f3f46]">/</span>
        <button type="button" onClick={onBack} className="bg-transparent p-0 text-[13px] text-[#71717a] hover:text-[#e4e4e7]">
          Catalog
        </button>
        <span className="text-[#3f3f46]">/</span>
        <span className="truncate font-mono text-[13px] font-medium text-[#e4e4e7]">{page.name}</span>
        <button
          type="button"
          onClick={onBack}
          className="ml-auto flex h-[30px] items-center gap-1.5 rounded-[7px] border border-[#232327] bg-transparent px-[11px] text-[12.5px] text-[#a1a1aa] hover:text-[#e4e4e7]"
        >
          <ArrowLeft className="h-[13px] w-[13px]" />
          Catalog
        </button>
      </div>

      {/* scroll body */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1200px] flex-col gap-[22px] px-[30px] pb-12 pt-[26px]">
          <Hero page={page} />
          {page.hasOps ? <OpsStrip page={page} /> : null}

          {/* tabs */}
          <div className="flex gap-0.5 border-b border-b-[#1a1a1e]">
            {TABS.map((t) => {
              const active = tab === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className="relative bg-transparent px-3.5 py-[9px] text-[13px]"
                  style={{ color: active ? "#fafafa" : "#a1a1aa", fontWeight: active ? 600 : 500 }}
                >
                  {t.label}
                  <span
                    className="absolute inset-x-2 -bottom-px h-0.5 rounded-sm"
                    style={{ background: active ? "#f59e0b" : "transparent" }}
                  />
                </button>
              );
            })}
          </div>

          {/* two column */}
          <div className="grid grid-cols-1 items-start gap-[26px] xl:grid-cols-[minmax(0,1fr)_290px]">
            <div className="flex min-w-0 flex-col gap-4">
              {tab === "overview" ? <OverviewTab page={page} /> : null}
              {tab === "docs" ? (
                <DocsTab page={page} activeDocId={activeDoc.id} onSelectDoc={setDocId} />
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
    <div className="flex items-start gap-4">
      <span className="grid h-[54px] w-[54px] shrink-0 place-items-center rounded-[14px] border border-[#232327] bg-[#161619] text-[#d4d4d8]">
        <PathIcon d={page.iconD} size={26} strokeWidth={1.6} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-[9px]">
          <h1 className="m-0 text-[23px] font-semibold tracking-[-0.015em] text-[#fafafa]">{page.name}</h1>
          <span className="rounded-[5px] border border-[#26262b] px-[7px] py-px text-[11px] text-[#71717a]">
            {page.kindLabel}
          </span>
        </div>
        <div className="mt-[5px] font-mono text-[12px] text-[#52525b]">{page.ref}</div>
        {page.description ? (
          <p className="mt-3 max-w-[680px] text-[13.5px] leading-[1.6] text-[#a1a1aa]">{page.description}</p>
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
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          className="flex h-[34px] items-center gap-[7px] rounded-[8px] border border-[#232327] bg-transparent px-[13px] text-[12.5px] font-medium text-[#d4d4d8] hover:border-[#3a3a40]"
        >
          <Github className="h-3.5 w-3.5" />
          Repo
        </button>
        <button
          type="button"
          className="flex h-[34px] items-center gap-[7px] rounded-[8px] border border-[#f59e0b] bg-[#f59e0b] px-3.5 text-[12.5px] font-semibold text-[#1a1206]"
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
      className="inline-flex h-6 items-center gap-1.5 rounded-md border border-[#26262b] px-2.5 text-[11.5px]"
      style={{ color: color ?? "#a1a1aa" }}
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
      <OpsTile label="Deploys" value={page.deploysWeek} valueColor="#e4e4e7" sub={`last ${page.deployLabel}`} />
      <div className="rounded-[12px] border border-[#1c1c20] bg-[#0d0d10] px-4 py-[13px]">
        <div className={MONO_LABEL}>Readiness</div>
        {page.hasScore ? (
          <>
            <div className="mt-1.5 flex items-baseline gap-[7px]">
              <span className="text-[21px] font-semibold leading-none text-[#fafafa]">{page.scoreNum}</span>
              <span className="text-[11px] font-semibold" style={{ color: page.tierColor }}>
                {page.tierLabel}
              </span>
            </div>
            <div className="mt-2 h-1 overflow-hidden rounded-sm bg-[#1c1c20]">
              <div className="h-full rounded-sm" style={{ background: page.tierColor, width: `${page.scorePct}%` }} />
            </div>
          </>
        ) : (
          <div className="mt-1.5 text-[21px] font-semibold leading-none text-[#3f3f46]">—</div>
        )}
      </div>
    </div>
  );
}

function OpsTile({ label, value, valueColor, sub }: { label: string; value: string; valueColor: string; sub: string }) {
  return (
    <div className="rounded-[12px] border border-[#1c1c20] bg-[#0d0d10] px-4 py-[13px]">
      <div className={MONO_LABEL}>{label}</div>
      <div className="mt-1.5 text-[21px] font-semibold leading-none" style={{ color: valueColor }}>
        {value}
      </div>
      <div className="mt-[3px] text-[10.5px] text-[#52525b]">{sub}</div>
    </div>
  );
}

// ── Overview tab ─────────────────────────────────────────────────

function OverviewTab({ page }: { page: ServicePage }) {
  return (
    <div className={CARD}>
      <div className={CARD_HEAD}>
        <PathIcon d={DOC_ICON.file} size={14} strokeWidth={1.8} className="text-[#71717a]" />
        <span className="font-mono text-[12.5px] font-medium text-[#d4d4d8]">README.md</span>
        <span className="ml-auto text-[11px] text-[#52525b]">rendered from service definition</span>
      </div>
      <div className="px-[26px] py-[22px]">
        <MarkdownView blocks={page.overviewBlocks} />
      </div>
    </div>
  );
}

// ── Docs tab ─────────────────────────────────────────────────────

function DocsTab({
  page,
  activeDocId,
  onSelectDoc,
}: {
  page: ServicePage;
  activeDocId: string;
  onSelectDoc: (id: string) => void;
}) {
  const active = page.docs.find((d) => d.id === activeDocId) ?? page.docs[0]!;
  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[210px_minmax(0,1fr)]">
      <div className="flex flex-col gap-0.5 rounded-[12px] border border-[#1a1a1e] bg-[#0c0c0f] p-2">
        <div className="px-2 pb-2 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#52525b]">
          Documents
        </div>
        {page.docs.map((d) => {
          const on = d.id === active.id;
          return (
            <button
              key={d.id}
              type="button"
              onClick={() => onSelectDoc(d.id)}
              className="flex w-full items-center gap-[9px] rounded-[8px] px-[9px] py-2 text-left"
              style={{
                background: on ? "rgba(245,158,11,.07)" : "transparent",
                border: `1px solid ${on ? "#26262b" : "transparent"}`,
              }}
            >
              <PathIcon d={d.iconD} size={14} strokeWidth={1.7} className="shrink-0 text-[#71717a]" />
              <span className="flex min-w-0 flex-col gap-px">
                <span
                  className="truncate font-mono text-[12.5px]"
                  style={{ color: on ? "#fafafa" : "#a1a1aa" }}
                >
                  {d.name}
                </span>
                <span className="text-[10.5px] text-[#52525b]">{d.sub}</span>
              </span>
            </button>
          );
        })}
      </div>
      <div className={CARD}>
        <div className={CARD_HEAD}>
          <span className="font-mono text-[12.5px] font-medium text-[#d4d4d8]">{active.name}</span>
          <span className="ml-auto text-[11px] text-[#52525b]">{active.sub}</span>
        </div>
        <div className="px-[26px] py-[22px]">
          <MarkdownView blocks={active.blocks} />
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
      <div className="rounded-[13px] border border-[#1a1a1e] bg-[#0c0c0f] px-5 py-10 text-center text-[13px] text-[#52525b]">
        No dependencies declared.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {page.hasDeps ? (
        <div className={CARD}>
          <div className={CARD_HEAD}>
            <span className="text-[12.5px] font-semibold text-[#e4e4e7]">Depends on</span>
            <span className="font-mono text-[11px] text-[#52525b]">{page.dependsOnRefs.length}</span>
            <button
              type="button"
              onClick={onViewMap}
              className="ml-auto flex items-center gap-1 bg-transparent text-[11.5px] text-[#f59e0b]"
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
            <span className="text-[12.5px] font-semibold text-[#e4e4e7]">Used by</span>
            <span className="font-mono text-[11px] text-[#52525b]">{page.usedByRefs.length}</span>
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
      className="flex w-full items-center gap-[11px] rounded-[9px] bg-transparent px-[11px] py-2.5 text-left transition-colors hover:bg-white/[0.022] disabled:cursor-default"
    >
      <span className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[8px] border border-[#232327] bg-[#161619] text-[#a1a1aa]">
        <PathIcon d={ref_.iconD} size={15} strokeWidth={1.7} />
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-[#e4e4e7]">{ref_.name}</span>
      <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: ref_.healthColor }} />
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#3f3f46]" />
    </button>
  );
}

// ── Activity tab ─────────────────────────────────────────────────

function ActivityTab({ page }: { page: ServicePage }) {
  return (
    <div className={CARD}>
      <div className={CARD_HEAD}>
        <span className="text-[12.5px] font-semibold text-[#e4e4e7]">Recent activity</span>
        <span className="ml-auto text-[11px] text-[#52525b]">catalog provenance</span>
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
                {!last ? <span className="my-1 w-[1.5px] flex-1 bg-[#18181b]" /> : null}
              </div>
              <div className="min-w-0 pb-[18px]">
                <div className="text-[13px] leading-[1.4] text-[#e4e4e7]">{ev.title}</div>
                <div className="mt-[3px] font-mono text-[11.5px] text-[#52525b]">{ev.meta}</div>
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
      <div className="rounded-[13px] border border-[#1a1a1e] bg-[#0c0c0f] px-5 py-10 text-center text-[13px] text-[#52525b]">
        Scorecards do not apply to managed resources.
      </div>
    );
  }
  return (
    <div className={CARD}>
      <div className="flex items-center gap-[18px] border-b border-b-[#18181b] px-[22px] py-5">
        <div className="relative h-[76px] w-[76px] shrink-0">
          <svg width="76" height="76" viewBox="0 0 76 76" className="-rotate-90">
            <circle cx="38" cy="38" r={RING_R_LG} fill="none" stroke="#1c1c20" strokeWidth="7" />
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
            <span className="text-[22px] font-bold text-[#fafafa]">{page.scoreNum}</span>
          </div>
        </div>
        <div>
          <div
            className="inline-flex h-6 items-center gap-1.5 rounded-[7px] px-2.5 text-[13px] font-semibold"
            style={{ background: page.tierBg, border: `1px solid ${page.tierBorder}`, color: page.tierColor }}
          >
            {page.tierLabel} tier
          </div>
          <div className="mt-2.5 flex gap-4 text-[12.5px] text-[#71717a]">
            <span>
              <span className="font-semibold text-[#34d399]">{page.passCount}</span> pass
            </span>
            <span>
              <span className="font-semibold text-[#fbbf24]">{page.warnCount}</span> warn
            </span>
            <span>
              <span className="font-semibold text-[#f87171]">{page.failCount}</span> fail
            </span>
          </div>
        </div>
      </div>
      <div className="px-3 py-2">
        {page.checks.map((ck) => {
          const c = CHECK_COLOR[ck.status];
          return (
            <div key={ck.id} className="flex items-center gap-3 border-b border-b-[#141417] px-2.5 py-2.5">
              <span className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[5px]" style={{ background: c.bg }}>
                <PathIcon d={CHECK_MARK[ck.status]} size={11} strokeWidth={3} style={{ color: c.c }} />
              </span>
              <span className="flex-1 text-[13px] text-[#d4d4d8]">{ck.label}</span>
              <span className="text-[11.5px] capitalize" style={{ color: c.c }}>
                {ck.status}
              </span>
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
  const runbookColor = runbookMuted ? "#52525b" : "#d4d4d8";
  return (
    <div className="flex flex-col gap-3.5">
      <div className="rounded-[12px] border border-[#1a1a1e] bg-[#0c0c0f] px-4 py-[15px]">
        <div className={`${MONO_LABEL} mb-[13px]`}>Ownership</div>
        <div className="flex items-center gap-[11px]">
          <span
            className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[9px] text-[12px] font-semibold"
            style={{
              background: page.owned ? "#1f1f23" : "transparent",
              border: page.owned ? "1px solid #2a2a2e" : "1px dashed #3a3a40",
              color: page.owned ? "#d4d4d8" : "#52525b",
            }}
          >
            {page.ownerInitials}
          </span>
          <div className="min-w-0">
            <div className="text-[13px] font-medium" style={{ color: page.owned ? "#d4d4d8" : "#71717a" }}>
              {page.ownerName}
            </div>
            <div className="text-[11px] text-[#52525b]">{page.ownerSub}</div>
          </div>
        </div>
        {page.hasOnCall ? (
          <div className="mt-[13px] flex items-center gap-2.5 border-t border-dashed border-t-[#1f1f23] pt-[13px]">
            <span className="h-2 w-2 shrink-0 rounded-full bg-[#34d399] shadow-[0_0_0_3px_rgba(52,211,153,.15)]" />
            <span className="text-[12.5px] text-[#d4d4d8]">{page.onCall}</span>
            <span className="text-[11px] text-[#52525b]">on-call</span>
          </div>
        ) : null}
      </div>

      <div className="rounded-[12px] border border-[#1a1a1e] bg-[#0c0c0f] px-4 py-[15px]">
        <div className={`${MONO_LABEL} mb-[11px]`}>About</div>
        <div className="flex flex-col gap-[9px]">
          <AboutRow label="System" value={page.system} />
          <AboutRow label="Language" value={page.language ?? "—"} />
          <AboutRow label="Lifecycle" value={page.lifeShow ? page.lifeLabel : "—"} capitalize={page.lifeShow} />
          <AboutRow label="Health" value={page.healthLabel} valueColor={page.healthText} />
        </div>
      </div>

      <div className="rounded-[12px] border border-[#1a1a1e] bg-[#0c0c0f] p-[9px]">
        <RailLink icon={<Github className="h-[15px] w-[15px] text-[#71717a]" />} label="Source repository" />
        <RailLink icon={<BookText className="h-[15px] w-[15px] text-[#71717a]" />} label="Runbook" color={runbookColor} />
        <RailLink icon={<AreaChart className="h-[15px] w-[15px] text-[#71717a]" />} label="Dashboards" />
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
      <span className="text-[12px] text-[#71717a]">{label}</span>
      <span className={`text-[12.5px] ${capitalize ? "capitalize" : ""}`} style={{ color: valueColor ?? "#d4d4d8" }}>
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
      className="flex w-full items-center gap-2.5 rounded-[8px] bg-transparent px-[9px] py-[9px] text-left hover:bg-white/[0.03]"
      style={{ color: color ?? "#d4d4d8" }}
    >
      {icon}
      <span className="text-[12.5px]">{label}</span>
      <ArrowUpRight className="ml-auto h-[13px] w-[13px] text-[#3f3f46]" strokeWidth={2} />
    </button>
  );
}
