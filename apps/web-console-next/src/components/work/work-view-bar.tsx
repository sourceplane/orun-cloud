"use client";

// The view bar (orun-work-v3 PM2): layout toggle (list | board), the filter
// chip row (labels, priority, rung), and the saved-view switcher. A saved
// view is pure, shareable UI intent — workspace configuration beside the
// logs; picking one applies its layout + filters, nothing more.

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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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

export type WorkLayout = "board" | "list";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function WorkViewBar({
  orgId,
  tasks,
  layout,
  filters,
  onLayoutChange,
  onFiltersChange,
}: {
  orgId: string;
  tasks: WorkTaskView[];
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
      // views are sugar; the board renders without them
    }
  }, [client, orgId]);

  React.useEffect(() => {
    void loadViews();
  }, [loadViews]);

  const applyView = (v: WorkViewView) => {
    onLayoutChange(v.config.layout === "board" ? "board" : "list");
    onFiltersChange({ ...(v.config.filters ?? {}) });
  };

  const saveView = async () => {
    const name = saveName.trim();
    if (!name) return;
    setSaveBusy(true);
    setSaveError(null);
    try {
      await client.work.saveView(orgId, { key: slugify(name), name, config: toViewConfig(layout, filters) });
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

  const tags = allTags(tasks);

  return (
    <div className="mt-[18px] flex flex-wrap items-center gap-x-3 gap-y-2">
      {/* layout toggle */}
      <div className="flex overflow-hidden rounded-md border">
        {(["list", "board"] as const).map((l) => (
          <button
            key={l}
            type="button"
            onClick={() => onLayoutChange(l)}
            className={cn(
              "px-2.5 py-1 text-[11.5px] capitalize transition-colors",
              layout === l ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {l}
          </button>
        ))}
      </div>

      {/* saved views */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="rounded-md border px-2.5 py-1 text-[11.5px] text-muted-foreground hover:text-foreground"
          >
            Views{views.length ? ` (${views.length})` : ""}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          {views.map((v) => (
            <DropdownMenuItem key={v.key} onSelect={() => applyView(v)} className="text-[12px]">
              {v.name}
              <span className="ml-auto text-[10.5px] text-muted-foreground">{v.config.layout}</span>
            </DropdownMenuItem>
          ))}
          {views.length > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem onSelect={() => setSaveOpen(true)} className="text-[12px]">
            Save current view…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <span className="h-4 w-px bg-border" aria-hidden />

      {/* label chips */}
      {tags.map((tag) => (
        <FilterChip
          key={`tag:${tag}`}
          active={filters.tags?.includes(tag) ?? false}
          onClick={() => onFiltersChange({ ...filters, tags: toggled(filters.tags, tag) })}
        >
          {tag}
        </FilterChip>
      ))}

      {/* priority chips */}
      {PRIORITY_OPTIONS.filter((p) => p !== "none").map((p: WorkPriority) => (
        <FilterChip
          key={`prio:${p}`}
          active={filters.priority?.includes(p) ?? false}
          onClick={() => onFiltersChange({ ...filters, priority: toggled(filters.priority, p) })}
        >
          {p}
        </FilterChip>
      ))}

      {/* rung chips (list layout benefits; board columns already split) */}
      {layout === "list"
        ? BOARD_RUNGS.map((r: WorkRung) => (
            <FilterChip
              key={`rung:${r}`}
              active={filters.rung?.includes(r) ?? false}
              onClick={() => onFiltersChange({ ...filters, rung: toggled(filters.rung, r) })}
            >
              {rungLabel(r)}
            </FilterChip>
          ))
        : null}

      {hasActiveFilters(filters) ? (
        <button
          type="button"
          onClick={() => onFiltersChange({})}
          className="text-[11.5px] text-muted-foreground underline-offset-2 hover:underline"
        >
          Clear filters
        </button>
      ) : null}

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle className="text-[14px]">Save view</DialogTitle>
            <DialogDescription>
              Saves the current layout and filters, shareable with the whole workspace — views are
              intent about how to look, never about what is true.
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
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2 py-0.5 text-[11px] transition-colors",
        active
          ? "border-foreground/30 bg-muted font-medium text-foreground"
          : "border-border text-muted-foreground hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}
