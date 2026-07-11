"use client";

// Filter and Display menus for the Tasks lens (orun-work-v5 WV2) — the
// mock's two quiet pills (design.md §3.1). Filter owns what is admitted;
// Display owns how it looks (layout; saved views serialize both). Neither
// can express a status write — views are intent about how to look, never
// about what is true (V3-3, carried).

import * as React from "react";
import type { WorkPriority, WorkRung, WorkTaskView, WorkViewView } from "@saas/contracts/work";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Check,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { useSession } from "@/lib/session";
import { rungLabel } from "@/lib/work/model";
import {
  allTags,
  hasActiveFilters,
  toggled,
  toViewConfig,
  BOARD_RUNGS,
  PRIORITY_OPTIONS,
  type BoardFilters,
} from "@/lib/work/board";
import type { WorkLayout } from "@/components/work/work-view-bar";

function ControlPill({
  active = false,
  children,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-[11px] py-[4.5px] text-xs transition-colors",
        active
          ? "border-foreground/30 bg-muted font-medium text-foreground"
          : "border-border bg-card text-muted-foreground hover:border-foreground/25 hover:text-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

function CheckRow({
  checked,
  onToggle,
  children,
}: {
  checked: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenuItem
      className="text-[12px]"
      onSelect={(e) => {
        e.preventDefault(); // keep the menu open while composing a filter
        onToggle();
      }}
    >
      <span className="grid w-4 place-items-center">
        {checked ? <Check className="h-3 w-3" /> : null}
      </span>
      {children}
    </DropdownMenuItem>
  );
}

/** The Filter pill: labels · priority · rung, AND across dimensions. */
export function FilterMenu({
  tasks,
  filters,
  onFiltersChange,
}: {
  tasks: WorkTaskView[];
  filters: BoardFilters;
  onFiltersChange: (filters: BoardFilters) => void;
}) {
  const tags = allTags(tasks);
  const activeCount =
    (filters.tags?.length ?? 0) + (filters.priority?.length ?? 0) + (filters.rung?.length ?? 0);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ControlPill id="work-filter-trigger" active={hasActiveFilters(filters)}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
          </svg>
          Filter
          {activeCount > 0 ? <span className="font-semibold">{activeCount}</span> : null}
        </ControlPill>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-96 w-56 overflow-y-auto">
        {tags.length > 0 ? (
          <>
            <DropdownMenuLabel className="text-[10.5px] uppercase tracking-wide text-muted-foreground">
              Labels
            </DropdownMenuLabel>
            {tags.map((tag) => (
              <CheckRow
                key={tag}
                checked={filters.tags?.includes(tag) ?? false}
                onToggle={() => onFiltersChange({ ...filters, tags: toggled(filters.tags, tag) })}
              >
                {tag}
              </CheckRow>
            ))}
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuLabel className="text-[10.5px] uppercase tracking-wide text-muted-foreground">
          Priority
        </DropdownMenuLabel>
        {PRIORITY_OPTIONS.filter((p) => p !== "none").map((p: WorkPriority) => (
          <CheckRow
            key={p}
            checked={filters.priority?.includes(p) ?? false}
            onToggle={() => onFiltersChange({ ...filters, priority: toggled(filters.priority, p) })}
          >
            {p}
          </CheckRow>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[10.5px] uppercase tracking-wide text-muted-foreground">
          Rung — observed, filter only
        </DropdownMenuLabel>
        {BOARD_RUNGS.map((r: WorkRung) => (
          <CheckRow
            key={r}
            checked={filters.rung?.includes(r) ?? false}
            onToggle={() => onFiltersChange({ ...filters, rung: toggled(filters.rung, r) })}
          >
            {rungLabel(r)}
          </CheckRow>
        ))}
        {hasActiveFilters(filters) ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-[12px]" onSelect={() => onFiltersChange({})}>
              Clear filters
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The Display pill: layout (list | board) + saved views. */
export function DisplayMenu({
  orgId,
  layout,
  filters,
  onLayoutChange,
  onFiltersChange,
}: {
  orgId: string;
  layout: WorkLayout;
  filters: BoardFilters;
  onLayoutChange: (layout: WorkLayout) => void;
  onFiltersChange: (filters: BoardFilters) => void;
}) {
  const { client } = useSession();
  const [views, setViews] = React.useState<WorkViewView[]>([]);
  const [saveOpen, setSaveOpen] = React.useState(false);
  const [saveName, setSaveName] = React.useState("");
  const [saveBusy, setSaveBusy] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const loadViews = React.useCallback(async () => {
    try {
      const res = await client.work.listViews(orgId);
      setViews(res.views);
    } catch {
      // views are sugar; the lens renders without them
    }
  }, [client, orgId]);
  React.useEffect(() => {
    void loadViews();
  }, [loadViews]);

  const saveView = async () => {
    const name = saveName.trim();
    if (!name) return;
    setSaveBusy(true);
    setSaveError(null);
    try {
      const key = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
      await client.work.saveView(orgId, { key, name, config: toViewConfig(layout, filters) });
      setSaveOpen(false);
      setSaveName("");
      await loadViews();
    } catch (err) {
      const e = err as { message?: string };
      setSaveError(e.message ?? "rejected");
    } finally {
      setSaveBusy(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <ControlPill id="work-display-trigger">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <line x1="21" x2="14" y1="4" y2="4" />
              <line x1="10" x2="3" y1="4" y2="4" />
              <line x1="21" x2="12" y1="12" y2="12" />
              <line x1="8" x2="3" y1="12" y2="12" />
              <line x1="21" x2="16" y1="20" y2="20" />
              <line x1="12" x2="3" y1="20" y2="20" />
              <line x1="14" x2="14" y1="2" y2="6" />
              <line x1="8" x2="8" y1="10" y2="14" />
              <line x1="16" x2="16" y1="18" y2="22" />
            </svg>
            Display
          </ControlPill>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuLabel className="text-[10.5px] uppercase tracking-wide text-muted-foreground">
            Layout
          </DropdownMenuLabel>
          {(["list", "board"] as const).map((l) => (
            <DropdownMenuItem key={l} className="text-[12px] capitalize" onSelect={() => onLayoutChange(l)}>
              <span className="grid w-4 place-items-center">
                {layout === l ? <Check className="h-3 w-3" /> : null}
              </span>
              {l}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[10.5px] uppercase tracking-wide text-muted-foreground">
            Saved views
          </DropdownMenuLabel>
          {views.map((v) => (
            <DropdownMenuItem
              key={v.key}
              className="text-[12px]"
              onSelect={() => {
                onLayoutChange(v.config.layout === "board" ? "board" : "list");
                onFiltersChange({ ...(v.config.filters ?? {}) });
              }}
            >
              <span className="w-4" />
              {v.name}
              <span className="ml-auto text-[10.5px] text-muted-foreground">{v.config.layout}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem className="text-[12px]" onSelect={() => setSaveOpen(true)}>
            <span className="w-4" />
            Save current view…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle className="text-[14px]">Save view</DialogTitle>
            <DialogDescription>
              Saves the current layout and filters, shareable with the whole workspace — views are intent
              about how to look, never about what is true.
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void saveView();
            }}
          >
            <Input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="Infra board" autoFocus />
            {saveError ? <p className="text-[12px] text-destructive">verdict: {saveError}</p> : null}
            <DialogFooter>
              <Button variant="outline" size="sm" type="button" onClick={() => setSaveOpen(false)}>
                Cancel
              </Button>
              <Button size="sm" type="submit" loading={saveBusy} disabled={!saveName.trim()}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
