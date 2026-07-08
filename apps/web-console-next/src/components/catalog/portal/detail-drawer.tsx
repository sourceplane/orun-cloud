/**
 * Catalog portal entity peek drawer (saas-catalog-portal CP3), Northwind design.
 *
 * A right-anchored floating panel over a scrim (per entity-drawer.html): kind
 * kicker + health pill + close, serif name, mono ref, description, two stat
 * tiles (SLO / Deploys), key-value rows, and a footer with "Open entity page"
 * (primary ink) + "View docs" (outline). On phones it becomes a bottom sheet.
 * Esc-close and scrim-click-close are preserved by the caller + the scrim button.
 */

import * as React from "react";
import { X } from "lucide-react";
import type { SelectedService } from "@/lib/catalog-portal/model";
import type { HealthKey } from "@/lib/catalog-portal/palette";
import { Kicker, Pill, type Tone } from "@/components/ui/northwind";

const HEALTH_TONE: Record<HealthKey, Tone> = {
  healthy: "success",
  degraded: "warning",
  down: "error",
  managed: "neutral",
};

const KV_LABEL = "text-[13px] text-muted-foreground";

function KeyValue({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className={KV_LABEL}>{label}</span>
      <span className={mono ? "font-mono text-[12px] text-foreground" : "text-[13px] font-medium text-foreground"}>
        {value}
      </span>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[10px] border border-border p-[12px_14px]">
      <div className="text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/70">{label}</div>
      <div className="mt-[5px] font-serif text-[22px] font-medium leading-none text-foreground">{value}</div>
    </div>
  );
}

export function DetailDrawer({
  sel,
  onClose,
  onOpenPage,
  onViewDocs,
}: {
  sel: SelectedService;
  onClose: () => void;
  /** Kept for API compatibility (dep peeks); unused in the Northwind drawer. */
  onSelectRef?: (key: string) => void;
  /** Kept for API compatibility (map jump); unused in the Northwind drawer. */
  onViewMap?: () => void;
  onOpenPage: () => void;
  onViewDocs: () => void;
}) {
  const healthTone = HEALTH_TONE[sel.healthKey];
  // Source line: the short commit when known, else the entity ref namespace.
  const source = sel.svc.sourceCommit ? sel.svc.sourceCommit.replace(/^sha\d*:/i, "").slice(0, 9) : sel.system;
  return (
    <>
      {/* scrim — click closes */}
      <button
        type="button"
        aria-label="Close detail"
        onClick={onClose}
        className="fixed inset-0 z-40 animate-scrim-in bg-[rgba(0,0,0,0.22)]"
      />
      {/* panel — right-inset floating card on desktop, bottom sheet on mobile */}
      <aside
        className="fixed inset-x-2 bottom-2 top-auto z-[41] flex max-h-[85dvh] animate-drawer-in flex-col overflow-hidden rounded-[14px] border border-border bg-card shadow-[0_18px_50px_rgba(0,0,0,0.16)] sm:inset-x-auto sm:inset-y-3 sm:right-3 sm:top-3 sm:bottom-3 sm:max-h-none sm:w-[440px]"
      >
        {/* header */}
        <div className="flex items-center gap-2.5 px-[22px] pt-[18px]">
          <Kicker>{sel.kindLabel}</Kicker>
          <Pill tone={healthTone} dot>
            {sel.healthLabel}
          </Pill>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="ml-auto grid h-7 w-7 place-items-center rounded-[7px] text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-[15px] w-[15px]" strokeWidth={2} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* identity */}
          <div className="px-[22px] pt-[10px]">
            <div className="font-serif text-[26px] font-medium leading-tight tracking-[-0.01em] text-foreground">
              {sel.name}
            </div>
            <div className="mt-1 break-all font-mono text-[12px] text-muted-foreground/70">{sel.ref}</div>
            {sel.description ? (
              <p className="mt-3 text-[13.5px] leading-[1.55] text-secondary-foreground">{sel.description}</p>
            ) : null}
          </div>

          {/* stat tiles */}
          <div className="grid grid-cols-2 gap-2.5 px-[22px] pt-[18px]">
            <StatTile label="SLO · 30d" value={sel.sloCur != null ? `${sel.sloCur}%` : "—"} />
            <StatTile label="Deploys" value={sel.deploysWeek} />
          </div>

          {/* key-value rows */}
          <div className="flex flex-col gap-3 px-[22px] py-[18px]">
            <KeyValue label="Owner" value={sel.ownerName} />
            <KeyValue label="Lifecycle" value={<span className="capitalize">{sel.lifeShow ? sel.lifeLabel : "—"}</span>} />
            <KeyValue label="Language" value={sel.language ?? "—"} />
            <KeyValue label="Source" value={source} mono />
            <KeyValue label="Maturity" value={sel.tierLabel || "—"} />
          </div>
        </div>

        {/* footer actions */}
        <div className="mt-auto flex gap-2.5 border-t border-t-border/70 px-[22px] py-4">
          <button
            type="button"
            onClick={onOpenPage}
            className="flex-1 rounded-[9px] bg-primary py-[9px] text-[13px] font-semibold text-primary-foreground transition-colors hover:brightness-110"
          >
            Open entity page
          </button>
          <button
            type="button"
            onClick={onViewDocs}
            className="flex-1 rounded-[9px] border border-border bg-card py-[9px] text-[13px] font-medium text-foreground transition-colors hover:bg-muted"
          >
            View docs
          </button>
        </div>
      </aside>
    </>
  );
}
