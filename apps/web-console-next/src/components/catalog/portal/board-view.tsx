/**
 * Catalog portal Board view (saas-catalog-portal CP2).
 * Kanban columns by lifecycle + an infrastructure column, matching the design.
 */

import * as React from "react";
import { PanelRight } from "lucide-react";
import type { CatalogService, DecoratedService } from "@/lib/catalog-portal/model";
import type { BoardColumn } from "@/lib/catalog-portal/layout";
import { PathIcon } from "./icon";

function Card({
  d,
  selected,
  onOpen,
  onQuickView,
}: {
  d: DecoratedService;
  selected: boolean;
  onOpen: () => void;
  onQuickView?: (() => void) | undefined;
}) {
  return (
    // A click opens the full service page; the quick-view button (a sibling, so
    // it isn't an invalid button-in-button) peeks the drawer on hover/focus.
    <div className="group relative">
      <button
        type="button"
        data-card
        onClick={onOpen}
        className="flex w-full flex-col gap-[9px] rounded-[10px] border p-[11px] text-left transition-colors hover:border-input"
        style={{
          background: selected ? "hsl(var(--primary) / 0.06)" : "hsl(var(--popover))",
          borderColor: selected ? "hsl(var(--primary) / 0.35)" : "hsl(var(--accent))",
        }}
      >
        <span className="flex min-w-0 items-center gap-[9px]">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-border bg-muted text-muted-foreground">
            <PathIcon d={d.iconD} size={15} />
          </span>
          <span className="flex min-w-0 flex-col gap-px">
            <span className="truncate text-[13px] font-medium text-foreground">{d.name}</span>
            <span className="truncate font-mono text-[10.5px] text-muted-foreground/60">{d.ownerName}</span>
          </span>
          <span className="ml-auto h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: d.healthColor }} />
        </span>
        <span className="flex items-center gap-2">
          {d.hasScore ? (
            <span
              className="inline-flex h-[18px] items-center rounded-[5px] px-1.5 text-[10px] font-semibold"
              style={{ background: d.tierBg, border: `1px solid ${d.tierBorder}`, color: d.tierColor }}
            >
              {d.tierLabel} {d.scoreNum}
            </span>
          ) : null}
          <span className="text-[10.5px] text-muted-foreground/60">{d.kindLabel}</span>
        </span>
      </button>
      {onQuickView ? (
        <button
          type="button"
          aria-label="Quick view"
          title="Quick view"
          onClick={onQuickView}
          className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-[7px] border border-transparent bg-transparent text-muted-foreground/70 opacity-0 transition-[opacity,color,background-color,border-color] hover:border-border hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
        >
          <PanelRight className="h-[15px] w-[15px]" strokeWidth={1.8} />
        </button>
      ) : null}
    </div>
  );
}

export function BoardView({
  columns,
  decorate,
  selectedKey,
  onOpen,
  onQuickView,
  isDesktop = true,
}: {
  columns: BoardColumn[];
  decorate: (s: CatalogService) => DecoratedService;
  selectedKey: string | null;
  /** Open the full service page — the primary single-click action. */
  onOpen: (key: string) => void;
  /** Open the quick-view drawer (desktop only) — omitted hides the button. */
  onQuickView?: ((key: string) => void) | undefined;
  isDesktop?: boolean;
}) {
  // Desktop: equal-fraction columns filling the frame. Mobile: a real
  // horizontally swiped board — fixed-width, snap-aligned columns capped to the
  // viewport — instead of N columns crushed into a phone's width.
  if (!isDesktop) {
    return (
      <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2">
        {columns.map((col) => (
          <div
            key={col.key}
            className="flex max-h-[68dvh] w-[80vw] max-w-[300px] shrink-0 snap-start flex-col overflow-hidden rounded-xl border border-border bg-background"
          >
            <div className="flex items-center gap-2 border-b border-b-border px-[13px] py-[11px]">
              <span className="h-[7px] w-[7px] rounded-full" style={{ background: col.color }} />
              <span className="text-[12.5px] font-semibold text-foreground">{col.title}</span>
              <span className="ml-auto rounded-[5px] bg-muted px-[7px] py-px font-mono text-[11px] text-muted-foreground/60">
                {col.count}
              </span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2.5">
              {col.services.map((s) => {
                const d = decorate(s);
                return (
                  <Card
                    key={d.key}
                    d={d}
                    selected={selectedKey === d.key}
                    onOpen={() => onOpen(d.key)}
                    onQuickView={onQuickView ? () => onQuickView(d.key) : undefined}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      className="grid min-h-0 flex-1 gap-3"
      style={{ gridTemplateColumns: `repeat(${columns.length || 1}, minmax(0, 1fr))` }}
    >
      {columns.map((col) => (
        <div
          key={col.key}
          className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-background"
        >
          <div className="flex items-center gap-2 border-b border-b-border px-[13px] py-[11px]">
            <span className="h-[7px] w-[7px] rounded-full" style={{ background: col.color }} />
            <span className="text-[12.5px] font-semibold text-foreground">{col.title}</span>
            <span className="ml-auto rounded-[5px] bg-muted px-[7px] py-px font-mono text-[11px] text-muted-foreground/60">
              {col.count}
            </span>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2.5">
            {col.services.map((s) => {
              const d = decorate(s);
              return (
                <Card
                  key={d.key}
                  d={d}
                  selected={selectedKey === d.key}
                  onOpen={() => onOpen(d.key)}
                  onQuickView={onQuickView ? () => onQuickView(d.key) : undefined}
                />
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
