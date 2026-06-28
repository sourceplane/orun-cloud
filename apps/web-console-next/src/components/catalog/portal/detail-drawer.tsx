/**
 * Catalog portal entity detail drawer (saas-catalog-portal CP3).
 *
 * The right-anchored overlay sheet from the design: identity, ops stats,
 * production-readiness scorecard (ring + checks), ownership + on-call, the
 * dependency neighborhood, and footer quick links. Driven by `buildSelected`.
 * Degrades per design.md §4 (ops hidden without runtime signals, etc.).
 */

import * as React from "react";
import { X, Github, AreaChart, BookText, ArrowUpRight } from "lucide-react";
import type { SelectedService, MiniRef } from "@/lib/catalog-portal/model";
import { CHECK_COLOR } from "@/lib/catalog-portal/palette";
import { CHECK_MARK } from "@/lib/catalog-portal/icons";
import { PathIcon } from "./icon";

const SECTION = "border-b border-b-border";
const MONO_LABEL = "font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground/80";

function Chip({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <span
      className="inline-flex h-[23px] items-center gap-1.5 rounded-md border border-input px-[9px] text-[11.5px]"
      style={{ color: color ?? "hsl(var(--muted-foreground))" }}
    >
      {children}
    </span>
  );
}

function MiniRow({ m, onSelect }: { m: MiniRef; onSelect: (key: string) => void }) {
  return (
    <button
      type="button"
      data-row
      onClick={() => m.key && onSelect(m.key)}
      disabled={!m.key}
      className="flex w-full items-center gap-[9px] rounded-[7px] bg-transparent px-2 py-[7px] text-left transition-colors hover:bg-foreground/[0.022] disabled:cursor-default"
    >
      <span className="grid shrink-0 place-items-center text-muted-foreground/80">
        <PathIcon d={m.iconD} size={14} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground/90">{m.name}</span>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: m.healthColor }} />
    </button>
  );
}

const RING_R = 27;
const RING_CIRC = 2 * Math.PI * RING_R;

export function DetailDrawer({
  sel,
  onClose,
  onSelectRef,
  onViewMap,
  onOpenPage,
}: {
  sel: SelectedService;
  onClose: () => void;
  onSelectRef: (key: string) => void;
  onViewMap: () => void;
  onOpenPage: () => void;
}) {
  // Desktop-only: on mobile the catalog taps straight through to the full
  // service page, so this peek drawer is never mounted on small screens.
  const ringOffset = RING_CIRC * (1 - (sel.score ?? 0) / 100);
  return (
    <>
      <button
        type="button"
        aria-label="Close detail"
        onClick={onClose}
        className="absolute inset-0 z-[5] animate-fade-in bg-black/50"
      />
      <aside className="absolute inset-y-0 right-0 z-[6] flex w-[512px] max-w-[92vw] animate-slide-in-right flex-col overflow-hidden border-l border-l-border bg-card shadow-[-28px_0_90px_hsl(0_0%_0%/0.6)]">
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* identity */}
          <div className={`px-[18px] pb-4 pt-[18px] ${SECTION}`}>
            <div className="flex items-start gap-3">
              <span className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-[11px] border border-border bg-muted text-foreground/90">
                <PathIcon d={sel.iconD} size={21} strokeWidth={1.7} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="m-0 truncate text-[16px] font-semibold text-foreground">{sel.name}</h2>
                  <span className="shrink-0 rounded border border-input px-[5px] text-[10px] text-muted-foreground/80">
                    {sel.kindLabel}
                  </span>
                </div>
                <div className="mt-1 break-all font-mono text-[11px] text-muted-foreground/60">{sel.ref}</div>
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={onClose}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-[7px] border border-border bg-transparent text-muted-foreground/80 hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            {sel.description ? (
              <p className="mt-[13px] text-[12.5px] leading-[1.55] text-muted-foreground">{sel.description}</p>
            ) : null}
            <div className="mt-[13px] flex flex-wrap gap-[7px]">
              {sel.lifeShow ? (
                <Chip color={sel.lifeText}>
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: sel.lifeColor }} />
                  <span className="capitalize">{sel.lifeLabel}</span>
                </Chip>
              ) : null}
              <Chip color={sel.healthText}>
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: sel.healthColor }} />
                {sel.healthLabel}
              </Chip>
              {sel.language ? <Chip>{sel.language}</Chip> : null}
              <Chip>{sel.system}</Chip>
            </div>
            <button
              type="button"
              onClick={onOpenPage}
              className="mt-3.5 flex h-[34px] w-full items-center justify-center gap-[7px] rounded-[8px] border-none bg-primary text-[12.5px] font-semibold text-primary-foreground hover:brightness-110"
            >
              Open full service page
              <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={2.4} />
            </button>
          </div>

          {/* operational stats */}
          {sel.hasOps ? (
            <div className={`grid grid-cols-3 ${SECTION}`}>
              <div className="border-r border-r-border px-4 py-3.5">
                <div className={MONO_LABEL}>SLO</div>
                <div className="mt-1.5 text-[16px] font-semibold" style={{ color: sel.sloColor }}>
                  {sel.sloCur != null ? `${sel.sloCur}%` : "—"}
                </div>
                <div className="mt-0.5 text-[10.5px] text-muted-foreground/60">
                  {sel.sloTarget != null ? `target ${sel.sloTarget}%` : "no target"}
                </div>
              </div>
              <div className="border-r border-r-border px-4 py-3.5">
                <div className={MONO_LABEL}>Incidents</div>
                <div className="mt-1.5 text-[16px] font-semibold" style={{ color: sel.incColor }}>
                  {sel.incidents}
                </div>
                <div className="mt-0.5 text-[10.5px] text-muted-foreground/60">open now</div>
              </div>
              <div className="px-4 py-3.5">
                <div className={MONO_LABEL}>Deploys</div>
                <div className="mt-1.5 text-[16px] font-semibold text-foreground">{sel.deploysWeek}</div>
                <div className="mt-0.5 text-[10.5px] text-muted-foreground/60">last {sel.deployLabel}</div>
              </div>
            </div>
          ) : null}

          {/* scorecard */}
          {sel.hasScore ? (
            <div className={`px-[18px] py-4 ${SECTION}`}>
              <div className="mb-3.5 flex items-center gap-2">
                <span className={MONO_LABEL}>Production readiness</span>
              </div>
              <div className="flex items-center gap-4">
                <div className="relative h-16 w-16 shrink-0">
                  <svg width="64" height="64" viewBox="0 0 64 64" className="-rotate-90">
                    <circle cx="32" cy="32" r={RING_R} fill="none" stroke="hsl(var(--border))" strokeWidth="6" />
                    <circle
                      cx="32"
                      cy="32"
                      r={RING_R}
                      fill="none"
                      stroke={sel.tierColor}
                      strokeWidth="6"
                      strokeLinecap="round"
                      strokeDasharray={RING_CIRC.toFixed(1)}
                      strokeDashoffset={ringOffset.toFixed(1)}
                    />
                  </svg>
                  <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-[18px] font-bold leading-none text-foreground">{sel.scoreNum}</span>
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <div
                    className="inline-flex h-[22px] items-center gap-1.5 rounded-md px-[9px] text-[12px] font-semibold"
                    style={{ background: sel.tierBg, border: `1px solid ${sel.tierBorder}`, color: sel.tierColor }}
                  >
                    {sel.tierLabel} tier
                  </div>
                  <div className="mt-2 flex gap-3 text-[11.5px] text-muted-foreground/80">
                    <span>
                      <span className="font-semibold text-success">{sel.passCount}</span> pass
                    </span>
                    <span>
                      <span className="font-semibold text-primary">{sel.warnCount}</span> warn
                    </span>
                    <span>
                      <span className="font-semibold text-destructive">{sel.failCount}</span> fail
                    </span>
                  </div>
                </div>
              </div>
              <div className="mt-[15px] flex flex-col gap-px">
                {sel.checks.map((ck) => {
                  const c = CHECK_COLOR[ck.status];
                  return (
                    <div key={ck.id} className="flex items-center gap-2.5 py-1.5">
                      <span
                        className="grid h-4 w-4 shrink-0 place-items-center rounded-[5px]"
                        style={{ background: c.bg, color: c.c }}
                      >
                        <PathIcon d={CHECK_MARK[ck.status]} size={10} strokeWidth={3} />
                      </span>
                      <span className="flex-1 text-[12.5px] text-foreground/90">{ck.label}</span>
                      <span className="text-[11px] capitalize" style={{ color: c.c }}>
                        {ck.status}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* ownership */}
          <div className={`px-[18px] py-4 ${SECTION}`}>
            <div className={`${MONO_LABEL} mb-3`}>Ownership</div>
            <div className="flex items-center gap-[11px]">
              <span
                className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[9px] text-[12px] font-semibold"
                style={{
                  background: sel.owned ? "hsl(var(--accent))" : "transparent",
                  border: sel.owned ? "1px solid hsl(var(--input))" : "1px dashed hsl(var(--input))",
                  color: sel.owned ? "hsl(var(--foreground) / 0.9)" : "hsl(var(--muted-foreground) / 0.6)",
                }}
              >
                {sel.ownerInitials}
              </span>
              <div className="min-w-0">
                <div className="text-[13px] font-medium" style={{ color: sel.owned ? "hsl(var(--foreground) / 0.9)" : "hsl(var(--muted-foreground) / 0.8)" }}>
                  {sel.ownerName}
                </div>
                <div className="text-[11px] text-muted-foreground/60">{sel.ownerSub}</div>
              </div>
            </div>
            {sel.hasOnCall ? (
              <div className="mt-3 flex items-center gap-2.5 border-t border-dashed border-t-border pt-3">
                <span className="h-2 w-2 shrink-0 rounded-full bg-success shadow-[0_0_0_3px_hsl(var(--success)/0.15)]" />
                <span className="text-[12.5px] text-foreground/90">{sel.onCall}</span>
                <span className="text-[11px] text-muted-foreground/60">on-call</span>
              </div>
            ) : null}
          </div>

          {/* dependencies */}
          <div className="px-[18px] py-4">
            <div className="mb-3 flex items-center gap-2">
              <span className={MONO_LABEL}>Dependencies</span>
              <button
                type="button"
                onClick={onViewMap}
                className="ml-auto flex items-center gap-1 bg-transparent text-[11px] text-primary"
              >
                View map
                <ArrowUpRight className="h-[11px] w-[11px]" strokeWidth={2.4} />
              </button>
            </div>
            {sel.hasDeps ? (
              <>
                <div className="mb-1 text-[11px] text-muted-foreground/60">Depends on {sel.dependsOn.length}</div>
                <div className="mb-3.5 flex flex-col gap-px">
                  {sel.dependsOn.map((d, i) => (
                    <MiniRow key={`${d.key ?? d.name}-${i}`} m={d} onSelect={onSelectRef} />
                  ))}
                </div>
              </>
            ) : null}
            {sel.hasUsedBy ? (
              <>
                <div className="mb-1 text-[11px] text-muted-foreground/60">Used by {sel.usedByList.length}</div>
                <div className="flex flex-col gap-px">
                  {sel.usedByList.map((u, i) => (
                    <MiniRow key={`${u.key ?? u.name}-${i}`} m={u} onSelect={onSelectRef} />
                  ))}
                </div>
              </>
            ) : null}
            {sel.noRelations ? <p className="m-0 text-[12.5px] text-muted-foreground/60">No relations declared.</p> : null}
          </div>
        </div>

        {/* footer quick links */}
        <div className="flex shrink-0 gap-2 border-t border-t-border bg-background px-4 py-3">
          <FooterLink icon={<Github className="h-[13px] w-[13px]" />} label="Repo" />
          <FooterLink icon={<AreaChart className="h-[13px] w-[13px]" />} label="Dashboards" />
          <FooterLink icon={<BookText className="h-[13px] w-[13px]" />} label="Runbook" />
        </div>
      </aside>
    </>
  );
}

function FooterLink({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[7px] border border-border bg-muted text-[12px] text-foreground/90 hover:border-input"
    >
      {icon}
      {label}
    </button>
  );
}
